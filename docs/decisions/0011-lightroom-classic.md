# 0011: Lightroom Classic preview-first editing and on-demand export rendering

Status: proposed, 2026-11-22 (revised after feasibility review: change detection, IPC and source-model prerequisites; revised again after the spike ran in Lightroom Classic 16.0.1: change detection, digest, `croppedDimensions`, batch rendering; then reframed around a general source-provider contract and render storage; then revised after that contract was checked against the code, see [the plan](../development/source-provider-plan.md); then on 2026-11-24 after the first large import: previews are Lightroom's own, see section 2). Phase 2 is built: the `lightroom` provider, the loopback bridge and the plugin; full-resolution export and Copy into Book of such photos are phase 3 ([Implementation](#implementation)). Builds on [0004](0004-document-packages.md) (document packages), [0005](0005-linked-sources.md) (linked sources) and [0010](0010-sync-revisions-and-cloud-assets.md) (sync, revision tracking and cloud assets).

The direction (a companion plugin that renders in Lightroom's own engine) is feasible. Several mechanisms first drafted here rested on SDK behaviour that was **unverified or contradicted by developer reports**. The spike in [Validation spike](#validation-spike) (`spikes/lightroom-classic/`) has since measured most of it on a real 40,000-photo catalog in Lightroom Classic 16.0.1; what it has not measured is still marked *unverified* below. The larger cost is not the Lua plugin but teaching ImageFlow's source model about photos that have no file ([Source providers](#source-providers)).

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

Make **Lightroom Classic the first non-file source provider** behind a general provider contract ([Source providers](#source-providers)), not a feature wired through the app. The host owns everything that is the same for every provider (previews, caches, digests, availability, export pinning, Copy into Book); the Lightroom provider supplies only what is specific to Lightroom. Concretely, integrate with **Lightroom Classic on macOS** through a bundled companion Lua plugin (`ImageFlow.lrplugin`) over a localhost IPC bridge, using **1400 px screen previews during editing** (`ProxyStore` + `assets-meta.json`) and **on-demand `LrExportSession` rendering during PDF export** (and explicit collection) only for photos actually placed in the book.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Lightroom Classic (macOS)                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ ImageFlow.lrplugin (Lua)                                          │  │
│  │ • Pull bridge: LrHttp client long-polls ImageFlow's loopback API  │  │
│  │ • Fast change poll: catalog:batchGetRawMetadata(photos, keys)     │  │
│  │ • Revision key:     lastEditTime + editCount + croppedDimensions  │  │
│  │ • Edit classifier:  hash of getDevelopSettings() (visual vs meta) │  │
│  │ • Preview:          requestJpegThumbnail (at least 1400 px)       │  │
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
│  • Source cache:     source-cache/content/<sha256>.jpg (full res)       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1. Source identity and manifest schema

Consistent with [0005](0005-linked-sources.md) and [0010](0010-sync-revisions-and-cloud-assets.md), photo IDs (`ph-...`) in `photos.json` remain stable internal identifiers, and external locations never become IDs.

- **Provider-tagged locator in `photos.json`:** A Lightroom-backed photo entry records a `lightroom` locator with the photo's catalog UUID (`photo:getRawMetadata("uuid")`) **and a catalog identity**, plus an optional source filename/collection hint, alongside user-editable `title`, `caption`, `credit` and `altText`. A UUID is only meaningful inside one catalog, and Lightroom has one catalog open at a time, so the plugin reports the open catalog's identity and a photo whose catalog is not the open one is "unavailable", never silently missing. (*Unverified:* that UUIDs survive catalog export/import and merge; the spike checks it.) Machine-local catalog paths stay in local app settings/approvals rather than in portable book manifests.
- **Portable book-state revision (`src/book-revision.ts`):** `computeBookStateRevision` retains `{ lightroom: { uuid } }` while stripping machine-local paths, so two synced Macs compute the exact same portable `bookStateRevision`.
- **True dimensions and EXIF in `assets-meta.json` (`src/asset-facts.ts`, `desktop/asset-facts.ts`):** When importing or refreshing a photo from Lightroom, ImageFlow records its **post-crop** dimensions (`croppedDimensions`, a table `{ width, height }`), capture timestamp, GPS coordinates and camera make/model in `assets-meta.json`.
- **Titles, captions, credit and alt text: provider values, ImageFlow overrides.** The provider's descriptive metadata is read-only in ImageFlow, and an edit in ImageFlow is an override that wins while it is set:
  - **Where each value lives.** Provider values are facts: the provider reports them with its other facts and the host records them in `assets-meta.json` (a `provided` object of `title`, `caption`, `credit`, `altText`), so they sync between Macs and show on a laptop without Lightroom. Overrides stay where these fields live today, in the photo's `photos.json` entry. `photos.json` holds only what the user changed, so it stays small and portable.
  - **Precedence.** For each field: the override if its key is present, otherwise the provider value, otherwise nothing (and for the title, the file name, as today). A present empty string is an override: it blanks a field the provider fills. An absent key inherits.
  - **Lightroom mapping.** `title` → title, `caption` → caption, `copyright` (falling back to `creator`) → credit, read with `getFormattedMetadata` in the same batch as the other facts. Lightroom's alt text field, if the SDK exposes one, maps to `altText` (*unverified*: the spike probes the key). Other providers map their own fields, or report none.
  - **Changes in Lightroom flow in.** A metadata-only edit changes `lrRevision` but not the develop hash (section 3), so the host refreshes the provided values without rendering, and a template printing an inherited caption updates on the next reload. An override is not touched by a change in Lightroom.
  - **Editing.** The Inspector shows an inherited value as the field's placeholder, marks an overridden field, and offers **Revert to Lightroom**. `set_photo_metadata` keeps its meaning: a string writes an override, and `null` removes it, which now means "inherit" instead of "empty".
  - **No write-back.** ImageFlow never writes titles or captions into the Lightroom catalog. An explicit "Write captions to Lightroom" action through the plugin can be added later; it is not part of this ADR.
  - **Import.** Import of a provider photo writes no title into `photos.json`, so the photo inherits its Lightroom title. The same rule lets the file providers later read IPTC/XMP titles and captions from files without changing the model.
  - **Templates** see only the resolved values, as `Photo.title`, `caption`, `credit` and `altText` today.
- **`digest` keeps its ADR 0010 meaning.** In `assets-meta.json`, `digest` is "SHA-256 of the original's bytes", and Locate Folder and the proxy store key on it. A Lightroom photo's `digest` is therefore the SHA-256 of the **stored preview bytes**, never a synthetic hash of Lightroom state. Lightroom writes a fresh `xmp:MetadataDate` and a random `xmpMM:DocumentID` into every export, whatever the metadata option, so two renders of the same edit differ in bytes. ImageFlow therefore removes the EXIF/XMP (APP1) and comment segments from a rendered preview, keeping the ICC profile, before storing and hashing it. The spike found the remaining image data identical across re-renders. The Lightroom revision that produced it (`lrRevision`) and the develop-settings hash go in a separate `lightroom` object on the fact. Two edits that render identically then share a digest, so downstream proxies and renditions are not invalidated.
- **`croppedDimensions` is an estimate until a full-resolution render exists.** It matched the real export size on every photo the spike tested (cropped and uncropped), but it can still differ by a few pixels from the real export (Upright, Super Resolution, rotation crops). Whenever a full-resolution render is produced, its actual pixel size replaces the estimate in `assets-meta.json`, so the 300 DPI checks converge on the truth.

### 2. Preview-first editing via `ProxyStore` and `assets-meta.json`

ImageFlow already decouples layout geometry and print-resolution checks from proxy pixels ([0010](0010-sync-revisions-and-cloud-assets.md), `desktop/project.ts`, `desktop/proxy-store.ts`):

- **1400 px sRGB preview on import, the one Lightroom keeps itself** (revised 2026-11-24, see [Why thumbnails](#why-thumbnails)): When photos are imported from Lightroom Classic (either pushed from Lightroom via **File → Plug-in Extras → Send to ImageFlow** or pulled from ImageFlow via **Import from Lightroom Classic…**), the plugin hands over `photo:requestJpegThumbnail(1400, 1400)`. It renders a preview only for a photo that has no picture and that Lightroom has no thumbnail of, and on **Refresh from Lightroom Classic**: a 1400 px long-edge sRGB JPEG (`LrExportSession` with `LR_format = 'JPEG'`, `LR_export_colorSpace = 'sRGB'`, `LR_jpeg_quality = 0.86`, `LR_size_doConstrain = true`, `LR_size_resizeType = 'wh'`, `LR_size_maxWidth = 1400`, `LR_size_maxHeight = 1400`).
  - This ADR first chose a render for every preview, because `requestJpegThumbnail` reads Lightroom's own preview cache, which developers report as stale after Develop adjustments and as behaving differently in Library and Develop. Measured, it is not stale, and it does behave differently: see [Why thumbnails](#why-thumbnails).
- **Stored in `ProxyStore` by content digest:** ImageFlow stores the 1400 px preview, without its metadata segments, in `ProxyStore` (`Cache/proxies/<sha256 of the stored bytes>-preview-v1.jpg`) and derives the 240 px filmstrip thumbnail from it.
- **Photos show as they arrive.** A load of an open book waits for no previews: a photo without one is laid out at its size and shown as loading, and the session fetches previews after the load and reloads the book as they come, compressing several at once while Lightroom works on the next.
- **A photo edited in Develop keeps its older picture, marked out of date.** Lightroom refuses a thumbnail of it until the user is back in Library (below). The plugin remembers the refusal and reports the photo again when Lightroom switches to Library, then ever less often while Lightroom still refuses. Nothing is rendered meanwhile: previews need not follow a slider. The fact keeps the older preview's digest and size and records the photo's current `revision` without a `contentRevision`, so the preview stays wanted, a sync does not take it for current, and an export still renders and prints the photo as it is now.
- **Two checks on a thumbnail.** One identical to the previous picture although the develop settings changed, and one under 1000 px of a larger photo, are not trusted: the photo is rendered. Its revision is read before and after, as for a render.
- **Layout, cropping and 300 DPI checks without full-resolution files:** Because `ProjectPhoto.width` and `ProjectPhoto.height` come from `assets-meta.json` (`croppedDimensions`), the spread canvas, normalized box crops (`centerX`, `centerY`, `zoom` in `[0..1]`) and `Book check`'s effective-DPI warnings operate against the true post-crop pixel dimensions of the RAW photo even though only a 1400 px preview exists on disk.
- **Multi-Mac sync compatibility:** Because `assets-meta.json` and `ProxyStore` entries sync across Macs under [0010](0010-sync-revisions-and-cloud-assets.md), a book with Lightroom Classic photos imported on an iMac can be opened, laid out and cropped on a MacBook without Lightroom Classic or the original RAW files present.

#### Why thumbnails

The first large import (992 Sony 33 MP RAWs, M4 Pro, Lightroom Classic 16.0.1) took **373 s**, 0.38 s per photo, in 199 sessions of five: not much less than exporting the photos. About 86 s of it was ImageFlow compressing previews one at a time while Lightroom waited. Measured in the same catalog:

| | 992 photos | Per photo |
| --- | --- | --- |
| Sessions of five, compressed one by one (as shipped) | 373 s | 376 ms |
| `requestJpegThumbnail(1400, 1400)` | 25.0 s (23.6 s again) | 25 ms |

Every request was answered exactly once and without an error; the first thumbnail came after 0.23 s. Compressing a preview takes 106 ms alone and 28 ms each with eight at once.

Render sessions of 40 photos each took 0.32 s per photo in fives (0.23 s in a second run), 0.29 s in tens, 0.26 s in twenties and 0.19 s in forties, so larger sessions help far less than not rendering; previews that must be rendered use sessions of twenty. Full-resolution sessions stay at five, for their cancel.

**Quality, against fresh renders of the same 992 photos** (compared at 350 px): every thumbnail was at least 1400 px, turned and cropped as Lightroom shows it, sRGB without a profile; the median RMS difference was 3.3 of 255, the largest 7.5; no aspect ratio was off by 1 %. Thirteen photos had only a 360 px preview before, and Lightroom built a 1440 px one when asked.

**Staleness, the reason this ADR first rejected thumbnails.** Lightroom's preview cache is keyed by the develop settings' digest: of the 992 photos, 986 previews carried exactly the catalog's current digest. While one photo was edited in Develop, 186 of 186 thumbnail requests failed at once ("error loading thumb") and none returned an older picture. Back in Library, Lightroom built the photo's preview, and it matched a render of the edits (RMS 3.1 of 255; 20.3 against the picture before them).

*Unverified:* the plugin itself fetching the thumbnail of an edited photo that is not on screen after the return to Library (the preview above was read from Lightroom's cache, and Lightroom probably built it because it was showing the photo); whether Quick Develop edits in Library behave the same; whether thumbnails of unedited photos are handed over in Develop. The refusal, the identical-picture check and the render fallback cover each, at the cost of a render or a later update.

Reading Lightroom's preview files directly would be faster still (0.96 s for all 992) and stays rejected: the format is undocumented and has changed between versions.

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
3. **Visual edits fetch the preview again,** once Lightroom has one (section 2), and the stored-bytes `digest` is a second filter: if the new preview's digest equals the stored one (an edit that renders the same), nothing downstream is invalidated (no proxy, thumbnail or rendition churn, no `DocumentSession` reload).
4. **Print is conservative.** The full-resolution render cache is keyed on `lrRevision`, not on the develop hash, so any change Lightroom records, including one the develop hash might miss on an untested mask type, re-renders a placed photo at export. A wasted full render after a rating change (about 1.5 s per photo) is the price of never printing a stale image.
5. **Debounce.** A dragged slider moves `lastEditTime` several times. The plugin reports a photo dirty only after its revision has been stable for one poll interval, and ImageFlow asks for at most one preview per photo at a time.
6. **Polling.** The plugin polls the tracked UUIDs (`catalog:findPhotoByUuid`) every 1–2 s while an open book has Lightroom sources, immediately on request (window focus, before export), and not at all otherwise.
7. **Hot reload.** When a re-rendered preview changes `digest`, ImageFlow writes it to `ProxyStore`, updates `width`, `height`, `digest`, `lightroom.revision` and `lightroom.developHash` in `assets-meta.json`, and reloads the active `DocumentSession`, as saving an external linked photo in place does today (`desktop/document-session.ts`).
8. **Crops keep their numbers, not necessarily their framing.** Box crops in `project.json` are normalized `[0..1]` coordinates, so they stay valid when a photo is re-cropped in Lightroom, and DPI checks update from the new dimensions. But a changed aspect ratio shifts what the box shows, so ImageFlow flags photos whose aspect ratio changed since they were placed.

**Not covered by polling:** a photo removed from the catalog, replaced by a different catalog, or the plugin not running. These surface as an unavailable source with the ordinary `Retry` and `Locate` actions, and never as a silent success.

### 4. On-demand rendering during PDF export and collection

Full-resolution print renditions are rendered only when needed and only for photos that are actually used. *The host side of this section is done, for every provider* ([plan](../development/source-provider-plan.md#full-resolution-originals)), with two differences from what follows: the export load does not update `assets-meta.json` for a revision that moved, but refuses the export ("Sources changed while preparing export") until the open book has seen the new revision; and an export while the provider is offline stays a proof even when an original for the last known revision is cached.

1. **Filtering to placed photos (`assetUsage`):**
   - When starting **Export PDF** (`desktop/document-session.ts`) or a `proof-photo` inspection, ImageFlow computes the active photo placements via `assetUsage(book, ...)` (`src/asset-usage.ts`), covering active spread layouts and the active cover layout. Unused candidate photos in the book's library are never rendered at full resolution.
2. **Freshness check and rendition cache lookup:**
   - If Lightroom Classic is reachable, ImageFlow asks the plugin for the placed photos' current `lrRevision` before export begins, bypassing the poll interval. A photo whose revision differs from the one its stored full-resolution render was made from is rendered again, and its `assets-meta.json` entry is updated first.
   - Full-resolution renders are **materializations** in the host's source cache (see [Where renders are stored](#where-renders-are-stored)), recorded against the photo's provider revision (`lrRevision`). Any placed photo whose current `lrRevision` already has a materialization requires no re-render in Lightroom. The record is never trusted without this check while Lightroom is reachable.
3. **Batch `LrExportSession` for cache misses:**
   - For placed photos missing a full-resolution render at their current `lrRevision`, ImageFlow requests a batch render from `ImageFlow.lrplugin` before loading the pinned export snapshot, reporting progress in the status bar (`"Rendering 12 of 48 photos in Lightroom Classic…"`).
   - The plugin executes `LrExportSession` (`LR_format = 'JPEG'`, `LR_export_colorSpace = 'sRGB'`, `LR_jpeg_quality = 0.95`, `LR_size_doConstrain = false`) into a staging folder the host names; the host hashes each file and moves it into the source cache. Renders are **full size**: in the spike, a 3508 px print-size render took as long as a full-size one (RAW processing dominates) and only saved disk, while a full-size render stays valid when a photo is resized in the layout.
   - **Sessions of a few photos at a time.** One session renders several photos in parallel (0.78 s per 24 MP RAW over a 20-photo session, against 1.5 s for one photo per session), but a session cannot be cancelled: `LrExportSession` has no `cancel`, and leaving its rendition loop does not stop Lightroom. The plugin therefore renders in sessions of about 5 photos, and cancelling takes effect at the next session boundary.
   - **Edits during a render invalidate it.** The plugin reads `lrRevision` before and after each render and reports both. A render whose revision changed is discarded and retried, mirroring ADR 0005's rejection of a source replaced during export. In the spike, an edit made while a session ran did not reach that session's render, so this check is required. The batch reports progress per photo.
   - The batch takes about 0.8 s per placed photo (24 MP RAW; 48 photos in under a minute, about 20 MB each on disk), and shares Lightroom's export queue with the user's own work. ImageFlow estimates the time from the first renders and shows it. During a 20-photo batch, other plugin tasks went up to 1.2 s without running, so revision polling slows while a batch runs.
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

## Source providers

The plugin is a few hundred lines of Lua. Most of the work is in ImageFlow, whose source model assumes that every photo is a file: `photoIndexSchema` requires a `path` (`src/project.ts`), and `sourceEntries`, `SourceStore` approvals and stamps, rendition keys and `photoDetails` (JPEG, PNG or WebP through `sharp`) all start from one. ADR 0010 anticipated provider-tagged locators (`local-root`, `s3`, `webdav`, `immich`, `lightroom`, `apple-photos`) but defined no contract. This ADR defines it, because Lightroom is the first provider that needs it, and keeps it general enough that a cloud provider fits without changing the host again.

### What the host owns and what a provider owns

Almost everything in this ADR is generic. Previews before originals, full resolution only for placed photos, a revision per photo, "the source is offline" states and Copy into Book apply just as well to Immich, S3 or Apple Photos. What is Lightroom-specific is how a photo is identified, how its revision is read, and how pixels are produced.

| Concern | Host (provider-independent) | Provider |
| --- | --- | --- |
| Identity | Stable `ph-...` IDs; locators never become IDs ([0005](0005-linked-sources.md)) | A portable locator schema (`{ provider: 'lightroom', catalog, uuid }`) and how to resolve it |
| Facts | `assets-meta.json`, `Book check`, DPI checks | Dimensions, capture metadata, and a provider-specific `extra` object |
| Revision | Stores tokens, compares them, decides what to re-render or reload | Two opaque tokens per photo: `revision` (any change; keys print) and an optional `contentRevision` (visual changes only; keys previews). Lightroom: `lrRevision` and the develop-settings hash. Local files: the file stamp, for both. S3: the ETag. Immich: the checksum. The host hands the tokens it stored back in, so a provider reads a costly one (the develop hash) only when the other moved. |
| Change events | Debounce, hot reload, aspect-ratio warnings | `watch(locators)`: filesystem watcher, Lightroom poll, cloud poll or webhook |
| Previews | `ProxyStore`, digests, thumbnails, sync between Macs | `preview(locator)` when the provider has one (Lightroom render, Immich preview); otherwise the host derives it from the original |
| Full resolution | Which photos are placed, the source cache, pinning into the export job, Copy into Book | `materialize(locators)` into a staging folder: render (Lightroom), download (cloud) or copy (local files, which an export already reads from a private copy); in batches, with progress, cancellable between batches. Each result names the revision before and after, and one that changed is discarded |
| Availability | One set of states and actions (`Retry`, `Locate`, proof-only export) | Maps its failures onto them: `offline` (Lightroom not running, no network), `needs-sign-in`, `missing` (deleted from the catalog or bucket) |
| Trust | Approvals, credentials in local settings, loopback server, Electron main only | Declares what it needs (a local app, a network origin, an account) |

The contract has two halves. Reading state, pixels and changes (`SourceProvider`, `desktop/source-provider.ts`) runs only in the Electron main process; templates still see only `Photo` objects. How a `photos.json` entry reads as a locator, and which part of it is portable (`LocatorKind`, `src/source-locator.ts`), is pure, because the book-state revision, sync snapshots and the renderer need it too.

**A photo is either a file the host reads in place, or facts.** The file providers report a file, and the host treats it as it does today: it reads the facts with `sharp`, derives and keys renditions from the file, and hashes its bytes into the render-input revision (`desktop/revisions.ts`). A provider without a file reports facts; its pixels come from `preview` and `materialize`, and its `revision` token takes the place of the bytes in the input revision. In the editor such a photo is drawn like one whose original is missing on this Mac today: from its fact and its proxy.

The contract covers photos. Texts and files stay files. Approvals stay inside `linked` (a grant is for one exact path), and import stays provider-specific until a second provider shows what the two share. The existing file behaviour becomes two providers that share how a file is read: `package`, a photo in the book's own `photos/` (the host's storage: no approval, synced as an original), and `linked`, a file elsewhere on this Mac (approved per path, watched where it is). Copy into Book changes any photo's provider to `package`. So the contract is proven by existing behaviour before it is designed for Lightroom. Before a cloud provider is built, its fit is checked on paper (Immich: previews, original download, checksum as revision), not implemented.

### Where renders are stored

| What | Where | Key | Lifetime |
| --- | --- | --- | --- |
| 1400 px previews | `ProxyStore`, `Cache/proxies/<digest>-preview-v1.jpg` | `digest`, the SHA-256 of the stored preview bytes | Synced between Macs (ADR 0010), so a laptop without the provider can still lay out the book |
| Full-resolution materializations | The source cache, `source-cache/content/<sha256>.<ext>`, beside today's snapshots of linked files | Content SHA-256, with the book's source index recording which provider `revision` produced it | Machine-local, never synced; reused by later exports while the revision matches |
| Export job | `privateCache/pinned-sources` | — | Deleted when the export ends (`desktop/document-session.ts`) |
| Copy into Book | The package's `photos/` | — | Permanent; the photo becomes an ordinary owned file |

Full-resolution files go into the **source cache, not the rendition cache.** The rendition cache (`Cache/renditions`) is capped at 512 MB and pruned between sessions (`pruneRenditions`, `desktop/rendition-cache.ts`); at about 20 MB per 24 MP render, a 48-photo book alone would exceed it and re-render at every export. The source cache already has the retention a materialization needs (`pruneSourceCache`, `desktop/source-store.ts`): the most recently opened book keeps every snapshot it references whatever the limit, recent books are preferred, open books and running jobs pin theirs, and the 2 GB limit applies to the rest. A materialized Lightroom render is then the same kind of object as a snapshot of a linked file, and export pinning works unchanged. Settings shows the cache size and a **Clear** action, since a few large books reach several GB.

### Sync between Macs

Providers do not change how a book syncs ([0010](0010-sync-revisions-and-cloud-assets.md)); they generalise what a linked file already is there. Book state, facts and 1400 px proxies sync for every photo, whatever its provider. An original syncs only when its provider is `package`.

**A Mac can print a photo if the photo is in the package, or if that Mac can reach the photo's provider.**

| Reach | Providers | Full resolution on another Mac |
| --- | --- | --- |
| Travels with the book | `package` | Yes: the original is downloaded on demand |
| Any Mac with access | Immich, S3 and other servers | Yes, once that Mac is signed in |
| Bound to one Mac | `linked`, `lightroom` | Only if that Mac has the folder or the catalog |

A book can therefore hold photos that no single Mac can print: one Mac adds Lightroom photos, another links a folder only it has. This is already possible with two linked folders, and each Mac shows the other's photos from their proxies. Only providers bound to one Mac cause it. There are three answers:

1. **Copy into Book** on the Mac that has the source. The photo becomes a `package` photo and its original syncs. It no longer follows edits in Lightroom.
2. **Say it before the export.** Book check lists the placed photos this Mac cannot print, with the reason (in Lightroom on another Mac, a linked folder not located here, not signed in), and the export is proof-only for them, as for a missing linked original today. Naming the other Mac needs a fact to record which Mac last read the original; today it records only when.
3. **Syncing full-resolution renders of placed photos** (*deferred*). A materialization is a content-addressed file recorded against a revision, so the sync engine can upload it like an owned original, and another Mac can export from it while the photo stays a Lightroom photo. That Mac cannot ask Lightroom whether the render is current, so it prints the revision the render was made from and says so. This needs nothing from a provider and is decided when full-resolution export exists (phase 3).

The provider contract needs nothing for this: the host asks whether a photo's provider is `package` (sync the original), and what `observe` returns on this Mac (can it print).

### Other prerequisites

- **Older builds.** An entry without `path` is rejected by builds that predate it, so provider locators ship behind a `schemaVersion` bump (ADR 0009 and 0010's mixed-version rules). *Done:* book format 4, which `bookFormatOf` derives from the photo index as well as `project.json` ([plan](../development/source-provider-plan.md#photos-without-a-file)).
- **Facts of older builds.** `assets-meta.json` was parsed with a schema that drops unknown fields, and a file with another `version` read as empty and was written over, so a build that predates the `provided` and revision objects would remove them when it saves the book. *Done:* facts and the file keep unknown fields, and a file of another version is never written over; this ships a release before any such book exists.
- **Proxy stand-in.** Today a proxy stands in only for `missing` or `unapproved` originals (`desktop/project.ts`). A provider photo whose provider is offline needs the `offline` state. Print is blocked or proof-only for it, using the same source-diagnostic codes and `ORIGINAL UNAVAILABLE` marking as ADR 0005.
- **Colour.** Materializations are 8-bit sRGB JPEGs for Lightroom, as ImageFlow's own pipeline produces (`withIccProfile('srgb')`), so there is no loss against today. Wide-gamut or 16-bit renders are out of scope.

## Alternatives considered

- **Hard Drive Publish Service, linked folder (today).** Lightroom's Publish Manager tracks modified photos itself, and the linked-folder watcher of ADR 0005 picks up the files. It needs no ImageFlow changes and is the baseline. This ADR adds lazy full-resolution rendering, post-crop dimensions without exporting and hot reload without a manual publish. A minimal Publish Service plugin that exports the 1400 px previews and a small sidecar is a cheaper first step if the provider work is deferred (see the phasing below).
- **Reading `Previews.lrdata` and the catalog.** Rejected above: stale, undocumented and locked while Lightroom runs.
- **Lightroom Cloud API.** Rejected above: 2560 px ceiling and cloud dependency.

## Validation spike

`spikes/lightroom-classic/` holds a plugin that answers, on a real catalog, the questions this ADR depends on. Its `README.md` has the procedure and the full results of the first run (2026-11-22, Lightroom Classic 16.0.1, macOS 27.2.1). In short: masks do bump `lastEditTime` and appear in `getDevelopSettings()`; metadata edits do not change the develop hash; renders take 0.5–1 s (1400 px) and about 1.5 s (full resolution, 24 MP Sony ARW) and are identical except for their metadata; loopback `LrHttp` works; `croppedDimensions` matched the real export size; the setting names below work and `doExportOnCurrentTask` returns with the file in place; a batch session renders in parallel at 0.78 s per photo, cannot be cancelled, and does not pick up edits made while it runs. Still open: the mask types and actions listed as *unverified* in section 3, UI stutter under polling, loopback under load, UUIDs across catalog export, and `croppedDimensions` on Upright and Super Resolution photos. The questions:

1. Which actions change `editCount` and `lastEditTime`: slider, mask, AI mask, spot removal, crop, rating, flag, keyword, virtual copy, undo, Sync Settings, Auto Sync, presets? If masks do not bump the revision, section 3 does not work and the fallback is re-rendering at export.
2. What does `getDevelopSettings()` return for mask and retouch edits (diagnostic only)?
3. How long does `batchGetRawMetadata` take for 50, 500 and 2,000 photos, and does polling it stall Lightroom's UI?
4. How long does a 1400 px and a full-resolution `LrExportSession` render take per photo, and does a render of an unchanged photo give byte-identical output?
5. Does `LrHttp` reach a loopback server reliably, while Lightroom is busy, and does a long-poll block other plugin tasks?
6. Do UUIDs survive catalog export and import, and what identifies a catalog?
7. Do the `LrExportSession` setting names used here (`LR_size_doConstrain`, `LR_size_resizeType`, `LR_tokenCustomString`, …) behave as assumed, and does `doExportOnCurrentTask` return with the file in place?
8. How close is `croppedDimensions` to the real export size on Upright, rotated and Super Resolution photos?
9. How fast is one `LrExportSession` over many photos, does a smaller target size save time, can a batch be cancelled, and does an edit made during a batch reach its render?

**Phasing** (each phase is useful alone):

0. Spike (above); revise this ADR from the results. *Done for questions 1–5, 7, 9 and part of 8.*
1. Minimal Publish Service plugin: previews and a sidecar to a folder, linked by ImageFlow as today. Ships without the provider contract.
2. The provider contract, with today's file behaviour moved behind it as the `package` and `linked` providers and no visible change; then the `lightroom` provider with the pull bridge and previews. *Done* (phase 1 was skipped), see [Implementation](#implementation).
3. Full-resolution rendering at export, collection and Copy into Book.

## Implementation

What phase 2 built, and where it settles points this ADR left open. Nothing of it has run inside Lightroom yet: the plugin's calls are the ones the spike measured, and what the spike did not measure is listed below.

- **Plugin** (`resources/ImageFlow.lrplugin`, shipped in `Contents/Resources`; Lightroom Classic 13 or later). It starts with Lightroom (`LrForceInitPlugin`), connects by itself and offers **Send to ImageFlow** under Plug-in Extras. `Info.lua`'s `VERSION` is what Settings compares.
- **Catalog identity** (section 1): a UUID the plugin makes once and keeps in the catalog's plug-in properties (`catalog:setPropertyForPlugin`), so it moves with the catalog and is not its path. Where that call fails, a hash of the catalog's path stands in. *Unverified:* the call itself, and whether the property survives Export as Catalog.
- **Bridge** (section 5, `desktop/lightroom/bridge.ts`). The port and token are in `lightroom-bridge.json` in ImageFlow's own Application Support folder (`~/Library/Application Support/ImageFlow/`, mode 0600, rewritten at every start and removed at quit). Routes: `POST /lightroom/hello` (catalog, plugin version; answers with a session and the photos to watch), `GET /lightroom/jobs` (long poll, 25 s), `POST /lightroom/results` (one route for every job, where this ADR first named `/revisions` and `/renders`), `POST /lightroom/changes`, `POST /lightroom/send` and `POST /lightroom/bye`. The plugin counts as gone after a bye, or when its held poll breaks off and no request follows within 3 s. Jobs and results: `desktop/lightroom/protocol.ts`, which parses everything the plugin sends.
- **Revision key** (section 3): the plugin makes `lrRevision` and hashes `getDevelopSettings()` (sorted-key JSON, MD5) only for a photo whose revision differs from the one ImageFlow hands in. The change poll runs every 1.5 s over the watched photos only (4 s while a render runs) and reports a photo once its revision has been stable for one poll. Its baseline is the first poll after a watch starts, so an edit between a book's load and that poll is not reported until the next one.
- **Facts**: `croppedDimensions` as the size, `dateTimeOriginalISO8601`, `gps`, camera make and model; `title`, `caption`, `copyright` (else `creator`) as provided values; orientation and file name in `extra`. Keys other than the ones the spike proved are probed once, each by itself. *Unverified:* the ISO capture-time and GPS keys, an alt-text key (`altTextAccessibility` is tried), and whether `croppedDimensions` is already turned for a photo Lightroom rotates by 90°.
- **Previews and renders** (sections 2 and 4): a `thumbnails` job asks for 24 at a time, and the next one starts while ImageFlow compresses these; a render is one export session of up to five photos at full size, or twenty previews. Each writes into a folder ImageFlow makes for it inside its staging folder; a file the plugin names outside it is refused. `thumbnails` came with plugin 1.1.0; with an older plugin still installed, ImageFlow renders previews as before. `provider.materialize` exists and is tested; the host stores its results in the source cache and pins them into exports ([plan](../development/source-provider-plan.md#full-resolution-originals)), so an export prints Lightroom photos at full resolution while Lightroom is reachable and is a proof otherwise.
- **Import**: Send to ImageFlow and **File → Import from Lightroom Classic…** both end in `importProvidedPhotos` (`desktop/project.ts`), the host step a file import ends in too (`finishImport`). A photo the book holds already, by catalog and UUID, is reported as existing. The new photos show at once, and their previews follow in the background.
- **Repair**: `launch` opens Lightroom Classic with `open -a` (no shell); the provider's watch reports every photo when the plugin connects, and the book observes them again.

## Consequences

- Photographers can import hundreds of candidate photos from Lightroom Classic into a book without waiting for full-resolution exports or filling their disk with unused JPEGs. Their previews are the ones Lightroom keeps (about half a minute for a thousand photos), so nothing is rendered for a photo that is only a candidate.
- Layout geometry, normalized crops and `Book check` 300 DPI warnings remain accurate during editing because `assets-meta.json` records Lightroom's true post-crop `croppedDimensions` alongside the 1400 px `ProxyStore` image.
- Tweaking exposure, masks or crops in Lightroom Classic updates only the affected photos' previews, once the user is back in Library, and full-resolution `LrExportSession` rendering runs at PDF export time only for the photos actually placed in the book (and only for those whose `lrRevision` changed since the last export).
- Syncing a book to a second Mac ([0010](0010-sync-revisions-and-cloud-assets.md)) carries the 1400 px Lightroom previews and post-crop dimensions automatically, allowing offline layout and cropping on a laptop while keeping final full-resolution PDF export on the Mac with the Lightroom Classic catalog (or converting selected photos into owned package files via *Copy into Book*).
- Change detection is cheap for metadata edits (no preview render) and conservative for print: any recorded change to a placed photo re-renders it at export, so a mask type the develop hash might not cover can cost a stale *preview*, never a stale print.
- ImageFlow needs the provider contract and a schema bump before any Lightroom code ships. The contract keeps Lightroom-specific code in one provider, and the next provider (Immich, S3, Apple Photos) reuses previews, materialization, the source cache, availability states and Copy into Book unchanged.
