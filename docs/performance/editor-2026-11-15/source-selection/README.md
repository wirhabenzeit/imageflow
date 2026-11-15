# Source selection: cold versus repeated

Follow-up to the [render profile](../README.md), after the [panel and hover optimization](../optimization/README.md).

**Decision: do not add a source-selection performance fix on this evidence.** The larger measured cost is concentrated in first selection. Repeated photo selections were 0.5–1.8 ms and repeated text selections 0.8–2.7 ms. No long tasks over 50 ms were recorded. This does not establish zero visible latency; these are React render durations, not end-to-end input-to-paint times.

The first photo selection in each renderer spent most of its time in `Date.prototype.toLocaleString`: 5.0 ms of a 6.7 ms host render for starter; 4.2 ms of 5.4 ms for calendar. The whole capture-date helper is also timed in the recording. Subsequent locale formatting calls were 0–0.4 ms. The direct call measurements establish a cold formatting cost; runtime locale-data/formatter initialization is a plausible explanation, not a separately traced internal stack.

First text selection took 7.8 ms. Reopening the same text five times took 0.8–2.7 ms (median 1.3 ms). `SourceInspector` generates its Markdown preview with `useMemo`; returning from spread selection remounts it and exercises this path again. This run does not isolate the parser's own duration, so the cold text cost cannot be attributed solely to Markdown parsing.

## Measurements

Maximum host React render duration in each action, milliseconds. Cold is one first-selection observation per renderer/source kind. Warm results are five individual actions per category. Returning to a spread before each remount and directly alternating between two photos exercise different paths.

| Book / source | First selection | Same-source remount median (range) | Alternate-photo median (range) |
|---|---:|---:|---:|
| starter / photo | 6.7 | 1.40 (1.1–1.7) | 0.60 (0.5–1.7) |
| calendar / photo | 5.4 | 1.10 (0.7–1.5) | 1.40 (0.6–1.8) |
| starter / text | 7.8 | 1.30 (0.8–2.7) | — |

## Why leave it alone

- The first inspector mount displays new information and builds controls; it is necessary work. A larger first render is not itself an unnecessary rerender.
- Cached date formatters could reduce repeated formatter construction but would not eliminate the first formatter initialization. Warm date formatting was already below 0.5 ms here.
- Eager formatting would move cold work into startup. That tradeoff is not supported by a measured interaction problem.
- Caching whole inspector/Markdown results across source remounts adds lifetime/invalidation considerations. Warm selection is inexpensive on these fixtures.

Revisit if real books, larger Markdown sources, lower-end machines or an input-to-paint trace show a user-visible delay. This sample does not cover very large source libraries or Markdown documents. There is no before/after optimization claim and no product behavior change from this investigation.

## Reproduce and evidence

Use the profiling build commands from the baseline, then:

```sh
node scripts/profile-editor.mjs --sources
node scripts/summarize-editor-profile.mjs .build/editor-profile-<printed timestamp>
```

The runner uses fresh disposable 20-spread books and document windows, and measures one first photo selection, five remounts and five alternating selections for each sample. Starter additionally measures a first text selection and five remounts. Calendar has no text sources in this fixture. Timing includes the existing 800 ms settling windows around each scripted action. The viewport and hardware match the baseline.

The diagnostic hook wraps `Date.prototype.toLocaleString` only in the profiling runner. The optional `imageflow.captureFact` measure is enabled only by the explicit profiling build flag. Both probes add some measurement overhead, and sub-millisecond values are timer-resolution-sensitive.

- [Raw recordings](recordings.json.gz)
- [Per-scenario/component summaries](summary.json)

The initial exploratory run identified the photo pattern but stopped at a text-tab locator mismatch. The complete corrected run above is the recorded dataset. Normal build/type checks and script syntax checks passed; normal bundles were restored and checked to exclude the profiling renderer and timing probes.
