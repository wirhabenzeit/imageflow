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
- **desktop:** `npm run test:desktop:smoke` on Apple silicon, covering launch, rendering, export, saves and shutdown. Runs on every public-repository PR and pushes to `main`; private-repository PRs skip it.
- **Docs:** site build and internal link checks. See [Documentation site](docs-site.md).

Run the **Full desktop suite** workflow manually for the complete desktop suite. The release workflow runs packaged-app checks. Review UI appearance and animation manually.
