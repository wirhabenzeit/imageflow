# 0006: Template dependencies, editor network access and generated files

Status: proposed, 2026-11-13. Motivated by a real map layout in the photobook starter, replacing the basemap-less GPX inset.

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

A template may contain `package.json` and a lockfile. Bare imports resolve from `template/node_modules` during authoring. The book and the library never depend on `node_modules`:

- **Save Template to Library, Export Template… and New Book** run the bundler once and store the result as `template/vendor/deps.js` (one ESM file holding every third-party module the template imports, plus its CSS). The template's own source stays readable beside it.
- **Opening a book** bundles `index.tsx` as today; bare imports resolve to `vendor/deps.js` when `node_modules` is absent. A bare import that is in neither place is an error naming the package and suggesting `npm install`.
- `react` and `imageflow` remain host modules and must not appear in `dependencies`; a template that bundles its own React is rejected.
- The template hash (`template.hash`, the library's `.library.json`) covers `vendor/deps.js`, so two books with the same hash render the same dependency code.
- Licences: the vendoring step collects each package's licence file into `vendor/LICENSES/`, so shared templates carry them.

The bundle size limit and the existing rules (no paths outside `template/`, no links) apply to the vendored file as to any other.

### 2. Declared network access for editors only

`defineTemplate` gains `network: string[]`, a list of HTTPS origins, e.g. `['https://tiles.openfreemap.org']`. Wildcards are limited to one leading label (`https://*.example.com`).

- **Consent.** Importing a template with `network` shows the origins in the import sheet; opening a book whose template declares new origins asks once per book identity, stored with the app-owned approvals from [0005](0005-linked-sources.md). Declining keeps the book usable; editors then load without network.
- **CSP.** The editor frame's response builds `connect-src`, `img-src` and `font-src` from the approved origins, and adds `worker-src blob:` and `child-src blob:` for libraries that spawn workers. Book previews, thumbnails, checks and export frames keep today's policy unchanged.
- **No credentials from the app.** The editor frame stays sandboxed, without cookies or the app's session. API keys, if a provider needs one, are a document parameter the user enters (`p.text({ secret: true })` stored outside `project.json` is a possible follow-up, not part of this decision).
- The MCP authoring context lists a template's declared and approved origins.

### 3. Editors can save generated files

Element editors receive `saveFile(data, { name, type })`, which stores bytes in the book and resolves to a file ID, mirroring `importFile`. The editor assigns the ID to a file parameter with `set`. Assignment is undoable; the file itself is kept, as with imports.

- File parameters today are UTF-8 text up to 20 MB. This adds **image file parameters**: `p.file({ accept: ['.png', '.jpg'], kind: 'image' })`. In `render`, `file(id)` for an image parameter returns `{ url, width, height, name }` instead of text, served from the render origin like photos, so it passes the existing image-resolution and colour checks at export.
- Generated files are document-owned (always copied, never linked) and are listed in Manage Sources as *Generated by <element>*. Replacing a generated file through `saveFile` again creates a new ID; unreferenced generated files are collected by the existing cleanup.
- `saveFile` accepts PNG, JPEG, SVG, GPX/JSON/text; up to 50 MB.

### 4. What stays the same

- `render` and `anchors` stay pure. A template that calls `fetch` or creates a WebGL context in `render` still fails the Book check.
- Export never waits for the network. If a page depends on a generated file that is missing, the Book check reports it like any other missing source.
- Trust: templates are still code you choose to run. `network` makes the reach of that code explicit and limits it to editing.

## The map layout under this contract

The starter's route element becomes a map element, all in template code:

- `package.json` depends on `maplibre-gl`. `network: ['https://tiles.openfreemap.org']`. OpenFreeMap needs no key and serves OpenMapTiles vector styles (Liberty, Bright, Positron) with OpenStreetMap data.
- Parameters: `track` (GPX file), `style` (enum), `center` and `zoom` (numbers), `bearing`, `trackColor`, `trackWidth`, and `snapshot` (image file, owned by the editor).
- The **Edit map** editor shows a MapLibre map with the GPX track as a GeoJSON layer. Drag, scroll and buttons move it; a segmented control picks the style. On Done (and after a short pause when idle) it renders the current view at the element's print size and the format's target resolution, using an offscreen MapLibre instance with `pixelRatio` set so that the canvas matches the box at 300 dpi. A full A4 landscape spread is about 4960 × 3510 px, inside common WebGL limits; the editor reports when a box would exceed `MAX_TEXTURE_SIZE` and caps the resolution.
- `render` draws `snapshot` as an image, the GPX track on top as SVG (so the line stays vector in the PDF), and an attribution line: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors". The attribution cannot be turned off, only restyled.
- Without a snapshot the element shows the track alone (as today) and the Book check warns that the basemap has not been generated.

Keyed providers (MapTiler, Mapbox, Stadia) can be added by template authors through `network` and a key parameter. Their terms on caching and print vary by plan, so the starter does not use them.

## Consequences

- Templates can use ordinary npm libraries, for maps, charts, QR codes, elevation profiles, without app changes.
- Printing stays reproducible: a book's output depends only on files inside it.
- Templates with `network` are more powerful code; the consent step and per-frame CSP keep that power to the editor.
- The template package gains a generated `vendor/` folder, and authors need `npm install` while working on a template with dependencies.
- Raster basemaps are only as sharp as the snapshot. A vector basemap (vector tiles drawn as SVG in `render`) stays possible later on top of the same mechanism: the editor would save clipped tile data instead of an image.

## Phases

1. Image file parameters and `saveFile` (useful on their own, e.g. for generated charts).
2. `network` with consent and the editor CSP.
3. npm dependencies and vendoring.
4. The starter's map layout, replacing the GPX-only inset, with docs and a desktop workflow test that edits the map with a stubbed tile server and exports offline.

## Open questions

- Should the snapshot regenerate automatically when the format or box size changes, or only when the user reopens the editor? (Proposed: the Book check warns when the snapshot's pixel size no longer meets the target resolution.)
- Should `network` approval be per book, per template version, or per app?
- Is one vendored bundle enough, or do large dependencies need code splitting so book previews do not load editor-only code such as MapLibre?
