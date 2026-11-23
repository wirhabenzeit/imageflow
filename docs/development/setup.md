# Setup

Use Node.js 22.20+ or 24.12+ on macOS.

```sh
npm ci
npm run dev
```

The development server reloads CSS in place, refreshes React components and restarts Electron after main-process changes. Book files reload after external edits.

By default, each run opens a temporary copy of the Photobook starter. Changes to `sample/starter` create another fresh copy; edits to temporary copies are disposable.

The built-in sample books share their photographs. The files live once in `sample/shared/photos/`, and each sample's `photos.json` lists only the photos that book uses, with its own titles and captions. Copy a sample into a book with `copySample` from `desktop/sample-book.mjs`, as the app, the scripts and the tests do, so the copy receives the photos it lists. A plain `cp` of a sample folder leaves its `photos/` empty. To add a photo, put the JPEG in `sample/shared/photos/` (about 6000 px on the long edge, quality 85) and list it in the `photos.json` of the samples that use it.

| Command | Opens |
| --- | --- |
| `npm run dev` | Fresh Photobook starter |
| `npm run dev -- --last` | Last opened book |
| `npm run dev -- --starter calendar` | Fresh Wall calendar starter |
| `npm start` | App built for production |

Set `IMAGEFLOW_TEMPLATES` to use another template library folder.

Sync ships ([ADR 0012](../decisions/0012-sync-backend-and-library.md)): **Settings → Sync** chooses the backend this Mac syncs every book through, an S3-compatible bucket with its access key and Test Connection; **File → Sync** starts and stops syncing a book; and the Start window is the library, which downloads and deletes books on that backend. Two flags offer what a release does not:

- `IMAGEFLOW_SYNC_ICLOUD=1` lists **iCloud** in Settings → Sync (it needs a signed build with the provisioning profile, `docs/signing.md`) until the checks of #292 are done. Without it, a settings file that names iCloud leaves sync off.
- `IMAGEFLOW_SYNC_FOLDER=1` lists **Folder**, a backend over a local folder for development and tests. A `settings.json` that names a folder (`"sync": { "kind": "folder", "path": "/abs/path" }`) is used with or without the flag, which is how the smoke tests set it up.

`IMAGEFLOW_SYNC_CREDENTIALS=memory` keeps a bucket's key in memory instead of the keychain in a development build.

`IMAGEFLOW_SYNC_IDLE_MS=<ms>` shortens how long a development build waits after a save before a book pushes by itself (30 s otherwise), and `IMAGEFLOW_SYNC_TEST_SLOW_MS=<ms>` makes each automatic sync wait that long at its start while it holds the book, as a slow remote would, so an edit can meet it. A packaged app ignores both.

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
