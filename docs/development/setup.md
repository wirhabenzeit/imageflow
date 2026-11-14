# Setup

Use Node.js 22.20+ or 24.12+ on macOS.

```sh
npm ci
npm run dev
```

The development server reloads CSS in place, refreshes React components and restarts Electron after main-process changes. Book files reload after external edits.

By default, each run opens a temporary copy of the Photobook starter. Changes to `sample/starter` create another fresh copy; edits to temporary copies are disposable.

| Command | Opens |
| --- | --- |
| `npm run dev` | Fresh Photobook starter |
| `npm run dev -- --last` | Last opened book |
| `npm run dev -- --starter calendar` | Fresh Wall calendar starter |
| `npm start` | App built for production |

Set `IMAGEFLOW_TEMPLATES` to use another template library folder.

## Build the app

```sh
npm run package:mac
```

The ad-hoc-signed app is written to `out/ImageFlow-darwin-arm64/ImageFlow.app` on Apple silicon or `out/ImageFlow-darwin-x64/ImageFlow.app` on Intel. See [Signing and notarization](../signing.md) for Developer ID builds and [Releasing](../releasing.md) for the release workflow.

After editing an icon in `resources/brand/`, run `npm run build:icons` and commit the SVG and generated `.icns` files.

## Template API docs

Edit topics in `docs/template-api/` and examples in `docs/examples/`, then run:

```sh
npm run generate:docs
```

This updates the single-page reference and template skill. `tests/docs-topics.test.ts` checks that generated copies match their sources. See [Documentation site](docs-site.md) for navigation and site builds.
