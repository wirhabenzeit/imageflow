# Spike: Lightroom Classic change detection, rendering and loopback bridge

Supports [ADR 0011](../../docs/decisions/0011-lightroom-classic.md). The ADR rests on SDK behaviour that is unverified or contradicted by developer reports. This spike measures it on a real catalog, so the ADR can be revised from results instead of forum threads. It is throwaway code: it logs and measures, and does not talk to ImageFlow.

**Status: written but not yet run.** Lightroom Classic was not available where it was written. The Lua parses as Lua 5.1 (checked with `luaparse`), and `server.mjs` and `analyze.mjs` were tested against synthetic input, but no plugin code has run inside Lightroom. Expect to fix SDK details on the first run (the first likely ones are marked below), and record what was fixed.

## Contents

| File | Purpose |
| --- | --- |
| `ImageFlowSpike.lrplugin/` | The plugin. Menu items appear under **Library → Plug-in Extras**. |
| `server.mjs` | Loopback server for the HTTP tests: bearer token, `Host` check, long-poll endpoint. No dependencies. |
| `analyze.mjs` | Summarizes the log as a Markdown table plus benchmark lines. |

## Setup

1. Quit Lightroom Classic. Copy or symlink the plugin: `ln -s "$PWD/ImageFlowSpike.lrplugin" ~/Library/Application\ Support/Adobe/Lightroom/Modules/`.
2. Start Lightroom Classic, open **File → Plug-in Manager**, **Add** the plugin if it is not listed, and check that it shows *Installed and running*.
3. Use a **copy of a real catalog** (the spike only reads and renders, but the benchmarks want a few thousand photos) and a handful of RAW photos you can edit freely, or virtual copies of them.
4. Everything is logged to `~/Documents/ImageFlowSpike/log.jsonl`; renders go to `~/Documents/ImageFlowSpike/renders/`. **Reveal log folder** opens it.

## Procedure (ADR question numbers in brackets)

### Q1 and Q2: which actions change the revision? [ADR 1, 2]

1. Select 3–5 photos in the Library grid. Run **1. Watch selected photos: start** (it polls once a second until stopped).
2. For each action in the list below: run **3. Add marker…** and type the action, do the action on one photo in Develop, wait about 5 seconds.
3. Run **2. Watch selected photos: stop** and `node analyze.mjs`. Paste the table into the results below.

Actions: exposure slider; the same slider dragged continuously for 3 s; tone curve; brush mask; radial filter; AI subject mask; AI sky mask; spot removal; crop (changing aspect); crop (same aspect, rotate 1°); Upright; lens profile on/off; apply a preset; Sync Settings to a second photo; Auto Sync; undo; rating (stars); flag; colour label; keyword; caption; create a virtual copy; Reset.

What to read in the table: a row with `editCount` = no and `develop hash` = no for a visual edit is the failure the ADR guards against. `masks/retouch in develop` lists which mask and retouch keys `getDevelopSettings()` returned; an empty entry for a mask action confirms that it cannot serve as a fingerprint. `lag` is the time from Lightroom's own `lastEditTime` to this detection.

### Q3: polling cost [ADR 3]

Select any photo and run **5. Benchmark batchGetRawMetadata**. It times 50, 500, 2,000 and 10,000 photos (as far as the catalog goes), compares with single calls, then runs 200 back-to-back calls. While the last step runs, scroll the grid and drag a Develop slider and note any stutter in the results. The watch loop's own poll time is in the `watch-tick` lines.

### Q4 and Q7: renders [ADR 4, 7]

Select 3 RAW photos (one cropped, one with a mask, one plain) and run **6. Benchmark renders**. For each photo it renders the 1400 px preview twice and one full-resolution JPEG, with the ADR's settings, and logs time, size, MD5 and the pixel size read with `sips`. Check:

- time per preview and per full render (the ADR's "seconds for hundreds" depends on this);
- whether the two previews are byte-identical (the ADR's suppression of false positives depends on this; if not, compare decoded pixels instead);
- whether the preview really is 1400 px on its long edge, so the setting names work;
- `editCount` before and after the render (rendering must not change the revision).

**Likely first fixes:** the `LR_*` export setting names are from memory of the SDK guide; if a render ignores a setting (wrong size, wrong name), correct it from the guide's *Export settings* table. If `doExportOnCurrentTask` returns before the file exists, switch to iterating `session:renditions()` and `rendition:waitForRender()`.

### Q5: HTTP bridge [ADR 5]

In a terminal: `node server.mjs`. In Lightroom run **7. Loopback HTTP tests**. It posts 20 requests, holds a 10 s long poll while a second plugin task keeps counting, and sends a wrong token. Check that the median round trip is a few milliseconds, that the second task kept ticking (`ticksDuring` close to `expectedTicks`), and that the wrong token got 401. Then repeat the long poll **while Lightroom is busy** (start a large export of your own first) to see whether the plugin still gets its turn.

### Q6: identity [ADR 6]

Select photos and run **4. Probe keys and identity**. It lists which candidate keys `batchGetRawMetadata` accepts (including the spelling of the orientation key and the type of `croppedDimensions`), the Lightroom version and the catalog path, and whether `findPhotoByUuid` finds each photo. Then **File → Export as Catalog** with the selected photos, open the exported catalog, select the same photos and run it again: compare the UUIDs. Also run it on a virtual copy and on a photo in a second catalog.

### Q8: `croppedDimensions` against the real export [ADR 8]

The render benchmark logs `fullMatchesCropped`. Include photos with Upright, a straightened crop, and Enhance → Super Resolution.

## Results

Fill in when run (date, Lightroom Classic version, macOS version):

- Q1/Q2 table: *(paste `analyze.mjs` output)*
- Q3: *(batch times; UI stutter?)*
- Q4/Q7: *(render times; byte-identical previews?; setting names that needed fixing)*
- Q5: *(round trip; long poll under load)*
- Q6: *(keys accepted; UUID survives catalog export?)*
- Q8: *(cropped vs real sizes)*

## What each outcome changes in the ADR

| Finding | Consequence |
| --- | --- |
| A visual edit (any mask type) does not change `editCount` or `lastEditTime` | Change detection by polling does not work. Fall back to re-rendering placed photos at export, plus a manual "Refresh from Lightroom" action. |
| Metadata edits also bump the revision (expected) | Keep the preview-hash suppression. If previews are not byte-identical, suppress by comparing decoded pixels. |
| Batch call is not much faster than single calls, or stalls the UI | Poll less often (5–10 s) and only on focus and before export. |
| Preview render takes more than about 1 s per RAW | Use `requestJpegThumbnail` for the grid and render 1400 px lazily, only for photos placed or opened. |
| `LrHttp` to loopback is unreliable, or a long poll blocks other tasks | Use the job-spool directory instead of HTTP. |
| UUIDs change on catalog export/import | The locator needs a second identity (file path plus capture time) for re-linking. |
