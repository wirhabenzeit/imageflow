# 0006: Template dependencies, editor network access and generated files

Status: accepted, 2026-11-13. Phases 1 (render purity), 2 (image files, `saveFile`, collection), 3 (editor network) and 4 (npm dependencies) implemented. An MCP tool for the rebuild is a follow-up. Motivated by a real map layout in the photobook starter, replacing the basemap-less GPX inset.

## Problem

A map page wants a real basemap with drag, zoom and a choice of styles. The natural tool is a library such as MapLibre GL. Today's contract rules that out in three places:

- **Imports.** The bundler (`bundleTemplate` in `desktop/project.ts`) resolves only `react`, `imageflow` and relative paths inside `template/`. Any other bare import is an error.
- **Network.** Every frame on the render origin, including custom element editors, gets `connect-src 'self'; img-src 'self' data:` and `default-src 'none'`. Tiles, styles and glyphs cannot load, and blob workers are blocked.
- **Purity.** `render` must be a pure function of its input: no effects, timers or fetching. Export captures a page once the DOM is ready and has no notion of waiting for asynchronous drawing.

Building maps into the app would solve one case. The goal here is that templates can do this kind of thing themselves.

## Principle: rich at edit time, pure at print time

Template code may be as capable as it needs to be **while the user edits**. Everything a printed page depends on must be **saved into the book first**. `render` stays pure and offline, export stays deterministic, and a book still opens and prints on a Mac with no network and no `node_modules`.

This splits the work in two:

| | Element editor frame | Render / export frame |
|---|---|---|
| npm dependencies | yes | yes (same bundle) |
| Network | declared hosts only | none |
| Effects, WebGL, workers | yes | no (unchanged) |
| Writes | parameters, and generated files (new) | none |

## Decision

### 1. npm dependencies, vendored at the template boundary

A template may contain `package.json` and a lockfile. A book and the library always run the **saved dependency bundle**, never `node_modules`. Installed packages are an authoring input to one explicit step, not something a book reads.

- **The saved bundle.** `template/vendor/` holds `deps.js` (one ESM file with every third-party module the template imports, plus its CSS), `types/` (declarations, below), `LICENSES/` (each package's licence file) and `manifest.json` (the packages and versions inside, the lockfile's hash, and which bare specifiers map to which export of `deps.js` and which declaration entry).
- **Opening, rendering, checks and export** bundle `index.tsx` as today and resolve every bare import through `vendor/manifest.json`. `node_modules` is ignored, even when it is present. A bare import the manifest does not list is a load error naming the package and pointing at the rebuild step.
- **Rebuilding is explicit.** *Template → Rebuild Dependencies* bundles the imported packages from `template/node_modules` into `vendor/`. It is the only way `vendor/` changes. The rebuild writes `vendor/` atomically and changes the template hash. When `node_modules` exists and its lockfile hash differs from the manifest's, the Book check warns that the saved bundle is stale; it never switches to the installed packages on its own.
- **Hash.** The template hash (`template.hash`, the library's `.library.json`) covers all of `vendor/` and still excludes `node_modules/`. Two books with the same hash therefore run the same dependency code, because nothing outside the hash can be loaded.
- **Types.** The rebuild also writes each package's declarations into `vendor/types/<package>/`, the closure of `.d.ts` files reachable from its `types` entry, with `@types/*` packages used when a package ships none. The TypeScript check maps bare specifiers to these entries through the manifest, as it maps `imageflow` and `react` to the installed host types today, and reads files under `vendor/types/` (it continues to skip `node_modules/`). A package without any declarations gets a generated `declare module '<name>';` stub and a Book check warning, so `check_book` with `typescript: true` reports the missing types rather than an unresolved import. The rebuild also updates `paths` in the template's `tsconfig.json`, so code editors resolve the same declarations.
- `react` and `imageflow` remain host modules and must not appear in `dependencies`; a rebuild that would bundle its own React is rejected.

The bundle size limit and the existing rules (no paths outside `template/`, no links) apply to `vendor/` as to any other template file.

### 2. Declared network access for editors only

`defineTemplate` gains `network: string[]`, a list of HTTPS origins, e.g. `['https://tiles.openfreemap.org']`. Wildcards are limited to one leading label (`https://*.example.com`).

- **Consent.** The first time an element editor opens in a book whose template declares origins not yet allowed, ImageFlow asks, listing them. The answer is stored per book identity with the app-owned approvals from [0005](0005-linked-sources.md). Declining keeps the book usable; that editor loads without network, and the question comes back the next time an editor opens. Showing the origins in the template import sheet as well is a follow-up.
- **CSP.** The editor frame's response builds `connect-src`, `img-src` and `font-src` from the approved origins, and adds `worker-src blob:` and `child-src blob:` for libraries that spawn workers. Book previews, thumbnails, checks and export frames keep today's policy unchanged.
- **No credentials from the app.** The editor frame stays sandboxed, without cookies or the app's session. API keys, if a provider needs one, are a document parameter the user enters (`p.text({ secret: true })` stored outside `project.json` is a possible follow-up, not part of this decision).
- The MCP authoring context lists a template's declared and approved origins.

### 3. Editors can save generated files

Element editors receive `saveFile(data, { name, type })`, which stores bytes in the book and resolves to a file ID, mirroring `importFile`. The editor assigns the ID to a file parameter with `set`. Assignment is undoable; the file itself is kept, as with imports.

- File parameters today are UTF-8 text up to 20 MB. This adds **image file parameters**: `p.file({ accept: ['.png', '.jpg'], kind: 'image' })`. In `render`, `file(id)` for an image parameter returns `{ url, width, height, name }` instead of text, served from the render origin like photos, so it passes the existing image-resolution and colour checks at export.
- Generated files are document-owned (always copied, never linked) and are listed in Manage Sources as *Generated by <element>*. A new `saveFile` always creates a new ID; files are never overwritten in place.
- **Cleanup is new work, not existing behaviour.** Today's cleanup prunes only app-owned caches outside books; nothing removes files inside a book. Generated files get their own collection rule. A generated file is kept while any of these references it: the saved `project.json`; any state in the open session's Undo or Redo history; a running preview, check or export job, which pins its inputs as photos are pinned today. It is deleted once no reference remains, checked after each save, when history is trimmed and when the book closes; deletion goes through the recoverable save journal, so an interrupted save cannot lose a file the saved state needs. Files a user imported are never collected by this rule.
- **Editors save only on purpose.** The map editor calls `saveFile` on Done or an explicit *Update map* button, not on idle pauses. An editor that calls `saveFile` more than a few times within one open session gets a console warning, and drafts it replaces before Done are collected immediately, since no saved state or history refers to them.
- `saveFile` accepts PNG, JPEG, SVG, GPX/JSON/text; up to 50 MB.

### 4. Purity at print time, and how it is checked

`render` and `anchors` stay pure. Today that is an authoring requirement: the render CSP already stops requests to other origins, but nothing reports an impure template, and a WebGL context or a timer in `render` goes unnoticed. With npm libraries in reach, this ADR adds enforcement:

- **Detection in checks.** Book check and export frames install guards before the template loads: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `importScripts`, `HTMLCanvasElement.getContext` and `OffscreenCanvas` with `webgl`/`webgl2`/`webgpu`, and `setTimeout`/`setInterval`/`requestAnimationFrame` called during render. A call is recorded with the spread and element being rendered and reported as a `render-impure` error naming the API; export refuses to print a book with such an error. A 2D canvas stays allowed, since it is synchronous and deterministic enough for charts drawn during render.
- **Network stays blocked regardless.** The render, check and export CSPs are unchanged, so a guard that is bypassed still cannot reach the network.
- **Validation.** Fixture templates that fetch, open a WebGL context, start a worker and set a timer in `render` each fail the Book check with `render-impure`; the same calls inside an element editor do not.
- Export never waits for the network. If a page depends on a generated file that is missing, the Book check reports it like any other missing source.
- Trust: templates are still code you choose to run. `network` makes the reach of that code explicit and limits it to editing. The guards report mistakes; they are not a security boundary.

## The map layout under this contract

The starter's route element becomes a map element, all in template code:

- `package.json` depends on `maplibre-gl`. `network: ['https://tiles.openfreemap.org']`. OpenFreeMap needs no key and serves OpenMapTiles vector styles (Liberty, Bright, Positron) with OpenStreetMap data.
- Parameters: `track` (GPX file), `style` (enum), `center` and `zoom` (numbers), `bearing`, `trackColor`, `trackWidth`, and `snapshot` (image file, owned by the editor).
- The **Edit map** editor shows a MapLibre map with the GPX track as a GeoJSON layer. Drag, scroll and buttons move it; a segmented control picks the style. On Done or *Update map* it renders the current view at the element's print size and the format's target resolution, using an offscreen MapLibre instance with `pixelRatio` set so that the canvas matches the box at 300 dpi. A full A4 landscape spread is about 4960 × 3510 px, inside common WebGL limits; the editor reports when a box would exceed `MAX_TEXTURE_SIZE` and caps the resolution.
- `render` draws `snapshot` as an image, the GPX track on top as SVG (so the line stays vector in the PDF), and an attribution line: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors". The attribution cannot be turned off, only restyled.
- Without a snapshot the element shows the track alone (as today) and the Book check warns that the basemap has not been generated.

Keyed providers (MapTiler, Mapbox, Stadia) can be added by template authors through `network` and a key parameter. Their terms on caching and print vary by plan, so the starter does not use them.

## Consequences

- Templates can use ordinary npm libraries, for maps, charts, QR codes, elevation profiles, without app changes.
- Printing stays reproducible: a book's output depends only on files inside it.
- Templates with `network` are more powerful code; the consent step and per-frame CSP keep that power to the editor.
- The template package gains a generated `vendor/` folder. Authors need `npm install` and an explicit rebuild to change dependencies; a book never picks up installed packages by itself.
- Raster basemaps are only as sharp as the snapshot. A vector basemap (vector tiles drawn as SVG in `render`) stays possible later on top of the same mechanism: the editor would save clipped tile data instead of an image.

## Phases

1. Render purity guards and the `render-impure` check, with their fixtures. This lands first so that later phases can rely on it.
2. Image file parameters, `saveFile`, and collection of generated files (references from saved state, Undo/Redo and running jobs; journal-safe deletion), with tests for each reference kind.
3. `network` with consent and the editor CSP.
4. npm dependencies: *Rebuild Dependencies*, `vendor/` with manifest, types and licences, manifest-based resolution in the bundler and the TypeScript check, and the stale-bundle warning. Tests cover a book with a stale `node_modules` rendering the saved bundle, and `check_book` with `typescript: true` resolving vendored types.
5. The starter's map layout, replacing the GPX-only inset, with docs and a desktop workflow test that edits the map with a stubbed tile server and exports offline.

## Open questions

- Should the snapshot regenerate automatically when the format or box size changes, or only when the user reopens the editor? (Proposed: the Book check warns when the snapshot's pixel size no longer meets the target resolution.)
- Should `network` approval be per book, per template version, or per app?
- Is one vendored bundle enough, or do large dependencies need code splitting so book previews do not load editor-only code such as MapLibre?
