// The user's private CloudKit database, for the iCloud sync store (desktop/sync-store-cloudkit.ts, #292). Ported from
// the spike (spikes/cloudkit/native/cloudkit.mm, #286).
//
// Records: one generic record type `Blob` with `data` (inline bytes) or `asset` (a file), `size` and `sha256`. Zones,
// record names and what they mean are the store's business; this module only moves records.
//
// Every call returns a promise. CloudKit's completion handlers run on its own queues and reach JavaScript through a
// thread-safe function. Long operations take an `id`, so JavaScript can cancel them (`cancel(id)`), and an optional
// progress callback that receives the fraction done.
//
// CloudKit traps the process (EXC_BREAKPOINT) when it is used without the iCloud entitlements, so `status()` reads the
// process's own entitlements first and never touches CloudKit without them: ad-hoc, development and unpackaged builds
// report `entitled: false` and keep working. Every other call fails until `status()` has found the entitlements.
#import <CloudKit/CloudKit.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <copyfile.h>
#include <node_api.h>
#include <mutex>
#include <string>

static NSString *const kRecordType = @"Blob";

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, #call " failed"); return nullptr; } } while (0)

typedef void (^JSWork)(napi_env env);
typedef napi_value (^Builder)(napi_env env);

// ---------- Entitlements

static id copyEntitlement(NSString *name) {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) return nil;
  CFTypeRef value = SecTaskCopyValueForEntitlement(task, (__bridge CFStringRef)name, nullptr);
  CFRelease(task);
  return CFBridgingRelease(value);
}

/** The container this process may use, or nil when it lacks the CloudKit entitlements. */
static NSString *entitledContainer() {
  NSArray *services = copyEntitlement(@"com.apple.developer.icloud-services");
  NSArray *containers = copyEntitlement(@"com.apple.developer.icloud-container-identifiers");
  if (![services isKindOfClass:NSArray.class] || ![services containsObject:@"CloudKit"]) return nil;
  if (![containers isKindOfClass:NSArray.class] || !containers.count || ![containers.firstObject isKindOfClass:NSString.class]) return nil;
  return containers.firstObject;
}

// ---------- Promises
//
// A pending call owns a thread-safe function. Progress and the result are queued on it under `lock`; once settled,
// nothing more is queued and the function is released. Node calls `finishPending` on the JavaScript thread after the
// last queued call has run, which frees the call and its progress callback.

struct Pending {
  napi_deferred deferred = nullptr;
  napi_threadsafe_function tsfn = nullptr;
  napi_ref progress = nullptr;
  std::mutex lock;
  bool settled = false;
};

static void callJs(napi_env env, napi_value, void *, void *data) {
  JSWork work = (__bridge_transfer JSWork)data;
  if (env) work(env);
}

static void finishPending(napi_env env, void *data, void *) {
  Pending *pending = static_cast<Pending *>(data);
  if (pending->progress) napi_delete_reference(env, pending->progress);
  delete pending;
}

static Pending *newPending(napi_env env, napi_value *promise, napi_value progress) {
  Pending *pending = new Pending();
  napi_create_promise(env, &pending->deferred, promise);
  napi_value name;
  napi_create_string_utf8(env, "cloudkit", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, pending, finishPending, nullptr, callJs, &pending->tsfn);
  napi_valuetype type = napi_undefined;
  if (progress) napi_typeof(env, progress, &type);
  if (type == napi_function) napi_create_reference(env, progress, 1, &pending->progress);
  return pending;
}

static void enqueue(Pending *pending, JSWork work) {
  napi_call_threadsafe_function(pending->tsfn, (__bridge_retained void *)[work copy], napi_tsfn_nonblocking);
}

/** Resolves or rejects once; later calls are ignored. `build` runs on the JavaScript thread. */
static void settle(Pending *pending, bool reject, Builder build) {
  napi_threadsafe_function tsfn;
  {
    std::lock_guard<std::mutex> guard(pending->lock);
    if (pending->settled) return;
    pending->settled = true;
    tsfn = pending->tsfn;
    Builder kept = [build copy];
    enqueue(pending, ^(napi_env env) {
      napi_value value = kept(env);
      if (reject) napi_reject_deferred(env, pending->deferred, value);
      else napi_resolve_deferred(env, pending->deferred, value);
    });
  }
  // Outside the lock: once released, Node may free `pending` as soon as the result has run.
  napi_release_threadsafe_function(tsfn, napi_tsfn_release);
}

static void reportProgress(Pending *pending, double fraction) {
  std::lock_guard<std::mutex> guard(pending->lock);
  if (pending->settled || !pending->progress) return;
  enqueue(pending, ^(napi_env env) {
    napi_value fn, global, argument;
    napi_get_reference_value(env, pending->progress, &fn);
    napi_get_global(env, &global);
    napi_create_double(env, fraction, &argument);
    napi_call_function(env, global, fn, 1, &argument, nullptr);
  });
}

// ---------- Values

static napi_value str(napi_env env, NSString *value) {
  napi_value result;
  napi_create_string_utf8(env, value.UTF8String ?: "", NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value num(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

static napi_value boolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

static void setProp(napi_env env, napi_value object, const char *key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

static napi_value undefinedValue(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static NSString *errorName(NSInteger code) {
  switch (code) {
    case CKErrorInternalError: return @"internalError";
    case CKErrorPartialFailure: return @"partialFailure";
    case CKErrorNetworkUnavailable: return @"networkUnavailable";
    case CKErrorNetworkFailure: return @"networkFailure";
    case CKErrorBadContainer: return @"badContainer";
    case CKErrorServiceUnavailable: return @"serviceUnavailable";
    case CKErrorRequestRateLimited: return @"requestRateLimited";
    case CKErrorMissingEntitlement: return @"missingEntitlement";
    case CKErrorNotAuthenticated: return @"notAuthenticated";
    case CKErrorPermissionFailure: return @"permissionFailure";
    case CKErrorUnknownItem: return @"unknownItem";
    case CKErrorInvalidArguments: return @"invalidArguments";
    case CKErrorServerRecordChanged: return @"serverRecordChanged";
    case CKErrorServerRejectedRequest: return @"serverRejectedRequest";
    case CKErrorAssetFileNotFound: return @"assetFileNotFound";
    case CKErrorAssetFileModified: return @"assetFileModified";
    case CKErrorIncompatibleVersion: return @"incompatibleVersion";
    case CKErrorConstraintViolation: return @"constraintViolation";
    case CKErrorOperationCancelled: return @"operationCancelled";
    case CKErrorChangeTokenExpired: return @"changeTokenExpired";
    case CKErrorBatchRequestFailed: return @"batchRequestFailed";
    case CKErrorZoneBusy: return @"zoneBusy";
    case CKErrorBadDatabase: return @"badDatabase";
    case CKErrorQuotaExceeded: return @"quotaExceeded";
    case CKErrorZoneNotFound: return @"zoneNotFound";
    case CKErrorLimitExceeded: return @"limitExceeded";
    case CKErrorUserDeletedZone: return @"userDeletedZone";
    case CKErrorAccountTemporarilyUnavailable: return @"accountTemporarilyUnavailable";
    default: return [NSString stringWithFormat:@"ckError%ld", (long)code];
  }
}

/** An Error with `code` (the CKError name, or `<domain>:<code>` for other errors) and `retryAfter` in seconds. */
static napi_value errorValue(napi_env env, NSError *error) {
  napi_value message = str(env, error.localizedDescription), result;
  napi_create_error(env, nullptr, message, &result);
  bool cloudKit = [error.domain isEqualToString:CKErrorDomain];
  setProp(env, result, "code", str(env, cloudKit ? errorName(error.code) : [NSString stringWithFormat:@"%@:%ld", error.domain, (long)error.code]));
  NSNumber *retry = error.userInfo[CKErrorRetryAfterKey];
  if ([retry isKindOfClass:NSNumber.class]) setProp(env, result, "retryAfter", num(env, retry.doubleValue));
  NSString *server = error.userInfo[@"ServerErrorDescription"];
  if ([server isKindOfClass:NSString.class]) setProp(env, result, "serverMessage", str(env, server));
  return result;
}

static void rejectWith(Pending *pending, NSError *error) {
  settle(pending, true, ^napi_value(napi_env env) { return errorValue(env, error); });
}

static void resolveUndefined(Pending *pending) {
  settle(pending, false, ^napi_value(napi_env env) { return undefinedValue(env); });
}

/** The error of the one item an operation was about, unwrapped from a partial failure. */
static NSError *itemError(NSError *error) {
  if (error.code != CKErrorPartialFailure || ![error.domain isEqualToString:CKErrorDomain]) return error;
  NSDictionary *errors = error.userInfo[CKPartialErrorsByItemIDKey];
  return [errors isKindOfClass:NSDictionary.class] ? (errors.allValues.firstObject ?: error) : error;
}

// ---------- Arguments

static NSString *argString(napi_env env, napi_value value) {
  if (!value) return nil;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return nil;
  std::string buffer(length, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), length + 1, &length);
  return [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
}

static napi_value prop(napi_env env, napi_value object, const char *key) {
  napi_valuetype type;
  if (!object || napi_typeof(env, object, &type) != napi_ok || type != napi_object) return nullptr;
  bool has = false;
  napi_has_named_property(env, object, key, &has);
  if (!has) return nullptr;
  napi_value value;
  napi_get_named_property(env, object, key, &value);
  napi_typeof(env, value, &type);
  return type == napi_undefined || type == napi_null ? nullptr : value;
}

static NSArray<NSString *> *argStrings(napi_env env, napi_value value) {
  NSMutableArray *result = [NSMutableArray array];
  uint32_t length = 0;
  if (!value || napi_get_array_length(env, value, &length) != napi_ok) return result;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    napi_get_element(env, value, index, &item);
    NSString *string = argString(env, item);
    if (string) [result addObject:string];
  }
  return result;
}

static bool requireStrings(napi_env env, std::initializer_list<NSString *> values) {
  for (NSString *value : values) {
    if (value.length) continue;
    napi_throw_type_error(env, nullptr, "Expected a non-empty string.");
    return false;
  }
  return true;
}

// ---------- Container

static CKContainer *container;
static CKDatabase *database;
static NSMutableDictionary<NSNumber *, NSOperation *> *running;
static NSString *environmentName;
static NSString *containerName;

static bool requireContainer(napi_env env) {
  if (container) return true;
  napi_throw_error(env, "notInitialized", "CloudKit is not available in this build, or status() has not been called.");
  return false;
}

/** Registers an operation under the caller's `id`, so `cancel(id)` finds it while it runs. */
static void track(napi_env env, napi_value options, CKOperation *operation) {
  napi_value id = prop(env, options, "id");
  if (!id) return;
  int64_t key = 0;
  napi_get_value_int64(env, id, &key);
  NSNumber *number = @(key);
  @synchronized (running) { running[number] = operation; }
  void (^previous)(void) = operation.completionBlock;
  operation.completionBlock = ^{
    if (previous) previous();
    @synchronized (running) { if (running[number] == operation) [running removeObjectForKey:number]; }
  };
}

static void configure(CKOperation *operation) {
  operation.qualityOfService = NSQualityOfServiceUserInitiated;
}

static CKRecordZoneID *zoneID(NSString *zone) {
  return [[CKRecordZoneID alloc] initWithZoneName:zone ownerName:CKCurrentUserDefaultName];
}

static napi_value describeRecord(napi_env env, CKRecord *record) {
  napi_value object;
  napi_create_object(env, &object);
  setProp(env, object, "name", str(env, record.recordID.recordName));
  NSNumber *size = record[@"size"];
  setProp(env, object, "size", num(env, [size isKindOfClass:NSNumber.class] ? size.doubleValue : 0));
  setProp(env, object, "lastModified", num(env, (record.modificationDate ?: NSDate.date).timeIntervalSince1970 * 1000));
  NSString *sha = record[@"sha256"];
  if ([sha isKindOfClass:NSString.class]) setProp(env, object, "sha256", str(env, sha));
  return object;
}

// ---------- Exports

// status(): { entitled: false } or { entitled: true, container, environment, accountStatus }.
static napi_value Status(napi_env env, napi_callback_info) {
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  NSString *identifier = entitledContainer();
  if (!identifier) {
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object;
      napi_create_object(env, &object);
      setProp(env, object, "entitled", boolean(env, false));
      return object;
    });
    return promise;
  }
  if (!container) {
    container = [CKContainer containerWithIdentifier:identifier];
    database = container.privateCloudDatabase;
    running = [NSMutableDictionary dictionary];
    containerName = identifier;
    id environment = copyEntitlement(@"com.apple.developer.icloud-container-environment");
    environmentName = [environment isKindOfClass:NSString.class] ? environment : @"Production";
  }
  [container accountStatusWithCompletionHandler:^(CKAccountStatus status, NSError *error) {
    if (error) return rejectWith(pending, error);
    NSString *name;
    switch (status) {
      case CKAccountStatusAvailable: name = @"available"; break;
      case CKAccountStatusRestricted: name = @"restricted"; break;
      case CKAccountStatusNoAccount: name = @"noAccount"; break;
      case CKAccountStatusTemporarilyUnavailable: name = @"temporarilyUnavailable"; break;
      default: name = @"couldNotDetermine"; break;
    }
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object;
      napi_create_object(env, &object);
      setProp(env, object, "entitled", boolean(env, true));
      setProp(env, object, "container", str(env, containerName));
      setProp(env, object, "environment", str(env, environmentName));
      setProp(env, object, "accountStatus", str(env, name));
      return object;
    });
  }];
  return promise;
}

// userRecordId(): the record name of the signed-in iCloud user in this container; another Apple ID gives another.
static napi_value UserRecordId(napi_env env, napi_callback_info) {
  if (!requireContainer(env)) return nullptr;
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  [container fetchUserRecordIDWithCompletionHandler:^(CKRecordID *recordID, NSError *error) {
    if (error) return rejectWith(pending, error);
    NSString *name = recordID.recordName;
    settle(pending, false, ^napi_value(napi_env env) { return str(env, name); });
  }];
  return promise;
}

static napi_value ModifyZones(napi_env env, NSArray<CKRecordZone *> *save, NSArray<CKRecordZoneID *> *remove) {
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKModifyRecordZonesOperation *operation = [[CKModifyRecordZonesOperation alloc] initWithRecordZonesToSave:save recordZoneIDsToDelete:remove];
  configure(operation);
  operation.modifyRecordZonesCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    if (error) return rejectWith(pending, itemError(error));
    resolveUndefined(pending);
  };
  [database addOperation:operation];
  return promise;
}

// saveZone(zone): creates a zone; saving one that exists succeeds.
static napi_value SaveZone(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1] = {nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]);
  if (!requireStrings(env, {zone})) return nullptr;
  return ModifyZones(env, @[[[CKRecordZone alloc] initWithZoneID:zoneID(zone)]], nil);
}

// deleteZones([zone]): deletes zones with every record in them.
static napi_value DeleteZones(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1] = {nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSMutableArray *ids = [NSMutableArray array];
  for (NSString *zone in argStrings(env, argv[0])) [ids addObject:zoneID(zone)];
  return ModifyZones(env, nil, ids);
}

// listZones(): [zoneName], without the default zone.
static napi_value ListZones(napi_env env, napi_callback_info) {
  if (!requireContainer(env)) return nullptr;
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKFetchRecordZonesOperation *operation = [CKFetchRecordZonesOperation fetchAllRecordZonesOperation];
  configure(operation);
  operation.fetchRecordZonesCompletionBlock = ^(NSDictionary<CKRecordZoneID *, CKRecordZone *> *zones, NSError *error) {
    if (error) return rejectWith(pending, error);
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    for (CKRecordZoneID *zone in zones) if (![zone.zoneName isEqualToString:CKRecordZoneDefaultName]) [names addObject:zone.zoneName];
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value array;
      napi_create_array_with_length(env, names.count, &array);
      for (NSUInteger index = 0; index < names.count; ++index) napi_set_element(env, array, (uint32_t)index, str(env, names[index]));
      return array;
    });
  };
  [database addOperation:operation];
  return promise;
}

// putIfAbsent(zone, name, { data?: Buffer, file?: string, sha256? }, { id?, onProgress? }): { created }
// `data` goes inline (the caller keeps it small: a record holds at most 1 MB), `file` as an asset. A new record saved
// with `ifServerRecordUnchanged` fails with serverRecordChanged when the name exists: a conditional create.
static napi_value PutIfAbsent(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4] = {nullptr, nullptr, nullptr, nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]), *name = argString(env, argv[1]);
  if (!requireStrings(env, {zone, name})) return nullptr;
  napi_value dataValue = prop(env, argv[2], "data"), fileValue = prop(env, argv[2], "file"), shaValue = prop(env, argv[2], "sha256");
  CKRecord *record = [[CKRecord alloc] initWithRecordType:kRecordType recordID:[[CKRecordID alloc] initWithRecordName:name zoneID:zoneID(zone)]];
  if (dataValue) {
    void *data; size_t length;
    CHECK(napi_get_buffer_info(env, dataValue, &data, &length));
    record[@"size"] = @(length);
    record[@"data"] = [NSData dataWithBytes:data length:length];
  } else if (fileValue) {
    NSString *path = argString(env, fileValue);
    NSError *error = nil;
    NSNumber *size = [NSFileManager.defaultManager attributesOfItemAtPath:path error:&error][NSFileSize];
    if (!size) {
      napi_throw_error(env, "assetFileNotFound", (error.localizedDescription ?: @"The file to upload is missing.").UTF8String);
      return nullptr;
    }
    record[@"size"] = size;
    record[@"asset"] = [[CKAsset alloc] initWithFileURL:[NSURL fileURLWithPath:path]];
  } else {
    napi_throw_type_error(env, nullptr, "putIfAbsent needs data or a file.");
    return nullptr;
  }
  if (shaValue) record[@"sha256"] = argString(env, shaValue);
  napi_value promise;
  Pending *pending = newPending(env, &promise, prop(env, argv[3], "onProgress"));
  CKModifyRecordsOperation *operation = [[CKModifyRecordsOperation alloc] initWithRecordsToSave:@[record] recordIDsToDelete:nil];
  operation.savePolicy = CKRecordSaveIfServerRecordUnchanged;
  operation.atomic = NO;
  configure(operation);
  operation.perRecordProgressBlock = ^(CKRecord *, double progress) { reportProgress(pending, progress); };
  __block NSError *recordError = nil;
  operation.perRecordSaveBlock = ^(CKRecordID *, CKRecord *, NSError *error) { if (error) recordError = error; };
  operation.modifyRecordsCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    NSError *cause = recordError ?: itemError(error);
    if (cause && cause.code == CKErrorServerRecordChanged && [cause.domain isEqualToString:CKErrorDomain]) {
      return settle(pending, false, ^napi_value(napi_env env) {
        napi_value object; napi_create_object(env, &object);
        setProp(env, object, "created", boolean(env, false)); return object;
      });
    }
    if (cause) return rejectWith(pending, cause);
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object; napi_create_object(env, &object);
      setProp(env, object, "created", boolean(env, true)); return object;
    });
  };
  track(env, argv[3], operation);
  [database addOperation:operation];
  return promise;
}

// fetch(zone, name, { mode: 'head' | 'bytes' | 'file', file?, id?, onProgress? }):
//   head  → { name, size, lastModified, sha256? }, or undefined when there is no such record or zone
//   bytes → the same with `bytes: Buffer`
//   file  → the same after writing the blob to `file`, which must not exist. Only the data is copied: CloudKit's asset
//           files carry com.apple.quarantine, which must not reach the originals in a book.
static napi_value Fetch(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3] = {nullptr, nullptr, nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]), *name = argString(env, argv[1]);
  if (!requireStrings(env, {zone, name})) return nullptr;
  napi_value modeValue = prop(env, argv[2], "mode"), fileValue = prop(env, argv[2], "file");
  NSString *mode = modeValue ? argString(env, modeValue) : @"head";
  NSString *destination = fileValue ? argString(env, fileValue) : nil;
  if ([mode isEqualToString:@"file"] && !destination.length) {
    napi_throw_type_error(env, nullptr, "fetch in file mode needs a file.");
    return nullptr;
  }
  napi_value promise;
  Pending *pending = newPending(env, &promise, prop(env, argv[2], "onProgress"));
  CKRecordID *recordID = [[CKRecordID alloc] initWithRecordName:name zoneID:zoneID(zone)];
  CKFetchRecordsOperation *operation = [[CKFetchRecordsOperation alloc] initWithRecordIDs:@[recordID]];
  if ([mode isEqualToString:@"head"]) operation.desiredKeys = @[@"size", @"sha256"];
  configure(operation);
  operation.perRecordProgressBlock = ^(CKRecordID *, double progress) { reportProgress(pending, progress); };
  __block CKRecord *found = nil;
  __block NSError *recordError = nil;
  __block NSData *bytes = nil;
  operation.perRecordCompletionBlock = ^(CKRecord *record, CKRecordID *, NSError *error) {
    found = record;
    if (error) recordError = error;
    if (!record) return;
    // The downloaded asset file belongs to CloudKit and is removed after the operation: read or copy it now.
    CKAsset *asset = record[@"asset"];
    NSData *inlineData = record[@"data"];
    NSError *failure = nil;
    if ([mode isEqualToString:@"bytes"]) {
      bytes = inlineData ?: (asset.fileURL ? [NSData dataWithContentsOfURL:asset.fileURL options:0 error:&failure] : [NSData data]);
    } else if ([mode isEqualToString:@"file"]) {
      if (inlineData || !asset.fileURL) {
        [(inlineData ?: [NSData data]) writeToFile:destination options:NSDataWritingWithoutOverwriting error:&failure];
      } else if (copyfile(asset.fileURL.fileSystemRepresentation, destination.fileSystemRepresentation, nullptr, COPYFILE_DATA | COPYFILE_EXCL) != 0) {
        failure = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
        unlink(destination.fileSystemRepresentation);
      }
    }
    if (failure) recordError = failure;
  };
  operation.fetchRecordsCompletionBlock = ^(NSDictionary *, NSError *error) {
    NSError *cause = recordError ?: itemError(error);
    bool missing = cause && [cause.domain isEqualToString:CKErrorDomain] && (cause.code == CKErrorUnknownItem || cause.code == CKErrorZoneNotFound);
    if (missing) return resolveUndefined(pending);
    if (cause) return rejectWith(pending, cause);
    if (!found) return resolveUndefined(pending);
    NSData *kept = bytes;
    CKRecord *record = found;
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object = describeRecord(env, record);
      if (kept) {
        napi_value buffer;
        napi_create_buffer_copy(env, kept.length, kept.bytes, nullptr, &buffer);
        setProp(env, object, "bytes", buffer);
      }
      return object;
    });
  };
  track(env, argv[2], operation);
  [database addOperation:operation];
  return promise;
}

// changes(zone, token?: base64, { limit? }): { changed: [{ name, size, lastModified, sha256? }], deleted: [name], token?, more }
// Without a token, every record of the zone: a full listing. With `limit`, at most about that many records, and
// `more` says whether there were others (used to tell whether a zone is empty). Assets are never downloaded.
static napi_value Changes(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3] = {nullptr, nullptr, nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]);
  if (!requireStrings(env, {zone})) return nullptr;
  CKServerChangeToken *token = nil;
  napi_valuetype type = napi_undefined;
  if (argc > 1 && argv[1]) napi_typeof(env, argv[1], &type);
  if (type == napi_string) {
    NSData *data = [[NSData alloc] initWithBase64EncodedString:argString(env, argv[1]) options:0];
    token = data ? [NSKeyedUnarchiver unarchivedObjectOfClass:CKServerChangeToken.class fromData:data error:nil] : nil;
    if (!token) {
      // A token that cannot be read is treated like one CloudKit no longer accepts.
      napi_value promise;
      Pending *pending = newPending(env, &promise, nullptr);
      rejectWith(pending, [NSError errorWithDomain:CKErrorDomain code:CKErrorChangeTokenExpired userInfo:@{NSLocalizedDescriptionKey: @"The change token cannot be read."}]);
      return promise;
    }
  }
  int64_t limit = 0;
  napi_value limitValue = prop(env, argv[2], "limit");
  if (limitValue) napi_get_value_int64(env, limitValue, &limit);
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKFetchRecordZoneChangesConfiguration *configuration = [CKFetchRecordZoneChangesConfiguration new];
  configuration.previousServerChangeToken = token;
  configuration.desiredKeys = @[@"size", @"sha256"];
  if (limit > 0) configuration.resultsLimit = (NSUInteger)limit;
  CKRecordZoneID *zid = zoneID(zone);
  CKFetchRecordZoneChangesOperation *operation = [[CKFetchRecordZoneChangesOperation alloc] initWithRecordZoneIDs:@[zid] configurationsByRecordZoneID:@{zid: configuration}];
  operation.fetchAllChanges = limit <= 0;
  configure(operation);
  NSMutableArray<CKRecord *> *changed = [NSMutableArray array];
  NSMutableArray<NSString *> *deleted = [NSMutableArray array];
  __block CKServerChangeToken *latest = nil;
  __block NSError *zoneError = nil;
  __block BOOL more = NO;
  operation.recordWasChangedBlock = ^(CKRecordID *, CKRecord *record, NSError *) {
    if (record) @synchronized (changed) { [changed addObject:record]; }
  };
  operation.recordWithIDWasDeletedBlock = ^(CKRecordID *recordID, CKRecordType) {
    @synchronized (deleted) { [deleted addObject:recordID.recordName]; }
  };
  operation.recordZoneChangeTokensUpdatedBlock = ^(CKRecordZoneID *, CKServerChangeToken *serverToken, NSData *) { if (serverToken) latest = serverToken; };
  operation.recordZoneFetchCompletionBlock = ^(CKRecordZoneID *, CKServerChangeToken *serverToken, NSData *, BOOL moreComing, NSError *error) {
    if (serverToken) latest = serverToken;
    if (error) zoneError = error;
    more = moreComing;
  };
  operation.fetchRecordZoneChangesCompletionBlock = ^(NSError *error) {
    NSError *cause = zoneError ?: itemError(error);
    if (cause) return rejectWith(pending, cause);
    NSData *tokenData = latest ? [NSKeyedArchiver archivedDataWithRootObject:latest requiringSecureCoding:YES error:nil] : nil;
    NSString *tokenString = [tokenData base64EncodedStringWithOptions:0];
    BOOL moreComing = more;
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object, changedArray, deletedArray;
      napi_create_object(env, &object);
      napi_create_array_with_length(env, changed.count, &changedArray);
      for (NSUInteger index = 0; index < changed.count; ++index) napi_set_element(env, changedArray, (uint32_t)index, describeRecord(env, changed[index]));
      napi_create_array_with_length(env, deleted.count, &deletedArray);
      for (NSUInteger index = 0; index < deleted.count; ++index) napi_set_element(env, deletedArray, (uint32_t)index, str(env, deleted[index]));
      setProp(env, object, "changed", changedArray);
      setProp(env, object, "deleted", deletedArray);
      if (tokenString) setProp(env, object, "token", str(env, tokenString));
      setProp(env, object, "more", boolean(env, moreComing));
      return object;
    });
  };
  [database addOperation:operation];
  return promise;
}

// deleteRecords(zone, [name]): records that are not there are ignored. At most 400 per call (CloudKit's limit).
static napi_value DeleteRecords(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2] = {nullptr, nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]);
  if (!requireStrings(env, {zone})) return nullptr;
  NSMutableArray<CKRecordID *> *ids = [NSMutableArray array];
  for (NSString *name in argStrings(env, argv[1])) [ids addObject:[[CKRecordID alloc] initWithRecordName:name zoneID:zoneID(zone)]];
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKModifyRecordsOperation *operation = [[CKModifyRecordsOperation alloc] initWithRecordsToSave:nil recordIDsToDelete:ids];
  operation.atomic = NO;
  configure(operation);
  __block NSError *firstError = nil;
  operation.perRecordDeleteBlock = ^(CKRecordID *, NSError *error) {
    if (error && error.code != CKErrorUnknownItem && !firstError) firstError = error;
  };
  operation.modifyRecordsCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    if (firstError) return rejectWith(pending, firstError);
    if (error && error.code != CKErrorPartialFailure) return rejectWith(pending, error);
    resolveUndefined(pending);
  };
  [database addOperation:operation];
  return promise;
}

// cancel(id): cancels a running putIfAbsent or fetch, whose promise then rejects with operationCancelled.
static napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1] = {nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  int64_t key = 0;
  napi_get_value_int64(env, argv[0], &key);
  NSOperation *operation = nil;
  if (running) @synchronized (running) { operation = running[@(key)]; }
  [operation cancel];
  return boolean(env, operation != nil);
}

// onAccountChange(fn): calls fn() when CloudKit says the account changed. It also fires without a change (seen around
// Wi-Fi reconnecting), so the caller compares the user record ID. One listener per process; later calls replace it.
static napi_threadsafe_function accountChanged;
static id accountObserver;
static void callAccountChanged(napi_env env, napi_value fn, void *, void *) {
  if (!env || !fn) return;
  napi_value global; napi_get_global(env, &global);
  napi_call_function(env, global, fn, 0, nullptr, nullptr);
}
static napi_value OnAccountChange(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1] = {nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  if (accountChanged) napi_release_threadsafe_function(accountChanged, napi_tsfn_abort);
  napi_value name; napi_create_string_utf8(env, "accountChanged", NAPI_AUTO_LENGTH, &name);
  CHECK(napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, callAccountChanged, &accountChanged));
  napi_unref_threadsafe_function(env, accountChanged);
  if (!accountObserver) {
    accountObserver = [NSNotificationCenter.defaultCenter addObserverForName:CKAccountChangedNotification object:nil queue:nil usingBlock:^(NSNotification *) {
      if (accountChanged) napi_call_threadsafe_function(accountChanged, nullptr, napi_tsfn_nonblocking);
    }];
  }
  return undefinedValue(env);
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"userRecordId", nullptr, UserRecordId, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"saveZone", nullptr, SaveZone, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteZones", nullptr, DeleteZones, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listZones", nullptr, ListZones, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"putIfAbsent", nullptr, PutIfAbsent, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"fetch", nullptr, Fetch, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"changes", nullptr, Changes, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteRecords", nullptr, DeleteRecords, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"onAccountChange", nullptr, OnAccountChange, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(*properties), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
