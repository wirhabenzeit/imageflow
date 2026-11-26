# 0013: Apple Photos as a source provider

Status: accepted, 2026-11-25, with the implementation. Builds on [0011](0011-lightroom-classic.md) (the source provider contract, previews and materialization of photos without a file) and [0012](0012-sync-backend-and-library.md) (sync by reach). The measurements behind it are in [`spikes/apple-photos/README.md`](../../spikes/apple-photos/README.md) (#327).

## Problem

Photos from the Mac's Photos library can only reach a book as files today, and the obvious way in is broken: **a drag from Photos imports a 1024 px copy that Photos keeps inside its library**, not the photo. A web view (Chromium) receives only that file from a drop. Imported, it prints at a fraction of the photo's resolution; linked, it points into a library bundle that Photos rewrites. A beta tester has run into this.

Photographers who keep their pictures in Photos want what Lightroom Classic users have since 0011: link photos, lay them out from previews, and print the photos as they are at export, with edits made in Photos reaching the book.

## Decision

Make **Apple Photos the second provider without a file**, behind the contract of 0011, read through **PhotoKit in a Node-API addon** (`desktop/native/photos.mm`) in the main process. Photos come in **by dragging them from Photos**, where the main process recognises the drop and links the photos instead of importing the small copies, or through **Assets → Import from Photos…**, the system photo picker.

### Access

- The main app claims `com.apple.security.personal-information.photos-library` and describes its use in `NSPhotoLibraryUsageDescription`. Under hardened runtime, without the entitlement, access is refused without a prompt; without the usage description, macOS ends a process that asks. `scripts/verify-mac-signing.mjs` checks both.
- ImageFlow asks the first time photos are dropped from Photos. Once refused, macOS does not ask again: ImageFlow offers System Settings (the drop dialog, **Allow Access to Photos…** in an asset's menu and in Manage Assets, and the Apple Photos card in **Settings → Sources**).
- The addon reports a process without the usage description (a development Electron) and macOS before 15.2 as unsupported, and asks nothing there.

### Identity

The locator is `{ photos: { cloud, local?, name? } }`:

- `cloud`: the archival `PHCloudIdentifier` (macOS 15.2+). Apple: the only identifier "guaranteed to be consistent through all scenarios". It is the photo's key, and portable.
- `local`: this Mac's `localIdentifier`, quick to look up but not stable and meaningless elsewhere. It never syncs (reach `mac`: `shared` drops it, `adopt` keeps this Mac's).
- `name`: the original file name, for a photo without a title.

The provider looks a photo up by `local` and falls back to `cloud` (about 0.3 ms a photo), remembering what it found for the session.

### Facts and revisions

- Facts: the current (edited) size, the creation date, the place, and on macOS 27 the caption (`PHAsset.extendedMetadata`). PhotoKit has no title. The capture time is the creation date at the photo's own UTC offset, with that offset: PhotoKit does not expose the photo's zone, so the addon reads EXIF OffsetTimeOriginal from the original in the background, only where it is on this Mac (no iCloud download), and reports the photo as changed once it has it. The addon reads OffsetTimeOriginal, else OffsetTimeDigitized (not OffsetTime, the modification time's), and concludes that the original records none from the whole file only. Until then, or where the original records none, the offset is this Mac's at that instant, marked `offsetGuessed` in the fact's `extra`. The addon keeps what it read for the process only: on the next launch it guesses again until it has read the original anew, so the host keeps a recorded capture time whose offset was not guessed over a guessed one of the same instant (on a Mac without the original, too). A correction read before any book watches the photo is reported when one does. A time zone set in Photos' Adjust Date & Time is not read (PhotoKit has no public API for it): the original's EXIF offset wins, and a photo whose original records none keeps this Mac's offset.
- **`contentRevision`** = `adjustmentTimestamp` (the last edit or revert, macOS 15+), size and RAW-or-JPEG base. Watched on a test photo, it moved on every visual edit and the revert, and on nothing else; a reverted photo rendered to the same bytes as before the edit.
- **`revision`** = `contentRevision` plus a hash of the caption.
- **`modificationDate` is not used.** It moved on 87 % of photos never edited, sometimes on its own, and in 736 edited photos it is older than the last edit.

### Pictures

- Previews (1400 px) and originals (full size) are rendered by Photos as the photo is now, through `PHImageManager`, and written as **8-bit sRGB JPEGs** (Photos hands most over in Display P3, some at 16 bit).
- **iCloud downloads are the normal case.** With Optimize Mac Storage, 82 % of previews and nearly all originals were not on the test Mac. Requests allow network access: about 1 s per preview and 2–4 s per original, measured. Four previews and two originals run at once; an abort cancels the requests in flight.
- An error without network maps to `offline` ("Not downloaded from iCloud…"), a library on a disk that is not connected to `offline`, a photo that left the library to `missing`, missing access to `denied` (repair: `allow`). A photo `denied` is drawn from its proxy, like one `offline`.

### Changes

`PHPhotoLibraryChangeObserver` over a fetch result of the photos open books hold: Photos reports a change within about a second, so nothing polls. A library that becomes unavailable reports every photo.

### Dragging in

A drop from Photos carries, for each photo, `com.apple.photos.object-reference.asset` (a dictionary with the `localIdentifier`), the small copy as `public.file-url`, and a file promise. Chromium passes on only the copy. The system drag pasteboard keeps the last drag, so the main process reads it when the editor imports files from inside a `.photoslibrary`:

1. Paths inside a Photos library are matched to the drag pasteboard's items by their file. Each match becomes a `photos` locator; a photo box receives the first.
2. Any other path imports as a file, as before, in the same save and undo step as the photos (`importIntoProject` with `provided`).
3. A path from inside a Photos library that the last drag does not name (a file picked in the Open dialog, or a drag that was another one) is refused with a hint, never imported as the copy. So is one dropped on a text box or a file parameter, and a still image the system library does not have (dragged from another library, which PhotoKit cannot read) says so. A folder imported with a Photos library inside it skips the library.

### The picker

**Import from Photos…** shows `PHPickerViewController` as a sheet on the book window, from the addon. However the sheet ends (picked, cancelled, its window closed) the call answers, and another picker may open. It runs out of process; configured with the shared library, it names the photos picked by their local identifiers, in the order picked (`PHPickerConfigurationSelectionOrdered`), still photos only. Access is asked for first, since linking needs it anyway. The photos go in like dragged ones.

### Show in Photos

Photos opens at a photo of its library by `photos://asset?identifier=<UUID>`, the UUID that starts its local identifier; the provider looks up this Mac's by the cloud identifier where the locator has none or another Mac's. One photo at a time. Nothing in the library changes.

### Sync and printing

Reach `mac`, like Lightroom: facts, the caption and the preview sync; the original never does. A Mac with the same iCloud Photos library resolves `cloud` and can print the photo; any other shows it from its preview and exports a proof, as for Lightroom. Book check names such photos, and those ImageFlow may not read here or cannot download now, in one note ("in Photos, but can't be read on this Mac now"), not one finding each. Giving access, from Settings or an asset, reads every open book's Photos photos again.

## Alternatives considered

- **AppleScript (Import Selected from Photos).** Photos' `selection` names the photos, and AppleScript has their titles, but it needs Photos running and an Apple Events permission.
- **Accepting the file promise** of a drag, and importing full-size copies. Fixes the resolution, but every photo becomes a copy that no longer follows Photos.
- **A helper app.** The addon needed no separate process: PhotoKit, permission and change notifications work in Electron's main process.

## Consequences

- Dragging photos from Photos links them; edits in Photos reach the book within a second or two; export prints them at full size, downloading from iCloud where needed.
- HEIC and RAW photos from Photos work without ImageFlow decoding them: Photos renders JPEGs (compare #328 for HEIC files).
- macOS 15.2 or later is needed (archival cloud identifiers); captions need macOS 27. Before 15.2, drops from Photos are refused with a hint to export.
- *Open:* behaviour with network access allowed on an offline Mac, several downloads at once, an iCloud-only photo dragged in, a second Mac resolving the same cloud identifier, edits synced in from an iPhone, and a library other than the system library open in Photos (its drags name photos PhotoKit cannot read, and are refused as unmatched).
