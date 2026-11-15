# Testing and CI

```sh
npm run test:unit       # unit tests
npm run test:desktop    # build, unit tests and desktop suite
npm run test:packaged   # package and test the app
```

Desktop checks require [Poppler](https://poppler.freedesktop.org) (`brew install poppler`). They cover rendering, PDF geometry, text flow, preflight, imports, autosave and live reload.

Packaged checks cover document registration, Finder open events, proof and print export, linked sources and the MCP bridge. Use `npm run test:packaged:existing` to test an existing build.

## Continuous integration

GitHub Actions runs:

- **check:** build, app/template/API type checks and unit tests on Linux.
- **desktop:** `npm run test:desktop:smoke` on Apple silicon, covering launch, presentation, rendering, export, saves, updates, shutdown and compatibility books. Runs on every public-repository PR and pushes to `main`; private-repository PRs skip it.
- **Pages:** site build and internal link checks, with documentation and update feeds published together from `main`. See [Documentation site](docs-site.md).

The **Full desktop suite** workflow runs the complete desktop suite nightly on `main` (02:30 UTC), so a breakage shows up the day after the merge that caused it; start it from Actions to check a branch or release candidate. Each smoke script has a time limit (`SMOKE_TIMEOUT_MINUTES`, default 6), and the run reports every failing script at the end. The release workflow runs packaged-app checks. Review UI appearance and animation manually.

Use `npm run test:updates` for the focused updater and quit checks. `npm run test:upgrade:signed` exercises real signed upgrades; see [Automated signed upgrade test](../releasing.md#automated-signed-upgrade-test) for its requirements.

For branch protection, require the `check` and `desktop` checks produced by GitHub Actions after both have passed. Revisit the required `desktop` check if the repository becomes private, since its PR job will then be skipped.
