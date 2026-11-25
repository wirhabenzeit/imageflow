# Testing and CI

```sh
npm run test:unit       # unit tests
npm run test:desktop    # build, full unit tests and desktop suite
npm run test:desktop:suite # every smoke script, of an existing build
npm run test:desktop -- --visible  # include native desktop checks (CI or VM)
npm run test:packaged   # package and test the app
```

Desktop checks require [Poppler](https://poppler.freedesktop.org) (`brew install poppler`). They cover rendering, PDF geometry, text flow, preflight, imports, autosave and live reload.

The smoke runner defaults to invisible windows: no native focus, fullscreen, Dock icon or interactive dialogs. Unexpected native prompts and uncaught exceptions fail with a terminal error; tests exercising confirmations mock their answers explicitly. `smoke-inline-editors` and `smoke-mcp-context` require compositor hit testing in shown windows and are reported as skipped. Use `node scripts/run-smokes.mjs --visible <scripts…>` or the full-suite command above on an isolated desktop to include them and the native presentation focus/fullscreen checks. Direct invocation of those two scripts also requires `--visible`. Build and staging must finish before running smoke scripts. An already-running staged app must be restarted to pick up these changes.

Packaged checks cover document registration, Finder open events, proof and print export, linked sources and the MCP bridge. Use `npm run test:packaged:existing` to test an existing build. Packaged checks include Finder integration and the visible MCP context test, so run them on an isolated desktop too.

## Sync through an S3-compatible bucket

The S3 store (`desktop/sync-store-s3.ts`) is tested against an in-process fake server (`tests/s3-fake.ts`) that checks every request's SigV4 signature and payload SHA-256 and injects failures; `npm run test:unit` runs the store conformance suite against it, and the core set of the sync engine scenarios (`core` and `coreEach` in `tests/sync.test.ts`, about 30 tests) against the memory store. The rest of that file (`test`, `each`) runs only in the full run: add new sync tests there unless they guard a user's data or are the one test of a feature. `npm run test:unit:full` runs all of them, also against the folder store, the fake S3 server and the fake CloudKit, which takes several minutes; `npm run test:desktop`, and so the nightly run, includes it.

The same tests run against a real bucket when these variables name one, which is how the spike of #281 is run against R2, B2, MinIO or S3. Use a bucket (or a prefix) for tests only and a key limited to it; each run writes below `<prefix>run-<uuid>/` and deletes what it wrote at the end.

```sh
export IMAGEFLOW_S3_TEST_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # https, or http://127.0.0.1:9000 for a local MinIO
export IMAGEFLOW_S3_TEST_REGION=auto                     # us-east-1, auto for R2, the bucket's region for B2 (us-west-004, …)
export IMAGEFLOW_S3_TEST_BUCKET=imageflow-test
export IMAGEFLOW_S3_TEST_ACCESS_KEY_ID=…
export IMAGEFLOW_S3_TEST_SECRET_ACCESS_KEY=…
export IMAGEFLOW_S3_TEST_PREFIX=imageflow-test/          # optional
export IMAGEFLOW_S3_TEST_ADDRESSING=path                 # optional: path or virtual
export IMAGEFLOW_S3_TEST_REPORT=s3-spike-r2.json         # optional: the spike's answers as JSON
npm run test:unit:full
```

`tests/sync-s3-real.test.ts` answers the spike's questions (conditional writes, checksum verification, addressing, listing right after a put, a large single PUT) as test diagnostics and in the report file. Never commit the variables or the report's endpoint if it names an account.

In the app, Settings → Sync offers an S3-compatible bucket; iCloud only in a build signed with the provisioning profile, and a folder only with `IMAGEFLOW_SYNC_FOLDER=1` (see [setup](setup.md)). Development builds can keep the bucket's access key in memory instead of the keychain with `IMAGEFLOW_SYNC_CREDENTIALS=memory`. The sync smokes (`smoke-sync`, `smoke-sync-auto`, `smoke-sync-settings`, `smoke-library`) set the folder backend up in a profile's `settings.json`. `smoke-sync-settings` also counts the storage and runs Clean Up over the fake S3 server. Clean Up's grace period is tested by passing a later `now` to `planCleanUp` (`desktop/sync-sweep.ts`) instead of ageing objects, so the sweep tests run against every store (`each` in `tests/sync.test.ts`). `smoke-sync` turns *Sync automatically* off, so every sync in it is one it asks for; `smoke-sync-auto` covers automatic sync with a short idle wait (`IMAGEFLOW_SYNC_IDLE_MS`) and automatic syncs slowed down (`IMAGEFLOW_SYNC_TEST_SLOW_MS`), so an edit meets one.

Push notifications from iCloud (#284) need a signed build with the `aps-environment` entitlement: the unit tests cover the subscription over the fake CloudKit and the scheduler that a push starts, not the push itself.

## Flaky tests

CI's hosted Macs have a few slow cores, so a test that waits for the wrong thing, or an app timeout that is too tight, fails there now and then while passing locally. To make such failures show up on a fast Mac, run the scripts at background priority, which keeps them on the efficiency cores (three to four times slower, about like CI), again and again:

```sh
npm run build && node scripts/stage-desktop.mjs
node scripts/stress-smokes.mjs --runs 5 --load 0 smoke-ui-details smoke-quit   # background priority only
node scripts/stress-smokes.mjs --runs 5 smoke-ui-details                       # plus 6 busy loops: far slower than CI
```

The logs of failed runs are kept in `.build/stress/`. When a test times out waiting for the book, `describeBookFrames(page)` from `scripts/ui-actions.mjs` reports what each book view and thumbnail frame shows, read inside the frames. After an edit, wait with `bookShows(page, { since })` until the book view shows the edited revision: a frame marked ready may still be the previous revision's. Close the app in cleanup with `closeApp(app)`, which kills an app that does not quit, so the test's own error is reported instead of the 6-minute script limit.

## Performance at a real book's size

The sample books are small, so they hide costs that only a long book shows. `scripts/heavy-book.mjs` writes a heavy test book to `.build/heavy-book/`: 244 pages, 300 linked photos at camera size, long Markdown stories with front matter, and a Terrain layout whose picture is drawn on a canvas about as slowly as a map's relief. It works offline. The photos are generated once (about 1.8 GB, 1–2 minutes) and kept. `approvals.json` beside the book holds the approvals its linked photos need in a test profile.

```sh
npm run build && node scripts/stage-desktop.mjs
node scripts/bench-edits.mjs            # Add, Delete, Move Down and Duplicate on the heavy book
node scripts/bench-edits.mjs --book ~/Books/Trip.imageflow   # a copy of your own book, with your app's approvals
```

For each edit it reports the first painted frame that shows it (*feedback*), when the book view shows its render (*shown*), and when the window stops changing (*settled*). With a profiling build (`IMAGEFLOW_PROFILE=1 npx vite build`), `--profile` adds the render steps and every picture drawn. A benchmark that shows no photos fails, rather than measuring a book without them.

## Continuous integration

GitHub Actions runs:

- **check:** build, app/template/API type checks and unit tests on Linux (`npm run test:unit`, without the sync engine reruns per store).
- **desktop:** `npm run test:desktop:smoke` on Apple silicon, covering launch, presentation, rendering, export, saves, updates, shutdown, compatibility books and one sync smoke (`smoke-sync`). Runs on every public-repository PR and pushes to `main`; private-repository PRs skip it.
- **Pages:** site build and internal link checks, with documentation and update feeds published together from `main`. See [Documentation site](docs-site.md).

Keep these two lean: a new smoke script or a slow test suite goes into `npm run test:desktop`, not into the PR checks, unless it guards something a PR is likely to break.

The **Full desktop suite** workflow runs the complete desktop suite nightly on `main` (02:30 UTC), in jobs that run side by side: the full unit tests (`--full --without-stores`), the sync scenarios against each other store (`--full --store=…`), and every smoke script in two halves (`SMOKE_SHARD`), among them `smoke-sync-auto`, `smoke-sync-settings` and `smoke-library`, so a breakage shows up the day after the merge that caused it; start it from Actions to check a branch or release candidate. Each smoke script has a time limit (`SMOKE_TIMEOUT_MINUTES`, default 6), and the run reports every failing script at the end. The release workflow runs packaged-app checks. Review UI appearance and animation manually.

Use `npm run test:updates` for the focused updater and quit checks. `npm run test:upgrade:signed` exercises real signed upgrades; see [Automated signed upgrade test](../releasing.md#automated-signed-upgrade-test) for its requirements.

For branch protection, require the `check` and `desktop` checks produced by GitHub Actions after both have passed. Revisit the required `desktop` check if the repository becomes private, since its PR job will then be skipped.
