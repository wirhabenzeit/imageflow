# Editor render profiling — 2026-11-15

Follow-up: [targeted panel and hover optimization results](optimization/README.md).

Second pass: [book rendering profile, 2026-11-17](../render-2026-11-17/README.md).

Profiling pass for #98, after the #83 fix merged in `fabac1e2af3b69b2e7e4cf40a228cdbd1d943722`. No performance fixes are included.

## Findings and priority

There is measurable render fan-out, but this pass did not establish user-visible input lag caused by React. No observed long task exceeded 50 ms. The slowest host render was source selection (6.7 ms starter, 6.9 ms calendar), predominantly `SourceInspector`; mounting that inspector is useful work, not an unnecessary rerender. Other recorded host maxima were 2.7 ms or less.

1. **Panel updates are the largest repeated-work opportunity.** Four toggle clicks caused 143/86 host commits (starter/calendar), including 137/81 renders each of `Inspector` and `Sources`. A 25-step resize caused 64/60 commits and 60/56 renders each of those children. Resize maxima were 2.1/1.4 ms. Geometry feedback accompanies panel changes, so these are not simply one commit per pointer event. `usePanels` also persists each changed panel object in an effect; storage-write duration was not separately measured.
2. **Hover unnecessarily reaches unrelated panels.** Sixty pointer moves caused 47/36 host commits and 32/23 renders each of `Inspector` and `Sources`. Host render maxima were 0.7/2.0 ms. Their props are new references, so this is an interaction-to-render observation, not proof that shallow-equal props triggered them. Isolating hover state is a better first experiment than memoizing the whole application.
3. **Saving, rather than typing, creates replacement books in the tested fields.** Thirteen map-label characters caused 14 host commits, no editor-root commits and no new book documents. Enter caused one book replacement and three editor-root commits. Seven calendar-field characters caused seven editor-root commits (max 0.2 ms), two host commits and no book replacement. `Field` owns the typing draft; the whole `EditorValues` context did not update on each character here. Adding the map track is recorded separately from typing and committing.
4. **A map pan or zoom still renders a replacement book.** Each validated gesture created one book document, one thumbnail document, and three editor-root commits. The host maxima were 1.2/1.8 ms. Pan was checked against saved longitude. This pass does not establish that host React is the expensive part of map interaction. Map tiles were replaced by a local background style, so real tile/network/snapshot latency is not represented.
5. **Scrolling is not a React hotspot in this run.** Canvas scrolling caused one/zero host commits and 12 `photoLoader` calls per book (max 0.6/1.2 ms). Pointer placement can change hover before wheel events; the isolated host commit must not be attributed to the scroll handler alone. Thumbnail scrolling caused one host commit each and no measured book photo-loader work.
6. **Reordering replaces frames but does not reset them on ordinary parent renders.** Move Down plus Undo created two book documents per sample; dragging created one. Hover and panel scenarios created none. The #83 synchronization and retained-frame behavior remain in place. No optimization of the revision-driven render pipeline was attempted.

## Follow-up checklist

These are experiments with acceptance targets, not measured after-results.

- [ ] Isolate hover state/overlays from the full editor. Repeat the same 60-pointer path: reduce unrelated `Inspector` and `Sources` renders from 32/23 each to at most 2 each, while retaining selection and target behavior. Keep the worst host render at or below this baseline.
- [ ] Isolate panel geometry feedback and persist panel sizes at gesture completion. Repeat the 25-step resize: reduce unrelated panel renders from 60/56 each to at most 2 each and target one storage write per completed gesture. Preserve live canvas resizing and keyboard resize behavior. Investigate the 137/81 app renders during four toggles before adding broad memoization.
- [ ] Before optimizing `SourceInspector`, separately compare cold and warm selection on the same source. Current first-selection host maxima are 6.7/6.9 ms; target under 4 ms only if repeat measurements confirm avoidable work. The recording identifies the component, not the responsible function or a proven defect.

## Leads checked / deferred

- `ProjectFilesContext`'s omitted callback dependency is documented in current code: `importParameterFile` reads refs, preload API and setters. The issue's stale-closure suspicion is not a confirmed bug.
- Whole-context editor updates remain possible on saves, but per-keystroke context fan-out was not observed for the map label or calendar text field. No context split is justified by these measurements.
- O(n²) lookup patterns and fresh `SpreadData` objects exist, but this 20-spread run does not isolate meaningful cost from them. Leave them alone pending a larger-book profile.
- `BookFrame` message commits are visible in recordings. Their cost is low here; reducing them is lower priority than narrowing panel/hover state ownership.
- Scroll work is already coalesced by the frame's 16 ms loader timer. No additional scroll optimization is justified by the measured loader durations.

## Method and limits

Apple M4 Pro, 14 CPU cores, 48 GB RAM, macOS arm64; Node 22.22.0, Electron 45.2.3, React 19.2.3. Visible Electron window, 1500×1000 viewport, fresh profile, separate copies of both sample books expanded to 20 spreads. Starter contains the Map layout and sample track. Each scenario settles for 800 ms before and after; map gestures include additional settling. Calendar text entry opens the real dialog fallback by reducing the rendered calendar size, then expands “All marked days”.

The opt-in build aliases `react-dom/client` to React's profiling renderer and disables minification for readable component names. A diagnostic DevTools hook records root commits, inclusive `actualDuration`, component names and shallow prop equality; previously reused fibers are excluded from component render counts. These are **React render durations associated with commits**, not DOM commit-phase timings, input latency, or total frame time. Inclusive component durations must not be added together. Timer resolution can yield zero-duration work. The hook uses internal React fiber fields and must be revalidated when upgrading React.

`sameProps` does not imply wasted work: state or context can legitimately change. New callback/object references also prevent shallow equality without establishing changed visible content. The recordings support state-isolation experiments, not blanket claims that every render is redundant.

Long tasks use `PerformanceObserver`; animation-frame gaps over 50 ms are also retained. Those gaps include pending/hidden iframe scheduling and do not establish dropped visible frames. A Chrome Performance trace with compositor/screenshot evidence is still needed to attribute visible jank. This is a custom diagnostic recording, not a React DevTools export, and does not include DevTools' full “why rendered” reasons or why-did-you-render output. No user-visible latency win or before/after improvement is claimed. Results are a single representative successful pass per sample, not statistically controlled benchmarks; earlier diagnostic runs were used to correct test locators and verify gestures.

## Recordings

- [Compressed per-event recordings](recordings.json.gz): host and all iframe roots, components, timing, document creation, loader timings and frame gaps.
- [Scenario and component summaries](summary.json): component render counts, shallow-equal prop counts and inclusive maxima.

| Book | Scenario | Host commits | Max host render ms | Editor commits | Max editor render ms | New book documents |
|---|---|---:|---:|---:|---:|---:|
| starter | hover | 47 | 0.7 | 0 | 0 | 0 |
| starter | canvas-scroll | 1 | 0.6 | 0 | 0 | 0 |
| starter | thumbnail-scroll | 1 | 0.5 | 0 | 0 | 0 |
| starter | select-spread | 21 | 0.5 | 0 | 0 | 0 |
| starter | select-source | 4 | 6.7 | 0 | 0 | 0 |
| starter | reorder-shortcuts | 38 | 1.4 | 0 | 0 | 2 |
| starter | reorder-drag | 22 | 0.8 | 0 | 0 | 1 |
| starter | toggle-panels | 143 | 0.7 | 0 | 0 | 0 |
| starter | resize-panel | 64 | 2.1 | 0 | 0 | 0 |
| starter | open-inline-editor | 11 | 1.5 | 2 | 0.7 | 0 |
| starter | map-pan | 20 | 1.2 | 3 | 1.3 | 1 |
| starter | map-zoom | 18 | 1.8 | 3 | 1.2 | 1 |
| starter | prepare-map-track | 29 | 1.6 | 3 | 0.6 | 1 |
| starter | type-map-track | 14 | 0.9 | 0 | 0 | 0 |
| starter | commit-map-track | 21 | 1 | 3 | 0.5 | 1 |
| starter | close-inline-editor | 1 | 2.7 | 0 | 0 | 0 |
| starter | open-photo-crop | 11 | 1.1 | 0 | 0 | 0 |
| calendar | hover | 36 | 2 | 0 | 0 | 0 |
| calendar | canvas-scroll | 0 | 0 | 0 | 0 | 0 |
| calendar | thumbnail-scroll | 1 | 0.4 | 0 | 0 | 0 |
| calendar | select-spread | 14 | 0.6 | 0 | 0 | 0 |
| calendar | select-source | 4 | 6.9 | 0 | 0 | 0 |
| calendar | reorder-shortcuts | 26 | 1.2 | 0 | 0 | 2 |
| calendar | reorder-drag | 19 | 0.6 | 0 | 0 | 1 |
| calendar | toggle-panels | 86 | 0.9 | 0 | 0 | 0 |
| calendar | resize-panel | 60 | 1.4 | 0 | 0 | 0 |
| calendar | open-inline-editor | 26 | 1 | 4 | 1.7 | 1 |
| calendar | calendar-edit | 11 | 0.5 | 2 | 1.1 | 1 |
| calendar | close-inline-editor | 3 | 1.4 | 0 | 0 | 0 |
| calendar | open-calendar-panel | 8 | 0.6 | 2 | 2 | 0 |
| calendar | type-calendar-field | 2 | 0.4 | 7 | 0.2 | 0 |
| calendar | open-photo-crop | 11 | 1.4 | 0 | 0 | 0 |

## Reproduce

From the repository root:

```sh
IMAGEFLOW_PROFILE=1 npm run build
node scripts/stage-desktop.mjs
node scripts/profile-editor.mjs
node scripts/summarize-editor-profile.mjs .build/editor-profile-<printed timestamp>
```

Pass `starter` or `calendar` to the runner for one sample. The runner makes disposable copies in `.build` and does not edit original books. Inspect errors in the recording; the summarizer exits nonzero for failed scenarios or missing profiling timings. The raw dataset here combines the successful starter run and the corrected calendar rerun. Fixture preparation, editor opening, adding a track, typing and committing are identified separately where their costs differ.

Restore the standard build afterward:

```sh
npm run build
node scripts/stage-desktop.mjs
```

The profiling renderer and photo-loader timing probe are enabled only by `IMAGEFLOW_PROFILE=1` at build time. Normal builds exclude the probe. The hook is injected only by the profiling runner; no listener or collector is shipped with the app. The normal build was restored and verified after this pass. No issue comments or follow-up issues were posted automatically; the checklist above is ready for triage.
