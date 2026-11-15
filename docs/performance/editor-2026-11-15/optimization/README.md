# Targeted panel and hover optimization

Follow-up to the [profiling baseline](../README.md), on the same machine and 20-spread fixtures. Working-tree implementation based on `fabac1e`.

## Changes

- Moved pointer-only state and overlay rendering into `CanvasHover`. The host app no longer renders on each hover target change; overlay animation still follows the reorder clock.
- Memoized the Inspector and Sources subtrees with stable callbacks that read the latest committed application state. Source selection, permissions, project revisions, editor targets and real content changes still invalidate those subtrees.
- Separated Inspector target identity/reading order from pixel rectangles. Its event handler resolves the current canvas target when opening an editor, preserving live positioning after resize. Duplicate occurrences and box-owned targets retain the previous listing semantics.
- Removed the host's duplicate geometry update for width changes: the iframe already reports those. Height-only changes still restore the canvas reading position.
- Deferred panel preference writes during pointer resizing, writing the final value after release; ignored unchanged/clamped sizes. Keyboard sizing, reset and panel toggles still persist immediately.

## Measured results

Counts below cover complete scripted scenarios, not a per-event average. The same pointer path, four panel toggle clicks and 25 resize steps were used. “Each panel” means both Inspector and Sources independently had the listed render count.

| Book | Scenario | Each panel renders, before → after | App renders, before → after | Host commits, before → after | Max host render ms, before → after |
|---|---|---:|---:|---:|---:|
| starter | hover | 32 → 0 | 32 → 0 | 47 → 46 | 0.7 → 0.2 |
| starter | toggle-panels | 137 → 0 | 137 → 68 | 143 → 73 | 0.7 → 0.5 |
| starter | resize-panel | 60 → 0 | 60 → 56 | 64 → 60 | 2.1 → 0.6 |
| calendar | hover | 23 → 0 | 23 → 0 | 36 → 41 | 2 → 0.3 |
| calendar | toggle-panels | 81 → 0 | 81 → 28 | 86 → 33 | 0.9 → 0.5 |
| calendar | resize-panel | 56 → 0 | 56 → 52 | 60 → 56 | 1.4 → 1.4 |

Both panels reached the baseline target (at most two unrelated renders) with zero renders in each measured scenario. Hover still creates commits in the small overlay subtree; the improvement is removing the application-wide work, not suppressing necessary hover updates. Resizing still updates the canvas live, so its overall commit count remains similar.

The new storage observer recorded one panel preference write per drag and four for the four toggle clicks. Storage writes were not instrumented in the baseline, so no measured before-count is claimed. The UI regression separately checks zero writes during dragging and persistence after pointer release and keyboard changes.

Absolute timings are single-run maxima and fluctuate. In particular, calendar resize remained at 1.4 ms. These results demonstrate less unrelated work, not a proven improvement in perceived responsiveness or a general latency percentage.

## Evidence and validation

- [Final focused recordings](panels-recordings.json.gz) and [component summaries](panels-summary.json).
- [Full interaction run](full-recordings.json.gz) and [summary](full-summary.json), including map/calendar typing and saving, source selection, reordering and crop opening. This preceded the final reading-order compatibility refinement; the focused run includes that refinement.
- Production build and type checks passed. Normal bundles exclude the profiling renderer and photo-loader probe.
- Unit suite: 554 tests, including Inspector metadata invariance and duplicate/owned target ordering.
- Electron regressions: panel persistence/keyboard sizing/hover/selection, reorder synchronization/Undo/Redo/Reduce Motion, source controls and shared preferences. Full inline-text regression checks (including Inspector keyboard routes, stable resize, Undo/Redo and conflict recovery) and map/calendar inline-editor checks also passed.

Reproduce the focused pass using the baseline build instructions, then `node scripts/profile-editor.mjs --panels`. This runs the original pre-panel setup and interactions for each book before stopping after resizing. Pass `starter` or `calendar` as well to restrict the sample. Run the summarizer against the printed output directory. Baseline caveats about profiling overhead, render vs commit duration, and frame-gap interpretation still apply.

No change was made to source-inspector rendering cost, map snapshot/replacement policy, scroll loading, or editor context structure.

Source-selection follow-up: [cold versus repeated measurements](../source-selection/README.md); no further optimization recommended on these fixtures.
