# v1 decisions

Status: agreed, 2026-11-09. These decisions narrow [content-template-contract.md](content-template-contract.md) for the first version. Where they conflict with open questions in the contract, this document wins for v1. The template API is specified in [template-api.md](template-api.md).

## Rendering

HTML/CSS templates, exported by Chromium. See [decisions/0001-rendering.md](decisions/0001-rendering.md).

## Application

- **Electron app for macOS**, building on the draft in [wirhabenzeit/imageflow#4](https://github.com/wirhabenzeit/imageflow/pull/4): sandboxed renderer, `imageflow://` protocol with a content security policy, native menus, save dialogs.
- **Export inside Electron.** `webContents.printToPDF` in a hidden window replaces the Swift renderer and the layout upload in #4; `capturePage` produces raster spreads where a format requires JPEG delivery. Post-processing runs in the main process: pdf-lib for page boxes, a native image library (for example sharp) for sRGB conversion, Ghostscript only if a format requires flattening.
- **Validated in Electron** (PR #5): Electron 45.2.3 bundles Chromium 156, the same version the spikes used. PDFs and flowed layouts from `printToPDF` are pixel-identical to the Chrome results, and an offscreen window with a zoom factor of 300/96 captures raster spreads at the exact required pixel size.

## Project folder

```
MyBook/
  project.json     spreads in order, assignments, crops, parameter values
  photos.json      photo index: stable id → photos/<file>, caption, title, credit, alt text
  photos/          original photo files, copied in on import
  texts/           Markdown files, edited in any editor
  template/        the template's code: TSX, CSS, fonts, assets
  .imageflow/      disposable cache: previews, thumbnails, sRGB copies, bundled template
```

- Photos and texts have stable identifiers. `photos.json` maps photo ids to paths; `project.json` maps text ids to paths. Renaming a file outside the app only requires fixing that mapping; missing files are reported, not dropped.
- The app watches the folder. A changed `.md` file reflows its text; a changed template file rebuilds the template and re-renders.
- Everything except `.imageflow/` is authoritative and human-readable, so a project folder can be versioned with git.

## Templates

- **Templates are code**, written in a code editor, not designed in the app. A new project receives a copy of the bundled starter template (a minimal template in the style of the Senja prototype with a few example spreads) in `template/`; the project then owns its copy, which also pins its version.
- The app bundles `template/` on load (esbuild) and reloads on change.
- **Trust:** opening a project executes its template code. v1 assumes you only open projects you trust; there is no sandbox for template code beyond the renderer's.
- Rendering and Markdown CSS are the template's job, within the platform-owned rules in [template-api.md](template-api.md).
- **Styling:** inline React `style` objects for layout and parameter-driven values, plus one plain CSS file per template for `@font-face`, Markdown typography, and shared rules (native CSS nesting is available). No Tailwind or CSS-in-JS library in v1; because the platform checks styles on the rendered result, another authoring approach can be added later without changing the contract.
- **One print format per template** (trim, bleed, safe area, delivery unit, output constraints), declared in the template. A book for another printer or size uses another template (typically a copy with a different format). Several formats per template are a possible later extension; the declaration keeps the same shape so that extension only adds to it.

## Editing

- **Canvas is a print preview plus drop target.** No clicking to select and no on-canvas text editing or crop dragging in v1.
- **Drag and drop:** photos from the photo strip or Finder onto photo boxes; `.md` files from Finder onto Markdown boxes. The platform finds the box under the pointer, checks the content type against the box type, and records the assignment. Files from Finder are copied into `photos/` or `texts/` and registered. Dropping the same Markdown file onto another box continues the text there.
- **Sidebar** shows document parameters, then for the selected spread its own parameters and one group per declared box and generated element: photo assignment and crop, caption (edited in the photo index), box parameters, Markdown assignment and flow position, element parameters. Hovering a group highlights its box on the canvas. Choosing a photo or file from a list is available as an alternative to dragging.
- **Text parameters** such as titles are edited in the sidebar.
- **Markdown is read-only in the app**; it is edited in the `.md` files.

## Markdown

- CommonMark subset: paragraphs, headings, emphasis, strong, links, lists, block quotes. No GFM extensions, tables, images, footnotes, or raw HTML.
- No typographic transformation: the file's characters are printed as written.
- Hyphenation is off by default; a template may enable `hyphens: auto` in its CSS. Preview and export run in the same Electron on the same machine, so results are consistent. Soft hyphens (`&shy;`) in Markdown always work. Revisit if the app runs on Windows or Linux, where Electron does not ship Chrome's hyphenation dictionaries.

## Scope

- **No covers** in v1; covers are made in the printer's own tools.
- **Parameter types:** boolean, integer, number, string (single- and multi-line), enum, colour, date. No objects, no inheritance between scopes.
- **Template switching:** boxes and parameters with the same identifier and type map automatically; everything else is kept in `project.json` and reported, not migrated.
- **Deferred:** clicking to select, on-canvas crop, multi-column text boxes, several print formats per template, shared printer-format registry, images and tables in Markdown, mixed photo/text boxes, sandboxed third-party templates.

## Readiness

- [template-api.md](template-api.md) is accepted as the v1 baseline.
- A Chromium-generated spike PDF passed a print service's upload check (manual test, 2026-11-09).
- Before the first real order: real photographs through the export and a printed proof.
- Implementation is planned in [v1-implementation-plan.md](v1-implementation-plan.md).
