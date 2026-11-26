// The Photos library on this Mac through PhotoKit, for the Apple Photos source provider (desktop/providers/photos.ts,
// ADR 0013; measured in spikes/apple-photos). Read only: nothing here makes a change request.
//
// Calls that wait return promises; PhotoKit's handlers run on its own queues and reach JavaScript through a
// thread-safe function, as in cloudkit.mm. Pictures are written as 8-bit sRGB JPEGs: PhotoKit hands most of them over
// in Display P3, some at 16 bit.
//
// The provider needs macOS 15.2 (archival cloud identifiers; `adjustmentTimestamp`, the revision of an edit, came in 15); captions and keywords need macOS 27. A
// process without `NSPhotoLibraryUsageDescription` in its Info.plist is killed by TCC when it asks for access, so
// `status()` reports such a process (a development Electron) as unsupported and nothing asks.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Photos/Photos.h>
#import <PhotosUI/PhotosUI.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <node_api.h>
#include <memory>
#include <unordered_map>
#include <mutex>
#include <cstring>
#include <string>
#include <vector>

// APIs of macOS 15 and later are reached at runtime, not through the SDK the addon is built with: CI and release
// builds may use an older Xcode, and the app must still use them wherever macOS has them. Each is checked with
// `respondsToSelector:` (or `@available`) before it is used.
static id property(id object, NSString *name) { return object && [object respondsToSelector:NSSelectorFromString(name)] ? [object valueForKey:name] : nil; }
/** A cloud identifier's archival string (macOS 15.2), or nil. */
static NSString *archivalString(PHCloudIdentifier *identifier) { id value = property(identifier, @"archivalStringValue"); return [value isKindOfClass:NSString.class] ? value : nil; }
/** The cloud identifier of an archival string (macOS 15.2), or nil. */
static PHCloudIdentifier *cloudIdentifier(NSString *text) {
  SEL init = NSSelectorFromString(@"initWithArchivalStringValue:");
  if (![PHCloudIdentifier instancesRespondToSelector:init]) return nil;
  PHCloudIdentifier *allocated = [PHCloudIdentifier alloc];
  // An init: the result is owned, as ARC expects of the init family.
  id (*send)(id, SEL, NSString *) = (id (*)(id, SEL, NSString *))[allocated methodForSelector:init];
  return send(allocated, init, text);
}

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, #call " failed"); return nullptr; } } while (0)

typedef void (^JSWork)(napi_env env);
typedef napi_value (^Builder)(napi_env env);

// ---------- Promises (as cloudkit.mm)

struct Pending {
  napi_deferred deferred = nullptr;
  napi_threadsafe_function tsfn = nullptr;
  napi_ref progress = nullptr;
  std::recursive_mutex lock;
  bool settled = false;
  bool closed = false;
};
typedef std::shared_ptr<Pending> PendingRef;

static void callJs(napi_env env, napi_value, void *, void *data) {
  JSWork work = (__bridge_transfer JSWork)data;
  if (env) work(env);
}

static void finishPending(napi_env env, void *data, void *) {
  PendingRef *holder = static_cast<PendingRef *>(data);
  {
    std::lock_guard<std::recursive_mutex> guard((*holder)->lock);
    (*holder)->closed = true;
    if ((*holder)->progress && env) napi_delete_reference(env, (*holder)->progress);
    (*holder)->progress = nullptr;
  }
  delete holder;
}

static PendingRef newPending(napi_env env, napi_value *promise, napi_value progress = nullptr) {
  PendingRef pending = std::make_shared<Pending>();
  napi_create_promise(env, &pending->deferred, promise);
  napi_value name;
  napi_create_string_utf8(env, "photos", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, new PendingRef(pending), finishPending, nullptr, callJs, &pending->tsfn);
  napi_valuetype type = napi_undefined;
  if (progress) napi_typeof(env, progress, &type);
  if (type == napi_function) napi_create_reference(env, progress, 1, &pending->progress);
  return pending;
}

static void enqueue(const PendingRef &pending, JSWork work) {
  napi_call_threadsafe_function(pending->tsfn, (__bridge_retained void *)[work copy], napi_tsfn_nonblocking);
}

static void settle(const PendingRef &pending, bool reject, Builder build) {
  std::lock_guard<std::recursive_mutex> guard(pending->lock);
  if (pending->settled || pending->closed) return;
  pending->settled = true;
  Builder kept = [build copy];
  PendingRef held = pending;
  enqueue(pending, ^(napi_env env) {
    napi_value value = kept(env);
    if (reject) napi_reject_deferred(env, held->deferred, value);
    else napi_resolve_deferred(env, held->deferred, value);
  });
  napi_release_threadsafe_function(pending->tsfn, napi_tsfn_release);
}

static void reportProgress(const PendingRef &pending, double fraction) {
  std::lock_guard<std::recursive_mutex> guard(pending->lock);
  if (pending->settled || pending->closed || !pending->progress) return;
  PendingRef held = pending;
  enqueue(pending, ^(napi_env env) {
    std::lock_guard<std::recursive_mutex> inner(held->lock);
    if (!held->progress) return;
    napi_value fn, global, argument;
    napi_get_reference_value(env, held->progress, &fn);
    napi_get_global(env, &global);
    napi_create_double(env, fraction, &argument);
    napi_call_function(env, global, fn, 1, &argument, nullptr);
  });
}

// ---------- Values

static napi_value str(napi_env env, NSString *value) { napi_value r; napi_create_string_utf8(env, value.UTF8String ?: "", NAPI_AUTO_LENGTH, &r); return r; }
static napi_value num(napi_env env, double value) { napi_value r; napi_create_double(env, value, &r); return r; }
static napi_value nullValue(napi_env env) { napi_value r; napi_get_null(env, &r); return r; }
static napi_value boolean(napi_env env, bool value) { napi_value r; napi_get_boolean(env, value, &r); return r; }
static napi_value undefinedValue(napi_env env) { napi_value r; napi_get_undefined(env, &r); return r; }
static void setProp(napi_env env, napi_value object, const char *key, napi_value value) { napi_set_named_property(env, object, key, value); }
static napi_value object(napi_env env) { napi_value r; napi_create_object(env, &r); return r; }

/** An Error whose `code` is `<domain>:<code>`, as the provider maps it. */
static napi_value errorValue(napi_env env, NSError *error) {
  napi_value result;
  napi_create_error(env, nullptr, str(env, error.localizedDescription ?: @"Photos could not answer."), &result);
  setProp(env, result, "code", str(env, [NSString stringWithFormat:@"%@:%ld", error.domain, (long)error.code]));
  // PhotoKit wraps a failed download (no network: NSURLErrorDomain -1009) in errors of its own iCloud domains.
  NSError *underlying = error.userInfo[NSUnderlyingErrorKey];
  for (int depth = 0; [underlying isKindOfClass:NSError.class] && depth < 4; depth++) {
    if ([underlying.domain isEqualToString:NSURLErrorDomain]) { setProp(env, result, "underlying", str(env, [NSString stringWithFormat:@"%@:%ld", underlying.domain, (long)underlying.code])); break; }
    underlying = underlying.userInfo[NSUnderlyingErrorKey];
  }
  return result;
}
static NSError *failure(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"ImageFlowPhotos" code:code userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *stringArg(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return nil;
  std::string buffer(length, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), length + 1, &length);
  return [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
}
static NSArray<NSString *> *stringsArg(napi_env env, napi_value value) {
  bool isArray = false;
  napi_is_array(env, value, &isArray);
  if (!isArray) return nil;
  uint32_t length = 0;
  napi_get_array_length(env, value, &length);
  NSMutableArray *out = [NSMutableArray arrayWithCapacity:length];
  for (uint32_t i = 0; i < length; i++) {
    napi_value item;
    napi_get_element(env, value, i, &item);
    NSString *text = stringArg(env, item);
    if (!text) return nil;
    [out addObject:text];
  }
  return out;
}
static napi_value stringsValue(napi_env env, NSArray *values) {
  napi_value array;
  napi_create_array_with_length(env, values.count, &array);
  for (NSUInteger i = 0; i < values.count; i++) napi_set_element(env, array, (uint32_t)i, [values[i] isKindOfClass:NSString.class] ? str(env, values[i]) : nullValue(env));
  return array;
}

// ---------- Access

// macOS 15.2: archival cloud identifiers, which name a photo for good and on every Mac of the library.
static bool supportedSystem() {
  if (@available(macOS 15.2, *)) return true;
  return false;
}
static bool describesUsage() {
  id text = [NSBundle.mainBundle objectForInfoDictionaryKey:@"NSPhotoLibraryUsageDescription"];
  return [text isKindOfClass:NSString.class] && [text length] > 0;
}
static NSString *statusName(PHAuthorizationStatus status) {
  switch (status) {
    case PHAuthorizationStatusAuthorized: return @"authorized";
    case PHAuthorizationStatusDenied: return @"denied";
    case PHAuthorizationStatusRestricted: return @"restricted";
    case PHAuthorizationStatusNotDetermined: return @"notDetermined";
    default: return @"limited";
  }
}
static NSString *currentStatus() {
  if (!supportedSystem()) return @"unsupported-system";
  if (!describesUsage()) return @"unsupported-build";
  return statusName([PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite]);
}
static bool authorized() {
  return supportedSystem() && describesUsage() && [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite] == PHAuthorizationStatusAuthorized;
}

/** status(): 'authorized' | 'notDetermined' | 'denied' | 'restricted' | 'limited' | 'unsupported-system' | 'unsupported-build' */
static napi_value Status(napi_env env, napi_callback_info) { return str(env, currentStatus()); }

/** requestAccess(): asks once (the system prompt) and resolves to the status after it. */
static napi_value RequestAccess(napi_env env, napi_callback_info) {
  napi_value promise;
  PendingRef pending = newPending(env, &promise);
  NSString *status = currentStatus();
  if (![status isEqualToString:@"notDetermined"]) {
    settle(pending, false, ^(napi_env e) { return str(e, status); });
    return promise;
  }
  [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite handler:^(PHAuthorizationStatus result) {
    NSString *name = statusName(result);
    settle(pending, false, ^(napi_env e) { return str(e, name); });
  }];
  return promise;
}

// ---------- Drags from Photos

/**
 * dragged(): the photos of the last drag on this Mac that came from Photos, from the system drag pasteboard, which
 * keeps the last drag until the next one. A web view's drop sees only a small JPEG Photos writes for each photo inside
 * its library; this names the photo itself. Each item: { localIdentifier, file, library, mediaType } where `file` is
 * the path of that JPEG, `library` the path of the library dragged from, and `mediaType` PhotoKit's (1: image, 2: video).
 */
static napi_value Dragged(napi_env env, napi_callback_info) {
  NSPasteboard *board = [NSPasteboard pasteboardWithName:NSPasteboardNameDrag];
  napi_value items;
  napi_create_array(env, &items);
  uint32_t index = 0;
  for (NSPasteboardItem *item in board.pasteboardItems) {
    id reference = [item propertyListForType:@"com.apple.photos.object-reference.asset"];
    if (![reference isKindOfClass:NSDictionary.class]) continue;
    id local = reference[@"localIdentifier"];
    if (![local isKindOfClass:NSString.class]) continue;
    napi_value entry = object(env);
    setProp(env, entry, "localIdentifier", str(env, local));
    NSString *url = [item stringForType:NSPasteboardTypeFileURL];
    NSString *path = url ? [NSURL URLWithString:url].path : nil;
    setProp(env, entry, "file", path ? str(env, path) : nullValue(env));
    id library = reference[@"libraryURL"];
    NSString *libraryPath = [library isKindOfClass:NSString.class] ? ([library hasPrefix:@"file:"] ? [NSURL URLWithString:library].path : library) : nil;
    setProp(env, entry, "library", libraryPath ? str(env, libraryPath) : nullValue(env));
    id mediaType = reference[@"mediaType"];
    setProp(env, entry, "mediaType", [mediaType isKindOfClass:NSNumber.class] ? num(env, [mediaType doubleValue]) : nullValue(env));
    napi_set_element(env, items, index++, entry);
  }
  napi_value result = object(env);
  setProp(env, result, "changeCount", num(env, board.changeCount));
  setProp(env, result, "items", items);
  return result;
}

// ---------- Identifiers

/** cloudIdentifiers(locals): the archival cloud identifier of each, or null. */
static napi_value CloudIdentifiers(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  NSArray<NSString *> *locals = argc ? stringsArg(env, argv[0]) : nil;
  napi_value promise;
  PendingRef pending = newPending(env, &promise);
  if (!locals) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(1, @"Expected identifiers.")); }); return promise; }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ @autoreleasepool {
    if (!authorized()) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(3311, @"ImageFlow may not read the Photos library.")); }); return; }
    NSMutableArray *out = [NSMutableArray new];
    if (@available(macOS 15.2, *)) {
      NSDictionary *mappings = [PHPhotoLibrary.sharedPhotoLibrary cloudIdentifierMappingsForLocalIdentifiers:locals];
      for (NSString *local in locals) { PHCloudIdentifier *cloud = [mappings[local] cloudIdentifier]; [out addObject:archivalString(cloud) ?: NSNull.null]; }
    } else {
      for (NSUInteger i = 0; i < locals.count; i++) [out addObject:NSNull.null];
    }
    settle(pending, false, ^(napi_env e) { return stringsValue(e, out); });
  } });
  return promise;
}

/** localIdentifiers(clouds): this library's local identifier of each archival cloud identifier, or null. */
static napi_value LocalIdentifiers(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  NSArray<NSString *> *clouds = argc ? stringsArg(env, argv[0]) : nil;
  napi_value promise;
  PendingRef pending = newPending(env, &promise);
  if (!clouds) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(1, @"Expected identifiers.")); }); return promise; }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ @autoreleasepool {
    if (!authorized()) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(3311, @"ImageFlow may not read the Photos library.")); }); return; }
    NSMutableArray *out = [NSMutableArray new];
    if (@available(macOS 15.2, *)) {
      NSMutableArray<PHCloudIdentifier *> *ids = [NSMutableArray new];
      for (NSString *text in clouds) { PHCloudIdentifier *id_ = cloudIdentifier(text); if (id_) [ids addObject:id_]; }
      NSDictionary *mappings = [PHPhotoLibrary.sharedPhotoLibrary localIdentifierMappingsForCloudIdentifiers:ids];
      NSUInteger at = 0;
      for (NSString *text in clouds) {
        PHCloudIdentifier *id_ = cloudIdentifier(text);
        if (!id_) { [out addObject:NSNull.null]; continue; }
        // Look up by the parsed identifier in order: the dictionary's keys are the identifiers passed in.
        PHCloudIdentifier *key = ids[at++];
        [out addObject:[mappings[key] localIdentifier] ?: NSNull.null];
      }
    } else {
      for (NSUInteger i = 0; i < clouds.count; i++) [out addObject:NSNull.null];
    }
    settle(pending, false, ^(napi_env e) { return stringsValue(e, out); });
  } });
  return promise;
}

// ---------- Facts

/** This Mac's UTC offset at an instant, in minutes: the guess for a photo whose own is not known. */
static NSInteger macOffset(NSDate *date) { return [NSTimeZone.systemTimeZone secondsFromGMTForDate:date] / 60; }
static id knownOffset(NSString *local);
static void readOffsets(NSArray<PHAsset *> *assets);

/**
 * facts(locals): for each local identifier, null when the library has no such still photo, else
 * { width, height, created (ms since 1970), offsetMinutes (the UTC offset it was taken at), offsetGuessed?, latitude?,
 *   longitude?, adjusted (ms of the last edit or revert, or null), base ('raw' | 'compressed'), caption?, keywords?,
 *   filename?, type?, favorite? (true, or absent) }
 * `offsetMinutes` is the original's own (EXIF OffsetTimeOriginal) once it has been read (`readOffsets`). Until then,
 * and for an original that records none, it is this Mac's offset at that instant, and `offsetGuessed` is true.
 */
static napi_value Facts(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  NSArray<NSString *> *locals = argc ? stringsArg(env, argv[0]) : nil;
  napi_value promise;
  PendingRef pending = newPending(env, &promise);
  if (!locals) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(1, @"Expected identifiers.")); }); return promise; }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ @autoreleasepool {
    if (!authorized()) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(3311, @"ImageFlow may not read the Photos library.")); }); return; }
    PHPhotoLibrary *library = PHPhotoLibrary.sharedPhotoLibrary;
    NSError *unavailable = library.unavailabilityReason;
    if (unavailable) { settle(pending, true, ^(napi_env e) { return errorValue(e, unavailable); }); return; }
    PHFetchOptions *options = [PHFetchOptions new];
    options.includeHiddenAssets = YES;
    if ([options respondsToSelector:NSSelectorFromString(@"setPrefetchAssetExtendedMetadata:")]) [options setValue:@YES forKey:@"prefetchAssetExtendedMetadata"];
    NSMutableDictionary<NSString *, PHAsset *> *byId = [NSMutableDictionary new];
    for (PHAsset *asset in [PHAsset fetchAssetsWithLocalIdentifiers:locals options:options]) byId[asset.localIdentifier] = asset;
    NSMutableArray *rows = [NSMutableArray new];
    NSMutableArray<PHAsset *> *unread = [NSMutableArray new];
    for (NSString *local in locals) {
      PHAsset *asset = byId[local];
      if (!asset || asset.mediaType != PHAssetMediaTypeImage || !asset.pixelWidth || !asset.pixelHeight) { [rows addObject:NSNull.null]; continue; }
      NSMutableDictionary *row = [@{@"width": @(asset.pixelWidth), @"height": @(asset.pixelHeight)} mutableCopy];
      if (asset.creationDate) {
        row[@"created"] = @(round(asset.creationDate.timeIntervalSince1970 * 1000));
        id own = knownOffset(asset.localIdentifier);
        if ([own isKindOfClass:NSNumber.class]) row[@"offsetMinutes"] = own;
        else {
          row[@"offsetMinutes"] = @(macOffset(asset.creationDate));
          row[@"offsetGuessed"] = @YES;
          if (!own) [unread addObject:asset];
        }
      }
      if (asset.location && CLLocationCoordinate2DIsValid(asset.location.coordinate)) {
        row[@"latitude"] = @(asset.location.coordinate.latitude); row[@"longitude"] = @(asset.location.coordinate.longitude);
      }
      // The last edit or revert (macOS 15).
      if ([asset respondsToSelector:NSSelectorFromString(@"adjustmentTimestamp")]) {
        id adjusted = property(asset, @"adjustmentTimestamp");
        row[@"adjusted"] = [adjusted isKindOfClass:NSDate.class] ? @(round([adjusted timeIntervalSince1970] * 1000)) : NSNull.null;
      }
      // Whether it renders from RAW (macOS 27: PHOriginalResourceChoiceRaw is 1).
      id choice = property(asset, @"originalResourceChoice");
      row[@"base"] = [choice isKindOfClass:NSNumber.class] && [choice integerValue] == 1 ? @"raw" : @"compressed";
      // Caption, keywords and file name (macOS 27).
      id metadata = property(asset, @"extendedMetadata");
      id caption = property(metadata, @"caption"), keywords = property(metadata, @"keywords"), filename = property(metadata, @"originalFilename");
      if ([caption isKindOfClass:NSString.class] && [caption length]) row[@"caption"] = caption;
      if ([keywords isKindOfClass:NSArray.class] && [keywords count]) row[@"keywords"] = keywords;
      if ([filename isKindOfClass:NSString.class] && [filename length]) row[@"filename"] = filename;
      // Its type (macOS 26).
      id type = property(property(asset, @"contentType"), @"identifier");
      if ([type isKindOfClass:NSString.class]) row[@"type"] = type;
      // Whether it is a favourite, only when it is one. `isFavorite` is older than any macOS the addon runs on.
      if (asset.isFavorite) row[@"favorite"] = @YES;
      [rows addObject:row];
    }
    readOffsets(unread);
    settle(pending, false, ^(napi_env e) {
      napi_value array;
      napi_create_array_with_length(e, rows.count, &array);
      for (NSUInteger i = 0; i < rows.count; i++) {
        id row = rows[i];
        if (row == NSNull.null) { napi_set_element(e, array, (uint32_t)i, nullValue(e)); continue; }
        napi_value value = object(e);
        for (NSString *key in row) {
          id field = row[key];
          napi_value converted = [field isKindOfClass:NSString.class] ? str(e, field) : [field isKindOfClass:NSArray.class] ? stringsValue(e, field)
            : field == NSNull.null ? nullValue(e) : field == (__bridge id)kCFBooleanTrue ? boolean(e, true) : num(e, [field doubleValue]);
          setProp(e, value, key.UTF8String, converted);
        }
        napi_set_element(e, array, (uint32_t)i, value);
      }
      return array;
    });
  } });
  return promise;
}

// ---------- Pictures

/**
 * Image requests from the call of `image` until their result, by the caller's id: an entry exists exactly while a
 * request may still be cancelled. `handle` is PhotoKit's once its request started; `cancelled` asks a request that has
 * not started yet to stop when it would. PhotoKit may answer a request before it returns its handle (a picture it has
 * at hand), and PhotoKit is never called under the lock: a cancel can answer at once, on the same thread.
 */
struct ImageRequest { PHImageRequestID handle = PHInvalidImageRequestID; bool cancelled = false; };
static std::unordered_map<double, ImageRequest> requests;
static std::mutex requestsLock;
static void forgetRequest(double id_) { std::lock_guard<std::mutex> guard(requestsLock); requests.erase(id_); }

/** An 8-bit sRGB JPEG of `image` at `path`. */
static NSError *writeJpeg(CGImageRef image, NSString *path, double quality) {
  size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
  CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(nullptr, width, height, 8, 0, srgb, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
  NSError *error = nil;
  if (!context) error = failure(2, @"Not enough memory to convert the picture.");
  else {
    CGContextSetFillColorWithColor(context, CGColorGetConstantColor(kCGColorWhite));
    CGContextFillRect(context, CGRectMake(0, 0, width, height));
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGImageRef converted = CGBitmapContextCreateImage(context);
    CGImageDestinationRef destination = CGImageDestinationCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], (__bridge CFStringRef)UTTypeJPEG.identifier, 1, nullptr);
    if (!converted || !destination) error = failure(2, @"The picture could not be written.");
    else {
      CGImageDestinationAddImage(destination, converted, (__bridge CFDictionaryRef)@{(id)kCGImageDestinationLossyCompressionQuality: @(quality)});
      if (!CGImageDestinationFinalize(destination)) error = failure(2, @"The picture could not be written.");
    }
    if (destination) CFRelease(destination);
    if (converted) CGImageRelease(converted);
    CGContextRelease(context);
  }
  CGColorSpaceRelease(srgb);
  return error;
}

/**
 * image(local, { file, full, id }, progress?): writes the photo as it is now (with its edits) to `file`, 1400 px on
 * its long edge or at full size, downloading it from iCloud where it is not on this Mac. Resolves to { width, height }.
 * `cancel(id)` stops it; it then rejects with ImageFlowPhotos:3072.
 */
static napi_value Image(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  NSString *local = argc > 0 ? stringArg(env, argv[0]) : nil;
  NSString *file = nil; bool full = false; double requestId = 0;
  if (argc > 1) {
    napi_value value; bool flag = false;
    if (napi_get_named_property(env, argv[1], "file", &value) == napi_ok) file = stringArg(env, value);
    if (napi_get_named_property(env, argv[1], "full", &value) == napi_ok && napi_get_value_bool(env, value, &flag) == napi_ok) full = flag;
    if (napi_get_named_property(env, argv[1], "id", &value) == napi_ok) napi_get_value_double(env, value, &requestId);
  }
  napi_value promise;
  PendingRef pending = newPending(env, &promise, argc > 2 ? argv[2] : nullptr);
  if (!local || !file) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(1, @"Expected an identifier and a file.")); }); return promise; }
  double ours = requestId;
  { std::lock_guard<std::mutex> guard(requestsLock); requests[ours] = ImageRequest(); }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ @autoreleasepool {
    if (!authorized()) { forgetRequest(ours); settle(pending, true, ^(napi_env e) { return errorValue(e, failure(3311, @"ImageFlow may not read the Photos library.")); }); return; }
    // A library on a disk that went away answers no photo at all: that is no photo gone from it.
    NSError *unavailable = PHPhotoLibrary.sharedPhotoLibrary.unavailabilityReason;
    if (unavailable) { forgetRequest(ours); settle(pending, true, ^(napi_env e) { return errorValue(e, unavailable); }); return; }
    PHFetchOptions *fetch = [PHFetchOptions new];
    fetch.includeHiddenAssets = YES;
    PHAsset *asset = [PHAsset fetchAssetsWithLocalIdentifiers:@[local] options:fetch].firstObject;
    if (!asset) { forgetRequest(ours); settle(pending, true, ^(napi_env e) { return errorValue(e, [NSError errorWithDomain:PHPhotosErrorDomain code:3201 userInfo:@{NSLocalizedDescriptionKey: @"The photo is no longer in the Photos library."}]); }); return; }
    PHImageRequestOptions *options = [PHImageRequestOptions new];
    options.version = PHImageRequestOptionsVersionCurrent;
    options.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat;
    options.resizeMode = PHImageRequestOptionsResizeModeExact;
    options.networkAccessAllowed = YES;
    options.progressHandler = ^(double progress, NSError *, BOOL *, NSDictionary *) { reportProgress(pending, progress); };
    CGSize target = full ? PHImageManagerMaximumSize : CGSizeMake(1400, 1400);
    {
      std::lock_guard<std::mutex> guard(requestsLock);
      auto entry = requests.find(ours);
      if (entry == requests.end() || entry->second.cancelled) {
        requests.erase(ours);
        settle(pending, true, ^(napi_env e) { return errorValue(e, failure(3072, @"Cancelled.")); });
        return;
      }
    }
    PHImageRequestID handle = [PHImageManager.defaultManager requestImageForAsset:asset targetSize:target
        contentMode:full ? PHImageContentModeDefault : PHImageContentModeAspectFit options:options resultHandler:^(NSImage *image, NSDictionary *result) {
      if ([result[PHImageResultIsDegradedKey] boolValue]) return;
      forgetRequest(ours);
      if ([result[PHImageCancelledKey] boolValue]) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(3072, @"Cancelled.")); }); return; }
      NSError *error = result[PHImageErrorKey];
      CGImageRef cg = image ? [image CGImageForProposedRect:nullptr context:nil hints:nil] : nullptr;
      if (!cg) {
        NSError *reported = error ?: failure(2, @"Photos returned no picture.");
        settle(pending, true, ^(napi_env e) { return errorValue(e, reported); });
        return;
      }
      CGImageRetain(cg);
      // The handler runs on the main thread: the conversion, about 150 ms for a full-size photo, does not.
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ @autoreleasepool {
        NSError *written = writeJpeg(cg, file, full ? 0.95 : 0.86);
        size_t width = CGImageGetWidth(cg), height = CGImageGetHeight(cg);
        CGImageRelease(cg);
        if (written) { settle(pending, true, ^(napi_env e) { return errorValue(e, written); }); return; }
        settle(pending, false, ^(napi_env e) { napi_value value = object(e); setProp(e, value, "width", num(e, width)); setProp(e, value, "height", num(e, height)); return value; });
      } });
    }];
    bool cancel = false;
    {
      std::lock_guard<std::mutex> guard(requestsLock);
      auto entry = requests.find(ours);
      // Answered already, before PhotoKit returned: nothing is left to cancel.
      if (entry != requests.end()) { entry->second.handle = handle; cancel = entry->second.cancelled; }
    }
    if (cancel) [PHImageManager.defaultManager cancelImageRequest:handle];
  } });
  return promise;
}

/** cancel(id): stops an image request; one that has not started yet is stopped when it would. */
static napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; double id_ = 0;
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (argc) napi_get_value_double(env, argv[0], &id_);
  PHImageRequestID handle = PHInvalidImageRequestID;
  {
    std::lock_guard<std::mutex> guard(requestsLock);
    auto entry = requests.find(id_);
    // A request that finished is gone: there is nothing to cancel, and nothing is remembered.
    if (entry == requests.end()) return undefinedValue(env);
    entry->second.cancelled = true;
    handle = entry->second.handle;
  }
  if (handle != PHInvalidImageRequestID) [PHImageManager.defaultManager cancelImageRequest:handle];
  return undefinedValue(env);
}

// ---------- Changes

// The function changes are reported to. PhotoKit's observer can fire while Node shuts down: Node's finalizer clears it
// under the lock, and nothing is queued on it after that.
static napi_threadsafe_function changes = nullptr;
static std::mutex changesLock;
static std::mutex trackedLock;
static PHFetchResult<PHAsset *> *tracked;
// `track` calls run one after another, in the order made: a later set of photos is never replaced by an earlier one.
static dispatch_queue_t trackQueue;

static void sendChanges(NSArray<NSString *> *ids) {
  if (!ids.count) return;
  std::lock_guard<std::mutex> guard(changesLock);
  if (!changes) return;
  NSArray *kept = [ids copy];
  if (napi_call_threadsafe_function(changes, (__bridge_retained void *)kept, napi_tsfn_nonblocking) != napi_ok) CFBridgingRelease((__bridge CFTypeRef)kept);
}
static void finishChanges(napi_env, void *, void *) {
  std::lock_guard<std::mutex> guard(changesLock);
  changes = nullptr;
}

static void callChanges(napi_env env, napi_value callback, void *, void *data) {
  NSArray *ids = (__bridge_transfer NSArray *)data;
  if (!env || !callback) return;
  napi_value global;
  napi_get_global(env, &global);
  napi_value argument = stringsValue(env, ids);
  napi_call_function(env, global, callback, 1, &argument, nullptr);
}

@interface ImageFlowPhotosObserver : NSObject <PHPhotoLibraryChangeObserver, PHPhotoLibraryAvailabilityObserver>
@end
@implementation ImageFlowPhotosObserver
- (void)photoLibraryDidChange:(PHChange *)change {
  NSMutableArray<NSString *> *ids = [NSMutableArray new];
  {
    std::lock_guard<std::mutex> guard(trackedLock);
    if (!tracked) return;
    PHFetchResultChangeDetails *details = [change changeDetailsForFetchResult:tracked];
    if (!details) return;
    for (PHAsset *asset in details.changedObjects) [ids addObject:asset.localIdentifier];
    // A photo back from Recently Deleted, say.
    for (PHAsset *asset in details.insertedObjects) [ids addObject:asset.localIdentifier];
    for (PHAsset *asset in details.removedObjects) [ids addObject:asset.localIdentifier];
    tracked = details.fetchResultAfterChanges;
  }
  sendChanges(ids);
}
- (void)photoLibraryDidBecomeUnavailable:(PHPhotoLibrary *)library { sendChanges(@[@"*"]); }
@end
static ImageFlowPhotosObserver *observer;

// ---------- Capture offsets

/*
 * The UTC offset each photo was taken at, as its original records it (EXIF OffsetTimeOriginal, else
 * OffsetTimeDigitized; OffsetTime is the modification time's; PhotoKit has no public time zone, and a zone set in
 * Photos' Adjust Date & Time is not read), by local identifier: minutes, or NSNull for an original that records none. An
 * original never changes, so what was read holds for the process.
 *
 * They are read in the background, one photo after another, and only where the original is on this Mac: nothing is
 * downloaded from iCloud for them. Reading stops once ImageIO finds an offset, mostly in the first chunk of the file; that
 * the original records none is concluded from the whole file only. A photo whose offset turns out to differ from the
 * guess `facts` gave is reported as changed (`onChanges`), so a book that shows it observes it again and records the
 * right capture time: a few seconds after the first of them, so that many read at once reload a book once. A photo whose original is not on this Mac
 * is tried again after a while, as it may have been downloaded meanwhile.
 */
static NSMutableDictionary<NSString *, id> *offsets = [NSMutableDictionary new];
static NSMutableDictionary<NSString *, NSDate *> *offsetsTried = [NSMutableDictionary new];
static NSMutableSet<NSString *> *offsetsQueued = [NSMutableSet new];
static std::mutex offsetsLock;
static const NSTimeInterval offsetRetry = 600;
// Enough for the metadata of any original: one read this far without finding it is taken to record no offset.
static const NSUInteger offsetReadLimit = 64 * 1024 * 1024;
// How long one original may take to read before it is left for later, so that one stalled file holds up little.
static const int64_t offsetReadTimeout = 10 * NSEC_PER_SEC;
// Corrections are reported this long after the first of them, together.
static const int64_t offsetReportDelay = 3 * NSEC_PER_SEC;

/** The original's own offset (NSNumber), NSNull for one known to record none, or nil when it is not known yet. */
static id knownOffset(NSString *local) {
  std::lock_guard<std::mutex> guard(offsetsLock);
  return offsets[local];
}

/** Minutes of an EXIF offset such as `+06:00`, or nil for anything else. */
static NSNumber *exifOffsetMinutes(id text) {
  if (![text isKindOfClass:NSString.class]) return nil;
  NSString *value = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (value.length != 6 || [value characterAtIndex:3] != ':') return nil;
  unichar sign = [value characterAtIndex:0];
  if (sign != '+' && sign != '-') return nil;
  NSCharacterSet *digits = NSCharacterSet.decimalDigitCharacterSet;
  for (NSUInteger at : {1, 2, 4, 5}) if (![digits characterIsMember:[value characterAtIndex:at]]) return nil;
  NSInteger hours = [[value substringWithRange:NSMakeRange(1, 2)] integerValue], minutes = [[value substringWithRange:NSMakeRange(4, 2)] integerValue];
  NSInteger total = (sign == '-' ? -1 : 1) * (hours * 60 + minutes);
  if (minutes > 59 || total < -12 * 60 || total > 14 * 60) return nil;
  return @(total);
}

/**
 * What the metadata in `data` says of the offset: NSNumber minutes, or NSNull when it records none. Of the start of a
 * file only (`whole` false), only an offset found counts, and nil means it is not known yet: the EXIF block may hold
 * the capture time in the part read and its offset in the part not read yet, and ImageIO reports an EXIF dictionary of
 * its own making for files without one.
 */
static id offsetInData(NSData *data, bool whole) {
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, (__bridge CFDictionaryRef)@{(id)kCGImageSourceShouldCache: @NO});
  if (!source) return nil;
  NSDictionary *properties = CGImageSourceGetCount(source) ? CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, nullptr)) : nil;
  CFRelease(source);
  NSDictionary *exif = properties[(id)kCGImagePropertyExifDictionary];
  if (![exif isKindOfClass:NSDictionary.class]) exif = nil;
  NSNumber *own = exifOffsetMinutes(exif[(id)kCGImagePropertyExifOffsetTimeOriginal]) ?: exifOffsetMinutes(exif[(id)kCGImagePropertyExifOffsetTimeDigitized]);
  if (own) return own;
  return whole ? NSNull.null : nil;
}

/** The offset the original of `asset` records (see `offsetInData`), or nil where it is not on this Mac or unreadable. */
static id readOffset(PHAsset *asset) {
  PHAssetResource *original = nil;
  for (PHAssetResource *resource in [PHAssetResource assetResourcesForAsset:asset]) {
    if (resource.type == PHAssetResourceTypePhoto) { original = resource; break; }
    if (!original && resource.type == PHAssetResourceTypeAlternatePhoto) original = resource;
  }
  if (!original) return nil;
  PHAssetResourceRequestOptions *options = [PHAssetResourceRequestOptions new];
  options.networkAccessAllowed = NO;
  NSMutableData *data = [NSMutableData new];
  __block id found = nil;
  __block bool done = false;
  // Parsed again each time the data doubled: an original without EXIF is read to its end, and parsed a few times only.
  __block NSUInteger parseAt = 0;
  // The request is named only once `requestDataForAssetResource` returns, and its handler may be called before: a stop
  // asked for then is made as soon as it is named.
  __block PHAssetResourceDataRequestID request = PHInvalidAssetResourceDataRequestID;
  __block bool cancelWanted = false;
  NSObject *lock = [NSObject new];
  dispatch_semaphore_t finished = dispatch_semaphore_create(0);
  PHAssetResourceManager *manager = PHAssetResourceManager.defaultManager;
  // Stops the request: now if it is named, else once it is.
  void (^stop)(void) = ^{
    PHAssetResourceDataRequestID named = PHInvalidAssetResourceDataRequestID;
    @synchronized (lock) {
      if (request == PHInvalidAssetResourceDataRequestID) cancelWanted = true;
      else named = request;
    }
    if (named != PHInvalidAssetResourceDataRequestID) [manager cancelDataRequest:named];
  };
  PHAssetResourceDataRequestID named = [manager requestDataForAssetResource:original options:options dataReceivedHandler:^(NSData *chunk) {
    bool enough = false;
    @synchronized (lock) {
      if (done) return;
      [data appendData:chunk];
      if (data.length >= parseAt) { found = offsetInData(data, false); parseAt = data.length * 2; }
      // One this large records no offset where ImageIO could find it.
      if (!found && data.length > offsetReadLimit) found = NSNull.null;
      enough = found;
      if (enough) done = true;
    }
    if (enough) { stop(); dispatch_semaphore_signal(finished); }
  } completionHandler:^(NSError *error) {
    @synchronized (lock) {
      if (done) return;
      done = true;
      // The whole file came without an offset: it records none. A failure (not on this Mac) tells nothing.
      if (!error) found = offsetInData(data, true);
    }
    dispatch_semaphore_signal(finished);
  }];
  bool cancel = false;
  @synchronized (lock) { request = named; cancel = cancelWanted; }
  if (cancel) [manager cancelDataRequest:named];
  if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, offsetReadTimeout))) {
    @synchronized (lock) { done = true; }
    [manager cancelDataRequest:named];
    return nil;
  }
  @synchronized (lock) { return found; }
}

// Photos whose offset was read and differs from the guess, not reported yet (under offsetsLock).
static NSMutableArray<NSString *> *offsetsChanged = [NSMutableArray new];

/** Reports the corrections read so far. */
static void reportOffsets() {
  NSArray<NSString *> *ids;
  {
    std::lock_guard<std::mutex> guard(offsetsLock);
    ids = [offsetsChanged copy];
    [offsetsChanged removeAllObjects];
  }
  sendChanges(ids);
}

/** Reads the offsets of `assets` in the background (see above); those read or queued already are skipped. */
static void readOffsets(NSArray<PHAsset *> *assets) {
  static dispatch_queue_t queue = dispatch_queue_create("imageflow.photos.offsets", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0));
  NSMutableArray<PHAsset *> *todo = [NSMutableArray new];
  {
    std::lock_guard<std::mutex> guard(offsetsLock);
    for (PHAsset *asset in assets) {
      NSString *local = asset.localIdentifier;
      NSDate *tried = offsetsTried[local];
      if (offsets[local] || [offsetsQueued containsObject:local] || (tried && -tried.timeIntervalSinceNow < offsetRetry)) continue;
      [offsetsQueued addObject:local];
      [todo addObject:asset];
    }
  }
  if (!todo.count) return;
  dispatch_async(queue, ^{
    for (PHAsset *asset in todo) { @autoreleasepool {
      id own = readOffset(asset);
      std::lock_guard<std::mutex> guard(offsetsLock);
      [offsetsQueued removeObject:asset.localIdentifier];
      if (!own) { offsetsTried[asset.localIdentifier] = [NSDate date]; continue; }
      offsets[asset.localIdentifier] = own;
      [offsetsTried removeObjectForKey:asset.localIdentifier];
      if (![own isKindOfClass:NSNumber.class] || !asset.creationDate || [own integerValue] == macOffset(asset.creationDate)) continue;
      // The first correction since the last report schedules the next one, off this queue: a slow original after it
      // does not hold it up.
      if (!offsetsChanged.count) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, offsetReportDelay), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ reportOffsets(); });
      [offsetsChanged addObject:asset.localIdentifier];
    } }
  });
}

// ---------- Change reports

/** onChanges(callback): calls `callback(ids)` with local identifiers of tracked photos that changed; `['*']` for all. */
static napi_value OnChanges(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  std::lock_guard<std::mutex> guard(changesLock);
  if (changes) return undefinedValue(env);
  napi_value name;
  napi_create_string_utf8(env, "photos-changes", NAPI_AUTO_LENGTH, &name);
  CHECK(napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, finishChanges, nullptr, callChanges, &changes));
  // The process may quit while it is registered.
  napi_unref_threadsafe_function(env, changes);
  return undefinedValue(env);
}

/** track(locals): the photos whose changes are reported, replacing the ones before. Registers the observer once. */
static napi_value Track(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  NSArray<NSString *> *locals = argc ? stringsArg(env, argv[0]) : nil;
  if (!locals || !authorized()) return undefinedValue(env);
  dispatch_async(trackQueue, ^{ @autoreleasepool {
    PHFetchOptions *options = [PHFetchOptions new];
    options.includeHiddenAssets = YES;
    PHFetchResult *result = locals.count ? [PHAsset fetchAssetsWithLocalIdentifiers:locals options:options] : nil;
    { std::lock_guard<std::mutex> guard(trackedLock); tracked = result; }
    static dispatch_once_t once;
    dispatch_once(&once, ^{
      observer = [ImageFlowPhotosObserver new];
      [PHPhotoLibrary.sharedPhotoLibrary registerChangeObserver:observer];
      [PHPhotoLibrary.sharedPhotoLibrary registerAvailabilityObserver:observer];
    });
  } });
  return undefinedValue(env);
}


// ---------- Picker

/**
 * The system photo picker as a sheet on a window. It runs out of process: picking needs no access, but the photos
 * picked are named by their local identifiers only because the picker is opened on the shared library.
 */
@interface ImageFlowPhotosPicker : NSObject <PHPickerViewControllerDelegate>
@property (nonatomic) PendingRef pending;
@property (nonatomic, strong) NSWindow *sheet;
@property (nonatomic, strong) NSWindow *parent;
@end
static ImageFlowPhotosPicker *activePicker;
@implementation ImageFlowPhotosPicker
- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
  NSMutableArray *ids = [NSMutableArray new];
  for (PHPickerResult *result in results) if (result.assetIdentifier) [ids addObject:result.assetIdentifier];
  // Settled first: ending the sheet settles it as cancelled, which then changes nothing.
  settle(self.pending, false, ^(napi_env e) { return stringsValue(e, ids); });
  [self.parent endSheet:self.sheet];
}
@end

/** cancelPick(): closes the picker, which then answers []; for its window closing under it. */
static napi_value CancelPick(napi_env env, napi_callback_info) {
  ImageFlowPhotosPicker *picker = activePicker;
  if (!picker) return undefinedValue(env);
  activePicker = nil;
  settle(picker.pending, false, ^(napi_env e) { return stringsValue(e, @[]); });
  if (picker.sheet.sheetParent) [picker.sheet.sheetParent endSheet:picker.sheet];
  return undefinedValue(env);
}

/** pick(nativeWindowHandle): shows the picker on that window; resolves to the local identifiers picked, [] on Cancel. */
static napi_value Pick(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; void *bytes = nullptr; size_t length = 0;
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  napi_value promise;
  PendingRef pending = newPending(env, &promise);
  if (argc < 1 || napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok || length != sizeof(void *) || ![NSThread isMainThread]) {
    settle(pending, true, ^(napi_env e) { return errorValue(e, failure(1, @"Expected a window.")); });
    return promise;
  }
  if (activePicker) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(4, @"The photo picker is open already.")); }); return promise; }
  void *pointer = nullptr;
  std::memcpy(&pointer, bytes, sizeof(pointer));
  NSWindow *parent = ((__bridge NSView *)pointer).window;
  if (!parent || !supportedSystem()) { settle(pending, true, ^(napi_env e) { return errorValue(e, failure(1, @"The photo picker cannot be shown.")); }); return promise; }
  PHPickerConfiguration *configuration = [[PHPickerConfiguration alloc] initWithPhotoLibrary:PHPhotoLibrary.sharedPhotoLibrary];
  configuration.selectionLimit = 0;
  configuration.selection = PHPickerConfigurationSelectionOrdered;
  configuration.filter = PHPickerFilter.imagesFilter;
  configuration.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;
  PHPickerViewController *controller = [[PHPickerViewController alloc] initWithConfiguration:configuration];
  ImageFlowPhotosPicker *delegate = [ImageFlowPhotosPicker new];
  delegate.pending = pending;
  delegate.parent = parent;
  controller.delegate = delegate;
  NSRect frame = parent.frame;
  NSWindow *sheet = [NSWindow windowWithContentViewController:controller];
  [sheet setContentSize:NSMakeSize(MIN(980, MAX(640, frame.size.width - 120)), MIN(720, MAX(480, frame.size.height - 120)))];
  delegate.sheet = sheet;
  activePicker = delegate;
  // However the sheet ends, picked, cancelled, or with its window closed under it, the call settles and another picker
  // may open.
  [parent beginSheet:sheet completionHandler:^(NSModalResponse) {
    settle(delegate.pending, false, ^(napi_env e) { return stringsValue(e, @[]); });
    if (activePicker == delegate) activePicker = nil;
  }];
  return promise;
}

NAPI_MODULE_INIT() {
  static dispatch_once_t queues;
  dispatch_once(&queues, ^{ trackQueue = dispatch_queue_create("ch.wirhabenzeit.imageflow.photos.track", DISPATCH_QUEUE_SERIAL); });
  const struct { const char *name; napi_callback fn; } functions[] = {
    {"status", Status}, {"requestAccess", RequestAccess}, {"dragged", Dragged}, {"cloudIdentifiers", CloudIdentifiers},
    {"localIdentifiers", LocalIdentifiers}, {"facts", Facts}, {"image", Image}, {"cancel", Cancel}, {"onChanges", OnChanges}, {"track", Track}, {"pick", Pick}, {"cancelPick", CancelPick},
  };
  for (const auto &entry : functions) {
    napi_value fn;
    napi_create_function(env, entry.name, NAPI_AUTO_LENGTH, entry.fn, nullptr, &fn);
    napi_set_named_property(env, exports, entry.name, fn);
  }
  return exports;
}
