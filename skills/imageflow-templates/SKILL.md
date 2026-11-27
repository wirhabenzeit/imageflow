---
name: imageflow-templates
description: Build, edit and check ImageFlow photo book templates (template/index.tsx, layouts, parameters, editors, print formats) and the books made from them. Use when a task touches an ImageFlow book or template, or the ImageFlow MCP tools.
---

# ImageFlow templates

An ImageFlow book is a folder with `project.json`, `photos.json`, `texts/` and a `template/` folder. The template is TypeScript and React: `template/index.tsx` default-exports `defineTemplate({...})` with print formats, document parameters and layouts ("spreads"), each with a pure `render(ctx)`. The ImageFlow app renders the whole book, flows text across spreads and owns saving and Undo.

Books created by ImageFlow carry a copy of this skill in `.claude/skills/imageflow-templates/`, from the app version that created them. This skill is the template API reference, split into topics under `references/`, plus complete example templates under `examples/`. The ImageFlow MCP server serves the same files: `get_authoring_context` lists them as `topics` and `examples`, and returns them with `docs: [...]` and `includeExamples: [...]`.

## Workflow

1. **Find the book.** With the ImageFlow MCP server, call `list_projects`, then `get_authoring_context` for the parsed declarations and `inspect_book` for saved spreads and sources. Without it, read `template/index.tsx` and `project.json` directly.
2. **Read only the topics you need** from the table below. Start a new template or layout from the closest example in `examples/` rather than from scratch.
3. **Edit template files** (`template/*.tsx`, `styles.css`, assets) with your file tools. Never edit `project.json` or `photos.json` while the book is open in ImageFlow; use `apply_project_changes` instead. To keep a history of template and text changes, use a Git repository at the book root; ImageFlow ignores `.git`.
4. **Verify with `check_book`** after every edit: request a spread `preview` to see the result, `typescript: true` for type errors, `draft.operations` to preview a new layout before saving it, and `fixtures` to stress-test layouts with long, empty and malformed content. Fix every error diagnostic before you finish. A `page-sequence` warning (a page count or book end the format does not take yet) is a to-do before export, not a reason to hold back a save; a `layout-format-mismatch` error (a layout of the wrong kind or side for the format) is fixed by switching the layout.
5. **Save supported project data** (spread layouts, parameter values, photo assignments) with one `apply_project_changes` batch, passing the revision from the last check as `expectedRevision`. Address split-sheet content with `page: 'left' | 'right'`; use `insert_page_pair` for independent facing pages and `switch_layout` with `page` for page layout changes. Omit page for unsplit units and whole-sheet operations.

Without the MCP server, type-check with the template's generated `.imageflow-sdk/tsconfig.json` (`npx tsc -p template`) and open the book in ImageFlow to see it; see [compatibility](references/compatibility.md).

[authoring-workflow](references/authoring-workflow.md) describes the MCP tools, revisions, drafts and fixtures in detail.
[project-commands](references/project-commands.md) gives JSON examples for every operation and preview target.

## Rules that matter most

- `render(ctx)` is a pure function of its input: no state, effects, timers, randomness or fetching. Asynchronous drawing goes through `<RenderedImage>`.
- A spread layout renders inside `<Spread>`; a `page()` layout renders inside `<Page>` in page-local coordinates. Position with millimetres: `geometry` rectangles and the `rect` prop, or `geometry.css(rect)`.
- IDs are identity: a box, element or parameter ID means the same thing in every layout, so content carries over when a spread switches layout. Rename an ID only with intent.
- Choose the smallest editing level that does what was asked: a parameter with generated controls before arranged controls, and those before a custom editor.
- Give a parameter a `description` when its meaning, unit or direction is not obvious from its label.
- `react` and `imageflow` come from the host. Other npm packages go through the saved dependency bundle.

## Feature map

| To do this | Use | Reference |
| --- | --- | --- |
| Lay out the template folder, find an example to start from | `template/index.tsx`, `styles.css`, `examples/` | [package](references/package.md) |
| Declare the template, its layouts and parameter scopes | `defineTemplate`, `spread()`, `page()`, `spreadFor` | [declaration](references/declaration.md) |
| Compose independent facing pages | `page()`, `<Page>`, `ctx.side`, page-local geometry | [page-layouts](references/page-layouts.md) |
| Add a setting: text, number, choice, colour, date, switch | `p.string`, `p.number`, `p.enum`, `p.color`, `p.date`, `p.boolean` | [parameters](references/parameters.md) |
| Let the user add a variable number of items | `p.list` | [list-parameters](references/list-parameters.md) |
| Hold photos and Markdown text, flow text across spreads | `boxes`, `type: 'photo' \| 'markdown'`, `flowOrder` | [boxes-and-elements](references/boxes-and-elements.md) |
| Set trim, bleed and safe area; offer several sizes; single pages | `printFormat`, `formats`, `span`, `facingPages` | [print-formats](references/print-formats.md) |
| Choose the spreads of a new book and the library preview | `openingSpreads`, `preview` | [template-library](references/template-library.md) |
| Make layouts interchangeable without losing content | shared IDs, `switch_layout` | [switching-layouts](references/switching-layouts.md) |
| Offer variants of one design (2×2 or 3×3 grid) | `layoutFamilies`, `family`, `variant` | [layout-families](references/layout-families.md) |
| Use an npm package such as a map library | `template/package.json`, dependency bundle | [dependencies](references/dependencies.md) |
| Read parameters, boxes and photo capture data while rendering | `render(ctx)`, `ctx.params`, `ctx.boxes`, `ctx.view` | [render-function](references/render-function.md) |
| Draw something asynchronously, such as a WebGL map | `<RenderedImage draw>` | [rendered-images](references/rendered-images.md) |
| Draw printable basemaps and SVG overlays | `maplibre-svg`, `drawMapSvg`, `projector` | [svg-maps](references/svg-maps.md) |
| Open a parameter popover by clicking rendered text | `ctx.edit(...paths)` | [click-to-edit](references/click-to-edit.md) |
| Build a table of contents or refer to another spread | `anchors`, `ctx.book` | [anchors-and-index](references/anchors-and-index.md) |
| Arrange, group or hide generated controls | `controls`, `when` | [editing-ui](references/editing-ui.md) |
| Write a custom editor for an element (calendar days, map pan) | `editor: { component }`, `ElementEditorProps` | [element-editors](references/element-editors.md) |
| Write a custom editor for book-wide values | template-level `editors`, `DocumentEditorProps` | [document-editors](references/document-editors.md) |
| Show an editor on the page instead of the panel | `presentation: 'inline'` | [editing-on-the-page](references/editing-on-the-page.md) |
| Use a file the user adds, such as a GPX track | `p.file`, `file()` | [file-parameters](references/file-parameters.md) |
| Report a problem with the template's own input | `issue()` | [template-findings](references/template-findings.md) |
| Compute page, safe-area and grid rectangles | `geometry.page`, `geometry.grid`, `geometry.design` | [geometry](references/geometry.md) |
| Render photos, Markdown, elements and editable text | `PhotoBox`, `MarkdownBox`, `Element`, `ctx.Text`, `ctx.Caption` | [platform-components](references/platform-components.md) |
| Style with CSS, fonts and Markdown typography; set the book's language for hyphenation | `styles.css`, geometry CSS variables, `language`, `lang`, `hyphens` | [css-contract](references/css-contract.md) |
| Know what fails validation | load and render checks | [validation](references/validation.md) |
| Understand saved spread data | `project.json` spreads, boxes, crops | [stored-data](references/stored-data.md) |
| Type-check, split layouts into files, preview limits | `.imageflow-sdk`, `tsconfig.json` | [compatibility](references/compatibility.md) |
| Edit a plain string or a photo caption on the page | `<ctx.Text presentation="inline">`, `<ctx.Caption box>` | [inline-text](references/inline-text.md) |
| Allow bold and italic inside a string | `markdown: 'inline'`, `FormattedText` | [formatted-text](references/formatted-text.md) |

## Examples

| Example | Shows |
| --- | --- |
| [minimal](examples/minimal.tsx) | Quickstart: one layout with a full-bleed photo, an editable heading, a book setting and a page number. Start here. |
| [photo-story](examples/photo-story.tsx) | Photo and story with text continuation, chapter anchors, a contents layout and photo credits from the book index. |
| [grid-bleed](examples/grid-bleed.tsx) | A photo grid inside the safe area and a full-bleed panorama with a caption. |
| [responsive](examples/responsive.tsx) | One layout that arranges photo and text by the shape of the chosen format. |
| [photo-frames](examples/photo-frames.tsx) | Photo boxes drawn by render callbacks: SVG shapes that mask the photo. |
| [layout-family](examples/layout-family.tsx) | A photo grid in 2×2 and 3×3 as a layout family, chosen with a picker. |
| [list-parameter](examples/list-parameter.tsx) | A timeline of up to eight stops as a list parameter. |
| [file-input](examples/file-input.tsx) | An optional CSV file drawn as a chart, with a structured finding for bad files. |
| [generated-element](examples/generated-element.tsx) | A trip summary drawn from element parameters, edited by clicking it. |
| [editing-levels](examples/editing-levels.tsx) | Generated controls, arranged controls with a condition, and a custom editor. |
| [inline-editor](examples/inline-editor.tsx) | An editor on the page: a focus ring dragged into place over a full-bleed photo. |

The first line of each example file describes it.
