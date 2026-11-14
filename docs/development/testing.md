# Testing and CI

```sh
npm run test:unit       # unit tests
npm run test:desktop    # build, unit tests and every desktop smoke script
npm run test:packaged   # package the app, then check the packaged build
```

The desktop checks need [Poppler](https://poppler.freedesktop.org) (`brew install poppler`). They exercise PDF geometry, line breaks, preflight, imports, autosave, live reload and randomized Markdown continuation. `npm run test:packaged` also checks the packaged document declaration, icon, real Finder open events and packaged proof and print workflows. `npm run test:packaged:existing` checks a release build without rebuilding it, including its MCP bridge.

## Continuous integration

For every pull request, GitHub Actions runs:

- **check**: build, app, template and API type checks, and unit tests on Linux.
- **desktop**: `npm run test:desktop:smoke` on an Apple silicon Mac, covering app launch, book opening and rendering, proof PDF output, durable saves and orderly shutdown.
- **Docs**: builds this site and checks its internal links (see [Documentation site](docs-site.md)).

The **Full desktop suite** workflow runs `npm run test:desktop` when started by hand from Actions, for example before a release. UI polish, animation and timing are checked by hand. Packaged-app checks belong to the release workflow.

Once both jobs have passed on GitHub, require the `check` and `desktop` status checks in the `main` branch protection rule. If the repository is private, the `desktop` job runs only on pushes to `main` to save macOS minutes, so revisit that requirement then.
