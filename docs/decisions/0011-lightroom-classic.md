# 0011: Lightroom Classic preview-first editing and on-demand export rendering

Status: proposed, 2026-11-22. Builds on [0004](0004-document-packages.md) (document packages), [0005](0005-linked-sources.md) (linked sources) and [0010](0010-sync-revisions-and-cloud-assets.md) (sync, revision tracking and cloud assets).

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
│  │ • Local IPC bridge (LrHttp / LrSocket) + lightroom:// URL handler │  │
│  │ • Fast change poll: catalog:batchGetRawMetadata(photos, keys)     │  │
│  │ • Develop hash:     photo:getDevelopSettings()                    │  │
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
│                                    "digest": "<sha256(lrRevision)>" } } │
│  • ProxyStore:       Cache/proxies/<digest>-preview-v1.jpg (1400 px)    │
│  • Rendition cache:  Cache/renditions/<digest>-export[-<w>].jpg         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1. Source identity and manifest schema

Consistent with [0005](0005-linked-sources.md) and [0010](0010-sync-revisions-and-cloud-assets.md), photo IDs (`ph-...`) in `photos.json` remain stable internal identifiers, and external locations never become IDs.

- **Provider-tagged locator in `photos.json`:** A Lightroom-backed photo entry records a `lightroom` locator with the photo's persistent catalog UUID (`photo:getRawMetadata("uuid")`) and optional source filename/collection hint, alongside user-editable `title`, `caption`, `credit` and `altText`. Machine-local catalog paths stay in local app settings/approvals rather than in portable book manifests.
- **Portable book-state revision (`src/book-revision.ts`):** `computeBookStateRevision` retains `{ lightroom: { uuid } }` while stripping machine-local paths, so two synced Macs compute the exact same portable `bookStateRevision`.
- **True dimensions and EXIF in `assets-meta.json` (`src/asset-facts.ts`, `desktop/asset-facts.ts`):** When importing or refreshing a photo from Lightroom, ImageFlow records its **post-crop** dimensions (`croppedDimensions.width` and `croppedDimensions.height`), capture timestamp, GPS coordinates, camera make/model and a synthetic content digest (`lrDigest`) in `assets-meta.json`.

### 2. Preview-first editing via `ProxyStore` and `assets-meta.json`

ImageFlow already decouples layout geometry and print-resolution checks from proxy pixels ([0010](0010-sync-revisions-and-cloud-assets.md), `desktop/project.ts`, `desktop/proxy-store.ts`):

- **1400 px sRGB preview on import:** When photos are imported from Lightroom Classic (either pushed from Lightroom via **File → Plug-in Extras → Send to ImageFlow** or pulled from ImageFlow via **Import from Lightroom Classic…**), the plugin renders a 1400 px long-edge sRGB JPEG (`LrExportSession` with `LR_format = 'JPEG'`, `LR_export_colorSpace = 'sRGB'`, `LR_jpeg_quality = 0.86`, `LR_size_doScale = true`, `LR_size_maxWidth = 1400`, `LR_size_maxHeight = 1400`).
  - Why `LrExportSession` at 1400 px instead of `photo:requestJpegThumbnail()`: `requestJpegThumbnail` reads Lightroom's internal `.lrprev` cache, which can be stale if Lightroom has not yet rebuilt previews after a Develop adjustment, and varies in behavior between the Library and Develop modules. A 1400 px `LrExportSession` guarantees current Develop settings and crop; `requestJpegThumbnail(240, 240)` may still be used for immediate grid thumbnails while 1400 px previews finish rendering.
- **Stored in `ProxyStore` by `lrDigest`:** ImageFlow stores the 1400 px preview in `ProxyStore` (`Cache/proxies/<lrDigest>-preview-v1.jpg`) and derives the 240 px filmstrip thumbnail from it.
- **Layout, cropping and 300 DPI checks without full-resolution files:** Because `ProjectPhoto.width` and `ProjectPhoto.height` come from `assets-meta.json` (`croppedDimensions`), the spread canvas, normalized box crops (`centerX`, `centerY`, `zoom` in `[0..1]`) and `Book check`'s effective-DPI warnings operate against the true post-crop pixel dimensions of the RAW photo even though only a 1400 px preview exists on disk.
- **Multi-Mac sync compatibility:** Because `assets-meta.json` and `ProxyStore` entries sync across Macs under [0010](0010-sync-revisions-and-cloud-assets.md), a book with Lightroom Classic photos imported on an iMac can be opened, laid out and cropped on a MacBook without Lightroom Classic or the original RAW files present.

### 3. Change detection in Lightroom Classic

To detect when a user adjusts Develop sliders, masks or crops in Lightroom Classic without re-exporting files to disk:

1. **Fast bulk metadata poll (`catalog:batchGetRawMetadata`):**
   - Unlike per-photo `photo:getRawMetadata()` calls, `catalog:batchGetRawMetadata(photos, keys)` executes in native C++ inside Lightroom Classic and inspects hundreds of photos in a few milliseconds.
   - ImageFlow polls the plugin (on window focus, before export, and periodically while an open book has active Lightroom sources) for:
     ```lua
     catalog:batchGetRawMetadata(photos, {
       "uuid",
       "editCount",
       "lastEditTime",
       "croppedDimensions",
       "isCropped",
       "Orientation",
     })
     ```
2. **Distinguishing visual Develop edits from catalog metadata edits (`photo:getDevelopSettings`):**
   - Lightroom increments `editCount` and updates `lastEditTime` (seconds since 2001-01-01 GMT) on both Develop changes and catalog metadata changes (such as star ratings, flags or keywords), and coalesces rapid slider drags over a few seconds.
   - Only when `editCount`, `lastEditTime` or `croppedDimensions` changes on a tracked photo does the plugin call `photo:getDevelopSettings()` for that photo and hash its visual develop dictionary (exposure, tone curve, color grading, crop rectangle, masks, lens corrections).
   - The photo's deterministic revision digest is:
     ```
     lrDigest = sha256("lightroom-classic-v1:" + uuid + ":" + croppedWidth + "x" + croppedHeight + ":" + developSettingsHash)
     ```
   - If only a star rating or keyword changed in Lightroom, `developSettingsHash` and `croppedDimensions` are unchanged, so `lrDigest` stays identical and no preview or export re-render is triggered.
3. **Hot-reloading in ImageFlow:**
   - When `lrDigest` changes, the plugin renders a fresh 1400 px preview, ImageFlow writes it to `ProxyStore`, updates `width`, `height` and `digest` in `assets-meta.json`, and reloads the active `DocumentSession` — matching the experience of saving an external linked photo in place today (`desktop/document-session.ts`).
   - Because box crops in `project.json` use normalized `[0..1]` coordinates, updating `width` and `height` when a photo is re-cropped in Lightroom preserves placements and updates DPI checks automatically.

### 4. On-demand rendering during PDF export and collection

Full-resolution print renditions are rendered only when needed and only for photos that are actually used:

1. **Filtering to placed photos (`assetUsage`):**
   - When starting **Export PDF** (`desktop/document-session.ts`) or a `proof-photo` inspection, ImageFlow computes the active photo placements via `assetUsage(book, ...)` (`src/asset-usage.ts`), covering active spread layouts and the active cover layout. Unused candidate photos in the book's library are never rendered at full resolution.
2. **Freshness check and rendition cache lookup:**
   - If Lightroom Classic is reachable, ImageFlow queries the plugin for the placed photos' current `lrDigest` before export begins. If any placed photo has unrefreshed Develop changes in Lightroom, its `lrDigest` and `assets-meta.json` entry are updated first.
   - Full-resolution sRGB export renders from Lightroom are cached in ImageFlow's persistent cache keyed by `lrDigest` (and optional target pixel width). Any placed photo whose current `lrDigest` is already cached requires no re-render in Lightroom.
3. **Batch `LrExportSession` for cache misses:**
   - For placed photos missing a full-resolution render at their current `lrDigest`, ImageFlow requests a batch render from `ImageFlow.lrplugin` before loading the pinned export snapshot, reporting progress in the status bar (`"Rendering 12 of 48 photos in Lightroom Classic…"`).
   - The plugin executes `LrExportSession` (`LR_format = 'JPEG'`, `LR_export_colorSpace = 'sRGB'`, `LR_jpeg_quality = 0.95`, `LR_size_doScale = false` or scaled to the placement's required print width when smaller than `croppedDimensions`) and writes the rendered files into ImageFlow's cache.
   - Once the batch completes, `loadProject(folder, privateCache, true, true)` pins the rendered full-resolution files into `privateCache/pinned-sources`, and `printBook()` (`desktop/export.ts`) runs unchanged.
4. **Offline and closed-Lightroom fallback:**
   - If every placed Lightroom photo already has a cached full-resolution render matching its last known `lrDigest`, export can proceed directly from cache (or optionally verify with Lightroom).
   - If a placed photo has only a 1400 px preview in `ProxyStore` and Lightroom Classic is not running, ImageFlow can offer to launch Lightroom Classic via its `lightroom://com.imageflow.lrplugin?...` URL handler to perform the render, or allow the user to confirm a **Proof PDF** export using the 1400 px proxy with the existing `ORIGINAL UNAVAILABLE` page banner (`desktop/export.ts`).
5. **Materializing standalone files (`Copy into Book` and `File → Duplicate`):**
   - Choosing **Copy into Book** in **Book → Assets…** (or **File → Duplicate…** with *Include all files* checked) on Lightroom-linked photos triggers the same on-demand full-resolution `LrExportSession`, writes the resulting sRGB JPEGs into the package's `photos/` directory, and converts their `photos.json` entries from `lightroom` locators to ordinary document-owned relative paths.

### 5. Local IPC and plugin packaging

- **Plugin installation:** ImageFlow bundles `ImageFlow.lrplugin` inside its macOS app bundle (`Contents/Resources/ImageFlow.lrplugin`) and can install or update it in `~/Library/Application Support/Adobe/Lightroom/Modules/ImageFlow.lrplugin` on user request from Settings or the Import menu.
- **Loopback-only authenticated IPC:** The bridge binds strictly to `127.0.0.1` (using a per-user bearer token stored in `~/Library/Application Support/ImageFlow/` with `0600` permissions that both ImageFlow and the Lua plugin read) so untrusted local webpages or other local accounts cannot query catalog metadata or trigger exports.
- **No template access:** Lightroom IPC lives exclusively in the trusted Electron main process (`desktop/`). Sandboxed template code (`src/`, render frames) never communicates with the plugin and sees only standard `Photo` objects (`width`, `height`, `src`, capture metadata).

## Consequences

- Photographers can import hundreds of candidate photos from Lightroom Classic into a book in seconds using lightweight 1400 px previews, without waiting for full-resolution exports or filling their disk with unused JPEGs.
- Layout geometry, normalized crops and `Book check` 300 DPI warnings remain accurate during editing because `assets-meta.json` records Lightroom's true post-crop `croppedDimensions` alongside the 1400 px `ProxyStore` image.
- Tweaking exposure, masks or crops in Lightroom Classic updates only the affected photos' 1400 px previews during editing, and full-resolution `LrExportSession` rendering runs at PDF export time only for the photos actually placed in the book (and only for those whose `lrDigest` changed since the last export).
- Syncing a book to a second Mac ([0010](0010-sync-revisions-and-cloud-assets.md)) carries the 1400 px Lightroom previews and post-crop dimensions automatically, allowing offline layout and cropping on a laptop while keeping final full-resolution PDF export on the Mac with the Lightroom Classic catalog (or converting selected photos into owned package files via *Copy into Book*).
