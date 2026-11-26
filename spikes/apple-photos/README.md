# Spike: Apple Photos as a source provider (#327)

Run on 25 November 2026, macOS 27.2.1 (iMac, Apple silicon), Electron 45.2.3, against the system Photos library on this Mac: 33,317 still images, iCloud Photos with **Optimize Mac Storage**. Read only: no change request. The first run allowed no iCloud downloads; a second (sections 4, 6, 7) downloaded a few photos and watched a test photo edited by hand in Photos. Results are counts and durations; nothing of the photos themselves was recorded.

| File | What it is |
| --- | --- |
| `native/photos.mm` | Node-API addon: authorization, census, metadata, identifiers, image requests, a native drop target, a change observer |
| `main.cjs` | Electron main process: runs a task list from `*.tasks.json` and writes JSON lines; with `"stay": true` it also opens a web drop target |
| `build.sh` | Copies Electron, adds the addon and `NSPhotoLibraryUsageDescription`, signs with hardened runtime. `entitled` adds `com.apple.security.personal-information.photos-library`, `bare` does not |

```sh
ELECTRON=…/node_modules/electron/dist/Electron.app IDENTITY=<Developer ID hash> ./build.sh entitled
echo '{"output":"/tmp/r.jsonl","tasks":[["status"],["census"],["identity",{"limit":500}]]}' > /tmp/r.tasks.json
open -n -a "out/entitled/Photos Spike.app" --args /tmp/r.tasks.json   # `open`, so the app, not the terminal, is the one asking
```

## 1. Access (issue question 2): answered

- **The entitlement is required.** Hardened runtime without `com.apple.security.personal-information.photos-library`: `requestAuthorization` answers `denied` at once, with no prompt, and the app stays denied. With it (and `NSPhotoLibraryUsageDescription` in Info.plist): the system prompt appears, naming the app, and after Allow the status is `authorized`.
- **Only the main app needs it.** PhotoKit ran inside a Node-API addon in Electron's main process; the helpers kept `allow-jit` only. ImageFlow's Info.plist gets the usage description, and `resources/entitlements.mac.plist` and `entitlements.icloud.mac.plist` (main app) get the entitlement. No provisioning profile is needed; it is not a restricted entitlement.
- **No sandbox**, as ImageFlow has none; a reported Electron failure was the app sandbox, not PhotoKit.
- Limited access ("selected photos only") is annotated for iOS only in the SDK. *Open:* whether the macOS prompt offers it.
- *Open:* a notarized build; an ad-hoc or unsigned dev build (without hardened runtime, TCC attributes the request differently).

## 2. Native code (question 3): an addon, like CloudKit

The addon is about 250 lines and needs no helper app. PhotoKit's handlers run on its own queues and reach JavaScript through a thread-safe function, as in `desktop/native/cloudkit.mm`. Synchronous image requests on a background queue were simplest; a provider would use asynchronous ones, for cancellation (`cancelImageRequest:`) and iCloud progress (`progressHandler`). `registerChangeObserver` and the macOS 27 `registerPersistentChangesObserver` work from the addon too.

## 3. Identity (question 4): answered by the API

| | Measured over 500 photos |
| --- | --- |
| `localIdentifier` | 43 characters, `<UUID>/L0/001` |
| Local → `PHCloudIdentifier` | 187 ms for all 500 (0.4 ms each), no errors |
| `archivalStringValue` (macOS 15.2+) | 69 characters, three parts separated by `:` |
| Archival string → back → local | 147 ms; 500 of 500 resolve to the same local identifier |
| `localIdentifierMappingsForSyncedCloudIdentifiers` (macOS 27) | 2.6 ms; 500 of 500 resolve |

Apple's answer on the developer forums ([thread 833047](https://developer.apple.com/forums/thread/833047)): `localIdentifier` "should not be considered for long-term persistence"; `PHCloudIdentifier` "is the only type that is guaranteed to be consistent through all scenarios". Keep both, and fall back to the cloud identifier when the local one no longer resolves.

**Locator:** `{ provider: 'photos', cloud: <archival string>, local?: <localIdentifier>, name? }`. `cloud` is portable; `local` is this Mac's own and is never synced (reach `mac`, with `shared` dropping `local` and `adopt` keeping this Mac's), like `linked`'s path. Without iCloud Photos, a cloud identifier still resolves in its own library and, on another, falls back to matching content (`PHPhotosErrorMultipleIdentifiersFound` when it is ambiguous); the synced-only mapping avoids that. *Open:* library repair, a moved library, and a second Mac (all should hold by Apple's statement; not tried).

## 4. Revisions (question 5): `modificationDate` is useless, `adjustmentTimestamp` is the one

Census of the 33,317 images:

| | Photos |
| --- | ---: |
| Never edited, yet `modificationDate` more than a day after capture | 28,927 (87 %) |
| Edited at some time (`adjustmentTimestamp` set) | 4,238 |
| … and `modificationDate` newer than the edit | 3,502 |
| … and `modificationDate` **older** than the edit (by more than 1 s) | 736 |
| Edited and later reverted (`hasAdjustments` false) | 0 |

`modificationDate` moves for things that are no edit (analysis, sync, favourites, metadata), so as a revision it would invalidate nearly every photo. It also misses edits: in 736 photos it is older than the last edit. **`adjustmentTimestamp`** (macOS 15+) is documented as the time of the last edit, also of a revert. So:

- `contentRevision` = `adjustmentTimestamp` (or `none`) + `pixelWidth × pixelHeight` + `originalResourceChoice` (RAW or JPEG base, macOS 27). This keys previews and, unlike Lightroom, can also key full-resolution renders: Photos renders deterministically (below), and nothing but an edit changes the pixels.
- `revision` = `contentRevision` + a hash of the caption (and keywords). A caption edit then refreshes the provided caption without a new preview.

**Watched on one test photo** (a HEIC, 3024 × 4032, edited by hand in Photos while the spike polled every 2 s and listened to `photoLibraryDidChange`):

| Edit in Photos | `adjustmentTimestamp` | `modificationDate` | Size | `assetContentChanged` | 1400 px preview |
| --- | --- | --- | --- | --- | --- |
| A metadata edit (not favourite, caption, date or keywords) | — | moved | — | no | same |
| Crop and adjust | set to the edit's time | moved (20 ms later) | 3024 × 4032 → 2934 × 3912 | yes | new picture |
| *(nothing, 10 s later)* | — | **moved** | — | no | same |
| Caption | — | moved | — | no | same; caption hash changed |
| Favourite | — | moved | — | no | same |
| Revert to Original | **set to the revert's time**; `hasAdjustments` false, format `none` | moved | back to 3024 × 4032 | yes | **byte-identical to the original's** (same digest as before the edit) |

So `adjustmentTimestamp` moves on every visual edit, a revert included, and on nothing else; `modificationDate` moves on everything, also on its own. `photoLibraryDidChange` came within about a second of each edit, with `changeDetailsForObject:` saying whether the photo's content changed: no poll needed. A revert gives back the very same bytes, so the host's digest check (a new preview with the old digest is no change) spares the downstream work. The size reported for the asset is the edited one at once, which is what layout and the resolution checks need.

*Open:* rotate on its own, edits made on an iPhone and synced in, and `adjustmentTimestamp` across a second Mac (it should sync with the edit).

## 5. Facts and titles (question 6)

- Size (`pixelWidth`, `pixelHeight`: the current, edited size), capture date (`creationDate`), place (`location`: 60 % of these photos), camera type (`contentType`): from the asset, about 0.25 ms per photo for 33,317 photos in 8.4 s, the first fetch of the whole library.
- **Captions and keywords: yes, from macOS 27** (`PHAsset.extendedMetadata`: `caption`, `originalFilename`, `keywords`). 2,000 photos in 0.46 s with `prefetchAssetExtendedMetadata`, 1.36 s without. Five of the 2,000 had a caption.
- **Titles: no.** PhotoKit has no title. Photos' AppleScript has one (`name`), and `description` and `keywords`, but that needs Photos running and the Apple Events entitlement and prompt; not worth it for a title. So a Photos photo inherits a caption (macOS 27) and no title; the book's own fields serve as usual.
- Before macOS 27 there is no caption either. A provider for macOS 15 or 26 has size, date and place only.

## 6. Pictures (question 7, partly 8)

| Request (`PHImageManager`, current version, high quality) | Result |
| --- | --- |
| 1400 px preview, photo on this Mac | 27 ms median, 167 ms at the 95th percentile; aspect ratio right in 37 of 37 |
| The same, encoded to an sRGB JPEG (q 0.86) | 11 ms; about 550 KB |
| Repeated request | Byte-identical JPEG in 10 of 10 (also full size) |
| Full size, photo on this Mac | 10–13 ms to deliver, 150 ms to encode a 12 MP JPEG (q 0.95, about 4 MB) |
| Colour | Most pictures arrive in **Display P3** (25 of 37 previews, all HEIC), some 16 bit. The provider must convert to sRGB 8 bit before handing over, as the addon does; the host's `keepMaterialized` takes JPEGs only |

**Most of this library is not on this Mac.** Without network access, `PHPhotosErrorNetworkAccessRequired` (3164) came back for **163 of 200** previews (82 %), for all 20 RAW photos asked, and for **29 of 30** full-size requests. With Optimize Mac Storage that is normal, so for Apple Photos an iCloud download is the main path, not an exception:

**Measured with network access** (one request at a time, this Mac's connection, photos picked from those not on this Mac):

| | Result |
| --- | --- |
| 1400 px preview from iCloud | 0.6–1.6 s, about 1 s typical; 8 of 8; 2–4 progress callbacks each |
| Full size from iCloud (12–33 MP) | 2.2–3.8 s; 4 of 4, at the asset's full size. One took 58 ms after its preview had been downloaded, so a preview download sometimes brings the original along |
| Cancelled after 0.3 s (`cancelImageRequest:`) | Ends at once with `PHPhotosErrorUserCancelled` (3072), no picture |
| The same photo asked again after the cancel | 2.4 s, as long as a fresh download: a cancel leaves nothing usable behind |

- An import of 300 candidates only in iCloud costs about 5 minutes of previews one at a time; the host already shows photos as their previews arrive (ADR 0011, §2). *Open:* several requests at once.
- An export downloads every placed photo's original: a 48-photo book about 2–3 minutes. Cancellation works per request, so an export can stop between photos and in the middle of one.
- The provider maps 3164 without network, and 3169 (network error), to `offline` ("Not downloaded from iCloud, and this Mac is offline"), never to `missing`. *Open:* what an offline Mac actually answers with network access allowed (3169 or a hang), to be tried with Wi-Fi off.
- *Open:* RAW (66 photos here, none on this Mac), Live Photos (15,612: the still frame is what an image request returns), HDR (1,090; `preferHDR` stays off, as print is SDR).

## 7. Dragging from Photos (question 1): yes, a drag can link

Tested by hand on 25 November 2026 (Photos on macOS 27.2.1): photos dragged from Photos onto a web drop target (Chromium in the spike's Electron window) and onto a native AppKit one, one photo and three at once. `main.cjs` with `"stay": true` and the task `drop` opens both. The task `dragboard` reads the system drag pasteboard (`NSPasteboardNameDrag`) from the addon.

**What a drag from Photos carries.** It carries the following for each photo:

| Type | Content |
| --- | --- |
| `com.apple.photos.object-reference.asset` | A property list dictionary (337 bytes): `localIdentifier`, `libraryURL` (a string, the system library's path), `mediaType`, `mediaSubtypes`, `sourceType`, `isHidden`, `isTrashed`, `isRecovered`, `needsSensitivityProtection` |
| `public.file-url` and `public.jpeg` | A **1024 × 768 JPEG derivative inside the library bundle** (`resources/derivatives/…`), for photos of 4896 × 3672 and 4032 × 3024 |
| `com.apple.pasteboard.promised-file-url` and the other promise types | A file promise for the full picture (`NSFilePromiseReceiver` reads one per photo) |

The `localIdentifier` resolved with `fetchAssetsWithLocalIdentifiers` for 3 of 3 photos, each had a cloud identifier, and `libraryURL` named the system library.

**What the web page gets.** Chromium handed the page one `File` (`image/jpeg`, 329 KB) whose path (`webUtils.getPathForFile`) is the derivative inside the library. It does not get the reference or the promise.

**Reading it natively after a web drop works.** When the page's `drop` handler asks the main process, the addon reads `NSPasteboard(name: .drag)` and finds the same items, reference included. The drag pasteboard keeps the last drag until the next one, so the read is not racing anything. That is how ImageFlow can link from a drag without changing how its web views receive drops:

1. The renderer's drop handler sees a `File` whose path is inside a `.photoslibrary` (or simply any drop), and asks the main process first.
2. The main process reads the drag pasteboard. Items with `com.apple.photos.object-reference.asset` whose `libraryURL` is the system library become `photos` locators (`localIdentifier`, plus the cloud identifier looked up once), and go into the book like Lightroom photos (`importProvidedPhotos`).
3. Otherwise the drop is a file drop, as today.

Caveats: the pasteboard is the system's last drag, so the main process should check that its items match the files of the drop (count and derivative paths) before trusting it. A photo of another library than the system one (`libraryURL`) cannot be read through PhotoKit and falls back to a copy.

**Today's import of a Photos drag is probably a bug** (from the code, not tried in ImageFlow: nothing in `src/` or `desktop/` treats a `.photoslibrary` path specially). Dragging photos from Photos into ImageFlow now imports, or links, the **1024 px derivative inside the Photos library** as if it were the photo: low resolution for print, and a linked path into a library bundle that Photos rewrites. Until the provider exists, ImageFlow should recognise such a drop (a path inside a `.photoslibrary`, or the reference type on the drag pasteboard) and refuse it with a hint (export from Photos first), or accept the file promise for the full picture.

*Not tested:* a multi-photo drop onto the web target (Chromium reads every item's `public.file-url`, so it should give one `File` each); a photo that is only in iCloud (Photos then probably delays the derivative or the promise); dragging an album.

**Other ways in**, still possible: `PHPickerViewController` (out of process, returns `assetIdentifier`), and Import Selected from Photos through AppleScript's `selection`.

## Recommendation

Build it, after v1, as the second provider without a file: the contract fits without changes. The provider needs a revision from `adjustmentTimestamp` (not `modificationDate`), Display P3 → sRGB conversion, iCloud downloads as the normal case, and a picker as the way in. A drag links: the reference with the local identifier is on the drag pasteboard and can be read from the main process after the web drop. iCloud downloads (about 1 s per preview, 2–4 s per original, cancellable) and `adjustmentTimestamp` (every visual edit and revert, nothing else) are measured too. Left for the build itself: an offline Mac with network access allowed, several downloads at once, a drag of a photo that is only in iCloud, and optionally `PHPickerViewController` as a second way in.

Independent of the provider: today a drag from Photos imports a 1024 px derivative from inside the library (section 7). That should be caught now.
