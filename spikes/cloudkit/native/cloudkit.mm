// CloudKit spike (#286): the object store operations of #278 over the user's private CloudKit database.
// One record zone per book, one generic record type (`Blob`), record names are the key below the book's prefix.
// Every call returns a promise; completion handlers run on CloudKit's queues and reach JavaScript through a
// thread-safe function. Long operations take an `id` so JavaScript can cancel them, and an optional progress callback.
#import <CloudKit/CloudKit.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <node_api.h>
#include <string>

static NSString *const kRecordType = @"Blob";
// A record holds at most 1 MB in all; smaller blobs go inline, larger ones as an asset.
static const NSUInteger kInlineLimit = 256 * 1024;

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, #call " failed"); return nullptr; } } while (0)

typedef void (^JSWork)(napi_env env);

// ---------- Entitlements: CloudKit traps (EXC_BREAKPOINT) in a process without them, so check before touching it.

static id copyEntitlement(NSString *name) {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) return nil;
  CFTypeRef value = SecTaskCopyValueForEntitlement(task, (__bridge CFStringRef)name, nullptr);
  CFRelease(task);
  return CFBridgingRelease(value);
}

static NSString *entitledContainer() {
  NSArray *services = copyEntitlement(@"com.apple.developer.icloud-services");
  NSArray *containers = copyEntitlement(@"com.apple.developer.icloud-container-identifiers");
  if (![services isKindOfClass:NSArray.class] || ![services containsObject:@"CloudKit"]) return nil;
  if (![containers isKindOfClass:NSArray.class] || !containers.count) return nil;
  return containers.firstObject;
}

// ---------- Promise plumbing

struct Pending {
  napi_deferred deferred = nullptr;
  napi_threadsafe_function tsfn = nullptr;
  napi_ref progress = nullptr;
  bool settled = false;
};

static void callJs(napi_env env, napi_value, void *, void *data) {
  JSWork work = (__bridge_transfer JSWork)data;
  if (env) work(env);
}

static Pending *newPending(napi_env env, napi_value *promise, napi_value progress) {
  Pending *pending = new Pending();
  napi_create_promise(env, &pending->deferred, promise);
  napi_value name;
  napi_create_string_utf8(env, "cloudkit", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, nullptr, callJs, &pending->tsfn);
  napi_valuetype type = napi_undefined;
  if (progress) napi_typeof(env, progress, &type);
  if (type == napi_function) napi_create_reference(env, progress, 1, &pending->progress);
  return pending;
}

static void enqueue(Pending *pending, JSWork work) {
  napi_call_threadsafe_function(pending->tsfn, (__bridge_retained void *)[work copy], napi_tsfn_blocking);
}

// Settles once; later calls are ignored. `build` runs on the JavaScript thread.
typedef napi_value (^Builder)(napi_env env);
static void settle(Pending *pending, bool reject, Builder build) {
  @synchronized ([NSNull null]) {
    if (pending->settled) return;
    pending->settled = true;
  }
  enqueue(pending, ^(napi_env env) {
    napi_value value = build(env);
    if (reject) napi_reject_deferred(env, pending->deferred, value);
    else napi_resolve_deferred(env, pending->deferred, value);
    if (pending->progress) napi_delete_reference(env, pending->progress);
    // Kept, not deleted: a late progress callback may still read `settled`. A few bytes per call, fine for a spike.
    pending->progress = nullptr;
  });
  napi_release_threadsafe_function(pending->tsfn, napi_tsfn_release);
}

static void reportProgress(Pending *pending, double fraction) {
  if (!pending->progress || pending->settled) return;
  enqueue(pending, ^(napi_env env) {
    if (!pending->progress) return;
    napi_value fn, global, argument;
    napi_get_reference_value(env, pending->progress, &fn);
    napi_get_global(env, &global);
    napi_create_double(env, fraction, &argument);
    napi_call_function(env, global, fn, 1, &argument, nullptr);
  });
}

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

static napi_value errorValue(napi_env env, NSError *error) {
  napi_value message = str(env, error.localizedDescription), result;
  napi_create_error(env, nullptr, message, &result);
  bool cloudKit = [error.domain isEqualToString:CKErrorDomain];
  setProp(env, result, "domain", str(env, error.domain));
  setProp(env, result, "code", str(env, cloudKit ? errorName(error.code) : [NSString stringWithFormat:@"%@:%ld", error.domain, (long)error.code]));
  setProp(env, result, "ckCode", num(env, error.code));
  NSNumber *retry = error.userInfo[CKErrorRetryAfterKey];
  if (retry) setProp(env, result, "retryAfter", num(env, retry.doubleValue));
  NSString *server = error.userInfo[@"ServerErrorDescription"];
  if (server) setProp(env, result, "serverMessage", str(env, server));
  return result;
}

static void rejectWith(Pending *pending, NSError *error) {
  settle(pending, true, ^napi_value(napi_env env) { return errorValue(env, error); });
}

// ---------- Arguments

static NSString *argString(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return nil;
  std::string buffer(length, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), length + 1, &length);
  return [NSString stringWithUTF8String:buffer.c_str()];
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
  if (napi_get_array_length(env, value, &length) != napi_ok) return result;
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    napi_get_element(env, value, index, &item);
    NSString *string = argString(env, item);
    if (string) [result addObject:string];
  }
  return result;
}

// ---------- Container state

static CKContainer *container;
static CKDatabase *database;
static NSMutableDictionary<NSNumber *, NSOperation *> *running;
static NSString *environmentName;

static void track(napi_env env, napi_value options, CKOperation *operation) {
  napi_value id = prop(env, options, "id");
  if (!id) return;
  int64_t key = 0;
  napi_get_value_int64(env, id, &key);
  @synchronized (running) { running[@(key)] = operation; }
  NSNumber *number = @(key);
  void (^previous)(void) = operation.completionBlock;
  operation.completionBlock = ^{
    if (previous) previous();
    @synchronized (running) { [running removeObjectForKey:number]; }
  };
}

static void configure(CKOperation *operation) {
  // Measured interactively; background sync would use utility.
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
  setProp(env, object, "size", num(env, size.doubleValue));
  setProp(env, object, "lastModified", num(env, record.modificationDate.timeIntervalSince1970 * 1000));
  NSString *sha = record[@"sha256"];
  if (sha) setProp(env, object, "sha256", str(env, sha));
  return object;
}

// ---------- Exports

// status(): { entitled, container?, environment?, accountStatus? }. Never touches CloudKit without the entitlement.
static napi_value Status(napi_env env, napi_callback_info) {
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  NSString *identifier = entitledContainer();
  if (!identifier) {
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object;
      napi_create_object(env, &object);
      napi_value no;
      napi_get_boolean(env, false, &no);
      setProp(env, object, "entitled", no);
      return object;
    });
    return promise;
  }
  if (!container) {
    container = [CKContainer containerWithIdentifier:identifier];
    database = container.privateCloudDatabase;
    running = [NSMutableDictionary dictionary];
    id environment = copyEntitlement(@"com.apple.developer.icloud-container-environment");
    environmentName = [environment isKindOfClass:NSString.class] ? environment : @"Production";
  }
  [container accountStatusWithCompletionHandler:^(CKAccountStatus status, NSError *error) {
    if (error) return rejectWith(pending, error);
    NSString *name = @[@"couldNotDetermine", @"available", @"restricted", @"noAccount", @"temporarilyUnavailable"][MIN((NSInteger)status, 4)];
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object, yes;
      napi_create_object(env, &object);
      napi_get_boolean(env, true, &yes);
      setProp(env, object, "entitled", yes);
      setProp(env, object, "container", str(env, identifier));
      setProp(env, object, "environment", str(env, environmentName));
      setProp(env, object, "accountStatus", str(env, name));
      return object;
    });
  }];
  return promise;
}

static bool requireContainer(napi_env env) {
  if (container) return true;
  napi_throw_error(env, "notInitialized", "Call status() first; this process may not have the CloudKit entitlement.");
  return false;
}

// saveZone(zone)
static napi_value SaveZone(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]);
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKModifyRecordZonesOperation *operation = [[CKModifyRecordZonesOperation alloc] initWithRecordZonesToSave:@[[[CKRecordZone alloc] initWithZoneID:zoneID(zone)]] recordZoneIDsToDelete:nil];
  configure(operation);
  operation.modifyRecordZonesCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    if (error) return rejectWith(pending, error);
    settle(pending, false, ^napi_value(napi_env env) { return undefinedValue(env); });
  };
  [database addOperation:operation];
  return promise;
}

// deleteZones([zone])
static napi_value DeleteZones(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSMutableArray *ids = [NSMutableArray array];
  for (NSString *zone in argStrings(env, argv[0])) [ids addObject:zoneID(zone)];
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKModifyRecordZonesOperation *operation = [[CKModifyRecordZonesOperation alloc] initWithRecordZonesToSave:nil recordZoneIDsToDelete:ids];
  configure(operation);
  operation.modifyRecordZonesCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    if (error) return rejectWith(pending, error);
    settle(pending, false, ^napi_value(napi_env env) { return undefinedValue(env); });
  };
  [database addOperation:operation];
  return promise;
}

// listZones(): [zoneName]
static napi_value ListZones(napi_env env, napi_callback_info) {
  if (!requireContainer(env)) return nullptr;
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKFetchRecordZonesOperation *operation = [CKFetchRecordZonesOperation fetchAllRecordZonesOperation];
  configure(operation);
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  operation.perRecordZoneCompletionBlock = ^(CKRecordZoneID *zone, CKRecordZone *, NSError *) {
    @synchronized (names) { [names addObject:zone.zoneName]; }
  };
  operation.fetchRecordZonesCompletionBlock = ^(NSDictionary *, NSError *error) {
    if (error) return rejectWith(pending, error);
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value array;
      napi_create_array(env, &array);
      uint32_t index = 0;
      for (NSString *name in names) {
        if ([name isEqualToString:CKRecordZoneDefaultName]) continue;
        napi_set_element(env, array, index++, str(env, name));
      }
      return array;
    });
  };
  [database addOperation:operation];
  return promise;
}

// putIfAbsent(zone, name, { bytes?: Buffer, file?: string, size, sha256? }, { id?, onProgress? }): { created }
// A new record saved with `ifServerRecordUnchanged` fails with serverRecordChanged when the name exists:
// a conditional create.
static napi_value PutIfAbsent(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4] = {nullptr, nullptr, nullptr, nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]), *name = argString(env, argv[1]);
  napi_value bytesValue = prop(env, argv[2], "bytes"), fileValue = prop(env, argv[2], "file"), shaValue = prop(env, argv[2], "sha256");
  CKRecord *record = [[CKRecord alloc] initWithRecordType:kRecordType recordID:[[CKRecordID alloc] initWithRecordName:name zoneID:zoneID(zone)]];
  NSURL *temporary = nil;
  if (bytesValue) {
    void *data; size_t length;
    CHECK(napi_get_buffer_info(env, bytesValue, &data, &length));
    record[@"size"] = @(length);
    if (length <= kInlineLimit) {
      record[@"data"] = [NSData dataWithBytes:data length:length];
    } else {
      temporary = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString]];
      [[NSData dataWithBytesNoCopy:data length:length freeWhenDone:NO] writeToURL:temporary atomically:NO];
      record[@"asset"] = [[CKAsset alloc] initWithFileURL:temporary];
    }
  } else if (fileValue) {
    NSString *path = argString(env, fileValue);
    NSNumber *size = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil][NSFileSize];
    record[@"size"] = size ?: @0;
    record[@"asset"] = [[CKAsset alloc] initWithFileURL:[NSURL fileURLWithPath:path]];
  } else {
    napi_throw_type_error(env, nullptr, "putIfAbsent needs bytes or file");
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
  operation.perRecordSaveBlock = ^(CKRecordID *, CKRecord *, NSError *error) { recordError = error; };
  operation.modifyRecordsCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    if (temporary) [NSFileManager.defaultManager removeItemAtURL:temporary error:nil];
    NSError *cause = recordError ?: error;
    if (cause.code == CKErrorPartialFailure) cause = [cause.userInfo[CKPartialErrorsByItemIDKey] allValues].firstObject ?: cause;
    if (cause && cause.code == CKErrorServerRecordChanged) {
      return settle(pending, false, ^napi_value(napi_env env) {
        napi_value object, no; napi_create_object(env, &object); napi_get_boolean(env, false, &no);
        setProp(env, object, "created", no); return object;
      });
    }
    if (cause) return rejectWith(pending, cause);
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object, yes; napi_create_object(env, &object); napi_get_boolean(env, true, &yes);
      setProp(env, object, "created", yes); return object;
    });
  };
  track(env, argv[3], operation);
  [database addOperation:operation];
  return promise;
}

// fetch(zone, name, { mode: 'head' | 'bytes' | 'file', file?, id?, onProgress? }):
//   head  → { name, size, lastModified, sha256? } or undefined
//   bytes → { ..., bytes: Buffer } or undefined
//   file  → { ... } after writing the blob to `file` (a new file), or undefined
static napi_value Fetch(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3] = {nullptr, nullptr, nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]), *name = argString(env, argv[1]);
  napi_value modeValue = prop(env, argv[2], "mode"), fileValue = prop(env, argv[2], "file");
  NSString *mode = modeValue ? argString(env, modeValue) : @"head";
  NSString *destination = fileValue ? argString(env, fileValue) : nil;
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
    found = record; recordError = error;
    if (!record) return;
    // The downloaded asset file belongs to CloudKit and is removed after the operation: read or copy it now.
    CKAsset *asset = record[@"asset"];
    NSData *inline_ = record[@"data"];
    if ([mode isEqualToString:@"bytes"]) {
      bytes = inline_ ?: (asset.fileURL ? [NSData dataWithContentsOfURL:asset.fileURL options:NSDataReadingMappedIfSafe error:&recordError] : nil);
    } else if ([mode isEqualToString:@"file"] && destination) {
      NSURL *target = [NSURL fileURLWithPath:destination];
      if (inline_) [inline_ writeToURL:target options:NSDataWritingWithoutOverwriting error:&recordError];
      else if (asset.fileURL) [NSFileManager.defaultManager copyItemAtURL:asset.fileURL toURL:target error:&recordError];
    }
  };
  operation.fetchRecordsCompletionBlock = ^(NSDictionary *, NSError *error) {
    NSError *cause = recordError ?: error;
    if (cause.code == CKErrorPartialFailure) cause = [cause.userInfo[CKPartialErrorsByItemIDKey] allValues].firstObject ?: cause;
    if (cause && cause.code == CKErrorUnknownItem) return settle(pending, false, ^napi_value(napi_env env) { return undefinedValue(env); });
    if (cause) return rejectWith(pending, cause);
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object = describeRecord(env, found);
      if (bytes) {
        napi_value buffer;
        napi_create_buffer_copy(env, bytes.length, bytes.bytes, nullptr, &buffer);
        setProp(env, object, "bytes", buffer);
      }
      return object;
    });
  };
  track(env, argv[2], operation);
  [database addOperation:operation];
  return promise;
}

// changes(zone, token?: base64): { changed: [{ name, size, lastModified }], deleted: [name], token: base64 }
// Without a token, every record of the zone (this is `list`). Assets are never downloaded.
static napi_value Changes(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3] = {nullptr, nullptr, nullptr};
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]);
  CKServerChangeToken *token = nil;
  napi_valuetype type = napi_undefined;
  if (argc > 1) napi_typeof(env, argv[1], &type);
  if (type == napi_string) {
    NSData *data = [[NSData alloc] initWithBase64EncodedString:argString(env, argv[1]) options:0];
    token = [NSKeyedUnarchiver unarchivedObjectOfClass:CKServerChangeToken.class fromData:data error:nil];
  }
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKFetchRecordZoneChangesConfiguration *configuration = [CKFetchRecordZoneChangesConfiguration new];
  configuration.previousServerChangeToken = token;
  configuration.desiredKeys = @[@"size", @"sha256"];
  CKRecordZoneID *zid = zoneID(zone);
  CKFetchRecordZoneChangesOperation *operation = [[CKFetchRecordZoneChangesOperation alloc] initWithRecordZoneIDs:@[zid] configurationsByRecordZoneID:@{zid: configuration}];
  operation.fetchAllChanges = YES;
  configure(operation);
  NSMutableArray<CKRecord *> *changed = [NSMutableArray array];
  NSMutableArray<NSString *> *deleted = [NSMutableArray array];
  __block CKServerChangeToken *latest = nil;
  __block NSError *zoneError = nil;
  operation.recordWasChangedBlock = ^(CKRecordID *, CKRecord *record, NSError *) {
    if (record) @synchronized (changed) { [changed addObject:record]; }
  };
  operation.recordWithIDWasDeletedBlock = ^(CKRecordID *recordID, CKRecordType) {
    @synchronized (deleted) { [deleted addObject:recordID.recordName]; }
  };
  operation.recordZoneChangeTokensUpdatedBlock = ^(CKRecordZoneID *, CKServerChangeToken *serverToken, NSData *) { latest = serverToken; };
  operation.recordZoneFetchCompletionBlock = ^(CKRecordZoneID *, CKServerChangeToken *serverToken, NSData *, BOOL, NSError *error) {
    if (serverToken) latest = serverToken;
    if (error) zoneError = error;
  };
  operation.fetchRecordZoneChangesCompletionBlock = ^(NSError *error) {
    NSError *cause = zoneError ?: error;
    if (cause.code == CKErrorPartialFailure) cause = [cause.userInfo[CKPartialErrorsByItemIDKey] allValues].firstObject ?: cause;
    if (cause) return rejectWith(pending, cause);
    NSData *tokenData = latest ? [NSKeyedArchiver archivedDataWithRootObject:latest requiringSecureCoding:YES error:nil] : nil;
    settle(pending, false, ^napi_value(napi_env env) {
      napi_value object, changedArray, deletedArray;
      napi_create_object(env, &object);
      napi_create_array_with_length(env, changed.count, &changedArray);
      for (NSUInteger index = 0; index < changed.count; ++index) napi_set_element(env, changedArray, (uint32_t)index, describeRecord(env, changed[index]));
      napi_create_array_with_length(env, deleted.count, &deletedArray);
      for (NSUInteger index = 0; index < deleted.count; ++index) napi_set_element(env, deletedArray, (uint32_t)index, str(env, deleted[index]));
      setProp(env, object, "changed", changedArray);
      setProp(env, object, "deleted", deletedArray);
      if (tokenData) setProp(env, object, "token", str(env, [tokenData base64EncodedStringWithOptions:0]));
      return object;
    });
  };
  [database addOperation:operation];
  return promise;
}

// deleteRecords(zone, [name]): deletes in batches of 400 (CloudKit's per-request limit).
static napi_value DeleteRecords(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]);
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
    settle(pending, false, ^napi_value(napi_env env) { return undefinedValue(env); });
  };
  [database addOperation:operation];
  return promise;
}

// saveMany(zone, [{ name, bytes }]): one modify operation, for seeding listing tests. Returns the number saved.
static napi_value SaveMany(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  NSString *zone = argString(env, argv[0]);
  uint32_t length = 0;
  napi_get_array_length(env, argv[1], &length);
  NSMutableArray<CKRecord *> *records = [NSMutableArray array];
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item; napi_get_element(env, argv[1], index, &item);
    void *data; size_t size;
    napi_get_buffer_info(env, prop(env, item, "bytes"), &data, &size);
    CKRecord *record = [[CKRecord alloc] initWithRecordType:kRecordType recordID:[[CKRecordID alloc] initWithRecordName:argString(env, prop(env, item, "name")) zoneID:zoneID(zone)]];
    record[@"size"] = @(size);
    record[@"data"] = [NSData dataWithBytes:data length:size];
    [records addObject:record];
  }
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKModifyRecordsOperation *operation = [[CKModifyRecordsOperation alloc] initWithRecordsToSave:records recordIDsToDelete:nil];
  operation.savePolicy = CKRecordSaveIfServerRecordUnchanged;
  operation.atomic = NO;
  configure(operation);
  __block NSUInteger saved = 0;
  __block NSError *firstError = nil;
  operation.perRecordSaveBlock = ^(CKRecordID *, CKRecord *, NSError *error) {
    if (!error) saved++;
    else if (error.code != CKErrorServerRecordChanged && !firstError) firstError = error;
  };
  operation.modifyRecordsCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    if (firstError) return rejectWith(pending, firstError);
    if (error && error.code != CKErrorPartialFailure) return rejectWith(pending, error);
    settle(pending, false, ^napi_value(napi_env env) { return num(env, saved); });
  };
  [database addOperation:operation];
  return promise;
}

// cancel(id): cancels a running putIfAbsent or fetch; its promise rejects with operationCancelled.
static napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  int64_t key = 0;
  napi_get_value_int64(env, argv[0], &key);
  NSOperation *operation;
  @synchronized (running) { operation = running[@(key)]; }
  [operation cancel];
  napi_value result;
  napi_get_boolean(env, operation != nil, &result);
  return result;
}

// onAccountChange(fn): calls fn() whenever the iCloud account changes (sign-out, another Apple ID).
static napi_threadsafe_function accountChanged;
static void callAccountChanged(napi_env env, napi_value fn, void *, void *) {
  if (!env) return;
  napi_value global; napi_get_global(env, &global);
  napi_call_function(env, global, fn, 0, nullptr, nullptr);
}
static napi_value OnAccountChange(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  napi_value name; napi_create_string_utf8(env, "accountChanged", NAPI_AUTO_LENGTH, &name);
  if (accountChanged) return nullptr;
  napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, callAccountChanged, &accountChanged);
  napi_unref_threadsafe_function(env, accountChanged);
  [NSNotificationCenter.defaultCenter addObserverForName:CKAccountChangedNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    napi_call_threadsafe_function(accountChanged, nullptr, napi_tsfn_nonblocking);
  }];
  return nullptr;
}

// saveSubscription(id): a database subscription on the private database with silent pushes (content-available),
// so another Mac is told to pull. Saving the same ID again replaces it.
static napi_value SaveSubscription(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  if (!requireContainer(env)) return nullptr;
  CKDatabaseSubscription *subscription = [[CKDatabaseSubscription alloc] initWithSubscriptionID:argString(env, argv[0])];
  CKNotificationInfo *notification = [CKNotificationInfo new];
  notification.shouldSendContentAvailable = YES;
  subscription.notificationInfo = notification;
  napi_value promise;
  Pending *pending = newPending(env, &promise, nullptr);
  CKModifySubscriptionsOperation *operation = [[CKModifySubscriptionsOperation alloc] initWithSubscriptionsToSave:@[subscription] subscriptionIDsToDelete:nil];
  configure(operation);
  operation.modifySubscriptionsCompletionBlock = ^(NSArray *, NSArray *, NSError *error) {
    if (error) return rejectWith(pending, error);
    settle(pending, false, ^napi_value(napi_env env) { return undefinedValue(env); });
  };
  [database addOperation:operation];
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"saveZone", nullptr, SaveZone, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteZones", nullptr, DeleteZones, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listZones", nullptr, ListZones, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"putIfAbsent", nullptr, PutIfAbsent, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"fetch", nullptr, Fetch, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"changes", nullptr, Changes, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteRecords", nullptr, DeleteRecords, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"saveMany", nullptr, SaveMany, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"onAccountChange", nullptr, OnAccountChange, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"saveSubscription", nullptr, SaveSubscription, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(*properties), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
