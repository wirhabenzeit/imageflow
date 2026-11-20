# Testing and CI

```sh
npm run test:unit       # unit tests
npm run test:desktop    # build, unit tests and desktop suite
npm run test:desktop -- --visible  # include native desktop checks (CI or VM)
npm run test:packaged   # package and test the app
```

Desktop checks require [Poppler](https://poppler.freedesktop.org) (`brew install poppler`). They cover rendering, PDF geometry, text flow, preflight, imports, autosave and live reload.

The smoke runner defaults to invisible windows: no native focus, fullscreen, Dock icon or interactive dialogs. Unexpected native prompts and uncaught exceptions fail with a terminal error; tests exercising confirmations mock their answers explicitly. `smoke-inline-editors` and `smoke-mcp-context` require compositor hit testing in shown windows and are reported as skipped. Use `node scripts/run-smokes.mjs --visible <scripts…>` or the full-suite command above on an isolated desktop to include them and the native presentation focus/fullscreen checks. Direct invocation of those two scripts also requires `--visible`. Build and staging must finish before running smoke scripts. An already-running staged app must be restarted to pick up these changes.

Packaged checks cover document registration, Finder open events, proof and print export, linked sources and the MCP bridge. Use `npm run test:packaged:existing` to test an existing build. Packaged checks include Finder integration and the visible MCP context test, so run them on an isolated desktop too.

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

- **check:** build, app/template/API type checks and unit tests on Linux.
- **desktop:** `npm run test:desktop:smoke` on Apple silicon, covering launch, presentation, rendering, export, saves, updates, shutdown and compatibility books. Runs on every public-repository PR and pushes to `main`; private-repository PRs skip it.
- **Pages:** site build and internal link checks, with documentation and update feeds published together from `main`. See [Documentation site](docs-site.md).

The **Full desktop suite** workflow runs the complete desktop suite nightly on `main` (02:30 UTC), so a breakage shows up the day after the merge that caused it; start it from Actions to check a branch or release candidate. Each smoke script has a time limit (`SMOKE_TIMEOUT_MINUTES`, default 6), and the run reports every failing script at the end. The release workflow runs packaged-app checks. Review UI appearance and animation manually.

Use `npm run test:updates` for the focused updater and quit checks. `npm run test:upgrade:signed` exercises real signed upgrades; see [Automated signed upgrade test](../releasing.md#automated-signed-upgrade-test) for its requirements.

For branch protection, require the `check` and `desktop` checks produced by GitHub Actions after both have passed. Revisit the required `desktop` check if the repository becomes private, since its PR job will then be skipped.
