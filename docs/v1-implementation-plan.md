# v1 implementation plan

Status: draft, 2026-11-09. Implements [v1-decisions.md](v1-decisions.md), [template-api.md](template-api.md), and [decisions/0001-rendering.md](decisions/0001-rendering.md). Effort is given as relative size (S, M, L), not dates.

## Architecture

```
Electron main process (Node)
  project/     open, create, read/write project.json and photos.json, watch the folder
  import/      copy photos and texts into the project, sRGB conversion, previews, thumbnails (sharp)
  template/    bundle template/ with esbuild, watch and rebuild, load-time validation
  export/      hidden export window → printToPDF / capturePage → post-processing (pdf-lib) → checks → save
  protocol     imageflow:// serves the editor, the template bundle, fonts, previews, and originals (export only)
  preload      typed IPC API exposed to the renderer (contextBridge)

Renderer (sandboxed React app)
  editor UI    spread list, photo strip, sidebar, canvas
  book render  renders spreads from project + template (mode: edit | export), shared with the export window
  flow         Markdown → HTML with source ranges, columns-based fragmentation, widow/keep rules
  state        project state, operations, undo/redo, validation messages

imageflow (template runtime package)
  defineTemplate, p.*, mm, Spread, PhotoBox, MarkdownBox, Element, asset, types
  provided to template bundles as an external, never bundled into them
```

The same book-render code runs in the editor window and the export window; only the mode and image sources differ. Flow runs after rendering in both, so preview and export fragments are computed by the same code on the same engine.

### Reused

| Source | What |
| --- | --- |
| PR #4 (Electron draft) | Electron shell, `imageflow://` protocol with CSP, sandboxing, menus, save dialogs, macOS packaging |
| `main` prototype | Crop math (`getCrop`, `Placement`), photo import checks, photo strip UI, demo photos for the starter project, parts of the app shell |
| `spikes/text-flow` | `markdown.mjs`, `flow.js` (columns strategy and rules), the property-test harness |
| `spikes/pdf-format` | Page-box post-processing (port from pikepdf to pdf-lib), PDF checks (port of `analyze.py`), test documents |
| `spikes/electron` | `printToPDF` options, zoom-based raster capture, readiness check that does not rely on `loadFile` |

### Removed

Swift renderer (`renderer/export.swift`) and its build steps, the multipart layout upload (`bookRender.exportBook`, `server/book-export.ts`, the Vite export middleware), the hard-coded layouts in `book.ts`, and the SVG canvas (`SpreadCanvas.tsx`).

## Milestones

The first milestone is a thin end-to-end slice, so that every later milestone extends a working app instead of integrating at the end.

### M1: Walking skeleton (L)

Open a project folder in Electron, render one spread from a bundled template with one photo and one Markdown box, export it to PDF.

- Merge the Electron shell from PR #4; remove the Swift export path; add the preload IPC API.
- Project folder: read `project.json`, `photos.json`, `texts/`, `template/`; schema validation with clear errors.
- Minimal `imageflow` runtime: `defineTemplate`, `p.boolean`/`p.string`, `Spread`, `PhotoBox`, `MarkdownBox`, geometry variables.
- esbuild bundling of `template/` in the main process, with `react` and `imageflow` as externals.
- Book render in edit mode with preview images; flow for a single Markdown box.
- Export window: same render with originals, `printToPDF`, page boxes via pdf-lib, save dialog.

Done when: a fixture project opens, shows its spread, and exports a PDF whose page size and boxes match the template's format, with identical line breaks in preview and PDF.

### M2: Template runtime and starter template (M)

- Complete `imageflow` API: all parameter types, document/spread/box/element scopes, `Element`, `asset`, render context (photo metadata, flow position, page numbers, resolved format), `span` for single-page ends.
- Load-time and render-time validation from [template-api.md](template-api.md); errors shown in the sidebar.
- Watch `template/` and hot-reload: rebuild, revalidate, re-render, reflow.
- Starter template: port the Senja layouts (title, photo and story, panorama, photo grid, two photos, text spread) plus a calendar spread as the generated-element example; inline styles plus `styles.css`; bundled static fonts (Source Serif 4, Inter).
- "New project" copies the starter template, sample photos, and sample texts into a new folder.

Done when: editing the starter template in a code editor updates the open project within a second, and invalid declarations produce actionable messages.

### M3: Editing (M)

- Spread list: add, duplicate, delete, reorder; choose the spread definition (with same-id box and parameter mapping and a report of unmapped state).
- Sidebar generated from schemas: document parameters, spread parameters, one group per box and element; hover highlights the box on the canvas.
- Project state as operations with undo/redo; autosave to `project.json`.
- Canvas: scaled spreads, edit-mode placeholders for empty boxes, guides for trim, bleed, and safe area.

Done when: every declared parameter of the starter template is editable, survives save and reopen, and undo/redo covers all edits.

### M4: Photos (M)

- Import from the menu, from Finder drops on the photo strip or a photo box: copy to `photos/`, register in `photos.json`, apply EXIF orientation, convert to sRGB copies and previews in `.imageflow/`.
- Photo strip with usage counts; drag a photo onto a photo box; choose a photo from the sidebar as an alternative.
- Crop editor in the sidebar (pan and zoom on the existing `Placement` model).
- Caption, title, credit, and alt text edited in the photo index.
- Resolution warnings from the format's resolution range and the placed size.
- Missing or renamed photo files reported, not dropped.

### M5: Markdown and flow (M)

- Read `texts/`, map text ids to paths in `project.json`, watch for changes.
- Productionize the flow engine from the spike: columns strategy, orphans, widow lookahead, keep-with-next, overflow guard, list continuation, continuation classes; platform CSS for Markdown boxes.
- Drop `.md` files from Finder onto Markdown boxes (copy into `texts/` if needed); choose a text from the sidebar.
- Flow order across spreads; sidebar shows each box's flow position and reports unplaced text.
- Reflow triggers: text change, parameter change, template reload, spread order, font loading.

Done when: the spike's property tests pass against the production engine, and editing a `.md` file reflows the open book.

### M6: Export (M)

- Export the whole book: render all spreads at full resolution with originals, wait for fonts and images, `printToPDF`.
- Delivery per format: single pages (render each spread once and present its left and right halves as separate pages with bleed on the outside edge) or spreads.
- Post-processing: exact page boxes; checks for page count rule, Type 3 or unbundled fonts, transparency against the format's policy, photo resolution, file size. Errors block the export with a list of affected spreads.
- Raster delivery (`capturePage` at 300 dpi) and transparency flattening are not needed for the WhiteWall starter format and stay out of v1; export fails with a clear message if a template's format requires them.
- Progress and cancel for long exports.

Done when: the starter project exports a PDF that passes the format checks, and a real book of about 50 spreads with real photos exports in an acceptable time.

### M7: Hardening and release (S–M)

- Performance with 100 spreads and several hundred photos (render only visible spreads in the editor, cached previews).
- Error handling for unreadable files, template exceptions, and interrupted exports.
- Packaging and signing for local use; app icon; About panel.
- Real-photo export test and a printed proof with the starter format.

## Testing

- **Unit tests**: schema validation, parameter defaults and constraints, definition switching and mapping, project file reading and writing, photo index operations, crop math.
- **Flow tests**: the spike's property tests (random box chains, coverage, clipping, numbering, orphans and widows) run against the production engine in Electron via Playwright.
- **Export tests**: export a fixture project and check page sizes and boxes, embedded fonts, image passthrough and colour profiles, and transparency with the ported PDF checks; compare rasterized pages against approved baselines.
- **End-to-end smoke test**: Playwright for Electron opens a fixture project, drops a photo and a text, edits a parameter, and exports.
- Run the export and flow tests on every Electron upgrade.

## Decisions to settle at the start of a milestone

| When | Decision | Proposal |
| --- | --- | --- |
| M1 | Format of the starter template | **Decided:** WhiteWall Gallery Square 29 × 29 cm on photo paper (layflat): PDF delivery, sRGB, transparency allowed, so no raster or flattening path is needed in v1. |
| M1 | How template bundles access `react` and `imageflow` | Host exposes them as globals that esbuild maps the externals to; no import maps. |
| M1 | Schema validation for `project.json` and template declarations | A small runtime validator (for example Valibot or Zod) shared by main and renderer. |
| M2 | `p.*` helpers: plain objects or schema-library backed | Plain objects with TypeScript inference; validation implemented in the platform. |
| M2 | Page numbers and running heads | Expose page numbers in the render context; no page-level components in v1. |
| M2 | Sample content in the starter project | Sample photos and texts copied alongside the template on "New project". |
| M3 | Undo/redo scope | All project edits in the session; not file imports or external file changes. |
| M4 | Crop model | Keep `centerX`/`centerY`/`zoom` from the prototype. |

## Out of scope for v1

Covers; clicking to select and on-canvas crop; multi-column text boxes; several print formats per template; images, tables, and footnotes in Markdown; mixed photo/text boxes; sandboxed third-party templates; Windows and Linux.
