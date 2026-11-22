# 0011: Lightroom Classic preview-first editing and on-demand export rendering

Status: proposed, 2026-11-22 (revised after feasibility review: change detection, IPC and source-model prerequisites; revised again after the spike ran in Lightroom Classic 16.0.1: change detection, digest, `croppedDimensions`). Builds on [0004](0004-document-packages.md) (document packages), [0005](0005-linked-sources.md) (linked sources) and [0010](0010-sync-revisions-and-cloud-assets.md) (sync, revision tracking and cloud assets).

The direction (a companion plugin that renders in Lightroom's own engine) is feasible. Several mechanisms first drafted here rested on SDK behaviour that was **unverified or contradicted by developer reports**. The spike in [Validation spike](#validation-spike) (`spikes/lightroom-classic/`) has since measured most of it on a real 40,000-photo catalog in Lightroom Classic 16.0.1; what it has not measured is still marked *unverified* below. The larger cost is not the Lua plugin but teaching ImageFlow's source model about photos that have no file ([Prerequisites in ImageFlow](#prerequisites-in-imageflow)).

## Problem

Photographers designing a photobook or calendar in Lightroom Classic often start from a pool of several hundred candidate photos before narrowing them down to the few dozen that appear on spreads. Under [0005](0005-linked-sources.md), linking Lightroom photos requires exporting full-resolution sRGB JPEGs to a folder on disk first (or maintaining a Lightroom Hard Drive Publish Service folder) and importing those files into ImageFlow:

- **Up-front disk and CPU cost for unused candidates.** Exporting 400 full-resolution 50 MP JPEGs takes minutes in Lightroom and hundreds of megabytes to several gigabytes on disk, even though most candidates will never be placed in the book.
- **Manual re-export round-trips.** When a user adjusts exposure, white balance, AI masks or cropping in Lightroom Classic while laying out spreads in ImageFlow, they must manually re-export or re-publish the modified photos to disk before ImageFlow's linked-file watcher picks up the change.
- **No headless Adobe Camera Raw engine.** Lightroom Classic stores edits parametrically inside its SQLite catalog (`.lrcat`) or XMP sidecars. Third-party applications cannot execute the proprietary Adobe Camera Raw (ACR) develop pipeline headlessly on a RAW file to produce an accurate print rendition.

## Why the Lightroom Cloud REST API and direct `.lrcat` reading are insufficient

We evaluated three integration paths across the Lightroom ecosystem:

1. **Adobe Lightroom Cloud REST API (`lr.adobe.io/v2/`) — rejected for print workflows.**
   - **2560 px Smart Preview ceiling for Lightroom Classic catalogs:** When Lightroom Classic syncs collections to Adobe Creative Cloud, it never uploads full-resolution originals; it uploads only lossy 2560 px Smart Previews (~4–5 MP). Even when requesting on-demand `fullsize` renditions (`POST .../renditions` with `X-Generate-Renditions: fullsize`), any asset originating from Lightroom Classic is capped at 2560 px on the long edge — well below the 300 DPI print threshold for an A4 or A3 spread.
   - **API gating and cloud requirement:** `fullsize` rendition generation is restricted on standard self-serve Adobe Developer Console keys, requires an active Adobe ID OAuth session and cloud storage quota, and fails entirely for local-only Lightroom Classic catalogs.
2. **Direct `.lrcat` and `Previews.lrdata` reading — insufficient for export rendering.**
   - Lightroom Classic's `.lrcat` is an undocumented SQLite database, and `Previews.lrdata` stores multi-resolution AdobeRGB JPEG pyramids (`.lrprev`) alongside `Smart Previews.lrdata` (lossy 2560 px DNGs without baked-in develop adjustments).
   - While an external app can read `.lrprev` JPEGs when Lightroom is closed, cached previews are only as fresh and as large as Lightroom's last preview render (often standard ~1440 px, or stale after recent Develop slider edits). An external reader still cannot render a fresh full-resolution print JPEG at export time. Furthermore, Lightroom Classic holds exclusive SQLite/WAL locks on `.lrcat` while running and alters schema details across major versions.
3. **Lightroom Classic Lua SDK companion plugin (`.lrplugin`) — chosen path.**
   - Runs inside Lightroom Classic with official access to `LrCatalog`, `LrPhoto`, `LrExportSession`, `LrPublishService`, `LrSocket`, `LrHttp` and custom `lightroom://` URL handlers.
   - Executes the local Adobe Camera Raw engine at full native resolution on demand, requires no Adobe account or cloud sync, and works with every local RAW, DNG, TIFF or PSD in the user's catalog.

## Decision

Integrate with **Lightroom Classic on macOS** through a bundled companion Lua plugin (`ImageFlow.lrplugin`) over a localhost IPC bridge, using **1400 px screen previews during editing** (`ProxyStore` + `assets-meta.json`) and **on-demand `LrExportSession` rendering during PDF export** (and explicit collection) only for photos actually placed in the book.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Lightroom Classic (macOS)                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ ImageFlow.lrplugin (Lua)                                          │  │
│  │ • Pull bridge: LrHttp client long-polls ImageFlow's loopback API  │  │
│  │ • Fast change poll: catalog:batchGetRawMetadata(photos, keys)     │  │
│  │ • Revision key:     lastEditTime + editCount + croppedDimensions  │  │
│  │ • Edit classifier:  hash of getDevelopSettings() (visual vs meta) │  │
│  │ • Preview render:   LrExportSession (1400 px sRGB JPEG, q86)      │  │
│  │ • Export render:    LrExportSession (full / target width, q95)    │  │
│  └───────────────┬───────────────────────────────────▲───────────────┘  │
└──────────────────┼───────────────────────────────────┼──────────────────┘
                   │ 1. Metadata + 1400 px preview     │ 2. On-demand print render
                   │    (on import & change detection) │    (placed photos only)
                   ▼                                   │
┌──────────────────────────────────────────────────────┴──────────────────┐
│                           ImageFlow Desktop                             │
│                                                                         │
│  • photos.json:      { "ph-abc": { "lightroom": { "uuid": "..." } } }   │
│  • assets-meta.json: { "ph-abc": { "width": 6000, "height": 4000,       │
│                        "digest": "<sha256(stored preview bytes)>",      │
│                        "lightroom": { "revision": "<editCount:time>" }}}│
│  • ProxyStore:       Cache/proxies/<digest>-preview-v1.jpg (1400 px)    │
│  • Rendition cache:  Cache/renditions/<digest>-export[-<w>].jpg         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1. Source identity and manifest schema

Consistent with [0005](0005-linked-sources.md) and [0010](0010-sync-revisions-and-cloud-assets.md), photo IDs (`ph-...`) in `photos.json` remain stable internal identifiers, and external locations never become IDs.

- **Provider-tagged locator in `photos.json`:** A Lightroom-backed photo entry records a `lightroom` locator with the photo's catalog UUID (`photo:getRawMetadata("uuid")`) **and a catalog identity**, plus an optional source filename/collection hint, alongside user-editable `title`, `caption`, `credit` and `altText`. A UUID is only meaningful inside one catalog, and Lightroom has one catalog open at a time, so the plugin reports the open catalog's identity and a photo whose catalog is not the open one is "unavailable", never silently missing. (*Unverified:* that UUIDs survive catalog export/import and merge; the spike checks it.) Machine-local catalog paths stay in local app settings/approvals rather than in portable book manifests.
- **Portable book-state revision (`src/book-revision.ts`):** `computeBookStateRevision` retains `{ lightroom: { uuid } }` while stripping machine-local paths, so two synced Macs compute the exact same portable `bookStateRevision`.
- **True dimensions and EXIF in `assets-meta.json` (`src/asset-facts.ts`, `desktop/asset-facts.ts`):** When importing or refreshing a photo from Lightroom, ImageFlow records its **post-crop** dimensions (`croppedDimensions`, a table `{ width, height }`), capture timestamp, GPS coordinates and camera make/model in `assets-meta.json`.
- **`digest` keeps its ADR 0010 meaning.** In `assets-meta.json`, `digest` is "SHA-256 of the original's bytes", and Locate Folder and the proxy store key on it. A Lightroom photo's `digest` is therefore the SHA-256 of the **stored preview bytes**, never a synthetic hash of Lightroom state. Lightroom writes a fresh `xmp:MetadataDate` and a random `xmpMM:DocumentID` into every export, whatever the metadata option, so two renders of the same edit differ in bytes. ImageFlow therefore removes the EXIF/XMP (APP1) and comment segments from a rendered preview, keeping the ICC profile, before storing and hashing it. The spike found the remaining image data identical across re-renders. The Lightroom revision that produced it (`lrRevision`) and the develop-settings hash go in a separate `lightroom` object on the fact. Two edits that render identically then share a digest, so downstream proxies and renditions are not invalidated.
- **`croppedDimensions` is an estimate until a full-resolution render exists.** It matched the real export size on every photo the spike tested (cropped and uncropped), but it can still differ by a few pixels from the real export (Upright, Super Resolution, rotation crops). Whenever a full-resolution render is produced, its actual pixel size replaces the estimate in `assets-meta.json`, so the 300 DPI checks converge on the truth.

### 2. Preview-first editing via `ProxyStore` and `assets-meta.json`

ImageFlow already decouples layout geometry and print-resolution checks from proxy pixels ([0010](0010-sync-revisions-and-cloud-assets.md), `desktop/project.ts`, `desktop/proxy-store.ts`):

- **1400 px sRGB preview on import:** When photos are imported from Lightroom Classic (either pushed from Lightroom via **File → Plug-in Extras → Send to ImageFlow** or pulled from ImageFlow via **Import from Lightroom Classic…**), the plugin renders a 1400 px long-edge sRGB JPEG (`LrExportSession` with `LR_format = 'JPEG'`, `LR_export_colorSpace = 'sRGB'`, `LR_jpeg_quality = 0.86`, `LR_size_doConstrain = true`, `LR_size_resizeType = 'wh'`, `LR_size_maxWidth = 1400`, `LR_size_maxHeight = 1400`).
  - Why `LrExportSession` at 1400 px instead of `photo:requestJpegThumbnail()`: `requestJpegThumbnail` reads Lightroom's internal `.lrprev` cache, which can be stale if Lightroom has not yet rebuilt previews after a Develop adjustment, and varies in behavior between the Library and Develop modules. A 1400 px `LrExportSession` guarantees current Develop settings and crop; `requestJpegThumbnail(240, 240)` may still be used for immediate grid thumbnails while 1400 px previews finish rendering.
- **Stored in `ProxyStore` by content digest:** ImageFlow stores the 1400 px preview, without its metadata segments, in `ProxyStore` (`Cache/proxies/<sha256 of the stored bytes>-preview-v1.jpg`) and derives the 240 px filmstrip thumbnail from it.
- **Layout, cropping and 300 DPI checks without full-resolution files:** Because `ProjectPhoto.width` and `ProjectPhoto.height` come from `assets-meta.json` (`croppedDimensions`), the spread canvas, normalized box crops (`centerX`, `centerY`, `zoom` in `[0..1]`) and `Book check`'s effective-DPI warnings operate against the true post-crop pixel dimensions of the RAW photo even though only a 1400 px preview exists on disk.
- **Multi-Mac sync compatibility:** Because `assets-meta.json` and `ProxyStore` entries sync across Macs under [0010](0010-sync-revisions-and-cloud-assets.md), a book with Lightroom Classic photos imported on an iMac can be opened, laid out and cropped on a MacBook without Lightroom Classic or the original RAW files present.

### 3. Change detection in Lightroom Classic

The SDK has no change notification, so the plugin polls. What it can and cannot tell apart is the main risk of this ADR.

**What the spike measured** (Lightroom Classic 16.0.1, `spikes/lightroom-classic/README.md`):

- `catalog:batchGetRawMetadata(photos, keys)` returns `uuid`, `editCount`, `lastEditTime` (seconds since 2001-01-01 GMT), `croppedDimensions` (a table), `isCropped` and `orientation` (lower case) in one call. It costs about 35 µs per photo, linearly (500 photos 14 ms, 10,000 photos 350 ms), about 3× less than single calls. Polling 5–25 tracked photos once a second took 3–6 ms per poll.
- **`lastEditTime` changed on every edit tested**, and the poll saw it within 0.1–1 s: global sliders, crops, spot removal, an AI Sky mask, a brush mask, tweaking and removing a mask, and metadata edits.
- **`editCount` is not a revision.** It went up on the first visual edit of a photo and then stayed put through later crops, spot removal and mask edits, yet it went up on every metadata edit.
- **`photo:getDevelopSettings()` includes masks.** Developers report it omitting mask data on earlier versions. In 16.0.1 it returns the full `MaskGroupBasedCorrections` (mask type and subtype, a `MaskDigest`, every local adjustment) and `RetouchAreas`, and its hash changed on every visual edit tested, mask tweaks included. **It did not change on metadata edits.** *Unverified:* radial, linear and AI Subject masks, presets, Sync Settings, and masks created in older Lightroom versions.

**Decision: classify by develop settings for previews, and never trust a stale print render.**

1. **Revision key.** The photo's Lightroom revision is `lrRevision = uuid : lastEditTime : editCount : croppedWidth x croppedHeight`, read in bulk. Any change to it marks the photo *dirty*. `lastEditTime` does the work; the other parts only add safety.
2. **Metadata edits cost nothing.** For a dirty photo the plugin hashes `getDevelopSettings()` (sorted-key encoding) and compares it with the hash stored for the last preview (`lightroom.developHash`). If it is unchanged, and so is `croppedDimensions`, the edit was metadata only: the new `lrRevision` is recorded and no preview is rendered. A rating change thus costs one `getDevelopSettings()` call.
3. **Visual edits re-render the preview,** and the stored-bytes `digest` is a second filter: if the new preview's digest equals the stored one (an edit that renders the same), nothing downstream is invalidated (no proxy, thumbnail or rendition churn, no `DocumentSession` reload).
4. **Print is conservative.** The full-resolution render cache is keyed on `lrRevision`, not on the develop hash, so any change Lightroom records, including one the develop hash might miss on an untested mask type, re-renders a placed photo at export. A wasted full render after a rating change (about 1.5 s per photo) is the price of never printing a stale image.
5. **Debounce.** A dragged slider moves `lastEditTime` several times. The plugin reports a photo dirty only after its revision has been stable for one poll interval, and ImageFlow renders at most one preview per photo at a time.
6. **Polling.** The plugin polls the tracked UUIDs (`catalog:findPhotoByUuid`) every 1–2 s while an open book has Lightroom sources, immediately on request (window focus, before export), and not at all otherwise.
7. **Hot reload.** When a re-rendered preview changes `digest`, ImageFlow writes it to `ProxyStore`, updates `width`, `height`, `digest`, `lightroom.revision` and `lightroom.developHash` in `assets-meta.json`, and reloads the active `DocumentSession`, as saving an external linked photo in place does today (`desktop/document-session.ts`).
8. **Crops keep their numbers, not necessarily their framing.** Box crops in `project.json` are normalized `[0..1]` coordinates, so they stay valid when a photo is re-cropped in Lightroom, and DPI checks update from the new dimensions. But a changed aspect ratio shifts what the box shows, so ImageFlow flags photos whose aspect ratio changed since they were placed.

**Not covered by polling:** a photo removed from the catalog, replaced by a different catalog, or the plugin not running. These surface as an unavailable source with the ordinary `Retry` and `Locate` actions, and never as a silent success.

### 4. On-demand rendering during PDF export and collection

Full-resolution print renditions are rendered only when needed and only for photos that are actually used:

1. **Filtering to placed photos (`assetUsage`):**
   - When starting **Export PDF** (`desktop/document-session.ts`) or a `proof-photo` inspection, ImageFlow computes the active photo placements via `assetUsage(book, ...)` (`src/asset-usage.ts`), covering active spread layouts and the active cover layout. Unused candidate photos in the book's library are never rendered at full resolution.
2. **Freshness check and rendition cache lookup:**
   - If Lightroom Classic is reachable, ImageFlow asks the plugin for the placed photos' current `lrRevision` before export begins, bypassing the poll interval. A photo whose revision differs from the one its stored full-resolution render was made from is rendered again, and its `assets-meta.json` entry is updated first.
   - Full-resolution sRGB export renders from Lightroom are cached in ImageFlow's persistent cache keyed by a hash of the photo's `lrRevision` (and optional target pixel width). Any placed photo whose current `lrRevision` is already cached requires no re-render in Lightroom. The cache is never trusted without this check while Lightroom is reachable.
3. **Batch `LrExportSession` for cache misses:**
   - For placed photos missing a full-resolution render at their current `lrRevision`, ImageFlow requests a batch render from `ImageFlow.lrplugin` before loading the pinned export snapshot, reporting progress in the status bar (`"Rendering 12 of 48 photos in Lightroom Classic…"`).
   - The plugin executes `LrExportSession` (`LR_format = 'JPEG'`, `LR_export_colorSpace = 'sRGB'`, `LR_jpeg_quality = 0.95`, `LR_size_doConstrain = false` or constrained to the placement's required print width when smaller than `croppedDimensions`) and writes the rendered files into ImageFlow's cache.
   - **Edits during a render invalidate it.** The plugin reads `lrRevision` before and after each render and reports both. A render whose revision changed is discarded and retried, mirroring ADR 0005's rejection of a source replaced during export. The batch is cancellable, and reports progress per photo.
   - The batch can take minutes: each render runs the full Adobe Camera Raw pipeline and shares Lightroom's export queue with the user's own work. ImageFlow estimates the time from the first renders and shows it.
   - Once the batch completes, `loadProject(folder, privateCache, true, true)` pins the rendered full-resolution files into `privateCache/pinned-sources`, and `printBook()` (`desktop/export.ts`) runs unchanged.
4. **Offline and closed-Lightroom fallback:**
   - If every placed Lightroom photo already has a cached full-resolution render matching its last known `lrRevision`, export can proceed directly from cache (or optionally verify with Lightroom).
   - If a placed photo has only a 1400 px preview in `ProxyStore` and Lightroom Classic is not running, ImageFlow can offer to launch Lightroom Classic itself (`open -a`, with `LrForceInitPlugin` so the plugin starts and connects without a URL handler), or allow the user to confirm a **Proof PDF** export using the 1400 px proxy with the existing `ORIGINAL UNAVAILABLE` page banner (`desktop/export.ts`).
5. **Materializing standalone files (`Copy into Book` and `File → Duplicate`):**
   - Choosing **Copy into Book** in **Book → Assets…** (or **File → Duplicate…** with *Include all files* checked) on Lightroom-linked photos triggers the same on-demand full-resolution `LrExportSession`, writes the resulting sRGB JPEGs into the package's `photos/` directory, and converts their `photos.json` entries from `lightroom` locators to ordinary document-owned relative paths.

### 5. Local IPC and plugin packaging

- **The plugin is the client; ImageFlow is the server.** `LrHttp` can only make requests, and `LrSocket` carries one direction per socket and has reported bind and receive failures. So the plugin long-polls ImageFlow's loopback API for jobs (`GET /lightroom/jobs`) and posts results (`POST /lightroom/revisions`, `POST /lightroom/renders`). No URL handler is needed. In the spike, loopback requests took 0.6 ms (median), a 10 s long poll did not block another plugin task, and headers reached the server (a wrong token got 401). A job-spool directory in Application Support, which the plugin polls with `LrFileUtils`, remains the fallback if `LrHttp` proves unreliable while Lightroom is busy with a large export (*unverified*).
- **No dependence on `URLHandler`.** A plugin URL handler is not called when Lightroom is launched by the URL ([reported](https://community.adobe.com/bug-reports-674/p-urlhandler-of-plugins-do-net-get-called-if-lightroom-classic-is-not-yet-running-664202)), so the handler is at most a convenience for "Send to ImageFlow" while Lightroom is already running.
- **Plugin installation:** ImageFlow bundles `ImageFlow.lrplugin` inside its macOS app bundle (`Contents/Resources/ImageFlow.lrplugin`) and installs or updates it in `~/Library/Application Support/Adobe/Lightroom/Modules/ImageFlow.lrplugin` on user request from Settings or the Import menu. The user still enables it once in Lightroom's Plug-in Manager.
- **Loopback-only authenticated server:** ImageFlow's server binds strictly to `127.0.0.1` on a port it chooses and writes, with a per-user bearer token, to a file in `~/Library/Application Support/ImageFlow/` with `0600` permissions that the plugin reads. Untrusted local webpages and other local accounts cannot query catalog metadata or trigger exports. Requests also check the `Host` header to resist DNS rebinding.
- **No template access:** Lightroom IPC lives exclusively in the trusted Electron main process (`desktop/`). Sandboxed template code (`src/`, render frames) never communicates with the plugin and sees only standard `Photo` objects (`width`, `height`, `src`, capture metadata).

## Prerequisites in ImageFlow

The plugin is a few hundred lines of Lua. Most of the work is in ImageFlow, whose source model assumes that every photo is a file:

- **Source providers.** `photoIndexSchema` requires a `path` (`src/project.ts`), and `sourceEntries`, `SourceStore` approvals and stamps, rendition keys and `photoDetails` (JPEG, PNG or WebP through `sharp`) all start from a file. A `lightroom` photo needs a provider abstraction, which ADR 0010 anticipated (provider-tagged locators) but does not exist yet. That is a prerequisite, shared with the other providers 0010 lists.
- **Older builds.** An entry without `path` is rejected or stripped by builds that predate it, so the new locator ships behind a `schemaVersion` bump (ADR 0009 and 0010's mixed-version rules).
- **Proxy stand-in.** Today a proxy stands in only for `missing` or `unapproved` originals (`desktop/project.ts`). A Lightroom photo with Lightroom closed needs its own state. Print is blocked or proof-only for it, using the same source-diagnostic codes and `ORIGINAL UNAVAILABLE` marking as ADR 0005.
- **Export materialization.** Rendered full-resolution files enter the export as ordinary pinned files in the job folder, so `printBook()` stays unchanged.
- **Colour.** Renders are 8-bit sRGB JPEGs, as ImageFlow's own pipeline produces (`withIccProfile('srgb')`), so there is no loss against today. Wide-gamut or 16-bit renders are out of scope.

## Alternatives considered

- **Hard Drive Publish Service, linked folder (today).** Lightroom's Publish Manager tracks modified photos itself, and the linked-folder watcher of ADR 0005 picks up the files. It needs no ImageFlow changes and is the baseline. This ADR adds lazy full-resolution rendering, post-crop dimensions without exporting and hot reload without a manual publish. A minimal Publish Service plugin that exports the 1400 px previews and a small sidecar is a cheaper first step if the provider work is deferred (see the phasing below).
- **Reading `Previews.lrdata` and the catalog.** Rejected above: stale, undocumented and locked while Lightroom runs.
- **Lightroom Cloud API.** Rejected above: 2560 px ceiling and cloud dependency.

## Validation spike

`spikes/lightroom-classic/` holds a plugin that answers, on a real catalog, the questions this ADR depends on. Its `README.md` has the procedure and the full results of the first run (2026-11-22, Lightroom Classic 16.0.1, macOS 27.2.1). In short: masks do bump `lastEditTime` and appear in `getDevelopSettings()`; metadata edits do not change the develop hash; renders take 0.5–1 s (1400 px) and about 1.5 s (full resolution, 24 MP Sony ARW) and are identical except for their metadata; loopback `LrHttp` works; `croppedDimensions` matched the real export size; the setting names below work and `doExportOnCurrentTask` returns with the file in place. Still open: the mask types and actions listed as *unverified* in section 3, UI stutter under polling, loopback under load, UUIDs across catalog export, and `croppedDimensions` on Upright and Super Resolution photos. The questions:

1. Which actions change `editCount` and `lastEditTime`: slider, mask, AI mask, spot removal, crop, rating, flag, keyword, virtual copy, undo, Sync Settings, Auto Sync, presets? If masks do not bump the revision, section 3 does not work and the fallback is re-rendering at export.
2. What does `getDevelopSettings()` return for mask and retouch edits (diagnostic only)?
3. How long does `batchGetRawMetadata` take for 50, 500 and 2,000 photos, and does polling it stall Lightroom's UI?
4. How long does a 1400 px and a full-resolution `LrExportSession` render take per photo, and does a render of an unchanged photo give byte-identical output?
5. Does `LrHttp` reach a loopback server reliably, while Lightroom is busy, and does a long-poll block other plugin tasks?
6. Do UUIDs survive catalog export and import, and what identifies a catalog?
7. Do the `LrExportSession` setting names used here (`LR_size_doConstrain`, `LR_size_resizeType`, `LR_tokenCustomString`, …) behave as assumed, and does `doExportOnCurrentTask` return with the file in place?
8. How close is `croppedDimensions` to the real export size on Upright, rotated and Super Resolution photos?

**Phasing** (each phase is useful alone):

0. Spike (above); revise this ADR from the results. *Done for questions 1–5, 7 and part of 8.*
1. Minimal Publish Service plugin: previews and a sidecar to a folder, linked by ImageFlow as today. Ships without the provider abstraction.
2. Source-provider abstraction and the `lightroom` locator, with the pull bridge and previews.
3. Full-resolution rendering at export, collection and Copy into Book.

## Consequences

- Photographers can import hundreds of candidate photos from Lightroom Classic into a book without waiting for full-resolution exports or filling their disk with unused JPEGs. Instant grid thumbnails come from `requestJpegThumbnail`, and 1400 px previews follow as background renders (minutes, not seconds, for hundreds of RAW files, because each runs the full Adobe Camera Raw pipeline).
- Layout geometry, normalized crops and `Book check` 300 DPI warnings remain accurate during editing because `assets-meta.json` records Lightroom's true post-crop `croppedDimensions` alongside the 1400 px `ProxyStore` image.
- Tweaking exposure, masks or crops in Lightroom Classic updates only the affected photos' 1400 px previews during editing, and full-resolution `LrExportSession` rendering runs at PDF export time only for the photos actually placed in the book (and only for those whose `lrRevision` changed since the last export).
- Syncing a book to a second Mac ([0010](0010-sync-revisions-and-cloud-assets.md)) carries the 1400 px Lightroom previews and post-crop dimensions automatically, allowing offline layout and cropping on a laptop while keeping final full-resolution PDF export on the Mac with the Lightroom Classic catalog (or converting selected photos into owned package files via *Copy into Book*).
- Change detection is cheap for metadata edits (no preview render) and conservative for print: any recorded change to a placed photo re-renders it at export, so a mask type the develop hash might not cover can cost a stale *preview*, never a stale print.
- ImageFlow needs a source-provider abstraction and a schema bump before any Lightroom code ships; that work is useful for the other providers ADR 0010 lists.
