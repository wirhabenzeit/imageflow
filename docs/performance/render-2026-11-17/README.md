# Book rendering profile — 2026-11-17

Second profiling pass for #98, on main `aedd8eb` (1.0.0-beta.8). The [first pass](../editor-2026-11-15/README.md) measured React commits in the editor window. This pass measures what happens around them: how long the book frames take to render, how that grows with the size of the book, and what keeps a book from appearing when it opens.

## Findings

1. **Opening a book waited for its cover to re-encode every photo at print resolution (fixed).** One second after a book opens, and when its window loses focus after a change, ImageFlow renders a 320-pixel cover for the recent-books list. That render ran in export mode, so it asked for every photo of the book as a print rendition: each 6000-pixel original decoded and re-encoded as a JPEG at quality 95, about 10 s each while 100 of them competed for the CPU. The three photos the editor needed on screen waited behind them, so a 60-spread book took 13.5 s to appear instead of 0.6 s for its photos. The print renditions also filled the shared rendition cache: on the development Mac it held 86 of them (6.1 MB each on average, 525 MB in all) against a 512 MB limit, pushing out the 0.3 MB previews and 10 kB thumbnails the editor reuses. The cover and the template library's preview cards now use the editor's 1400-pixel previews, which are more than a 320-pixel picture needs.
2. **Photo renditions were made first come, first served (fixed).** Opening a book asks for every thumbnail, the photos on screen, and the cover's photos within the same second. They now run four at a time, most urgent first: photos on screen in the editor, then other work someone waits for (thumbnails, export and checks), then background work such as the cover. A rendition already queued for the background moves up when the editor asks for it. On the 60-spread book, the photos on screen are ready 0.6 s after opening, down from 13.5 s.
3. **An edit re-renders the whole book in about 0.25–0.7 s, growing linearly with its length.** A document parameter change took 260 ms at 20 spreads, 350 ms at 60 and 660 ms at 150 until the new book view, thumbnails and layout picker were all shown. No single step dominates (table below): waiting for photos, the Book check findings, the text checks and the layout grow with the book. The render frames run in their own process, so the 100–130 ms long tasks they have at 150 spreads do not block the editor's toolbar, panels or typing; they delay when the new frame appears.
4. **On a book's first open the canvas waits for every thumbnail (follow-up).** The book view and the thumbnails reveal each revision together, so the reorder animation (#83) never shows two different books. On the very first open, with nothing shown yet, the canvas still waits until all thumbnails are made: 3.8 s for 100 photos, compared with 0.6 s for its own photos. This only applies while a book's renditions are not cached; a reopen takes 0.5–1.1 s.
5. **The editor's React work has not regressed since the first pass.** Hover, panel toggles and panel resizing still render neither the Inspector nor Sources. Source selection remains the slowest host render (10.3 ms starter, 6.3 ms calendar; single runs, 6.7/6.9 ms on 2026-11-15), mostly `SourceInspector` mounting. Selecting a spread costs 33 host commits instead of 21 on the starter, rendering the Inspector's new sections (`PanelSection`, `LayoutGrid`) among others; the slowest commit took 2 ms.
6. **Memory sits at 1.4–2.1 GB across all of ImageFlow's processes for these books (not investigated).** That is the working set of the main, GPU and renderer processes together, including three full-book frames and the picture cache. It barely grows with the book (1.4 GB at 20 spreads, 2.1 GB at 150), so it is not an obvious leak, but a breakdown by process would show whether it is expected.

## Measurements

`bench-render`, the starter book with a distinct copy of a 6000 × 4000 sample photo in every photo box. Hidden windows, so painting is not included. Single runs; edits are the median of five.

| Spreads | Photos | First open, before | First open, after | Reopen | Edit until shown | Five rapid edits |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 31 | 4.2 s | 1.6 s | 0.5 s | 260 ms | 265 ms |
| 60 | 100 | 13.5 s | 4.0 s | 0.7 s | 350 ms | 335 ms |
| 150 | 262 | 34.8 s | 9.7 s | 1.1 s | 660 ms¹ | 440 ms¹ |

¹ Measured once the background cover had finished (`--settle 20000`). Edited within 1.5 s of opening, while the cover still renders, the same edit took 1150 ms. Before the fix the cover competed with opening the book instead.

Render steps of the book view for one edit, in ms (median of five). Each step runs from the end of the previous one, as marked in `startRender`:

| Spreads | template | react | decode | findings | text-checks | layout | output | sum |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 19 | 6 | 49 | 34 | 4 | 4 | 11 | ~140 |
| 60 | 43 | 12 | 72 | 60 | 9 | 11 | 45 | ~270 |
| 150 | 19 | 28 | 104 | 78 | 51 | 33 | 50 | ~380 |

- **decode** waits for the cached pictures and photo elements to settle, **findings** collects the Book check findings, **text-checks** runs the per-spread typography, font and text-block checks, **layout** arranges the sheets, and **output** waits for the photos on screen.
- The rest of the time until the frame is shown is creating the frame, loading the runtime and template, and revealing the book view and thumbnails together.
- `data`, `index`, `validate`, `pictures` and `flow` (text flow) stayed under 15 ms at every size.

Where the time went when opening the 60-spread book for the first time, from a temporary log of every rendition (not kept in the code):

| | Renditions made | Time each | Done after |
|---|---:|---:|---:|
| Before: thumbnails | 101 | 3.2 s (sharing the CPU) | 3.6 s |
| Before: cover, print resolution | 100 | 10 s (sharing the CPU) | 13.9 s |
| Before: photos on screen | 3 | 10.1 s (waiting behind the cover) | 13.6 s |
| After: photos on screen | 3 | 0.2 s | 0.6 s |
| After: thumbnails | 101 | 0.14 s | 3.7 s |
| After: cover, previews in the background | 97 | 0.19 s | 8.5 s |

## Editor React profile

The first pass's `profile-editor` scenarios, rerun on the same 20-spread starter and calendar books, in hidden windows. The full table is in [editor-summary.json](editor-summary.json) and the recordings in [editor-recordings.json.gz](editor-recordings.json.gz).

| Book | Scenario | Host commits, 11-15 after #152 → now | Max host render ms |
|---|---|---:|---:|
| starter | hover | 46 → 46 | 0.2 → 0.2 |
| starter | toggle-panels | 73 → 75 | 0.5 → 0.5 |
| starter | resize-panel | 60 → 64 | 0.6 → 0.9 |
| starter | select-spread | 21² → 33 | 0.5² → 2.0 |
| starter | select-source | 4² → 4 | 6.7² → 10.3 |
| calendar | hover | 41 → 41 | 0.3 → 0.2 |
| calendar | toggle-panels | 33 → 32 | 0.5 → 0.7 |
| calendar | resize-panel | 56 → 57 | 1.4 → 1.6 |

² From the 11-15 baseline; #152's focused run did not repeat these scenarios.

The long tasks in the recordings during hover and canvas scrolling come from the cover render's hidden window, which the recording hook also observes. They do not run in the editor's process. The 171 ms long task when opening the map editor was reported by the book, thumbnail, layout and element-editor frames at once, so they share one render process; the editor window's process was not blocked.

## Follow-ups

- [ ] Show the canvas on a book's first open without waiting for every thumbnail, keeping later revisions paired for #83. Target for the 60-spread book with an empty cache: book view shown within 1 s instead of 3.8 s.
- [ ] Break down the 1.4–2.1 GB working set by process (main, GPU, editor, render frames) and check it against the picture cache's limit.
- [ ] Record a visible-window Chrome Performance trace of map panning and canvas scrolling. Hidden windows do not paint, so compositor cost and dropped frames are still unmeasured.
- Edits at 150 spreads (0.66 s) are spread over several steps that each grow with the book. Rendering only part of the book would mean changing the whole-book render that text flow and the Book check depend on, which these numbers do not justify yet.

## Changes in this pass

- `desktop/main.ts`, `desktop/document-session.ts`: a render session can ask for preview photos (`photos: 'preview'`). The recent-book cover and the template library's preview cards do.
- `desktop/photos.ts`: renditions run four at a time from a priority queue; a queued rendition moves up when requested more urgently. A unit test covers both.
- `src/render.tsx`: profiling builds time each render step as `imageflow.render.<step>`. Normal builds leave the marks out.
- `scripts/bench-render.mjs`: works again with the current starter (it edited a field that is now edited on the page), counts photos in page layouts for `--unique`, and reports render steps per view, the first open per view, a reopen, and which process runs the frames. New options are `--repeat` and `--settle`.
- `scripts/profile-editor.mjs`: closes the map editor reliably before the crop scenario, which failed after the Tracks dialog had been opened.

Validation: `npm run build`, 687 unit tests, and the smoke tests `smoke-documents`, `smoke-template-library`, `smoke-template-previews`, `smoke-desktop`, `smoke-photo-render`, `smoke-export`, `smoke-project-lifecycle`, `smoke-linked-sources`, `smoke-reorder-motion` and `smoke-thumbnail-scroll`.

## Method and limits

Apple M4 Pro, 14 CPU cores, 48 GB RAM, macOS 27.0.1; Node 22.22.0, Electron 45.2.3, React 19.2.3. Both harnesses ran with `IMAGEFLOW_HIDE_WINDOW=1` so as not to take over the desktop. Hidden windows lay out and run scripts with background throttling off, but they do not paint: frame timings exclude painting and compositing. Each benchmark starts from a fresh profile, so the first open makes every rendition; reopening measures the usual case of a cached book. These are single runs on one machine, so treat differences under about 20 % as noise.

## Reproduce

```sh
IMAGEFLOW_PROFILE=1 npm run build
node scripts/stage-desktop.mjs
node scripts/bench-render.mjs --spreads 60 --unique --repeat 5     # also 20 and 150
IMAGEFLOW_HIDE_WINDOW=1 node scripts/profile-editor.mjs
node scripts/summarize-editor-profile.mjs .build/editor-profile-<printed timestamp>
npm run build && node scripts/stage-desktop.mjs                    # restore the normal build
```
