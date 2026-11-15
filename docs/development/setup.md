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

## Icons and branding

The app, book and template icons have SVG sources in `resources/brand/`. The app also has a layered Icon Composer source, `ImageFlow.icon`, for macOS 26 Liquid Glass. After editing these sources, run `npm run build:icons` on a Mac with Xcode 26. Commit the sources together with the generated `.icns` files, `resources/Assets.car` and DMG background in `resources/dmg/`.

The DMG window layout comes from `scripts/build-dmg-layout.py`. Outlined logo and wordmark SVGs live in `resources/brand/logo/`, in horizontal and stacked versions for light and dark backgrounds. They use Inter Display under the SIL Open Font License.

## Template API docs

Edit topics in `docs/template-api/` and examples in `docs/examples/`, then run:

```sh
npm run generate:docs
```

This updates the single-page reference and template skill. `tests/docs-topics.test.ts` checks that generated copies match their sources. See [Documentation site](docs-site.md) for navigation and site builds.
