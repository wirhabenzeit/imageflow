# 0006: Template dependencies, network access and asynchronous rendering

Status: accepted, 2026-11-13; revised the same day. Phases 1 (render purity), 2 (asynchronous rendering), 3 (network), 4 (npm dependencies) and 5 (the starter's Map layout) implemented. The Map layout is added beside the Panorama GPX inset rather than replacing it for now. Persistent snapshots and generated files are deferred (see [Deferred](#deferred)); reproducible offline printing is tracked in #94. Motivated by a real map layout in the photobook starter, replacing the basemap-less GPX inset.

## Problem

A map page wants a real basemap with drag, zoom and a choice of styles. The natural tool is a library such as MapLibre GL. Today's contract rules that out in three places:

- **Imports.** The bundler (`bundleTemplate` in `desktop/project.ts`) resolves only `react`, `imageflow` and relative paths inside `template/`. Any other bare import is an error.
- **Network.** Every frame on the render origin, including custom element editors, gets `connect-src 'self'; img-src 'self' data:` and `default-src 'none'`. Tiles, styles and glyphs cannot load, and blob workers are blocked.
- **Purity.** `render` must be a pure function of its input: no effects, timers or fetching. Export captures a page once the DOM is ready and has no notion of waiting for asynchronous drawing.

Building maps into the app would solve one case. The goal here is that templates can do this kind of thing themselves.

## Principle

**Rendering may load declared external resources and finish asynchronously. Rendering never modifies the book's saved content.**

A first draft of this decision kept printing offline: the editor would draw the map and save it into the book as an image, and the page would show that snapshot. That needed generated files with their own garbage collection, a stale-snapshot check and an explicit *Update map* step, and the print was only as sharp as the last snapshot. Offline, reproducible printing is not a requirement for v1, so the page now draws the map itself: live in the preview, and again at the output resolution when exporting. What a page depends on is still explicit: the template's declared `network` origins, which the user allows, and the element's parameters.

| | Element editor | Page preview, Book check, export |
|---|---|---|
| npm dependencies | yes | yes (same bundle) |
| Network | declared origins, once allowed | declared origins, once allowed |
| Effects, WebGL, workers | yes | only inside `<RenderedImage>` drawing |
| Writes | parameters | none |

## Decision

### 1. npm dependencies, vendored at the template boundary

A template may contain `package.json` and a lockfile. A book and the library always run the **saved dependency bundle**, never `node_modules`. Installed packages are an authoring input to one explicit step, not something a book reads.

- **The saved bundle.** `template/vendor/` holds `deps.js` (one ESM file with every third-party module the template imports, plus its CSS), `types/` (declarations, below), `LICENSES/` (each package's licence file) and `manifest.json` (the packages and versions inside, the lockfile's hash, and which bare specifiers map to which export of `deps.js` and which declaration entry).
- **Opening, rendering, checks and export** bundle `index.tsx` as today and resolve every bare import through `vendor/manifest.json`. `node_modules` is ignored, even when it is present. A bare import the manifest does not list is a load error naming the package and pointing at the rebuild step.
- **Rebuilding is explicit.** `node scripts/rebuild-template-dependencies.mjs /path/to/template` bundles the imported packages from `template/node_modules` into `vendor/`. It is the only way `vendor/` changes. The rebuild writes `vendor/` atomically and changes the template hash. When `node_modules` exists and its lockfile hash differs from the manifest's, the Book check warns that the saved bundle is stale; it never switches to the installed packages on its own.
- **Hash.** The template hash (`template.hash`, the library's `.library.json`) covers all of `vendor/` and still excludes `node_modules/` and dotfiles. Two books with the same hash therefore run the same dependency code, because nothing outside the hash can be loaded: the bundler also refuses a relative import that resolves into `node_modules/` or a dot folder, such as `./node_modules/pkg/index.js`, so loading, hashing and copying agree on what a template may run.
- **Types.** The rebuild also writes each package's declarations into `vendor/types/<package>/`, the closure of `.d.ts` files reachable from its `types` entry, with `@types/*` packages used when a package ships none. The TypeScript check maps bare specifiers to these entries through the manifest, as it maps `imageflow` and `react` to the installed host types today, and reads files under `vendor/types/` (it continues to skip `node_modules/`). A package without any declarations gets a generated `declare module '<name>';` stub and a Book check warning, so `check_book` with `typescript: true` reports the missing types rather than an unresolved import. The rebuild also updates `paths` in the template's `tsconfig.json`, so code editors resolve the same declarations.
- `react` and `imageflow` remain host modules and must not appear in `dependencies`; a rebuild that would bundle its own React is rejected.

The bundle size limit and the existing rules (no paths outside `template/`, no links) apply to `vendor/` as to any other template file.

### 2. Host-managed asynchronous rendering

`imageflow` exports `<RenderedImage draw inputs label alt className style />` (capability `rendered-images`). It is the one place a layout may do asynchronous or GPU work.

- **The host drives it.** When the element mounts, or its `inputs` (JSON-like data) change, the host calls `draw({ width, height, pixelRatio, mode, signal })`: the box's size in CSS pixels as laid out, the device pixels per CSS pixel to draw at, the mode (`preview`, `check` or `export`) and an `AbortSignal`. `draw` resolves to a canvas, an `OffscreenCanvas` or an image `Blob`, and rejects to fail. The host turns the result into an image; nothing is written to the book. Page and layout thumbnails share a bounded in-memory picture cache within their book window, so switching pages or replacing a render frame can reuse an identical picture. The key includes the layout and picture position, declared inputs, output dimensions and pixel ratio; the host scopes it to the template hash and network permissions. A window keeps at most 16 MB, with a 4 MB limit per picture, and releases it when the book closes. Checks and exports always draw afresh.
- **Resolution.** Previews draw at the screen's density (at most 2×, and 0.5× for thumbnails and checks). Export draws at the format's target resolution ÷ 96 (300 ppi when the format sets none), so a map in a PDF is as sharp as a photo would need to be.
- **Concurrency.** The host runs at most two drawings at once in the book view and one elsewhere, so a long book does not open a WebGL context per page.
- **Waiting.** A Book check and every export page wait until all pictures on the page, and any they start, have finished. Each picture has its own drawing timeout (60 s for previews and checks, 120 s for export), counted from when it starts drawing, so time queued behind other pictures is not held against it. The jobs that wait for a frame (`src/render-budget.ts`) therefore have no fixed whole-book deadline: they wait while pictures keep starting or finishing, and time out only when nothing has moved for one picture's timeout plus a minute for loading and layout. A book with many slow maps takes longer, but a picture within its own timeout never fails because of the job around it. MCP calls keep their own two-minute limit.
- **Live status.** The edit view does not wait; pictures fill in as they finish, with a quiet placeholder until then. It reports to the live Book check as pictures start, finish or fail, so a map that failed on the page is listed there, and the check says while pictures are still drawing. Pictures on spreads not yet scrolled into view have not been drawn; the check before export draws them all.
- **Invalidation and cancellation.** A picture is drawn again when its `inputs`, the box's size or the output settings (mode, pixel ratio) change; a change of format renders the book again, which draws every picture anew. Each drawing keeps the `draw` function, inputs and settings of the render that started it, so the basemap and anything drawn over it from the same values always match. The signal is aborted when the element unmounts (the frame closes or reloads), a newer drawing replaces it, or the timeout passes, and a result that arrives after its signal was aborted is discarded, so an older drawing never replaces a newer one.
- **Resolution.** The picture covers the box, cropped to its proportions, so its resolution is the lower of the two axes. A picture with fewer pixels than the box needs at the requested pixel ratio on either axis fails, so a template cannot print a stretched or low-resolution picture by mistake.
- **Failure.** A rejected or timed-out drawing shows its message on the page and is a `rendered-image-failed` Book check error naming the label, spread and element, so export stops rather than printing a page without its map. A library error that is a plain object or event with a `message` is reported by that message.
- **Readiness is the template's job.** The host cannot know when a library has finished; `draw` decides. The starter's map resolves on MapLibre's `idle` event and rejects on any `error` event (a style, tile or glyph that failed to load), so a half-loaded map never counts as ready.

### 3. Declared network access

`defineTemplate` gains `network: string[]`, a list of HTTPS origins, e.g. `['https://tiles.openfreemap.org']`. Wildcards are limited to one leading label (`https://*.example.com`).

- **Consent.** The first time a book whose template declares origins not yet allowed renders, or one of its element editors opens, ImageFlow asks, listing them and saying that previews and export need them. The answer is stored per book identity with the app-owned approvals from [0005](0005-linked-sources.md), together with the template's hash: like library trust, it holds only while the template's files are unchanged, and a changed template asks again. Declining keeps the book usable offline: its pictures fail, so the Book check reports them and export stops, and the question comes back when an editor opens. Importing a template into the library also lists its packages and origins, and the user may allow the origins for that exact version: the grant is stored app-wide by template hash, so books whose template still has that hash need not ask, and any change to the template's files ends it. Built-in templates are trusted for the origins they declare. Settings → Templates shows the packages, origins and trust, and can allow or revoke it.
- **Changes while a book is open.** Every frame gets the origins allowed for the hash of the template it renders, so a frame of a changed template gets none until its own hash is allowed. Allowing, revoking in Settings and changing the template's files render the open book again under the new policy. When origins are withdrawn, a running export or Book check stops, since its frames loaded under the old policy: export saves nothing and says that network access was withdrawn. Frames already loaded keep the policy they loaded with until they are replaced, which this does at once: the book's frames render again, and an open element editor loads again on the current book.
- **CSP.** Every frame of a book with allowed origins (element editors, the book view, thumbnails, checks and export) builds `connect-src`, `img-src` and `font-src` from them, and adds `worker-src blob:` and `child-src blob:` for libraries that spawn workers. `img-src` always allows `blob:` for rendered pictures. Undeclared origins stay blocked everywhere.
- **No credentials from the app.** Frames stay sandboxed, without cookies or the app's session. API keys, if a provider needs one, are a document parameter the user enters (`p.text({ secret: true })` stored outside `project.json` is a possible follow-up, not part of this decision).
- The MCP authoring context lists a template's declared and approved origins.

### 4. Purity, and how it is checked

`render` and `anchors` stay synchronous functions of their input, and they never change the book. Everything asynchronous goes through `<RenderedImage>`. With npm libraries in reach, this ADR adds enforcement:

- **Detection in checks.** Book check and export frames install guards before the template loads: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `importScripts`, `HTMLCanvasElement.getContext` and `OffscreenCanvas` with `webgl`/`webgl2`/`webgpu`, and `setTimeout`/`setInterval`/`requestAnimationFrame` called during render. A call is recorded with the spread and element being rendered and reported as a `render-impure` error naming the API; export refuses to print a book with such an error. A 2D canvas stays allowed, since it is synchronous and deterministic enough for charts drawn during render.
- **Declared work is exempt.** While a `<RenderedImage>` is drawing, the guards record nothing: its requests, WebGL context, workers and timers are the declared rendering work. The CSP still limits it to the allowed origins.
- **Validation.** Fixture templates that fetch, open a WebGL context, start a worker and set a timer in `render` each fail the Book check with `render-impure`; the same calls inside an element editor or a `<RenderedImage>` drawing do not.
- Trust: templates are still code you choose to run. `network` makes the reach of that code explicit. The guards report mistakes; they are not a security boundary.

## The map layout under this contract

The starter's Map layout (`sample/starter/template/map.tsx`), all in template code:

- `package.json` depends on `maplibre-gl`. `network: ['https://tiles.openfreemap.org']`. OpenFreeMap needs no key and serves OpenMapTiles vector styles (Liberty, Bright, Positron) with OpenStreetMap data.
- Parameters: `track` (GPX file), `style` (enum), `longitude`, `latitude` and `zoom` (numbers; the zoom is a print zoom independent of the screen size), `trackColor`, `trackWidth`.
- The **Edit map** editor shows an interactive MapLibre map with the GPX track as a GeoJSON layer. Drag, scroll and buttons move it; a segmented control picks the style. The view is saved as ordinary parameters as it changes.
- `render` draws the basemap with `<RenderedImage label="Map">`: an off-screen MapLibre map at the box's size with `pixelRatio` from the target, resolved on `idle`. The GPX track goes on top as SVG, so the line stays vector in the PDF, with an attribution line: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors". The attribution cannot be turned off, only restyled.
- A full A4 landscape spread at 300 ppi is about 4960 × 3510 px, inside common WebGL limits.

Keyed providers (MapTiler, Mapbox, Stadia) can be added by template authors through `network` and a key parameter. Their terms on caching and print vary by plan, so the starter does not use them.

## Consequences

- Templates can use ordinary npm libraries, for maps, charts, QR codes, elevation profiles, without app changes.
- Maps are drawn at print resolution, and there is no snapshot to fall out of date.
- Printing a book with a map needs the network and the provider. If a provider changes its style or data, a reprint can differ; if it is down, the Book check fails and export stops instead of printing an incomplete page. Offline, reproducible printing returns with #94.
- Templates with `network` are more powerful code; the consent step and per-frame CSP limit that power to the declared origins.
- Export takes longer for pages with pictures, bounded by the per-picture timeout.
- The template package gains a generated `vendor/` folder. Authors need `npm install` and an explicit rebuild to change dependencies; a book never picks up installed packages by itself.

## Deferred

- **Persistent snapshots and generated files.** Saving a rendered picture into the book (an editor `saveFile`, image file parameters, and collection of files no saved state or Undo history refers to) was designed in the first draft and is left out of v1. It returns, if needed, for offline and reproducible printing (#94).

## Phases

1. Render purity guards and the `render-impure` check, with their fixtures. This lands first so that later phases can rely on it.
2. `<RenderedImage>`: the host lifecycle (size, resolution, signal, concurrency, waiting with a timeout), `rendered-image-failed`, and the guard exemption.
3. `network` with consent and the CSP for editors, previews, checks and export.
4. npm dependencies: *Rebuild Dependencies*, `vendor/` with manifest, types and licences, manifest-based resolution in the bundler and the TypeScript check, and the stale-bundle warning. Tests cover a book with a stale `node_modules` rendering the saved bundle, and `check_book` with `typescript: true` resolving vendored types.
5. The starter's Map layout, with docs and a desktop test (`smoke-map`) that renders the preview, checks, exports a proof PDF at print resolution against a stubbed map server, and reports a failing server.

## Open questions

- Is one vendored bundle enough, or do large dependencies need code splitting so book previews do not load editor-only code?
- Should export cache pictures drawn for the same inputs and resolution within one run, so a check before export does not draw everything twice?
