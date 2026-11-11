# Large-book authoring benchmark

On the fixture measured here, repeated context and inspection calls fell from about 31 seconds to 0.12 seconds. A requested preview fell from a 22.3-second median to 1.10 seconds. All 18 tool calls in each run completed successfully, with no layout diagnostics or timeouts.

This comparison covers baseline `4b9f0b61072613b1b596dd7c3e8b81d8b8eba3e2` and optimized implementation `502b8aac17c6fa4d47ad56d29c1060c76a7728a4`. The changes combine a session input-digest index, reuse of completed inspection checks, and a bounded cache of photo renditions retained only after successful input verification. Explicit preview requests still render the complete book in a fresh private check folder.

## Fixture and measurement conditions

- 300 distinct, valid JPEG originals, each 6,000 × 4,000 pixels. Their combined size is 5,817,163,676 bytes, or 5.817 GB using decimal units. Individual files range from 19,385,319 to 19,412,491 bytes.
- Every original has unique deterministic synthetic landscape-texture pixels with high-frequency grain. JPEG quality is 95 with 4:2:0 chroma subsampling. File size comes from encoded image data. The generator uses neither sparse files nor padding to reach the target size.
- 150 spreads and 300 physical pages, with two large photos on each spread, a bundled font, and a 26,400-word Markdown chain across the whole book. Pages have 210 × 210 mm trim and declared maximum photo resolution of 150 ppi for this proof workload.
- Each image request captures the first actual spread at 400 × 200 pixels, using trim bounds and PNG. It runs through the app’s whole-book flow, photo preparation and native MCP image delivery. PNGs were fully decoded by the benchmark driver.
- One Apple M4 Pro machine with 14 CPU cores and 48 GiB RAM, running macOS on arm64. The driver used Node.js 22.22.0. Both apps used Electron 45.2.3, Chromium 156.0.8078.80 and embedded Node.js 24.22.2.
- Measurements ran sequentially on 2026-11-11, with tests and builds paused. Each run used a new process/profile and cleared fixture-derived caches. The OS file cache was not flushed and could be warm. “Cold” below describes a new app/session, rather than a cold physical disk cache.

The same fixture was restored between runs, including exact manifest, template, Markdown and first-photo bytes. Corresponding phases produced the same content revisions. The initial revision was `69960424f9796adaa3f01e266af2b39e659fa59616c9661b522131da3bebbf26`.

Tool elapsed time includes the MCP round trip and queued app work. Edit phases also include the file write or replacement immediately preceding the check. Opening the project and waiting for both the book and sidebar thumbnails took 13.0 seconds in the baseline and 8.4 seconds in the optimized run. Those startup times are separate from the tool timings.

## Initial work

These are individual measurements, each taken once in the main comparison run. The first requested preview follows the initial context call, which has already resolved the book and prepared photo renditions.

| Operation | Baseline seconds | Optimized seconds | Baseline input bytes hashed | Optimized input bytes hashed |
| --- | ---: | ---: | ---: | ---: |
| Initial context, new session | 32.928 | 13.876 | 29.087 GB | 5.818 GB |
| First preview after context | 25.970 | 1.171 | 17.452 GB | 0.359 MB |

The optimized initial context hashed all 300 originals once. Later verification scans reused their digests after checking current paths and filesystem metadata. Initial loading, hashing and rendition preparation remain material costs.

## Repeated unchanged calls

Each row reports the median and observed minimum–maximum of three sequential repetitions. The order in each repetition was list, context, inspection, preview. No percentile or broader workload estimate is inferred from three samples.

| Tool | Baseline seconds, median (range) | Optimized seconds, median (range) | Original photo bytes hashed per baseline call | Original photo bytes hashed per optimized call |
| --- | ---: | ---: | ---: | ---: |
| `list_projects` | 4.386 (4.287–4.577) | 0.039 (0.038–0.041) | 5.817 GB | 0 |
| `get_authoring_context` | 30.493 (30.436–32.368) | 0.117 (0.113–0.118) | 29.086 GB | 0 |
| `inspect_book` | 31.000 (30.322–31.106) | 0.115 (0.112–0.120) | 29.086 GB | 0 |
| `check_book` with preview | 22.331 (21.990–22.395) | 1.098 (1.092–1.151) | 17.451 GB | 0 |

The optimized preview calls still completed whole-book layout and returned native image content. Context and inspection reused a completed check for the verified unchanged inputs.

## Changes after the warm calls

Each change was measured once. The title batch changed the saved book title. The CSS edit changed one background color without changing photo geometry. The photo phase replaced one registered original with a different valid 19,391,705-byte JPEG, then requested another preview.

| Operation | Baseline seconds | Optimized seconds | Baseline input bytes hashed | Optimized input bytes hashed |
| --- | ---: | ---: | ---: | ---: |
| Title command batch | 38.150 | 0.382 | 34.905 GB | 0.393 MB |
| CSS edit and preview | 23.506 | 1.285 | 17.452 GB | 0.534 MB |
| Replace one photo and preview | 23.502 | 1.282 | 17.452 GB | 19.894 MB |

After the photo replacement, the optimized run hashed exactly one original, totaling 19,391,705 photo bytes. The remaining hashed bytes were other inputs. Across the complete 18-call sequence, total logical input bytes hashed fell from 366.497 GB to 5.842 GB. Tool elapsed time totaled 414.46 seconds and 22.19 seconds respectively. The additional revision-discovery call before the title command is retained separately in the raw results.

These counters measure bytes streamed into revision hashing. Zero original-photo bytes hashed does not imply zero disk reads. The app still checks filesystem metadata, may read photo headers, and loads cached renditions for rendering. Generation-related retries are included in the counters.

## Image audit and resource use

A separate capture audit used unchanged inputs and two previews from each app. Both baseline previews and the first optimized preview had identical decoded RGBA pixels. The second optimized preview differed in 13,798 of 80,000 pixels, confined to the left photo at the inclusive bounding box x=12–187, y=16–135. Its maximum channel difference was 3 on an 8-bit scale. Mean absolute difference across all RGBA channels was 0.06114. Of the changed pixels, 451 exceeded a channel difference of 1, and none exceeded 3.

Visual inspection of native images and an amplified difference image showed fine color variation in that photo. Text, the other photo, background and page geometry were unchanged. The cause of this capture variation has not been established. This benchmark does not claim pixel-identical output for every capture. The initial timing run also recorded encoded image-hash variation, preserved in its raw JSON.

The sampled peak sum of app-process working sets increased from 1,961 MiB to 2,397 MiB, approximately 1.92 GiB to 2.34 GiB. This is a sum across processes and can count shared memory more than once. Samples were taken about once per second, so they can miss shorter peaks. Retained rendition files are bounded to 512 MiB and 2,048 files, and the input index to 8,192 entries. These cache bounds are separate from total app memory use.

## Reproduce

Run from a checkout with the pinned dependencies installed. Fixture generation needs about 6 GB of available disk space, plus derived caches and builds. A fresh baseline destination is required because preparation refuses to overwrite an existing checkout.

```sh
npm ci
node scripts/bench-authoring.mjs prepare --count 300
node scripts/bench-authoring.mjs prepare-baseline --destination .build/authoring-benchmark/reproduction-baseline
node scripts/bench-authoring.mjs run --app .build/authoring-benchmark/reproduction-baseline/.build/desktop --label baseline --revision 4b9f0b61072613b1b596dd7c3e8b81d8b8eba3e2 --repetitions 3
npm run build
node scripts/stage-desktop.mjs
node scripts/bench-authoring.mjs run --app .build/desktop --label current --revision 502b8aac17c6fa4d47ad56d29c1060c76a7728a4 --repetitions 3
```

`prepare-baseline` exports the baseline commit, shares the installed dependency directory, and adds measurement-only counters in revision capture and streamed hash updates before building its isolated app. It leaves hashing behavior unchanged. The optimized app exposes equivalent counters only in an unpackaged process with `IMAGEFLOW_BENCHMARK=1`, which the driver sets. The preparation command was also verified against a second fresh destination after the timed runs.

The driver obtains the stable handle through the normal open IPC, displays the resulting book through its normal project-changed event, and waits for book and thumbnail readiness before starting the first MCP call. This avoids a preliminary discovery scan seeding the input index. Subsequent measured operations use the official MCP SDK client and the app-owned service.

To save native captures for a short audit, add `--audit-dir <directory> --audit-only true` to `run`. This performs initial context and two previews, then closes the app and restores the fixture. A benchmark omits further identical warm calls after two failures, while preserving distinct edit cases. Neither timed run reached that limit.

Raw measurements are available in [baseline JSON](benchmarks/authoring-baseline.json), [optimized JSON](benchmarks/authoring-current.json), and [preview audit JSON](benchmarks/authoring-preview-audit.json). They include per-call timing, check outcomes, input counters, image hashes, runtime and source identifiers, with machine-local user paths omitted.

This evidence applies to the specified synthetic corpus, simple photo/text layout, requested image size, proof resolution and hardware. More complex template code, different photo geometry, larger delivered images, cold OS caches and other machines require their own measurements.
