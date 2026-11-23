# Spike: CloudKit as a sync backend beside S3 (#286)

Run on 23 November 2026 with Electron 45.2.3 on macOS 27.2.1 (iMac, Apple silicon), against the container `iCloud.ch.wirhabenzeit.imageflow` and the App ID `ch.wirhabenzeit.imageflow` (team DX96FWY9AX). A second Mac (MacBook, same Apple ID, no profile installed) ran the cross-Mac tests. Items marked *Open* were not tested.

## Files

| File | What it is |
| --- | --- |
| `native/cloudkit.mm` | The Node-API addon: entitlement check, account status, zones, put-if-absent, fetch (head, bytes, file), zone changes, delete, cancel, account-change events, database subscription |
| `store.cjs` | The object store of #278 over the addon: key-to-zone mapping, retries, abort signals |
| `main.cjs` | The Electron main process. Runs one task and prints JSON lines: `status`, `smoke`, `sizes`, `burst`, `race`, `listing`, `listen`, `touch`, `watch`, `zones`, `cleanup` |
| `package.mjs` | Builds the addon and packages and signs the app like `scripts/package-mac.mjs`. `--variant devid \| dev \| adhoc \| noprofile` |
| `race.mjs` | Runs two `race` processes against the same record name |
| `results/` | Raw output of the size, throughput, race and push runs (push payloads reduced to times) |

```sh
node package.mjs --variant devid      # uses ~/Downloads/ImageFlow_Developer_ID-2.provisionprofile
exe="out/devid/ImageFlow CloudKit Spike-darwin-arm64/ImageFlow CloudKit Spike.app/Contents/MacOS/CloudKitSpike"
"$exe" smoke
"$exe" sizes '{"sizes":[20,50,100]}'
node race.mjs devid 10
"$exe" cleanup                        # deletes every spike-* zone
```

## Mapping

One record zone per book in the private database, one record type `Blob` with the fields `data` (bytes, for blobs up to 256 KB), `asset` (larger ones), `size` (int64) and `sha256` (string). The record name is the key below `books/<bookId>/`. `remote.json` and the tombstones `books/<bookId>/deleted.json` live in a zone called `index`, so deleting a book's zone keeps its tombstone. `listPrefixes('books/')` lists zones; `list` and the change feed are `CKFetchRecordZoneChangesOperation` without and with a token, asking only for `size` and `sha256`, so no asset is downloaded. `copy` is left out.

## 1. Packaging

| Build | Result |
| --- | --- |
| Developer ID, iCloud entitlements on the main app, Developer ID profile embedded (`osx-sign` `provisioningProfile`) | Launches; CloudKit works against **Production** only (the profile allows only that environment) |
| Apple Development identity, Mac Development profile | Launches; works against **Development**; runs only on the Macs listed in the profile |
| Ad hoc (`npm run package:mac` without an identity), no entitlements | Launches; the addon reports `entitled: false` |
| Developer ID with the iCloud entitlements but no profile | **Killed at launch** (SIGKILL, `open` reports "Launchd job spawn failed") |
| Any process without the entitlements that calls `CKContainer` | **Crashes** with `EXC_BREAKPOINT` inside CloudKit; this is a trap, not an exception |

- **Only the main app needs the entitlements.** The addon runs in the main process; the Electron helpers keep `allow-jit` only. Set `preAutoEntitlements: false` and give the main app its entitlements explicitly: `application-identifier`, `team-identifier`, `icloud-container-identifiers`, `icloud-services: [CloudKit]`, `icloud-container-environment` and, for push, `aps-environment`.
- **Guard the addon.** It reads its own entitlements (`SecTaskCopyValueForEntitlement`) and never touches CloudKit without them, so ad-hoc builds, `npm run dev` and plain `electron` keep working with sync reported as unavailable.
- **An installed profile hides a missing one.** Double-clicking a `.provisionprofile` installs it system-wide (System Settings → General → Device Management), and macOS then uses it for any app with that App ID. With both profiles installed, the build without a profile launched on this Mac; after removing them, it was killed. Release checks must verify the embedded profile (present, matching App ID and team, environment `Production`, not expired), and test Macs must not have it installed.
- **Linking a container to an App ID took about 13 minutes** to reach CloudKit. Until then, saves fail with `permissionFailure` "Invalid bundle ID for container".
- **Notarization accepts it.** The Developer ID build with the profile embedded was notarized (`notarytool`, accepted), stapled, and Gatekeeper reports `accepted, source=Notarized Developer ID`; it also opened with a quarantine flag set. Copied to the MacBook, which never had the profile installed, it ran with `entitled: true`, Production, account available.

## 2. Native bridge

`native/cloudkit.mm` is about 700 lines of Objective-C++, `store.cjs` about 150 lines of JavaScript. Every call returns a promise, and CloudKit's completion handlers reach JavaScript through a thread-safe function.

- **Progress** comes from `perRecordProgressBlock` as a fraction, per record, for uploads and downloads.
- **Cancellation** passes an operation ID; `cancel(id)` cancels the `CKOperation`, and the promise rejects with `operationCancelled`. `store.cjs` wires that to an `AbortSignal`. A 30 MB upload cancelled at 10% left no record.
- **Errors** reject with `code` (the `CKError` name, such as `zoneNotFound` or `requestRateLimited`), `retryAfter` when CloudKit gives one, and the server's message.
- The Objective-C API has the `…CompletionBlock` names; the newer `…ResultBlock` properties are Swift only.
- Downloaded asset files belong to CloudKit and are removed after the operation, so `download` copies the file from inside the per-record block.
- **Conformance:** `smoke` passes all 20 checks against both Development and Production, including put-if-absent never replacing, missing records and zones, assets from files and from bytes, listing with sizes and modification dates, the index zone, abort, delete, and deleting a book.

## 3. Asset size and throughput

Single files, uploaded and downloaded with SHA-256 checked (Development, this Mac, `results/sizes-dev.jsonl`):

| Size | Upload | Download |
| ---: | ---: | ---: |
| 20 MB | 4.8 s (4.1 MB/s) | 0.6 s (33 MB/s) |
| 50 MB | 7.2 s (7.0 MB/s) | 1.0 s (50 MB/s) |
| 100 MB | 10.5 s (9.5 MB/s) | 1.3 s (75 MB/s) |

200 × 5 MB (1 GB) in a row (`results/burst-*.jsonl`):

| | One at a time | Four in parallel |
| --- | ---: | ---: |
| Upload | 234 s, 4.3 MB/s | 123 s, 8.2 MB/s |
| Per upload, median / 95th percentile | 1.10 s / 1.45 s | 2.35 s / 2.66 s |
| Download | 84 s, 12 MB/s | 20 s, 50 MB/s |
| Listing the 200 records | 1.3 s | 1.2 s |

- **No throttling.** No `requestRateLimited` or `zoneBusy` came back in the two runs (2 GB, 400 uploads and 400 downloads) or anywhere else in the spike, about 3.5 GB in all, so nothing was retried.
- Every upload has about a second of fixed cost, so originals should upload a few at a time.
- **250 MB** uploaded to Production in 33 s (7.5 MB/s). No size limit was reached; larger sizes were not tried.
- **Downloads on the other Mac** (MacBook, network limited to about 29 Mbit/s): 20 + 50 + 100 + 250 MB one at a time at 3.4 MB/s, eight 50 MB files four at a time at 3.6 MB/s, all SHA-256 verified. Parallel downloads only share the line; there, the network is the limit, not CloudKit. Figures for downloads on the uploading Mac (above) come from its local cache.
- **CloudKit keeps its own copy of every asset** it uploads or downloads, in `~/Library/Caches/CloudKit/<bundle ID>/…/Assets`. After these tests it held 3.0 GB on the iMac, and deleting the zones did not shrink it. The files carry `com.apple.cscachefs`, which suggests the system purges them under disk pressure (not verified). There is no API to evict them. For a book whose originals are synced, a downloaded original therefore exists twice until the system purges the cache.
- **Downloaded asset files carry `com.apple.quarantine`** set by `cloudd`; `download` should copy without extended attributes (or remove that one) so originals in a book are not quarantined.

## 4. Conditional create

A new record saved with `savePolicy = ifServerRecordUnchanged` fails with `serverRecordChanged` when the name exists, which `putIfAbsent` reports as `existed: true`. `race.mjs` started two processes writing the same name within 0 to 3 ms of each other: in 10 rounds, exactly one created it, and both then read the winner's content. Both processes go through this Mac's `cloudd`, so the same was run from two Macs (`racemany`): both fired at 0 to 27 ms after the same second, ten rounds. Every round had exactly one creator (iMac 5, MacBook 5) and both Macs read the same winner in all ten.

## 5. Listing

A zone with 3000 small records:

| | Time |
| --- | ---: |
| Seeding, 8 batches of 400 | 16.8 s |
| Full listing (change feed without a token) | 9.3 s |
| Changes since the token, nothing new | 0.28 s |
| Changes since the token, 10 added and 1 deleted | 0.37 s (both reported) |

A full listing runs at about 320 records a second, so the change token is what makes routine sync cheap: a Mac stores one token per book and asks only for what changed. The token is 376 bytes base64. This replaces the commit header cache of ADR 0012. `listPrefixes` is one zone listing.

## 6. Errors

| Condition | How it shows | Sync status |
| --- | --- | --- |
| Build without entitlements | `status()` → `entitled: false` | Sync unavailable in this build |
| Offline (Wi-Fi off) | `networkFailure` (in flight), then `networkUnavailable` at once, both with `retryAfter: 3`; the account status stays `available` | *Offline*; wait for the network rather than retry on a timer |
| iCloud turned off for the app (System Settings → iCloud) | `accountChanged` event, `accountStatus: noAccount`, writes fail at once with `notAuthenticated` "CloudKit access was denied by user settings"; turning it back on gives `available` and working writes within a second | *iCloud is off for ImageFlow* (or not signed in; the status does not tell the two apart) |
| Not signed in to iCloud | `accountStatus: noAccount` | *Sign in to iCloud* |
| Restricted (parental controls, managed Mac) | `accountStatus: restricted` | *iCloud restricted on this Mac* |
| Account changed while running | `CKAccountChanged` notification (`onAccountChange`). It also fired twice without any account change, around Wi-Fi coming back | Re-read the status and compare the user record ID; only a different ID means a different remote |
| Rate limited, zone busy, service unavailable | `requestRateLimited`, `zoneBusy`, `serviceUnavailable` with `retryAfter` | Retry after the given time (in `store.cjs`) |
| Quota exceeded | `quotaExceeded` | *iCloud storage full* |

Observed on the MacBook with `watch` (account status and a test write every 5 seconds): offline, iCloud off for the app, and the account-change event. *Open:* signing out, restricted, quota exceeded; those rows are from the documentation.

## 7. Schema

Saving in Development created `Blob` with its four fields. After **Deploy Schema Changes** in the CloudKit Console, the Developer ID build passed `smoke` against Production unchanged. No indexes are needed: every read is by record ID or through the zone change feed, never a query. A blob kind or book layout change is a new key, not a schema change, so the deployed schema should not need another change.

## 8. Push

The Developer ID Electron build registers with APNs (`pushNotifications.registerForAPNSNotifications()`, needs `aps-environment` in the entitlements and profile) and saves a `CKDatabaseSubscription` with silent pushes. A write from another process on the same Mac did not produce a push, as expected: CloudKit does not notify the device that made the change. Across Macs, the MacBook listened for ten minutes while the iMac wrote a record every 30 seconds: **19 of 19 writes arrived as pushes, 0.04 to 0.14 s after the save returned** (`results/push-two-macs.json`). Each push names the subscription and the zone (`met.zid`), so a Mac knows which book changed without listing anything.

## Recommendation

**Build it**, as the default backend for Macs signed in to iCloud, with S3 kept as the bring-your-own option. Every question the spike had to answer came out in CloudKit's favour:

- **Packaging works**, with one release-time trap: a profile missing from the bundle kills the app at launch, and a Mac with the profile installed hides it. The release checks must verify the embedded profile, and the addon must refuse to touch CloudKit without its entitlements.
- **The store maps cleanly.** A real conditional create (one winner in every round, across two Macs), zones as books (one call deletes a book), and change tokens that list a book's news in 0.3 s instead of 9 s for a full listing. A book's news also arrives as a push within a fraction of a second.
- **No throttling** at the volumes a book needs (about 3.5 GB in all, 400 uploads in a row), and assets of at least 250 MB.
- **The bridge is small**: about 700 lines of Objective-C++ and 150 of JavaScript, with progress and cancellation.

Costs to accept, beyond those the issue lists:

- **CloudKit's asset cache** keeps another copy of every original until the system purges it.
- **Spurious account-change events**: decide on the user record ID, not on the event.
- **Each new App ID–container link takes minutes to propagate**, and only the iMac and MacBook can run development builds against the Development environment.

### Order and ADR 0012

- **#278 first, unchanged**, apart from `copy` being optional (already so). Add the change feed as an optional store capability (`changes(prefix, token)`), so the commit header cache is the fallback for stores without one.
- **CloudKit after #281** (S3), not instead of it: S3 keeps the S3 store and its conformance suite honest, and CloudKit cannot run in CI. Insert it as a new step between #281 and #282, so the backend choice in #280's setting has two entries before automatic sync (#284) ships. Push wakes automatic sync, so it belongs with #284.
- **Amend ADR 0012:** the backend setting offers iCloud (the default when the Mac is signed in and the build is entitled) and S3; the trust rule holds unchanged, since the private database is authenticated as the user; the remote identity is the container plus the iCloud user record ID; *ImageFlow Cloud* moves further back.
- **Signing:** `docs/signing.md` and the release workflow gain the Developer ID profile (as a secret, embedded by `osx-sign`), the main-app entitlements, and a check of the embedded profile before notarization.
