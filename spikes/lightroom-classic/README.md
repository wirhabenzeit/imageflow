# Spike: Lightroom Classic change detection, rendering and loopback bridge

Supports [ADR 0011](../../docs/decisions/0011-lightroom-classic.md). The ADR rests on SDK behaviour that is unverified or contradicted by developer reports. This spike measures it on a real catalog, so the ADR can be revised from results instead of forum threads. It is throwaway code: it logs and measures, and does not talk to ImageFlow.

**Status: experiments 3–8 ran in Lightroom Classic 16.0.1 on 2026-11-22 (see Results); experiment 1/2 still needs a manual run.**

## Contents

| File | Purpose |
| --- | --- |
| `ImageFlowSpike.lrplugin/` | The plugin. Menu items appear under **File → Plug-in Extras**, in every module. |
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

### Q9: batch export for the final render [ADR section 4]

Select about 20 photos (RAW, some cropped) and make one of them the active photo (click it last). Run **9. Benchmark batch export**. A dialog explains the first pass. When you click OK, it renders all of them in **one** `LrExportSession` at full size, with the active photo last. While that runs, switch to Develop and change the active photo's exposure. Then leave Lightroom alone until the final message. The experiment then:

- re-renders the edited photo and compares image data, to see whether the batch rendered it with the settings from the start of the session or from the moment its turn came;
- renders the same photos at print size (3508 px long edge, A4 at 300 DPI);
- starts a third pass and leaves the rendition loop after 3 photos, then counts files for 20 s to see whether Lightroom keeps rendering (whether a batch can be cancelled from the plugin);
- measures how long another plugin task can go without running (`maxTaskGap`).

Note anything that felt slow in Lightroom during the passes.

### Q8: `croppedDimensions` against the real export [ADR 8]

The render benchmark logs `fullMatchesCropped`. Include photos with Upright, a straightened crop, and Enhance → Super Resolution.

## Results

First run 2026-11-22, Lightroom Classic 16.0.1 (build 202611171809), macOS 27.2.1, on a real catalog of 40,308 photos (Sony ARW, 7008×4672). Experiments 3–7 ran unattended from a temporary init script; experiment 1/2 (watch while editing) still needs a manual run.

**Also fixed:** the watch compared `croppedDimensions` by reference (it is a table), so it logged a change on every poll; values are now compared encoded.

**Fixed on the first run:** `pcall` around anything that yields (`batchGetRawMetadata`, exports, `LrTasks.sleep`) fails with *"Yielding is not allowed within a C or metamethod call"*. Every experiment failed before the first log line. All calls now use `LrTasks.pcall`. The `LR_*` export setting names worked unchanged, and `doExportOnCurrentTask` returns only once the file exists.

- **Q1/Q2 (partial, no markers):** 5 photos watched for 4 min, edits in Develop: one global slider edit, two crops, a spot removal, an AI Sky mask then two adjustments to it. **`lastEditTime` changed on every edit**, detected within 0.1–1.0 s. **`editCount` changed only on the first edit of each photo** (1 → 2) and stayed at 2 through the later crop, spot removal and mask edits, so it cannot serve as a revision on its own. **`getDevelopSettings()` does include masks** in 16.0.1: the full `MaskGroupBasedCorrections` (mask type `"Sky 1"`, `MaskSubType`, a `MaskDigest`, every local adjustment), and its hash changed on every mask adjustment. `RetouchAreas` appeared with the spot removal. Crops changed `croppedDimensions` and `isCropped`. Polling 5 photos took 2.6 ms per tick on average. Second run, 25 photos: **two metadata-only edits bumped both `editCount` (2 → 3 → 4) and `lastEditTime`, with the develop hash unchanged**. A brush mask bumped `editCount` once, then `lastEditTime` only; it appears in `MaskGroupBasedCorrections`, and removing it changed the hash again. So a revision change with an unchanged develop hash is a metadata edit, and can be skipped without rendering. Polling 25 photos took 6 ms per tick. Not tested yet: radial, AI subject mask, presets, Sync. The watch now logs the changed develop keys (`changedSettings`), so markers are optional.
- **Q3:** `batchGetRawMetadata` with `uuid, editCount, lastEditTime, croppedDimensions, isCropped`: 50 photos 1.3 ms, 500 photos 14 ms, 2,000 photos 67 ms, 10,000 photos 352 ms (median of 5), so about 35 µs per photo, linear. 500 single `getRawMetadata` calls take 45 ms, so the batch call is about 3× faster per photo. 200 back-to-back calls over 2,000 photos took 14.6 s (73 ms each). UI stutter was not observed (nobody was at the UI). Reading `fileFormat, isCropped, isVirtualCopy` for all 40,308 photos took 1.3 s.
- **Q4/Q7:** a 1400 px preview takes 0.5–1.0 s per RAW (about 1 s on the first render of a photo, 0.5 s once Lightroom has it cached), and a full-resolution JPEG (q 0.95, 17–22 MB) takes about 1.5 s. Previews really are 1400×933. Rendering does not change `editCount`. **Re-renders are not byte-identical:** each export writes a new `xmp:ModifyDate`/`xmp:MetadataDate` and a random `xmpMM:DocumentID`, even with `LR_embeddedMetadataOption = 'copyrightOnly'`. The image data (the file without its APPn/COM segments) is identical on every photo tested (4 of 4), so a hash of it is stable. The spike now logs `imageMd5` and `identicalPreviewImageData`.
- **Q5:** 20 loopback POSTs: median 0.6 ms, max 3.7 ms. A 10 s long poll did not block another plugin task (19 of 20 expected ticks). A wrong token got 401, so `LrHttp` headers reach the server. A long poll during a large user export was not tested.
- **Q6:** Accepted keys: `uuid, editCount, lastEditTime, croppedDimensions, dimensions, isCropped, orientation, rating, pickStatus, fileSize, fileFormat, isVirtualCopy, countVirtualCopies, width, height`. Rejected: `Orientation` (the key is lower-case `orientation`, values such as `"AB"`), `copyName`, `aspectRatioCache`. **`croppedDimensions` is a table `{ width, height }`, not a string.** `findPhotoByUuid` resolves every photo tested, a virtual copy included (a virtual copy has its own UUID). UUIDs across *Export as Catalog* were not tested.
- **Q9 (batch export):** 20 RAWs in **one** `LrExportSession` at full size took 15.7 s, **0.78 s per photo**: Lightroom renders several at once, about twice as fast as one session per photo (1.5 s). Renditions come back roughly in order. The same 20 at print size (3508 px long edge) took 15.1 s: **a smaller target saves disk (105 MB instead of 381 MB), not time**, because the RAW processing dominates. **An edit made during the batch was not in its render:** the photo's revision changed between the start of the session and the end of its render, and its batch render differs from a fresh render. The before/after revision check catches this, so it is required, not optional. **A batch cannot be cancelled from the plugin:** `LrExportSession` has no `cancel`, and leaving the rendition loop after 3 photos did not stop Lightroom, which finished all 20 within about 6 s. While the full pass ran, another plugin task went up to 1.2 s without running. Lightroom felt responsive (reported by the user).
- **Q8:** On 4 photos (one cropped to 6654×4436, three uncropped), `croppedDimensions` equals the real full-resolution size. Upright, straightened and Super Resolution photos were not tested.

## What each outcome changes in the ADR

| Finding | Consequence |
| --- | --- |
| A visual edit (any mask type) does not change `editCount` or `lastEditTime` | Change detection by polling does not work. Fall back to re-rendering placed photos at export, plus a manual "Refresh from Lightroom" action. |
| Metadata edits also bump the revision (expected) | Keep the preview-hash suppression. If previews are not byte-identical, suppress by comparing decoded pixels. |
| Batch call is not much faster than single calls, or stalls the UI | Poll less often (5–10 s) and only on focus and before export. |
| Preview render takes more than about 1 s per RAW | Use `requestJpegThumbnail` for the grid and render 1400 px lazily, only for photos placed or opened. |
| `LrHttp` to loopback is unreliable, or a long poll blocks other tasks | Use the job-spool directory instead of HTTP. |
| UUIDs change on catalog export/import | The locator needs a second identity (file path plus capture time) for re-linking. |
