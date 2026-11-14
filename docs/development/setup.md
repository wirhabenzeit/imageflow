# Setup

Use Node.js 22.20 or newer (or 24.12+) on macOS.

```sh
npm ci
npm run dev
```

`npm run dev` starts a Vite dev server and opens the app with hot reloading. Editor and render CSS apply in place, React components refresh without losing the open book, and main-process changes restart Electron and reopen the book. Template, Markdown and photo changes in the book reload as they do in the released app.

Each run opens a fresh copy of the Photobook starter in a temporary folder, and a new copy whenever `sample/starter` changes, so you always try the current starter. Edits to that copy are thrown away with it.

| Command | Opens |
| --- | --- |
| `npm run dev` | A fresh copy of the Photobook starter |
| `npm run dev -- --last` | The book that was open last, for example a real book |
| `npm run dev -- --starter calendar` | A fresh copy of the Wall calendar starter |
| `npm start` | The production build |

`IMAGEFLOW_TEMPLATES` points the app at another template library folder.

## Building the app

```sh
npm run package:mac
```

The ad-hoc-signed app appears in `out/ImageFlow-darwin-arm64/ImageFlow.app`. [Signing and notarization](../signing.md) covers Developer ID builds, and [Releasing](../releasing.md) the release workflow.

The app icon and the book and template document icons are drawn as SVG in `resources/brand/`. After editing one, run `npm run build:icons` to regenerate the `.icns` files in `resources/` and commit both.

## Template API docs

The template API reference is written as one file per topic in `docs/template-api/`, listed in order in `topics.json`. The MCP server, the agent skill in `skills/imageflow-templates/`, the one-page `docs/template-api.md` and this site all use those files. After editing a topic or an example in `docs/examples/`, run:

```sh
npm run generate:docs
```

`tests/docs-topics.test.ts` fails when a generated copy is stale.
