// Spike (#327): reads the Photos library through PhotoKit from Electron's main process. Read only: nothing here uses a
// change request. Results are counts, durations and sizes; no titles, places, names or pictures leave the process.
#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <Photos/Photos.h>
#import <PhotosUI/PhotosUI.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <CommonCrypto/CommonDigest.h>
#include <node_api.h>
#include <string>

typedef void (^Reply)(NSDictionary *value);
static napi_threadsafe_function tsfn;

static void callJs(napi_env env, napi_value callback, void *, void *data) {
  NSString *json = CFBridgingRelease(data);
  napi_value undefined, argument; napi_get_undefined(env, &undefined);
  napi_create_string_utf8(env, json.UTF8String, NAPI_AUTO_LENGTH, &argument);
  napi_call_function(env, undefined, callback, 1, &argument, nullptr);
}
static void emit(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{\"error\":\"json\"}";
  napi_call_threadsafe_function(tsfn, (void *)CFBridgingRetain(json), napi_tsfn_nonblocking);
}
static NSTimeInterval now() { return NSProcessInfo.processInfo.systemUptime; }
static NSString *statusName(PHAuthorizationStatus s) { return @[@"notDetermined", @"restricted", @"denied", @"authorized", @"limited"][MIN((NSInteger)s, 4)]; }
static NSNumber *ms(NSTimeInterval start) { return @(round((now() - start) * 10000) / 10); }
static void count(NSMutableDictionary *into, NSString *key) { into[key] = @([into[key] integerValue] + 1); }

static NSArray<PHAsset *> *images(NSUInteger limit) {
  PHFetchOptions *options = [PHFetchOptions new];
  options.sortDescriptors = @[[NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO]];
  if (limit) options.fetchLimit = limit;
  PHFetchResult *result = [PHAsset fetchAssetsWithMediaType:PHAssetMediaTypeImage options:options];
  return [result objectsAtIndexes:[NSIndexSet indexSetWithIndexesInRange:NSMakeRange(0, result.count)]];
}

static NSDictionary *census() {
  NSTimeInterval start = now();
  NSArray<PHAsset *> *all = images(0);
  NSNumber *fetched = ms(start);
  NSMutableDictionary *types = [NSMutableDictionary new], *states = [NSMutableDictionary new], *subtypes = [NSMutableDictionary new], *sources = [NSMutableDictionary new];
  NSInteger edited = 0, editBeforeModified = 0, editAfterModified = 0, modifiedOnly = 0, neverModified = 0, noModification = 0, withLocation = 0, zero = 0, timestampWithoutAdjustments = 0;
  start = now();
  for (PHAsset *a in all) {
    if (@available(macOS 26, *)) count(types, a.contentType.identifier ?: @"none");
    if (@available(macOS 15, *)) {
      count(states, [NSString stringWithFormat:@"%ld", (long)a.adjustmentsState]);
      if (a.adjustmentTimestamp) {
        edited++;
        if (!a.hasAdjustments) timestampWithoutAdjustments++;
        NSTimeInterval d = [a.modificationDate timeIntervalSinceDate:a.adjustmentTimestamp];
        if (d < -1) editAfterModified++; else if (d > 1) editBeforeModified++;
      } else if (a.modificationDate && [a.modificationDate timeIntervalSinceDate:a.creationDate] > 86400) modifiedOnly++;
    }
    if (!a.modificationDate) noModification++;
    if (a.mediaSubtypes & PHAssetMediaSubtypePhotoLive) count(subtypes, @"live");
    if (a.mediaSubtypes & PHAssetMediaSubtypePhotoHDR) count(subtypes, @"hdr");
    if (a.mediaSubtypes & PHAssetMediaSubtypePhotoAnimation) count(subtypes, @"animation");
    if (a.representsBurst) count(subtypes, @"burst");
    count(sources, [NSString stringWithFormat:@"%lu", (unsigned long)a.sourceType]);
    if (a.location) withLocation++;
    if (!a.pixelWidth || !a.pixelHeight) zero++;
  }
  return @{@"images": @(all.count), @"fetchMs": fetched, @"readMs": ms(start), @"contentTypes": types, @"adjustmentStates": states, @"subtypes": subtypes, @"sourceTypes": sources,
    @"everEdited": @(edited), @"adjustmentOlderThanModification": @(editBeforeModified), @"adjustmentNewerThanModification": @(editAfterModified),
    @"revertedEdits": @(timestampWithoutAdjustments), @"neverEditedButModifiedADayAfterCapture": @(modifiedOnly), @"withoutModificationDate": @(noModification), @"withLocation": @(withLocation), @"zeroSize": @(zero)};
}

static NSDictionary *metadata(NSUInteger limit) {
  NSMutableDictionary *out = [NSMutableDictionary new];
  if (@available(macOS 27, *)) {
    for (NSNumber *prefetch in @[@NO, @YES]) {
      PHFetchOptions *options = [PHFetchOptions new]; options.fetchLimit = limit; options.prefetchAssetExtendedMetadata = prefetch.boolValue;
      options.sortDescriptors = @[[NSSortDescriptor sortDescriptorWithKey:@"creationDate" ascending:NO]];
      NSTimeInterval start = now(); NSInteger captions = 0, names = 0, keywords = 0;
      for (PHAsset *a in [PHAsset fetchAssetsWithMediaType:PHAssetMediaTypeImage options:options]) {
        PHAssetExtendedMetadata *m = a.extendedMetadata;
        if (m.caption.length) captions++; if (m.originalFilename.length) names++; if (m.keywords.count) keywords++;
      }
      out[prefetch.boolValue ? @"prefetched" : @"onDemand"] = @{@"ms": ms(start), @"captions": @(captions), @"filenames": @(names), @"keywords": @(keywords)};
    }
  }
  out[@"limit"] = @(limit);
  return out;
}

static NSDictionary *identity(NSUInteger limit) {
  NSArray<PHAsset *> *assets = images(limit);
  NSArray<NSString *> *locals = [assets valueForKey:@"localIdentifier"];
  NSTimeInterval start = now();
  NSDictionary *clouds = [PHPhotoLibrary.sharedPhotoLibrary cloudIdentifierMappingsForLocalIdentifiers:locals];
  NSNumber *toCloud = ms(start);
  NSMutableArray *ids = [NSMutableArray new]; NSMutableDictionary *errors = [NSMutableDictionary new], *lengths = [NSMutableDictionary new], *shapes = [NSMutableDictionary new];
  NSMutableDictionary *localOf = [NSMutableDictionary new];
  for (NSString *local in locals) {
    PHCloudIdentifierMapping *m = clouds[local];
    if (!m.cloudIdentifier) { count(errors, [NSString stringWithFormat:@"%ld", (long)m.error.code]); continue; }
    NSString *archived = nil; if (@available(macOS 15.2, *)) archived = m.cloudIdentifier.archivalStringValue;
    PHCloudIdentifier *restored = nil; if (@available(macOS 15.2, *)) restored = [[PHCloudIdentifier alloc] initWithArchivalStringValue:archived];
    count(lengths, [NSString stringWithFormat:@"%lu", (unsigned long)archived.length]);
    NSRegularExpression *hex = [NSRegularExpression regularExpressionWithPattern:@"[0-9A-Za-z+/=_-]" options:0 error:nil];
    count(shapes, [hex stringByReplacingMatchesInString:archived options:0 range:NSMakeRange(0, archived.length) withTemplate:@""]);
    if (!restored) { count(errors, @"unparsable"); continue; }
    [ids addObject:restored]; localOf[restored] = local;
  }
  NSMutableDictionary *localShapes = [NSMutableDictionary new];
  for (NSString *local in locals) count(localShapes, [NSString stringWithFormat:@"%lu%@", (unsigned long)local.length, [local hasSuffix:@"/L0/001"] ? @" …/L0/001" : @" other"]);
  start = now();
  NSDictionary *back = [PHPhotoLibrary.sharedPhotoLibrary localIdentifierMappingsForCloudIdentifiers:ids];
  NSNumber *toLocal = ms(start);
  NSInteger same = 0, different = 0, failed = 0;
  for (PHCloudIdentifier *i in ids) { PHLocalIdentifierMapping *m = back[i]; if (!m.localIdentifier) failed++; else if ([m.localIdentifier isEqual:localOf[i]]) same++; else different++; }
  NSMutableDictionary *out = [@{@"assets": @(assets.count), @"toCloudMs": toCloud, @"toLocalMs": toLocal, @"same": @(same), @"different": @(different), @"failed": @(failed),
    @"errors": errors, @"archivalLengths": lengths, @"archivalPunctuation": shapes, @"localIdentifierShapes": localShapes} mutableCopy];
  if (@available(macOS 27, *)) {
    start = now(); NSInteger synced = 0;
    NSDictionary *only = [PHPhotoLibrary.sharedPhotoLibrary localIdentifierMappingsForSyncedCloudIdentifiers:ids];
    for (PHCloudIdentifier *i in ids) if ([only[i] localIdentifier]) synced++;
    out[@"synced"] = @(synced); out[@"syncedMs"] = ms(start);
  }
  return out;
}

static NSString *digest(NSData *data) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  return [NSString stringWithFormat:@"%02x%02x%02x%02x%02x%02x", hash[0], hash[1], hash[2], hash[3], hash[4], hash[5]];
}
static NSData *jpeg(CGImageRef image, double quality) {
  CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef context = CGBitmapContextCreate(nullptr, CGImageGetWidth(image), CGImageGetHeight(image), 8, 0, srgb, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
  CGContextDrawImage(context, CGRectMake(0, 0, CGImageGetWidth(image), CGImageGetHeight(image)), image);
  CGImageRef converted = CGBitmapContextCreateImage(context);
  NSMutableData *data = [NSMutableData new];
  CGImageDestinationRef d = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, (__bridge CFStringRef)UTTypeJPEG.identifier, 1, nullptr);
  CGImageDestinationAddImage(d, converted, (__bridge CFDictionaryRef)@{(id)kCGImageDestinationLossyCompressionQuality: @(quality)});
  CGImageDestinationFinalize(d); CFRelease(d); CGImageRelease(converted); CGContextRelease(context); CGColorSpaceRelease(srgb);
  return data;
}

// One image request; the options are those a provider would use. `network` decides whether iCloud may be asked.
static NSDictionary *request(PHAsset *asset, CGSize target, BOOL network, BOOL twice) {
  PHImageRequestOptions *options = [PHImageRequestOptions new];
  options.version = PHImageRequestOptionsVersionCurrent; options.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat;
  options.resizeMode = PHImageRequestOptionsResizeModeExact; options.networkAccessAllowed = network; options.synchronous = YES;
  __block NSDictionary *out = @{@"error": @"no answer"};
  NSTimeInterval start = now();
  BOOL full = CGSizeEqualToSize(target, PHImageManagerMaximumSize);
  [PHImageManager.defaultManager requestImageForAsset:asset targetSize:target contentMode:full ? PHImageContentModeDefault : PHImageContentModeAspectFit options:options resultHandler:^(NSImage *image, NSDictionary *info) {
    NSError *error = info[PHImageErrorKey];
    if (!image) { out = @{@"error": error ? [NSString stringWithFormat:@"%@ %ld", error.domain, (long)error.code] : @"none", @"inCloud": @([info[PHImageResultIsInCloudKey] boolValue])}; return; }
    CGImageRef cg = [image CGImageForProposedRect:nullptr context:nil hints:nil];
    NSString *space = CFBridgingRelease(CGColorSpaceCopyName(CGImageGetColorSpace(cg))) ?: @"unnamed";
    NSNumber *delivered = ms(start);
    NSTimeInterval encode = now(); NSData *data = jpeg(cg, full ? 0.95 : 0.86);
    out = @{@"ms": delivered, @"encodeMs": ms(encode), @"width": @(CGImageGetWidth(cg)), @"height": @(CGImageGetHeight(cg)), @"bits": @(CGImageGetBitsPerComponent(cg)), @"space": space,
      @"degraded": @([info[PHImageResultIsDegradedKey] boolValue]), @"bytes": @(data.length), @"digest": digest(data)};
  }];
  return out;
}

static NSDictionary *pictures(NSUInteger limit, BOOL full, BOOL network, NSString *type) {
  NSArray<PHAsset *> *assets = images(0); NSMutableArray *chosen = [NSMutableArray new];
  for (PHAsset *a in assets) {
    if (type.length) { if (@available(macOS 26, *)) { if ([type isEqual:@"edited"] ? !a.hasAdjustments : [type isEqual:@"raw"] ? ![a.contentType conformsToType:UTTypeRAWImage] : ![a.contentType.identifier isEqual:type]) continue; } }
    [chosen addObject:a];
  }
  // Spread over the library rather than the newest only.
  NSMutableArray<PHAsset *> *sample = [NSMutableArray new];
  for (NSUInteger i = 0; i < MIN(limit, chosen.count); i++) [sample addObject:chosen[i * chosen.count / MIN(limit, chosen.count)]];
  NSInteger ok = 0, sizeMatches = 0, transposed = 0, smaller = 0, identical = 0, degraded = 0, inCloud = 0; NSMutableDictionary *errors = [NSMutableDictionary new], *spaces = [NSMutableDictionary new], *bits = [NSMutableDictionary new];
  NSMutableArray *times = [NSMutableArray new], *encodes = [NSMutableArray new]; double bytes = 0; NSTimeInterval start = now();
  CGSize target = full ? PHImageManagerMaximumSize : CGSizeMake(1400, 1400);
  NSInteger again = 0;
  for (PHAsset *a in sample) @autoreleasepool {
    NSDictionary *r = request(a, target, network, NO);
    if (r[@"error"]) { count(errors, r[@"error"]); if ([r[@"inCloud"] boolValue]) inCloud++; continue; }
    ok++; [times addObject:r[@"ms"]]; [encodes addObject:r[@"encodeMs"]]; bytes += [r[@"bytes"] doubleValue]; count(spaces, r[@"space"]); count(bits, [r[@"bits"] stringValue]);
    if ([r[@"degraded"] boolValue]) degraded++;
    double w = [r[@"width"] doubleValue], h = [r[@"height"] doubleValue], pw = a.pixelWidth, ph = a.pixelHeight;
    if (full) { if (w == pw && h == ph) sizeMatches++; else if (w == ph && h == pw) transposed++; else smaller++; }
    else { if (fabs(w / h - pw / ph) < 0.01) sizeMatches++; else if (fabs(h / w - pw / ph) < 0.01) transposed++; if (MAX(w, h) < MIN(1400, MAX(pw, ph)) - 1) smaller++; }
    if (again < 10) { again++; if ([request(a, target, network, NO)[@"digest"] isEqual:r[@"digest"]]) identical++; }
  }
  NSNumber *total = ms(start);
  [times sortUsingSelector:@selector(compare:)]; [encodes sortUsingSelector:@selector(compare:)];
  id median = times.count ? times[times.count / 2] : @0, p95 = times.count ? times[(NSUInteger)(times.count * 0.95)] : @0;
  return @{@"type": type ?: @"any", @"of": @(chosen.count), @"asked": @(sample.count), @"ok": @(ok), @"errors": errors, @"inCloud": @(inCloud), @"totalMs": total, @"medianMs": median, @"p95Ms": p95, @"encodeMedianMs": encodes.count ? encodes[encodes.count / 2] : @0,
    @"meanBytes": ok ? @(round(bytes / ok)) : @0, @"spaces": spaces, @"bits": bits, @"sizeMatches": @(sizeMatches), @"transposed": @(transposed), @"otherOrSmaller": @(smaller), @"repeatIdentical": [NSString stringWithFormat:@"%ld of %ld", (long)identical, (long)again], @"degraded": @(degraded)};
}

// What Photos' own pasteboard offers on a drag: the type names, and the asset reference's shape (never its content).
static NSArray *pasteboardTypes(NSPasteboard *board) {
  NSMutableArray *items = [NSMutableArray new];
  for (NSPasteboardItem *item in board.pasteboardItems) {
    NSMutableDictionary *entry = [@{@"types": item.types} mutableCopy];
    id reference = [item propertyListForType:@"com.apple.photos.object-reference.asset"];
    NSData *raw = [item dataForType:@"com.apple.photos.object-reference.asset"];
    entry[@"referenceBytes"] = @(raw.length);
    if (reference) entry[@"referenceClass"] = NSStringFromClass([reference classForCoder]);
    if ([reference isKindOfClass:NSDictionary.class]) {
      entry[@"referenceKeys"] = [reference allKeys];
      id local = reference[@"localIdentifier"], library = reference[@"libraryURL"];
      entry[@"localIdentifierClass"] = NSStringFromClass([local classForCoder]); entry[@"libraryURLClass"] = NSStringFromClass([library classForCoder]);
      NSString *path = [library isKindOfClass:NSString.class] ? ([library hasPrefix:@"file:"] ? [NSURL URLWithString:library].path : library) : [library isKindOfClass:NSURL.class] ? [library path] : nil;
      // Whether it names a library bundle; that it is the system library shows in `resolves` (PhotoKit reads only that one).
      entry[@"libraryIsBundle"] = @([path.pathExtension isEqualToString:@"photoslibrary"]);
      if ([local isKindOfClass:NSString.class]) {
        PHAsset *asset = [PHAsset fetchAssetsWithLocalIdentifiers:@[local] options:nil].firstObject;
        entry[@"resolves"] = @(asset != nil);
        if (asset) {
          entry[@"assetSize"] = [NSString stringWithFormat:@"%lux%lu", (unsigned long)asset.pixelWidth, (unsigned long)asset.pixelHeight];
          if (@available(macOS 26, *)) entry[@"assetType"] = asset.contentType.identifier;
          PHCloudIdentifierMapping *m = [PHPhotoLibrary.sharedPhotoLibrary cloudIdentifierMappingsForLocalIdentifiers:@[local]][local];
          entry[@"cloudIdentifier"] = @(m.cloudIdentifier != nil);
          NSString *file = [item stringForType:NSPasteboardTypeFileURL];
          NSURL *url = file ? [NSURL URLWithString:file] : nil;
          if (url) {
            CGImageSourceRef src = CGImageSourceCreateWithURL((__bridge CFURLRef)url, nullptr);
            NSDictionary *props = src ? CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(src, 0, nullptr)) : nil; if (src) CFRelease(src);
            entry[@"fileSize"] = [NSString stringWithFormat:@"%@x%@", props[(id)kCGImagePropertyPixelWidth], props[(id)kCGImagePropertyPixelHeight]];
            NSArray *parts = url.path.pathComponents; NSUInteger at = [parts indexOfObjectPassingTest:^BOOL(NSString *p, NSUInteger i, BOOL *stop) { return [p hasSuffix:@".photoslibrary"]; }];
            NSMutableArray *shape = [NSMutableArray new];
            if (at != NSNotFound) for (NSUInteger i = at + 1; i < parts.count; i++) [shape addObject:i + 1 < parts.count && [parts[i] length] > 2 ? parts[i] : @"…"];
            entry[@"fileInLibrary"] = [shape componentsJoinedByString:@"/"];
          }
        }
      }
    }
    NSString *text = [reference isKindOfClass:NSString.class] ? reference : raw ? [[NSString alloc] initWithData:raw encoding:NSUTF8StringEncoding] : nil;
    if (text) { NSRegularExpression *x = [NSRegularExpression regularExpressionWithPattern:@"[0-9A-Za-z]" options:0 error:nil];
      entry[@"referenceShape"] = [x stringByReplacingMatchesInString:[text substringToIndex:MIN(text.length, 120)] options:0 range:NSMakeRange(0, MIN(text.length, 120)) withTemplate:@"x"]; }
    if (text) { entry[@"referenceLength"] = @(text.length); entry[@"resolves"] = @([PHAsset fetchAssetsWithLocalIdentifiers:@[text] options:nil].count); }
    NSString *url = [item stringForType:NSPasteboardTypeFileURL];
    entry[@"fileURL"] = url ? ([url containsString:@".photoslibrary"] ? @"inside the library" : @"elsewhere") : @"none";
    [items addObject:entry];
  }
  return items;
}


// ---------- iCloud downloads (network allowed) and one watched photo

static NSArray<PHAsset *> *notLocal(NSUInteger want, BOOL full) {
  NSMutableArray *out = [NSMutableArray new];
  NSArray<PHAsset *> *all = images(0);
  PHImageRequestOptions *o = [PHImageRequestOptions new]; o.synchronous = YES; o.networkAccessAllowed = NO;
  o.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat; o.resizeMode = PHImageRequestOptionsResizeModeExact;
  CGSize target = full ? PHImageManagerMaximumSize : CGSizeMake(1400, 1400);
  for (NSUInteger i = 0; i < all.count && out.count < want; i += 97) @autoreleasepool {
    __block BOOL cloud = NO;
    [PHImageManager.defaultManager requestImageForAsset:all[i] targetSize:target contentMode:full ? PHImageContentModeDefault : PHImageContentModeAspectFit options:o resultHandler:^(NSImage *r, NSDictionary *info) {
      cloud = !r && [info[PHImageErrorKey] code] == 3164; }];
    if (cloud) [out addObject:all[i]];
  }
  return out;
}

// One asynchronous request with network access; `cancelAfter` > 0 cancels after that many seconds.
static NSDictionary *download(PHAsset *asset, BOOL full, double cancelAfter) {
  PHImageRequestOptions *o = [PHImageRequestOptions new];
  o.networkAccessAllowed = YES; o.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat; o.resizeMode = PHImageRequestOptionsResizeModeExact;
  __block NSInteger progressCalls = 0; __block double lastProgress = 0, firstProgressAt = 0;
  NSTimeInterval start = now();
  o.progressHandler = ^(double progress, NSError *error, BOOL *stop, NSDictionary *info) { if (!progressCalls) firstProgressAt = now() - start; progressCalls++; lastProgress = progress; };
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSDictionary *out;
  CGSize target = full ? PHImageManagerMaximumSize : CGSizeMake(1400, 1400);
  PHImageRequestID rid = [PHImageManager.defaultManager requestImageForAsset:asset targetSize:target contentMode:full ? PHImageContentModeDefault : PHImageContentModeAspectFit options:o resultHandler:^(NSImage *r, NSDictionary *info) {
    if ([info[PHImageResultIsDegradedKey] boolValue]) return;
    NSError *e = info[PHImageErrorKey];
    CGImageRef cg = r ? [r CGImageForProposedRect:nullptr context:nil hints:nil] : nullptr;
    out = @{@"ms": ms(start), @"ok": @(cg != nullptr), @"cancelled": @([info[PHImageCancelledKey] boolValue]), @"error": e ? [NSString stringWithFormat:@"%@ %ld", e.domain, (long)e.code] : @"none",
      @"width": @(cg ? CGImageGetWidth(cg) : 0), @"height": @(cg ? CGImageGetHeight(cg) : 0), @"asset": [NSString stringWithFormat:@"%lux%lu", (unsigned long)asset.pixelWidth, (unsigned long)asset.pixelHeight],
      @"progressCalls": @(progressCalls), @"lastProgress": @(round(lastProgress * 100) / 100), @"firstProgressMs": @(round(firstProgressAt * 1000))};
    dispatch_semaphore_signal(done);
  }];
  if (cancelAfter > 0) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(cancelAfter * NSEC_PER_SEC)), dispatch_get_global_queue(0, 0), ^{ [PHImageManager.defaultManager cancelImageRequest:rid]; });
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_SEC))) return @{@"timeout": @YES, @"ms": ms(start), @"progressCalls": @(progressCalls), @"lastProgress": @(lastProgress)};
  return out;
}

static NSDictionary *icloud(NSUInteger previews, NSUInteger fulls, double cancel) {
  NSMutableDictionary *r = [NSMutableDictionary new];
  NSTimeInterval start = now();
  NSArray *p = notLocal(previews + 1, NO); r[@"findPreviewMs"] = ms(start);
  NSMutableArray *list = [NSMutableArray new];
  for (NSUInteger i = 0; i < MIN(previews, p.count); i++) [list addObject:download(p[i], NO, 0)];
  r[@"previews"] = list;
  start = now(); NSArray *f = notLocal(fulls + 1, YES); r[@"findFullMs"] = ms(start);
  list = [NSMutableArray new];
  for (NSUInteger i = 0; i < MIN(fulls, f.count); i++) [list addObject:download(f[i], YES, 0)];
  r[@"fulls"] = list;
  if (f.count > fulls) {
    PHAsset *last = f[fulls];
    r[@"cancelled"] = download(last, YES, cancel);
    r[@"afterCancel"] = download(last, YES, 0);   // did the cancelled download leave anything behind?
  }
  return r;
}

static PHAsset *watched;
static NSDictionary *lastSnapshot;
static NSString *shortHash(NSString *s) { return s.length ? digest([s dataUsingEncoding:NSUTF8StringEncoding]) : @""; }
static NSDictionary *snapshot(PHAsset *a) {
  NSMutableDictionary *s = [NSMutableDictionary new];
  NSISO8601DateFormatter *f = [NSISO8601DateFormatter new]; f.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  s[@"modificationDate"] = a.modificationDate ? [f stringFromDate:a.modificationDate] : @"none";
  s[@"size"] = [NSString stringWithFormat:@"%lux%lu", (unsigned long)a.pixelWidth, (unsigned long)a.pixelHeight];
  s[@"favorite"] = @(a.favorite); s[@"hasAdjustments"] = @(a.hasAdjustments);
  if (@available(macOS 15, *)) { s[@"adjustmentTimestamp"] = a.adjustmentTimestamp ? [f stringFromDate:a.adjustmentTimestamp] : @"none"; s[@"adjustmentsState"] = @(a.adjustmentsState); }
  s[@"adjustmentFormat"] = a.adjustmentFormatIdentifier ?: @"none";
  if (@available(macOS 27, *)) { s[@"rating"] = @(a.rating); s[@"captionHash"] = shortHash(a.extendedMetadata.caption); s[@"keywords"] = @(a.extendedMetadata.keywords.count); s[@"originalResourceChoice"] = @(a.originalResourceChoice); }
  s[@"creationDate"] = a.creationDate ? [f stringFromDate:a.creationDate] : @"none";
  NSDictionary *pic = request(a, CGSizeMake(1400, 1400), YES, NO);
  s[@"previewDigest"] = pic[@"digest"] ?: pic[@"error"]; s[@"previewSize"] = [NSString stringWithFormat:@"%@x%@", pic[@"width"], pic[@"height"]];
  return s;
}
static void checkWatched(NSString *why) {
  if (!watched) return;
  PHAsset *fresh = [PHAsset fetchAssetsWithLocalIdentifiers:@[watched.localIdentifier] options:nil].firstObject;
  if (!fresh) { emit(@{@"event": @"watched", @"why": why, @"gone": @YES}); return; }
  watched = fresh;
  NSDictionary *now_ = snapshot(fresh);
  if ([now_ isEqual:lastSnapshot]) return;
  NSMutableDictionary *changed = [NSMutableDictionary new];
  for (NSString *k in now_) if (![now_[k] isEqual:lastSnapshot[k]]) changed[k] = now_[k];
  emit(@{@"event": @"watched", @"why": why, @"at": [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]], @"changed": lastSnapshot ? changed : now_});
  lastSnapshot = now_;
}

@interface Observer : NSObject <PHPhotoLibraryChangeObserver>
@end
@implementation Observer
- (void)photoLibraryDidChange:(PHChange *)change {
  PHAsset *w = watched; PHObjectChangeDetails *d = w ? [change changeDetailsForObject:w] : nil;
  emit(@{@"event": @"libraryDidChange", @"watchedChanged": @(d != nil), @"assetContentChanged": @(d.assetContentChanged)});
  if (d) dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ checkWatched(@"observer"); });
}
@end
static Observer *observer;

@interface DropView : NSView
@end
@implementation DropView
- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)info { return NSDragOperationCopy; }
- (BOOL)performDragOperation:(id<NSDraggingInfo>)info {
  NSArray *promises = [info.draggingPasteboard readObjectsForClasses:@[NSFilePromiseReceiver.class] options:nil];
  NSArray *items = pasteboardTypes(info.draggingPasteboard);
  emit(@{@"event": @"nativeDrop", @"items": items, @"promiseReceivers": @(promises.count)});
  id ref = [info.draggingPasteboard.pasteboardItems.firstObject propertyListForType:@"com.apple.photos.object-reference.asset"];
  NSString *local = [ref isKindOfClass:NSDictionary.class] ? ref[@"localIdentifier"] : nil;
  if (local) { watched = [PHAsset fetchAssetsWithLocalIdentifiers:@[local] options:nil].firstObject; lastSnapshot = nil;
    static dispatch_source_t timer; if (!timer) { timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
      dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC, NSEC_PER_SEC / 4); dispatch_source_set_event_handler(timer, ^{ checkWatched(@"poll"); }); dispatch_resume(timer); } }
  return YES;
}
- (void)drawRect:(NSRect)r { [NSColor.systemTealColor setFill]; NSRectFill(self.bounds); [@"Native drop: drag a photo from Photos here" drawAtPoint:NSMakePoint(16, 16) withAttributes:nil]; }
@end

static NSString *text(napi_env env, napi_value value) { size_t n; napi_get_value_string_utf8(env, value, nullptr, 0, &n); std::string s(n, 0); napi_get_value_string_utf8(env, value, s.data(), n + 1, &n); return @(s.c_str()); }

static napi_value run(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSString *name = text(env, argv[0]);
  NSDictionary *a = [NSJSONSerialization JSONObjectWithData:[text(env, argv[1]) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  NSUInteger limit = [a[@"limit"] unsignedIntegerValue];
  if ([name isEqual:@"request"]) {
    [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite handler:^(PHAuthorizationStatus s) { emit(@{@"task": name, @"status": statusName(s)}); }];
    return nullptr;
  }
  if ([name isEqual:@"drop"]) {
    NSWindow *w = [[NSWindow alloc] initWithContentRect:NSMakeRect(80, 200, 420, 260) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    w.releasedWhenClosed = NO; DropView *v = [DropView new]; NSMutableArray *types = [@[NSPasteboardTypeFileURL, @"public.image", @"com.apple.photos.object-reference.asset"] mutableCopy];
    [types addObjectsFromArray:NSFilePromiseReceiver.readableDraggedTypes]; [v registerForDraggedTypes:types]; w.contentView = v; [w makeKeyAndOrderFront:nil];
    static NSWindow *kept; kept = w; emit(@{@"task": name, @"ready": @YES}); return nullptr;
  }
  if ([name isEqual:@"dragboard"]) { emit(@{@"task": name, @"items": pasteboardTypes([NSPasteboard pasteboardWithName:NSPasteboardNameDrag])}); return nullptr; }
  if ([name isEqual:@"observe"]) { observer = [Observer new]; [PHPhotoLibrary.sharedPhotoLibrary registerChangeObserver:observer]; emit(@{@"task": name, @"ready": @YES}); return nullptr; }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ @autoreleasepool {
    NSDictionary *value = @{@"error": @"unknown task"};
    @try {
      if ([name isEqual:@"status"]) value = @{@"readWrite": statusName([PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite]), @"bundle": NSBundle.mainBundle.bundleIdentifier ?: @"none"};
      else if ([name isEqual:@"census"]) value = census();
      else if ([name isEqual:@"metadata"]) value = metadata(limit);
      else if ([name isEqual:@"identity"]) value = identity(limit);
      else if ([name isEqual:@"icloud"]) value = icloud([a[@"previews"] unsignedIntegerValue], [a[@"fulls"] unsignedIntegerValue], [a[@"cancel"] doubleValue]);
      else if ([name isEqual:@"pictures"]) value = pictures(limit, [a[@"full"] boolValue], [a[@"network"] boolValue], a[@"type"]);
    } @catch (NSException *e) { value = @{@"exception": e.name ?: @"", @"reason": e.reason ?: @""}; }
    emit(@{@"task": name, @"args": a ?: @{}, @"result": value});
  } });
  return nullptr;
}
static napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1], label; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_create_string_utf8(env, "photos", NAPI_AUTO_LENGTH, &label);
  napi_create_threadsafe_function(env, argv[0], nullptr, label, 0, 1, nullptr, nullptr, nullptr, callJs, &tsfn);
  return nullptr;
}
NAPI_MODULE_INIT() {
  napi_value f; napi_create_function(env, "start", NAPI_AUTO_LENGTH, start, nullptr, &f); napi_set_named_property(env, exports, "start", f);
  napi_create_function(env, "run", NAPI_AUTO_LENGTH, run, nullptr, &f); napi_set_named_property(env, exports, "run", f);
  return exports;
}
