# Template API (contract 1)

Status: implemented reference for the v1 runtime. The executable schemas in `src/template.tsx`, `src/parameters.ts`, `src/format.ts`, and `src/project.ts` govern validation. The authoring declarations are in `authoring/imageflow.d.ts`; the complete working example is `sample/starter/template/index.tsx`. Historical proposals are not alternative supported APIs.

This page is generated from the topic files in [`template-api/`](template-api), which the ImageFlow MCP server (`get_authoring_context` with `docs`) and the [agent skill](../skills/imageflow-templates/SKILL.md) serve one at a time. Edit those files and run `npm run generate:docs`.

## Topics

- [Authoring workflow](#authoring-workflow): MCP tools, revisions and drafts.
- [Project commands and preview targets](#project-commands-and-preview-targets): Batch edits, parameter scopes and previews.
- [Package](#package): Imports, examples and contract-1 features.
- [Declaration](#declaration): defineTemplate and layout builders.
- [Page layouts](#page-layouts): Page roots, geometry and facing pages.
- [Parameters](#parameters): p.* types, options and defaults.
- [List parameters](#list-parameters): List items, IDs and edit commands.
- [Boxes and elements](#boxes-and-elements): Photo boxes, Markdown flow, text.meta and composing a text.
- [Print format](#print-format): Trim, bleed, safe areas and pagination.
- [Template library](#template-library): Import, previews and openingSpreads.
- [Switching layouts](#switching-layouts): Content, crops and saved layout state.
- [Layout families](#layout-families): Variant tags, and family pickers: a built-in choice or a component.
- [Dependencies](#dependencies): npm bundles, licences and allowed sites.
- [Render function](#render-function): render(ctx), caching and photo metadata.
- [Rendered images](#rendered-images): Async artwork for previews and export.
- [SVG maps](#svg-maps): Vector tiles, projection and attribution.
- [Click-to-edit](#click-to-edit): Open parameter controls with ctx.edit().
- [Anchors](#anchors): Cross-references, pages and credits.
- [Editing UI](#editing-ui): Generated controls and custom editors.
- [Element editors](#element-editors): React controls and parameter scopes.
- [Document editors](#document-editors): Book-wide parameter editors.
- [Editing on the page](#editing-on-the-page): Inline editor placement and styling.
- [File parameters](#file-parameters): p.file, file() and imported assets.
- [Template findings](#template-findings): Report input problems with issue().
- [Geometry helpers](#geometry-helpers): Insets, grids and design coordinates.
- [Platform components](#platform-components): Spread, boxes, Element and Text.
- [CSS contract](#css-contract): Fonts, CSS variables and print styling.
- [Validation](#validation): Template load and render checks.
- [Stored project data](#stored-project-data): Saved layouts, crops and parameters.
- [Authoring and compatibility details](#authoring-and-compatibility-details): SDK types, enum maps and preview limits.
- [Inline plain text (`inline-text`)](#inline-plain-text-inline-text): Edit strings on the page with ctx.Text.
- [Formatted text (`formatted-text`)](#formatted-text-formatted-text): Inline Markdown and FormattedText.

## Authoring workflow

How an agent edits an ImageFlow book through the MCP server. The template API topics describe what a template can declare; this topic describes the order of work and which tool does what.

### Orientation

1. Call `list_projects` to get the handle and input revision of the open, authorized book.
2. Call `get_authoring_context`. It returns the parsed template declarations (`template`), saved and current template identity, the files under `template/`, a table of contents of the API reference (`topics`) and the shipped examples (`examples`). Ask for the topics you need with `docs: ['list-parameters', …]`, for example sources with `includeExamples: ['minimal']`, and for template or Markdown files with `includeSource`. Those calls return just what they ask for, without the declarations again; one for topics or examples alone has no `revision` either.
3. Call `inspect_book` for the saved spreads, sources and parameter values. The `elements` view measures boxes and elements of one spread after whole-book text flow.

### Editing

- Edit `template/` TSX, CSS and assets directly with your workspace tools.
- Edit registered Markdown at its source location; linked Markdown stays outside the package.
- Use `apply_project_changes` for sheet/page changes in `project.json` and metadata changes in `photos.json`. See [Project commands and preview targets](#project-commands-and-preview-targets) for examples. Address split-page content with `page: 'left' | 'right'` beside `spread`; unaddressed content commands return `SPREAD_SHOWN_AS_PAGES`.
- While an editor is active, dry runs and draft checks still validate against saved inputs. Saves that change only other spreads go through; a blocked save (one touching the editor's spread or page, or anything book-wide) reports `EDIT_IN_PROGRESS` with the active editor when available. `inspect_book` with `view: "summary"` also shows it.
- Copy new content into `inbox/` and call `import_sources`. Then assign the returned IDs with a command batch.
- Parameter commands use saved scopes: `document`, `spread`, `box` or `element`. An element editor can also own spread parameters; use `scope: 'spread'` for those fields, not `scope: 'element'`.
- Mark a single user-written string the page prints with `<ctx.Text presentation="inline">`, so it is typed where it prints ([inline-text](#inline-plain-text-inline-text)). Small text at whole-spread zoom opens the panel instead.
- To find the parameter a request means, read each parameter's description with its unit, range and options. Give new parameters a description when their meaning or direction is not obvious from the label.
- To start or extend a template, read the [package](#package) topic's example table, fetch the closest example with `includeExamples` and copy its layout.
- For an empty book, inspect `template.openingSpreads` and insert suitable layouts with `insert_spread` or facing page pairs with `insert_page_pair`. `openingSpreads` describes new-book defaults and is not applied again automatically.
- Use a layout family when layouts are variants of one design (`template.layoutFamilies`; `family` and `variant` on each layout). Give a family a `choice` picker, which the app draws, unless it needs a component for more than one tag; pickers choose by variant tags, not hard-coded IDs. Switch variants with `switch_layout` and the layout ID of the variant ([Layout families](#layout-families)).

### Verifying

- Call `check_book` with a spread preview after every edit. Images include whole-book text flow. Layout errors carry the spread and template source line; text that runs out of its box or overlaps other text is reported per block.
- Set `typescript: true` to type-check template sources against the installed runtime. Type errors do not suppress usable images.
- Preview a new or unused layout before saving it: call `check_book` with `draft.operations` (an `insert_spread` with a `ref`) and target the preview at its `$ref`. Then apply the same operations with `apply_project_changes` to save them.
- Use `preview.target.spreads` for a contact sheet of up to 12 spreads, and `box` or `element` targets for close-ups. `guides` and `labels` add trim, safe-area and box outlines.
- Stress-test layouts with `check_book` `fixtures`: synthetic typical, long, empty, portrait-photo, valid-GPX and malformed-file content per format, with a coverage matrix and a bannered fixture contact sheet that is never the saved book. Coverage names the checks that did not run.

### Revisions

Every result carries the input `revision`. Pass it as `expectedRevision` to commands, page-number previews and drafts. A `REVISION_CONFLICT` means the book changed: inspect or check again before editing. Template files are inputs too, so editing `template/` also changes the revision: after a template edit, take the new `revision` from `check_book` before the next `apply_project_changes`, or it is rejected once. When the user saves the book in ImageFlow during a check, or photos change in Lightroom, the result stands for the `revision` it names, and `superseded.revision` is the one to edit next; `get_authoring_context` and `inspect_book` then return the book as it is now, with `checkedRevision` for the diagnostics of the one before. When template files, texts or photo files change, the call is repeated for you until the book is quiet; a `SOURCE_CHANGED` error means it kept changing, and names what changed. A dry run or draft against a revision that has since changed is planned at the current one and says so in `revisionMoved` and `notice`; a commit always needs the exact revision. Commands need a unique `idempotencyKey`, so a retry of the same request after a lost reply returns the original result instead of applying the batch twice, also after ImageFlow restarts. After reopening a book, `list_book_checkpoints` with the key confirms whether a batch was committed and lists what changed since.

## Project commands and preview targets

Pass these operations to `apply_project_changes` with `project`, `expectedRevision`, a unique `idempotencyKey`, and an Undo `label`. The same operations work in `check_book.draft.operations` with `project` and `expectedRevision`. A batch holds 1–100 operations in execution order. Use `dryRun: true` to validate without saving.

Use layout, format and parameter IDs from `get_authoring_context`; use spread and source IDs from `inspect_book`. A command that creates a spread can name it with `"ref":"chapter"`. Later commands and draft preview targets refer to it with the string `"$chapter"`. Use an earlier spread ID or reference in `after`, or use `null` to insert at the start. With no `after`, inserts append and duplicates follow the original.

### Exterior covers

Pass `cover: true` where a layout, box, or element operation would otherwise name a spread. Use `scope: "cover"` for whole-cover parameters. Run these operations as a batch or check them as a draft.

```json
[
  { "op": "switch_layout", "cover": true, "definition": "wrapPhoto" },
  { "op": "set_parameter", "scope": "cover", "key": "title", "value": "Along the coast" },
  { "op": "assign_source", "cover": true, "box": "hero", "kind": "photo", "source": "registered-photo-id" }
]
```

### Layout and book operations

| Operation | Example |
| --- | --- |
| Set the title | `{"op":"set_title","title":"Kyrgyzstan"}` |
| Choose a print format | `{"op":"select_format","format":"portrait"}` |
| Insert a spread | `{"op":"insert_spread","definition":"story","after":"arrival","ref":"chapter","params":{"heading":"Chapter One"}}` |
| Insert two independent facing pages | `{"op":"insert_page_pair","after":"$chapter","ref":"pair","pages":{"left":{"definition":"story"},"right":{"definition":"photo"}}}` |
| Clear one page of a split sheet, keeping its saved content | `{"op":"clear_page","spread":"$pair","page":"left"}` |
| Exchange the two pages of a split sheet | `{"op":"swap_pages","spread":"$pair"}` |
| Duplicate a spread | `{"op":"duplicate_spread","spread":"$chapter","ref":"copy"}` |
| Move a spread | `{"op":"move_spread","spread":"$copy","after":null}` |
| Remove a spread | `{"op":"remove_spread","spread":"$copy"}` |
| Switch a layout or family variant | `{"op":"switch_layout","spread":"$pair","page":"right","definition":"photo-framed"}` |

Spread and page inserts can supply initial `params`, `boxes` and `elements` by ID. In a page pair, omit a side to leave it blank. See [Page layouts](#page-layouts) and [Switching layouts](#switching-layouts) for compatible placements and saved content.

### Parameter and list operations

Use `scope:"document"` with just a `key`, or `scope:"spread"` with a `spread` and `key`. Use `scope:"box"` or `scope:"element"` with the owning box or element ID in `owner`. Add `page:"left"` or `"right"` when addressing a split page. Omit `page` for unsplit units.

| Operation | Example |
| --- | --- |
| Set a parameter | `{"op":"set_parameter","scope":"element","spread":"$pair","page":"left","owner":"map","key":"track","value":"stage-1"}` |
| Remove a saved value, including one whose declaration was removed | `{"op":"reset_parameter","scope":"document","key":"colophon"}` |
| Append a list item | `{"op":"insert_list_item","scope":"document","key":"credits","item":{"id":"guide","name":"Aida"}}` |
| Change fields on a list item | `{"op":"update_list_item","scope":"document","key":"credits","id":"guide","values":{"name":"Aida A."}}` |
| Move a list item to the start | `{"op":"move_list_item","scope":"document","key":"credits","id":"guide","after":null}` |
| Remove a list item | `{"op":"remove_list_item","scope":"document","key":"credits","id":"guide"}` |

See [Parameters](#parameters) and [List parameters](#list-parameters) for value types and list defaults.

### Source, crop and metadata operations

| Operation | Example |
| --- | --- |
| Assign a photo or Markdown source | `{"op":"assign_source","spread":"$pair","page":"right","box":"hero","kind":"photo","source":"photo-1"}` |
| Clear a box | `{"op":"clear_box","spread":"$pair","page":"right","box":"hero"}` |
| Exchange content between boxes | `{"op":"swap_content","from":{"spread":"arrival","box":"hero"},"to":{"spread":"$pair","page":"right","box":"hero"}}` |
| Set a photo crop | `{"op":"set_crop","spread":"arrival","box":"hero","centerX":0.5,"centerY":0.5,"zoom":1.25}` |
| Update or clear photo metadata | `{"op":"set_photo_metadata","photo":"photo-1","values":{"caption":"First morning","credit":null}}` |

### Preview targets

Put one of these objects in `check_book.preview.target`. Page-number targets and draft previews require `expectedRevision`.

| Target | Example |
| --- | --- |
| Whole spread | `{"spread":"arrival"}` |
| One side of a spread | `{"spread":"arrival","side":"left"}` |
| Page by its positive book page number | `{"page":3}` |
| Box close-up, optionally on a split page | `{"spread":"$pair","page":"right","box":"hero"}` |
| Element close-up, optionally on a split page | `{"spread":"$pair","page":"left","element":"map"}` |
| Contact sheet of up to 12 spreads | `{"spreads":["arrival","$pair"],"columns":2}` |

Use `side:"page"` for a format without facing pages. Close-ups and `inspect_book` element requests use `page:"left"` or `"right"` to locate a box or element on a split sheet. Contact sheets need a `preview.maxEdge` of at least 128 pixels.

## Package

A template is the `template/` folder of a project:

```
template/
  index.tsx        default export: defineTemplate({...})
  styles.css       imported from index.tsx: @font-face rules, Markdown typography, shared rules
  fonts/           static font files (WOFF2, TTF, OTF)
  assets/          optional SVG or raster artwork used by the design
  spreads/         optional: one file per spread definition
```

The app bundles `index.tsx` with esbuild. `react` and `imageflow` are provided by the host and must not be bundled. Relative imports, CSS imports, and asset imports inside `template/` are allowed. Other packages come from npm through the template's saved dependency bundle ([Dependencies](#dependencies)). Templates must render deterministically without fetching data, timers, state, or effects. This is an authoring requirement, not a guarantee that arbitrary template JavaScript is safe; open only projects you trust.

`imageflow` exports `defineTemplate`, `spreadFor`, `p`, `mm`, `pt`, `inch`, `printFormat`, `Spread`, `Page`, `PhotoBox`, `MarkdownBox`, `Element`, `asset`, `file`, `geometry`, `box`, `issue`, `capabilities`, `RenderedImage`, `FormattedText`, `plainText`, `Choice` and `fonts`. A build fails with a hint to update ImageFlow when a template uses an export the installed app does not have.

### Examples

[`docs/examples`](examples) holds complete templates that compile against the installed declarations:

| Example | Shows |
| --- | --- |
| `minimal.tsx` | **Quickstart.** One layout with a full-bleed photo, an editable heading, a book setting and a page number. |
| `photo-story.tsx` | Photo and story, text continuation across layouts, chapter anchors and a contents layout. |
| `grid-bleed.tsx` | A photo grid inside the safe area and a full-bleed panorama with a caption. |
| `generated-element.tsx` | Generated SVG content from element parameters, edited by clicking it. |
| `file-input.tsx` | An optional CSV file input, parsed by the template, with a structured finding for bad lines. |
| `editing-levels.tsx` | Editing UI at three levels: generated controls, arranged `controls` with a condition, and a custom editor using `Control`. |
| `responsive.tsx` | Two formats and one layout that arranges itself by the shape of the chosen format. |
| `layout-family.tsx` | A layout family of three variants (grid size × text box, one combination missing) with a picker of two independent choices. |
| `inline-editor.tsx` | An element editor on the page (`presentation: 'inline'`): a focus ring dragged into place where it prints. |
| `list-parameter.tsx` | A list parameter: timeline stops the user adds, reorders and removes, each with a place, a date and a colour. |

Agents receive them with `get_authoring_context` and `includeExamples`. To start a template, copy `minimal.tsx` (or the closest example) and add layouts. To extend one, copy a single layout and its declarations. The starter template is the complete reference book, not a required starting point.

The examples use the generic `serif` and `sans-serif` font families, so they preview anywhere but **PDF export reports them as errors and asks for confirmation**: PDF preflight expects fonts bundled inside `template/` and loaded with `@font-face` from CSS the template imports. Before printing, add font files to `template/fonts/`, import a stylesheet that declares them, and use those families. The starter template shows the pattern ([Fonts and output](#fonts-and-output)).

### Requirements and compatibility

Every supported contract-1 runtime provides the complete baseline below, including document editors, network declarations, rendered images and editing on the page. A template selects it with `contract: 1`; no `requires` list is needed:

```ts
defineTemplate({ id: 'travel', version: '2.0.0', contract: 1, … })
```

| Baseline feature | Provides |
| --- | --- |
| `anchors` | `anchors` declarations and `ctx.book`. |
| `geometry` | The `geometry` helpers. |
| `box-helpers` | `box.photo` and `box.markdown`. |
| `template-issues` | `issue()` structured findings. |
| `typed-components` | `ctx.PhotoBox`, `ctx.MarkdownBox` and `ctx.Element`. |
| `spread-builder` | `spreads` as a function, `spreads: ({ spread }) => ({ … })`. |
| `bound-geometry` | `ctx.geometry` and the `rect` prop of platform components. |
| `text-component` | `ctx.Text`. |
| `format-helper` | `printFormat`. |
| `box-records` | `box.photos`. |
| `editor-controls` | `controls` on spreads, boxes and elements. |
| `editor-native-controls` | `Control` and `importFile` in element editors, and the element's other parameters in the editor dialog. |
| `layout-families` | `layoutFamilies`, `family` and `variant` on layouts, and a family's picker: a built-in choice or a component. |
| `editor-spread-parameters` | `spread` on an element editor: layout parameters edited together with the element's, with `setSpread` and `<Control scope="spread">`. |
| `opening-spreads` | `openingSpreads`, the spreads a new book starts with. |
| `page-layouts` | `page()` declarations, `<Page>`, page-local geometry, side-aware contexts and independent facing pages ([Page layouts](#page-layouts)). |
| `single-pages` | Formats without facing pages (`facingPages: false`) and `span: 'page'` layouts. |
| `editor-context` | `context` in element and document editors: the spread they were opened from, as `render` sees it, kept current. |
| `document-editors` | `editors`: editors of document parameters, opened from nodes marked with them. |
| `editor-network` | Declared HTTPS origins for editors and rendering, subject to user approval. |
| `rendered-images` | `<RenderedImage>` for host-managed asynchronous pictures in preview, check and export. |
| `rendered-vectors` | SVG pictures from `<RenderedImage>` (markup, an `<svg>` element or an `image/svg+xml` Blob) placed in the page as vectors with the template's fonts, and `output="vector" \| "raster"` ([Rendered images](#rendered-images)). |
| `book-credits` | `credits` on layouts and `ctx.book.credits`: what the book uses that needs a credit, collected for a credits page ([Credits](#credits)). |
| `font-coverage` | `fonts`: the bundled faces and the characters they can set, for text the template draws itself ([Fonts and output](#fonts-and-output)). |
| `inline-editors` | `presentation: 'inline'` on element and document editors: editing on the page, in the frame of what the editor was opened from ([Editing on the page](#editing-on-the-page)). |
| `inline-text` | `ctx.Text presentation="inline"` for plain-string typing in template typography, with existing parameter scopes and Undo. |
| `list-parameters` | `p.list` of flat items with stable IDs, the generated list control, `Control` for one item's field, and item-level project commands ([List parameters](#list-parameters)). |
| `template-preview` | `preview`: the template's own image for New Book instead of a render of its opening spread ([Template previews](#template-previews)). |
| `photo-render` | `PhotoBox` children: a render callback that draws the box's photo from its crop, such as through an SVG mask ([PhotoBox render callbacks](#photobox-render-callbacks)). |
| `formatted-text` | `markdown: 'inline'` on string parameters: bold, italic and strikethrough, shown by `ctx.Text` and `<FormattedText>` ([Formatted text](#formatted-text-formatted-text)). |
| `app-controls` | `<Choice>`: ImageFlow's own segmented choice for element editors and layout-family pickers ([App controls](#app-controls)). |
| `text-metadata` | `text.meta` on Markdown boxes: the fields of the source's YAML header, the same on every box of the chain ([Text metadata](#text-metadata)); every placed text in `ctx.book.texts` ([Texts](#texts)); and `boxes` in `anchors`. |
| `template-lineage` | `basedOn`: the template a fork was copied from, so a fork can take an ID of its own ([Forks and starter updates](#forks-and-starter-updates)). |
| `text-composition` | `compositions`: named functions that compose a text from its blocks, adding, replacing or wrapping them; a Markdown box names one with `composition` ([Composing a text](#composing-a-text)). |


Use `requires` for extensions beyond the contract-1 baseline. Unsupported extensions are rejected when the template loads, with an update hint. Listing baseline features in `requires` is also valid.

`capabilities` lists all supported features. `get_authoring_context` reports the contract, `baseline`, `capabilities` and module `exports` in `capabilities.templateApi`. The baseline is defined in `src/runtime-exports.ts`.

An app update never rewrites a project's template folder. Renaming an ID, moving a parameter to another scope or changing an ID's type needs an explicit migration in the template and in `project.json`; ImageFlow never reinterprets or deletes saved values on its own.

## Declaration

The following sketch illustrates the scopes; `MonthGrid` and the abbreviated format are placeholders. Use [`minimal.tsx`](examples/minimal.tsx) for a complete, compilable starting point.

```tsx
import { box, defineTemplate, mm, p, printFormat, Spread } from 'imageflow';
import './styles.css';

export default defineTemplate({
  id: 'senja-starter',
  version: '0.1.0',
  // Shown in the template library and the New Book picker.
  label: 'Senja journal',
  description: 'Full-bleed photos with a field-notes text column.',
  // Optional, for a fork: the template it was copied from, at the version copied (see Template library).
  basedOn: { id: 'imageflow-starter', version: '0.13.1' },
  // Optional: what New Book shows for the template. Without it, a render of the first opening spread.
  preview: './preview.jpg',
  contract: 1,

  // One print format, or several named `formats` the user chooses between; see below.
  format: printFormat({
    label: 'Square · 30 × 30 cm',
    trim: { width: mm(294), height: mm(294) },
    /* bleed, safe, pageCount, output … */
  }),

  // Document scope: the template controls, read through ctx.document.
  parameters: {
    showPageNumbers: p.boolean({ label: 'Show page numbers', default: true }),
    accent: p.color({ label: 'Accent colour', default: '#2c5070' }),
  },

  // `spread` types each layout's render context from its own declarations and the document parameters above.
  spreads: ({ spread }) => ({
    story: spread({
      label: 'Photo and story',
      parameters: {
        heading: p.string({ label: 'Heading', multiline: true, default: '' }),
        eyebrow: p.string({ label: 'Chapter label', default: '' }),
      },
      boxes: {
        hero: box.photo('Main photograph', { showCaption: p.boolean({ label: 'Show caption', default: true }) }),
        body: box.markdown('Story', { flowOrder: 1 }),
      },
      render: (ctx) => (
        <Spread className="story">
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />
          {ctx.boxes.hero.params.showCaption && ctx.boxes.hero.photo?.caption && (
            <p className="caption">{ctx.boxes.hero.photo.caption}</p>
          )}
          <ctx.Text parameter="eyebrow" className="eyebrow" />
          <ctx.Text parameter="heading" as="h1" className="heading" style={{ color: ctx.document.accent }} />
          <ctx.MarkdownBox id="body" className="body editorial" />
        </Spread>
      ),
    }),

    calendar: spread({
      label: 'Calendar month',
      parameters: {
        year: p.integer({ label: 'Year', default: 2027 }),
        month: p.integer({ label: 'Month', min: 1, max: 12, default: 1 }),
      },
      boxes: { photo: box.photo('Photo of the month') },
      elements: { grid: { label: 'Calendar grid', parameters: { firstWeekday: p.enum({ label: 'Week starts', options: ['monday', 'sunday'], default: 'monday' }) } } },
      render: (ctx) => (
        <Spread className="calendar">
          <ctx.PhotoBox id="photo" className="left-page bleed" />
          <ctx.Element id="grid" className="grid">
            <MonthGrid year={ctx.params.year} month={ctx.params.month} firstWeekday={ctx.elements.grid.params.firstWeekday} />
          </ctx.Element>
        </Spread>
      ),
    }),
  }),
});
```

### Declaring layouts

Declare `spreads` as a function of `{ spread, page }`. Use `spread()` for a full spread and `page()` for a reusable single page; see [Page layouts](#page-layouts). Its `spread` builder types each layout's `ctx.params`, `ctx.boxes`, `ctx.elements` and edit paths from the layout's own declarations, and `ctx.document` from the template's `parameters`, so the document settings are declared once. `defineTemplate` calls the function and validates the resulting record; the builder itself only exists for TypeScript and returns the declaration (`page()` also sets `span: 'page'`).

`spreads` can also be a plain record. Its spreads are then typed only broadly (`UntypedRenderContext`), unless they come from `spreadFor(documentParameters)`, which returns the same builder for spreads declared outside `defineTemplate`, such as in their own files. Pass it the same object as the template's `parameters`: a spread typed with document parameters the template does not declare, or declares with values the spread could not accept (a number for a string, an enum with more options), fails type checking, whether `spreads` is a record or a function that returns it, and the Book check warns about it (`declaration-document-mismatch`), because `ctx.document` would lack those values at runtime.

The authoring types reject declaration mistakes that used to load silently:

- A template needs exactly one of `format` or `formats`; `defaultFormat` must name one of the `formats`.
- Unknown properties, such as `paramters` for `parameters`, `lable` or `mutliline` in a parameter, or `flowOrdr` in a box, fail type checking, usually with a "did you mean" hint. This covers spreads, their box and element declarations, and parameters (checked against the parameter's `type`), whether they come from the `spread` builder and `p.*`/`box.*` helpers or are written as plain objects. Values TypeScript only sees as a wider type, such as a declaration built by a function returning `BoxDeclaration`, are checked at runtime only.

At runtime, for templates that are not type-checked, an unknown property anywhere in the declaration (template, format, spread, box, element, element editor or parameter) is reported as a `declaration-unknown-property` warning that names the property, its path and the property it probably meant. It is a warning rather than an error so that contract-1 templates that loaded before keep loading. When an unknown property makes the declaration invalid, for example `lable` leaving `label` missing, the declaration error lists it next to the schema error.

### Reusable declarations and typed IDs

Declarations are plain objects, so share them as constants. `box.photo(label, parameters?)` and `box.markdown(label, { flowOrder?, parameters? })` declare boxes without repeating `type`. `box.photos(ids, label, parameters?)` declares several photo boxes with explicit IDs, typed without casts: `boxes: box.photos(['one', 'two', 'three'], (id, i) => 'Photo ' + (i + 1))`. The ID stays where the box is declared, which keeps its saved identity explicit:

```tsx
const caption = p.boolean({ label: 'Show caption', default: false });
const story = box.markdown('Story', { flowOrder: 1 });
spread({ label: 'Story', boxes: { hero: box.photo('Main photo', { caption }), story }, render: (ctx) => … })
```

With the `spread` builder, the render context types every parameter, box and element of its layout. `ctx.PhotoBox`, `ctx.MarkdownBox` and `ctx.Element` are the platform components restricted to that layout's IDs, so `<ctx.PhotoBox id="heor" />` fails type checking. The top-level components accept any ID for extracted helpers. `MarkdownBox` takes `columns` as a number or a numeric string, so an enum value such as `'2'` needs no cast. Runtime validation still checks every rendered box and element, for code that is not type-checked.

## Page layouts

Included in the contract-1 baseline as `page-layouts`; no `requires` entry is needed.

A facing spread can show one spread layout or two independently chosen page layouts. Declare reusable pages with `page()` and render them inside `<Page>`. The same page design can be used on the left, the right, at a book end, or in a format without facing pages.

```tsx
import { box, defineTemplate, mm, p, Page, printFormat } from 'imageflow';

export default defineTemplate({
  id: 'page-book', version: '1', contract: 1,
  format: printFormat({
    label: 'Square', trim: { width: mm(200), height: mm(200) },
    bleed: mm(3), safe: mm(10), ends: 'inside-covers',
    pageCount: { min: 2, max: 100, step: 2 },
  }),
  spreads: ({ page }) => ({
    photo: page({
      label: 'Photo page', boxes: { hero: box.photo('Photo') },
      render: ctx => <Page>
        <ctx.PhotoBox id="hero" rect={ctx.geometry.page('bleed')} />
      </Page>,
    }),
    story: page({
      label: 'Story page', parameters: { heading: p.string({ label: 'Heading', default: '' }) },
      boxes: { body: box.markdown('Story') },
      render: ctx => {
        const at = ctx.geometry.design({ width: 200, height: 200 });
        return <Page>
          <ctx.Text parameter="heading" rect={at.page(15, 15, 170, 25)} />
          <ctx.MarkdownBox id="body" rect={at.page(15, 45, 170, 140)} />
        </Page>;
      },
    }),
  }),
});
```

### Declaring and rendering a page

A page layout's `label` names its tile in the sidebar, which shows about 10 characters at a usual width; see [Layout families](#layout-families) for naming short labels. `page()` sets `span: 'page'` and types the layout's parameters, boxes, elements, edit paths and document parameters like `spread()`. Page and spread layouts share the `spreads` record, so every layout ID must be unique. A page can declare the same parameters, controls, boxes, elements, anchors, credits, family and variant tags as a spread. Optional `sides: ['left']` or `sides: ['right']` restricts a facing page's placement; omit it to allow both sides.

Page coordinates start at that page's left trim edge. `ctx.geometry.page(area?)` returns its trim, safe or bleed rectangle; `ctx.geometry.design(canvas).page(x, y, width, height)` scales a design into those local coordinates. `ctx.geometry.spread()` and requests for the facing page's geometry throw. Use `ctx.side` (`'left'`, `'right'`, or `'page'` without facing pages) to mirror artwork when needed. `<Page>` exposes the same value as `data-side` and supplies the side's outside/binding safe and bleed variables.

`ctx.page` contains only this page's number: `{ left }`, `{ right }`, or `{ number }` without facing pages. A page reads only its own parameters, boxes and elements. The whole-book index remains available through `ctx.book`; anchors and credits declared by a page belong to that page, regardless of a declaration's `side`. Text flow visits the left page first, then the right, using each page's own `flowOrder`. Identical box IDs on the two pages are independent boxes.

### Choosing pages in the editor

Click either half of a sheet to select that side. The Inspector shows **Left page** or **Right page** once a spread is split, with that page's settings and content. Left/right arrows move through pages; thumbnails, reorder, duplicate and delete still operate on whole sheets.

The layout browser shows all designs in one grid: two double-page designs or four single-page designs fit across, with equal gaps. A patterned blank-page tile sits in the same grid. Choosing a page design splits a full spread: the selected side gets the chosen design, and the facing side restores its remembered page or starts blank. With a whole sheet selected, the target is the left page. Dragging a layout onto a half uses the drop position. Page designs keep the same positions when the selected side changes. Designs with a side restriction remain visible but disabled on the other side. A page preview shows one page; assistive descriptions explain content moves and replacements without hover tooltips.

Choosing a spread layout merges the two pages into one layout. **Blank page** clears the selected full-sheet side's layout while keeping its stored content. **Book → Swap Pages** exchanges the complete page states; it is enabled only when each layout permits the opposite side. Each action is one Undo step. See [Switching layouts](#switching-layouts) for content transfer rules.

Opening and closing units in a `single-pages` format use ordinary page layouts that allow the required side, without creating a split sheet. A template with only page designs can start a facing book and add sheets: a full sheet begins with a design on an allowed side and a blank facing page. The platform blank-page choice is currently offered for full-sheet positions.

### Beta testing and automation

The editor supports page selection, page settings and source assignment, cropping, inline text and element editors, layout changes, content recovery, Undo, saving/reopening and PDF export. To test a reusable design, place it on both sides, edit just one page, switch or merge layouts, Undo, save/reopen, and export. Test each allowed side in every offered format; synthetic layout fixtures also render page designs on their allowed sides.

MCP content commands accept `page: 'left' | 'right'` beside the sheet's `spread` ID for split sheets. This applies to parameters (including list items), source assignments, crops, clearing boxes and each endpoint of `swap_content`. `scope: 'spread'` means the selected page's layout parameters when `page` is present. Omit `page` for document parameters, book ends and non-facing units. Unaddressed content commands on split sheets return `SPREAD_SHOWN_AS_PAGES`; page addressing on an unsplit unit is rejected.

Use `switch_layout` with `page` to split a full facing sheet or change its selected side, or choose a spread layout to merge it. The selected side wins when merging. `clear_page` shows a blank side while retaining content for recovery; `swap_pages` exchanges page states if their side restrictions allow it. `insert_page_pair` inserts a sheet with `pages.left` and/or `pages.right`, each with a `definition`, optional `params`, `boxes` and `elements`; an omitted side is blank. It supports `after` and `ref` like `insert_spread`. Whole-sheet duplicate, move and remove commands also work on split sheets. All commands retain the normal revision checks, atomic batches, drafts and shared Undo.

`inspect_book(view: 'parameters')` returns `pageDeclarations.left/right` for a split sheet (null for a blank page), beside its saved `pages` values. It does not label hidden spread declarations as visible. Element inspection accepts `page`; whole-sheet inspection includes each measured node's page. Detail previews use `{ spread, page, box }` or `{ spread, page, element }`, so identical IDs on facing pages stay separate. Whole-page preview targets still use `{ spread, side }`, or a physical `{ page: number }` with `expectedRevision`.

## Parameters

`p.*` helpers create plain, serializable schema objects; the editor generates controls from them, and the `spread` builder infers render-context types from them. A spread declared as a plain object gets a broad context.

| Helper | Value | Options |
| --- | --- | --- |
| `p.boolean` | `boolean` | `default` |
| `p.integer` | `number` | `default`, `min`, `max`, `step`, `unit` (display only) |
| `p.number` | `number` | `default`, `min`, `max`, `step`, `unit` (display only) |
| `p.string` | `string` | `default`, `multiline`, `maxLength`, `placeholder`, `markdown` ([Formatted text](#formatted-text-formatted-text)) |
| `p.enum` | one of `options` | `default`, `options` (an array of values or a value-to-label map), optional `labels` for arrays |
| `p.color` | `#rrggbb` | `default` |
| `p.date` | ISO date `YYYY-MM-DD` | `default`, `min`, `max`, `precision` (`day` or `month`) |
| `p.file` | file ID, or `''` when none is assigned | `accept` (lowercase extensions such as `'.gpx'`); see File parameters |
| `p.list` | array of items, each `{ id, ...fields }` | `item` (the fields), `min`, `max`, `default` (items, `[]` when omitted); see List parameters |

Every parameter has a `label` and a `default` (`p.file` supplies `''`, `p.list` `[]`); a saved value outside the constraints is reported and replaced by the default for rendering, but kept in `project.json`.

Any parameter, at any scope, may also have a `description`: plain help text of up to 1000 characters (trimmed, not empty), for people and agents alike. Say what the value means, which way it goes and when to change it, so an agent asked to "zoom the map out a bit" knows which parameter to lower:

```ts
zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: 8, step: .1,
  description: 'Higher values zoom in. 1 shows the whole route; 2 shows half its width.' }),
```

Descriptions appear with the parameter's type, range, `step`, `unit` and options in `get_authoring_context` (under `template`) and in `inspect_book`'s parameter view. In the editor, a field shows its parameter's description only as its hover tooltip, so the settings stay uncluttered; write it for agents first. A `description` on a `controls` entry is shown under the field instead and replaces it there; control descriptions have the same limits. Descriptions never change defaults, allowed values or saved data. Put units in `unit`, not in the description.

Scopes: `parameters` at template level (document), on a spread definition (spread instance), on a box or element (element instance). Values are stored in `project.json` at the matching scope. There is no inheritance between scopes.

## List parameters

A list holds a variable number of flat items, such as the GPX tracks of one map, each with its own colour and label:

```tsx
const mapParameters = {
  tracks: p.list({
    label: 'Tracks',
    item: {
      track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
      colour: p.color({ label: 'Colour', default: '#c0392b' }),
      label: p.string({ label: 'Label', default: '' }),
    },
    min: 0, max: 12,
  }),
};
// render: ctx.elements.map.params.tracks is { id: string; track: string; colour: string; label: string }[]
```

- **Items are flat.** `item` declares the fields with the other `p.*` helpers: file, string, number, integer, colour, date, enum and boolean. There are no nested lists. `id` is not a field name: it is the item's own ID.
- **Saved value:** a JSON array in `project.json`. Each item has a stable `id`, generated by the app when the user adds or duplicates an item, so reordering, Undo and editor drafts address the item, not its position. Use it as the React `key`. A missing field takes its default.
- **Default:** `[]`, or `default` items valid against `item`. `p.list` gives default items without an `id` one from their position (`item1`, `item2`, …), skipping IDs other default items already use.
- **Validation:** each item is checked with the field's own rules, and `min`/`max` bound the count. In `render`, a field with a value it does not allow takes its default, an item without a unique valid `id` is left out, and a count outside `min`/`max` (or a value that is not a list) uses the list's default. Each problem is reported per item; the saved data is never rewritten. A list's file fields are checked like file parameters: a missing or unreadable file is a Book check error naming the item.
- **Generated control:** a compact list with add, remove, duplicate and reordering (drag, or the arrows), where each row shows a one-line summary (the file name, the first text, a colour swatch) and opens to the item's fields on click. Every change is one Undo step. In the inline editor's toolbar the list is a *Tracks (3)* button that opens it in a popover, so the toolbar stays one row. `controls` can name the list like any parameter.
- **Custom editors** receive and `set` the whole array; ImageFlow validates it like any other value, so items need their `id`. `<Control parameter="tracks" />` renders the generated list control, and `<Control parameter="tracks" itemId={track.id} field="track" />` renders one field of one item, such as an import per track. `itemId` and `field` go together and only lists take them; the types check `field` against the item fields. An `itemId` the list never had is an error; once the item is removed, the control renders nothing.
- **Agents** set the whole array with `set_parameter`, or change one item with `insert_list_item`, `update_list_item`, `remove_list_item` and `move_list_item`, addressed by its `id` (docs/mcp.md).
- `ctx.Text`, `ctx.edit` conditions and `controls` `when` cannot compare a list; show its items with your own markup.

The starter's Map layout draws every track of its `tracks` list; *Fit tracks* frames all of them. It replaces the map's earlier single `track` and `trackColor`; books saved with those are not migrated (no released books use them).

## Boxes and elements

- `boxes` declares content boxes. `type: 'photo'` accepts a photo from the photo index; `type: 'markdown'` accepts a Markdown file. Boxes may declare their own `parameters`.
- Markdown boxes on a spread need a unique `flowOrder` when the spread has more than one. Continuation follows project spread order, then `flowOrder`.
- `elements` declares generated artwork (calendar, ornaments with options) that has parameters but no assigned content.
- Identifiers are stable keys: renaming one is a breaking change for projects using the template.

### Text metadata

A Markdown source may start with a YAML header. ImageFlow leaves it out of the flowed text and gives its fields to every box the text flows through as `ctx.boxes[id].text.meta`, so a chapter's title, a palette or the places a map marks travel with the file that holds the chapter:

```markdown
---
title: Crossing the Alps
eyebrow: Field notes
places:
  - { name: Bergün, latitude: 46.63, longitude: 9.75 }
  - { name: Albula Pass, latitude: 46.58, longitude: 9.84 }
---

We left before sunrise…
```

```tsx
render: (ctx) => {
  const text = ctx.boxes.story.text;
  const title = typeof text?.meta.title === 'string' ? text.meta.title : undefined;
  return <Spread>
    {text?.part === 1 && title && <h1 className="opener">{title}</h1>}
    {text && text.part > 1 && title && <header className="running">{title}</header>}
    <ctx.MarkdownBox id="story" />
  </Spread>;
},
```

- **Recognising a header.** The first line of the file is exactly `---`, a later line is `---` or `...`, and the lines between are a YAML mapping. Anything else, such as a file that starts with a thematic break followed by a paragraph, stays Markdown. A file that starts `---`, then `key: value` lines and `---`, is a header even though it would otherwise read as a rule and a heading.
- **Values.** `meta` holds what JSON can: strings, numbers, booleans, `null`, lists and objects. YAML 1.2's core schema applies, so `2024-05-01` and `no` stay strings. A source without a header has `meta: {}`. ImageFlow does not check the fields: read the keys your layout understands, check their shape, and fall back to the layout's normal rendering otherwise. Report a field you cannot use with [`issue()`](#template-findings).
- **One source, every box.** `meta` is read from the saved file before any spread renders and is the same object for every box of the chain, whatever the flow puts in it, so a layout may size or style its boxes from it. Two sources on a spread each keep their own `meta`; the layout decides which one, if any, styles the page around them. Other pages read it through [`ctx.book.texts`](#texts), and `anchors` through `boxes`. In layout previews a Markdown box has no flow position, so its `text` is `null` there.
- **Unreadable headers.** A header whose YAML cannot be read is a `text-frontmatter-invalid` warning on the text's first box. The header is still left out of the text, and `meta` is `{}`.
- **Editing.** ImageFlow does not change the header. Edit it in the Markdown editor or the linked file.

### Composing a text

A `MarkdownBox` flows its Markdown as it is. A composition shapes the text first: a function in the template's `compositions` that receives the text's top-level blocks and returns what flows. It can add an element before or after the blocks, replace a block with its own element, or put several blocks in one. A Markdown box names the composition for the text that starts in it:

```tsx
export default defineTemplate({
  // …
  compositions: {
    story: ({ blocks, meta }) => <>
      {meta.date && <p className="story-date" data-keep-next>{String(meta.date)}</p>}
      <h3>{String(meta.title ?? '')}</h3>
      {blocks.map((block) => block.type === 'heading' && block.depth === 2
        ? <div key={block.key} className="day-head" data-keep-next>
            <span className="day">{block.text.split(' · ')[0]}</span>
            <h3>{block.text.split(' · ')[1] ?? block.content}</h3>
          </div>
        : block.node)}
      <p className="end-mark">❦</p>
    </>,
  },
  spreads: ({ spread }) => ({
    story: spread({
      label: 'Story',
      boxes: { body: box.markdown('Story', { composition: 'story' }) },
      render: (ctx) => <Spread><ctx.MarkdownBox id="body" /></Spread>,
    }),
  }),
});
```

- **Blocks.** Each block has a `type` (`paragraph`, `heading`, `blockquote`, `list` or `rule`), a heading's `depth`, a list's `ordered`, its `text` without Markdown syntax, and a `key`. `block.node` is the block as ImageFlow renders it; `block.content` is what is inside it, such as a heading's formatted words, for your own element. Place a block once. The Markdown stays plain: read what you need from a heading's `text`, or from the header through `meta`.
- **What it reads.** A composition receives the text (`blocks`, `meta`) and the document settings (`document`), never a spread: a text has one structure wherever it is placed, and no spread parameter can change pages further on. A text that needs another structure names it in its header, and the composition reads `meta`; a layout that needs another names another composition.
- **Which composition.** The box a text starts in decides for the whole text, and the result flows through the chain, so an element before the blocks appears where the text starts and one after them where it ends. Give the boxes a text continues in the same `composition`, so their CSS meets the structure it expects. When a later box of the chain names another, or none, the Book check warns with `text-composition-mixed`; the text keeps the first. Moving a text's start to a layout with another composition therefore restructures the whole text.
- **Flow.** What a composition returns is measured, broken across columns and boxes and counted towards overflow like Markdown. Return block elements (`p`, headings, `div`, `blockquote`, lists) next to each other. An element marked `data-keep-next` stays whole and with the one after it, as a heading does, and a run of them stays together: a date, its title and the paragraph below. A run that begins a box too small for it stays where it is, and may then split. An element split across two boxes gets `.split` and `.cont` like a Markdown block; set `break-inside: avoid` on one that must not split.
- **Static.** A composition renders once per text, off the page, before the flow. Use plain elements and your own helper components. Content that arrives later — such as a `<RenderedImage>` or an `<img>` without fixed dimensions (images are decoded before the flow runs) — and platform components (`PhotoBox`, `MarkdownBox`, `Element`, `ctx.Text`) are not supported inside it.
- **Errors.** A composition that throws is a `text-composition-failed` error on the text's first box, and the text flows as plain Markdown until it is fixed. A box that names a composition the template does not declare fails the template's validation.

### One box over several rectangles

`rects` draws one Markdown box over several rectangles, such as the two pages of a spread, so a text can run across the fold without two boxes and a `flowOrder` pairing:

```tsx
const left = ctx.geometry.page('left', 'safe');
const right = ctx.geometry.page('right', 'safe');
// A text spread: both pages in full.
<ctx.MarkdownBox id="body" columns={2} rects={[left, right]} />
// An opener band: the text sits in the bottom quarter of both pages, level below the head that opens it.
<ctx.MarkdownBox id="body" columns={2} rects={[bandLeft, bandRight]} alignHeads />
```

- **One box.** There is one ID, one label, one text assignment and one drop target. The text cannot differ between the rectangles, and `text.part` counts the box once. `rect` and `rects` are mutually exclusive; `className` and `style` apply to every rectangle.
- **Flow.** Text runs down the columns of the first rectangle, then those of the next, then continues in the next box that holds the same text, as with chained boxes. Every rectangle has `columns` columns. Rectangles may differ in size and position; the space between pages is whatever lies between the rectangles, so it can differ from the column gap.
- **Without `alignHeads`** each rectangle behaves like a box of its own in a chain. A head (an element with `column-span: all`, such as a composition's day head) spans the columns of the rectangle it lands in and moves nothing else, so facing pages keep the same top line and only the page a head opens is lowered. This is the usual setting for running text, where heads fall wherever the text breaks.
- **With `alignHeads`,** a head that opens the box, as the first thing in its first rectangle, leaves the same room at the top of every other rectangle, so the columns on all pages start on one line below it. The room is the head's full height: its padding and its bottom margin count. A later rectangle that itself opens with a head grows that head to the same height instead of adding a gap. Use it for opener bands, where the head belongs to the whole band. Give heads and text whole baseline-grid lines (a head of three lines, text in the same line height) and the columns stay on the grid across the fold.
- **Only a head that opens the box counts.** A head in the middle of a rectangle, or at the top of a later rectangle, spans that rectangle's columns and does not change the others. The room costs capacity: a text that just fitted may now need another box. A later rectangle that is too short for the room holds no text, the text goes on in the next rectangle or box, and the Book check warns with `text-band-too-tall`. A rectangle the text never reaches gets no room.
- **Column fill.** Columns fill top to bottom and the text continues in the next rectangle, as in chained boxes; the platform sets this, so a template's `column-fill` has no effect. A short text therefore fills the first rectangle's columns before the next. Balancing across rectangles is not supported.
- **Existing books.** A book made with two boxes (`body` and `bodyMore`) keeps the second assignment when a spread switches to a layout with one box over two rectangles: what a layout does not show stays with the spread, `switch_layout` reports it as kept, and only the box the layout draws flows. `clear_box` discards the leftover assignment; switching back shows both boxes again. IDs are identity, so renaming `body` or dropping `bodyMore` from a template is a breaking change for books that use them.

## Print format

`format` is a single `PrintFormat` as sketched in `spikes/pdf-format/print-format-sketch.md` (PR #2): trim, bleed per edge, safe insets, structure (`delivery: 'pages' | 'spreads'`, `ends: 'single-pages' | 'inside-covers'`, page-count rule), and output constraints (container, colour space, transparency policy, resolution range, raster size, font rules, minimum text size). The platform resolves it into concrete geometry once.

A template declares either one `format` or several named `formats`, which the user chooses between under **the template’s settings → Format**:

```tsx
formats: {
  square: bookFormat('Square · 29 × 29 cm', 290, 290),
  landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
},
defaultFormat: 'square',   // optional; otherwise the first format
```

`printFormat({ label, trim, bleed, safe, pageCount, delivery?, ends?, output? })` builds a complete `PrintFormat` with less repetition. `bleed` and `safe` take one length for all four sides (`mm(12)`), `{ all, …sides }` where named sides override `all` (`{ all: mm(3), binding: mm(0) }`), or all four sides. `delivery` defaults to `'pages'`, `ends` to `'single-pages'`, and `output` to `{ container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' }`, with given fields replacing those. The result is an ordinary `PrintFormat`. `get_authoring_context` reports every preset in full under `template.printFormats` (by format ID, `default` for a single `format`), next to the active `template.format`, its `formatId` and the `formats` labels. It describes geometry, not a printer's product: page counts, resolution, minimum text size, font rules and file-size limits come from the printer's specification.

Each entry is a complete `PrintFormat`, so presets may differ in bleed, safe area, page-count rules and output limits, not only in trim. Every format is validated when the template loads (schema and geometry: PDF edges between 10 and 1000 mm, binding bleed within the facing page, safe insets leaving room inside the trim), so a broken preset is a template error rather than something a book discovers after switching to it. The choice is stored as `format` in `project.json` and applies to the whole book. A project without it uses `defaultFormat`, else the first format. A project naming a format the template no longer has is previewed in the default format, but the Book check reports an error, so export asks for confirmation until a format is chosen again. A template with a single `format` ignores the project's choice.

Changing the format re-renders the book: assignments, crops and text sources stay, while text flow, photo resolution and print checks are recomputed. Layouts adapt through `ctx.format` (resolved millimetres), `ctx.geometry` (the geometry helpers for that format), `ctx.formatId` (the chosen key, or `'default'` for a single `format`), and the `--trim-*`, `--bleed-*` and `--safe-*` CSS variables of `<Spread>`. The starter template draws its layouts on a 290 × 290 design page and scales positions with the trim size; full-bleed boxes use the bleed variables directly.

Arbitrary dimensions within declared limits, rather than named presets, are not supported yet.

### Exterior covers

Declare `requires: ['physical-covers']`, `coverFormats` keyed by interior format ID, and `coverLayouts`. For a template with a single `format`, use the key `default`. A cover layout is available for every declared cover format unless its `formats` list names specific IDs. An interior format without a corresponding cover specification opens in the usual content editor.

Each cover layout renders one full exterior sheet. It can declare photo boxes, parameters, and elements with generated controls. The render context provides `cover.sheet`, `cover.trim`, and `cover.regions` for the back, spine, front and optional flaps, in millimetres. Use `cover.safe` for text placement. A region can have a `null` safe area if its insets consume the available space. `cover.sheet` starts at negative trim-relative coordinates so artwork can extend into the wrap or bleed.

Print specifications can use fixed widths or inclusive page-count bands for the spine and both flaps. Bands cover every valid interior page count, with printer rounding applied in the source unit. Interior page counts include blank pages. Guides and provisional sizing appear in the editor and preview metadata.

#### Printer presets

The Photobook starter has measured presets in `print-presets.ts`: `whiteWallGallerySquare({ paper })` for WhiteWall Gallery Square (Fuji Crystal Archive, Fedrigoni gloss and Sappi silk-matt papers) and `blurbLargeSquare({ paper, cover })` for Blurb Large Square (six papers, `'imageWrap'` or `'dustJacket'`). Each returns `{ format, coverFormat, researched, sources }`. The interior format and the cover come together because the cover's panels, height and spine bands depend on the interior trim and page-count rule. To use a preset, copy `print-presets.ts` into your template folder. It is part of the template, so a book keeps the values it was made with when the app updates.

```tsx
import { blurbLargeSquare, whiteWallGallerySquare } from './print-presets';

const whiteWall = whiteWallGallerySquare({ paper: 'fujiCrystalArchive' });
const blurb = blurbLargeSquare({ paper: 'premiumMatte', cover: 'dustJacket' });

export default defineTemplate({
  // …
  requires: ['physical-covers'],
  formats: {
    whiteWall: { ...whiteWall.format, label: 'WhiteWall · 29 × 29 cm' },
    blurb: blurb.format,
  },
  coverFormats: { whiteWall: whiteWall.coverFormat, blurb: blurb.coverFormat },
  coverLayouts: { /* … */ },
});
```

A preset is plain data. Spread it to change a field, for example `{ ...blurb.coverFormat, foldAvoidance: { back: pt(18), front: pt(18) } }`. The values were measured from the printers' calculators, templates and help pages on the `researched` date. They were not tested with the printers' uploaders, so check them against `sources` before ordering. If a printer changes its specification, add the new values beside the old ones instead of editing them, so existing books keep their size.

#### A custom cover

For any other printer, write the `CoverFormat` yourself, from the printer's cover template or calculator. This one is for a 21 × 21 cm hardcover with a 5 mm spine up to 40 pages and 7 mm up to 80, with 15 mm wrapped around the board on each edge:

```tsx
const edges = (length: Length) => ({ top: length, right: length, bottom: length, left: length });

formats: {
  square: printFormat({ label: 'Square · 21 × 21 cm', trim: { width: mm(210), height: mm(210) },
    bleed: { all: mm(3), binding: mm(0) }, safe: mm(5), pageCount: { min: 24, max: 80, step: 2 } }),
},
coverFormats: {
  square: {
    kind: 'wrap',
    height: mm(216), panels: { back: mm(213), front: mm(213) },   // the cover board, front and back
    widths: { kind: 'page-bands', bands: [
      { from: 24, to: 40, value: { spine: mm(5) } },
      { from: 42, to: 80, value: { spine: mm(7) } },
    ] },
    outer: { kind: 'wrap', insets: edges(mm(15)) },                // 'bleed' for a jacket or a softcover
    safe: { back: edges(mm(8)), front: edges(mm(8)), spine: edges(mm(1)) },
    foldAvoidance: { back: mm(8), front: mm(8) },                  // a warning band next to the spine
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
  },
},
```

The bands must cover every page count the interior allows, here 24 to 80 in steps of two. A dust jacket adds `flaps: { back, front }` to each band's `value` and declares `flaps: { safe: { back, front } }` on the cover. Use `widths: { kind: 'fixed', value: { spine } }` when the spine does not depend on the page count.

### Formats without facing pages

Wall calendars, cards, loose print series and posters have no facing pages. Declare them with `facingPages: false`, and every unit of the book is one page: the editor, the thumbnails, the Book check and export works page by page instead of spread by spread. The name follows print convention (InDesign's *Facing Pages* setting).

```tsx
format: printFormat({
  label: 'Wall calendar · A4 portrait',
  trim: { width: mm(210), height: mm(297) },
  facingPages: false,
  bleed: mm(3),                                   // or { all: mm(3), left: mm(5) }
  safe: { top: mm(8), bottom: mm(8), left: mm(8), right: mm(8) },
  pageCount: { min: 13, max: 13, step: 1 },
}),
```

In `PrintFormat` the flag is `structure.facingPages`, and the format's schema depends on it:

| | `facingPages: true` (default) | `facingPages: false` |
|---|---|---|
| `bleed`, `safe` sides | `top`, `bottom`, `outside`, `binding` | `top`, `bottom`, `left`, `right` |
| `delivery` | `'pages'` or `'spreads'` | not allowed: always one page per PDF page |
| `ends` | `'single-pages'` or `'inside-covers'` | not allowed |
| `pageCount.step` | `2` or `4` | `1`, `2` or `4` |

The `all` shorthand of `bleed` and `safe` works in both. A side name of the other kind is a schema error with a hint. Geometry is validated the same way: without facing pages, the PDF page is the trim plus the left and right bleed wide, and the safe insets must leave space inside the trim.

Layouts for these formats use `span: 'page'` (see [Spread spans](#spread-spans)). In a format without facing pages, `ctx.format` and `ctx.geometry` describe one page: `ctx.format.facingPages` is `false`, `bleed` and `safe` have `left` and `right`, `spreadWidth` is the page width, `ctx.geometry.page(area?)` takes no side and `ctx.geometry.spread()` throws. `ctx.page` is `{ number }`, anchors report `side: 'page'`, and `ctx.book.pages` counts pages as usual. `<Spread>` sets `--bleed-left`, `--bleed-right`, `--safe-left` and `--safe-right` instead of the outside and binding variables. The export has one PDF page per unit, with bleed on all four sides and a TrimBox inset by the bleed on each edge.

The Wall calendar starter, `sample/calendar/template/index.tsx`, is a complete example: two landscape formats without facing pages, a cover and a month layout, months numbered by `month` anchors (`ctx.book.anchors('month')`), and type sizes scaled with the trim width.

### Spread spans

`span` says which pages a layout occupies, and so which formats it fits:

| `span` | Fits | Pages |
|---|---|---|
| `'spread'` | formats with facing pages | two facing pages |
| `'right'`, `'left'` | formats with facing pages, `ends: 'single-pages'` and `delivery: 'pages'` | a single first page (`right`) or last page (`left`); the inactive half is shown as an inside cover and not exported |
| `'page'` | any format, subject to `sides` | one page; one half of a facing sheet, a single book end, or a non-facing unit |

`span` defaults to `'page'` when no format of the template has facing pages, and to `'spread'` otherwise, so a calendar template does not repeat it on every layout. A layout whose `span` fits none of the template's formats loads with a `declaration-span-unused` warning.

Page designs should use `page()` and `<Page>` with page-local coordinates, with optional `sides` restrictions. `span: 'left'/'right'` remains supported for older end-page layouts drawn in spread coordinates. See [Page layouts](#page-layouts).

### Book ends

The template and the format each have one job. The template offers layouts with a `span`: a page layout allowing the right side for the opening, a page layout allowing the left side for the closing, and spread layouts or two composed page layouts in between. Legacy `right`/`left` layouts still work. The format states what the printer expects, and export follows the format alone. `ends` is therefore a requirement, not a permission:

| `ends` | First spread | Last spread | In between |
|---|---|---|---|
| `'single-pages'` (e.g. Blurb) | a page layout allowing right, or legacy `span: 'right'` | a page layout allowing left, or legacy `span: 'left'` | full sheets: one spread layout or two page layouts |
| `'inside-covers'` (e.g. Saal) | full spread; left half printed on the inside cover | full spread; right half printed on the inside cover | full spreads |

- **Page sequence.** A book that breaks the rule gets a `page-sequence` error naming the first or last spread, with the span to switch it to. Export asks for confirmation before saving a PDF with these errors. A book of only its opening page is reported as missing its closing page.
- **`delivery` and `ends`.** Single end pages need page delivery: `delivery: 'spreads'` with `ends: 'single-pages'` is a schema error, because a PDF of whole spreads cannot open on a single right page. `printFormat` defaults `ends` to `'inside-covers'` when `delivery` is `'spreads'`, else to `'single-pages'`. `right` and `left` layouts fit only formats with `ends: 'single-pages'` and `delivery: 'pages'`; in other formats they are filtered and reported like `span: 'page'` layouts.
- **Editor.** With `'single-pages'`, nothing is inserted before the opening page or after the closing page, spreads do not move into or out of the end positions, and the end pages are not duplicated. The layout picker at the first and last positions offers page layouts allowed on that side and compatible legacy `right`/`left` layouts. An empty book starts with a layout allowed on the right. Removing an end spread stays possible and is reported by the page sequence. MCP supports page-addressed edits and `insert_page_pair` (see [Page layouts](#page-layouts)); whole-sheet commands `insert_spread`, `duplicate_spread` and `move_spread` follow the same rules and fail with `INVALID_POSITION`; `switch_layout` fails with `INCOMPATIBLE_LAYOUT` naming the span the position requires.
- **Declaration check.** A template with a `'single-pages'` format but no layout allowed on the right or no layout allowed on the left loads with a `declaration-ends-missing` warning.
- **Opening spreads** may be only the start of a book, so full spreads may come first or last among them; single pages must still be at their own end.

A template may offer formats of both kinds side by side. The layout picker, new spreads and fixtures use only the layouts that fit the chosen format. A format change never restructures saved sheets. A split sheet in a format without facing pages remains split and reports a page-sequence problem; choose a page layout to merge it into one unit, or switch back. A book that switches to a format its layouts do not fit still previews (a page layout is drawn on a spread, a spread layout on one page), but the Book check reports a `page-sequence` error naming each such spread or page, and export asks for confirmation until its layouts are switched. The picker of a mismatched spread offers the layouts that fit the new format. Switching back to the earlier format restores the book; assignments, crops and text sources are kept, as with any format change. Opening spreads are checked against the formats of the default format's kind, because a new book starts in the default format.

## Template library

New books are made from the templates in the library: the built-in starter and the templates imported with **Templates → Manage Templates… → Import…**. Import loads the template like a book would and refuses one that fails to load. Before a template that bundles npm packages or declares `network` sites enters the library, the import lists the packages with their versions and licences and the sites its editors connect to, and **Templates → Manage Templates…** keeps showing them ([Dependencies](#dependencies), [Element editors](#element-editors)). The library keeps one entry per `id`, compared by `version` as dot-separated numbers: a newer version replaces the entry, while an older version, or the same version with other files, asks first. So bump `version` when you change a template you have shared. `label` (up to 80 characters) and `description` (up to 300) are what the library shows; without a label it shows the ID. A book copies its template when it is created, and `project.json` records the source's hash as `template.hash`; the library is never read while a book renders.

### Forks and starter updates

A book's template is its own copy. An app update never changes it, even when the library holds a newer version of the template it came from; `project.json` records that template's `id`, `version` and `hash` as provenance, and nothing updates them later. So once you change a book's template, it is a fork.

Give a fork an `id` of its own and start its `version` again, and name the template it was copied from, at the version copied, as `basedOn: { id: 'imageflow-starter', version: '0.11.1' }`. A book made from that template opens with the fork, because its ID check also accepts `basedOn.id`, and a fork saved to the library is a separate entry beside the original. Agents see `basedOn` in `templateIdentity`, so they can tell a fork from an unchanged copy, and an older `version` of the same ID from a newer template. Included in the contract-1 baseline (`template-lineage`).

To bring changes from a newer starter into a fork, compare the two rather than replacing the fork's `template/` folder, which would discard its changes. The starter's `CHANGELOG.md` lists what each version changed. Agents read a library template's files with `read_library_template`, and with `project` it lists which files differ from the book's `template/`. Port what you want by hand, check the book, and raise `basedOn.version` to the version you compared with.

### Template previews

New Book and **Manage Templates…** show a picture of each template. By default it is a render of the first opening spread (or, when that is blank, an illustrated sample spread), made once per version and saved: built-in templates ship theirs with the app, and an imported template is rendered when it is imported and kept with it in the library. Both are tied to the [template hash](#template-library), so any change to the template's files makes a new one, and removing the template removes its render. A template that declares `network` sites is saved only once those sites are allowed, so the picture never lacks a map; until then it is rendered again in each session.

When the opening spread doesn't sell the template well, set `preview` to an image inside the template folder, such as `preview: './preview.jpg'`. New Book shows it instead of the render, cropped to fill a tile with the shape of the default format's trimmed page, never letterboxed. **Manage Templates…** keeps showing the render in its details, so you can compare. The image must be PNG, JPEG or WebP with a matching extension, at most 2 MB (about 1200 pixels on the long edge is plenty), and inside the template folder: no `..`, no dot folders, no symbolic links. It is part of the template's files and hash, so a book copies it and an export includes it. When the file is missing, too large or cannot be read, New Book falls back to the render. The Book check, and `check_book` and `get_authoring_context` for agents, report a `template-preview-invalid` warning for such a file and a `template-preview-aspect` warning when its width-to-height ratio differs from the default format's page by more than 5%. Update the image when you change the layouts it shows. The wall calendar sample uses `preview` to show a month page instead of its cover. Included in the contract-1 baseline.

To share a template, export it as an `.imageflow-template` file: **Export…** in **Templates → Manage Templates…** saves a library entry, built-in ones included. To share an edited book template, import its template folder into the library first; an agent can save it with the `save_template_to_library` tool. The file is a zip of the template's files, leaving out dotfiles and `node_modules/`, and exporting the same files always gives the same bytes. Importing it, from **Import Templates…** or by opening it in Finder, gives the same hash as the folder it came from. A zip made with Finder's **Compress** works too, when it holds the template folder or its contents. Files with paths outside the template, links, encrypted entries or damaged data are refused before anything is written.

### Opening spreads

`openingSpreads` lists the units a new book starts with, in order. Creating a book from a library template applies these defaults; the editor also offers them in an empty book. An entry either names one layout with optional layout parameters, or supplies independent page states for a full facing sheet:

```ts
defineTemplate({
  …,
  spreads: ({ spread, page }) => ({
    title: page({ label: 'Title', sides: ['right'], … }),
    photo: page({ label: 'Photo', … }),
    story: page({ label: 'Story', parameters: { heading }, … }),
    panorama: spread({ label: 'Panorama', … }),
    closing: page({ label: 'Closing', sides: ['left'], … }),
  }),
  openingSpreads: [
    { layout: 'title' },
    { pages: { left: { layout: 'photo' }, right: { layout: 'story', params: { heading: 'Day one' } } } },
    { layout: 'panorama' },
    { layout: 'closing' },
  ],
});
```

- A `{ layout, params? }` entry creates one ordinary layout state: a spread, a single end page, or a unit without facing pages, according to the layout and format. A `{ pages }` entry creates a sheet shown as independent pages, with page parameters stored separately. It is available only for facing formats and full-sheet positions.
- Each `pages.left`/`pages.right` state can name a page layout and its own `params`. Omit a side, or use `{}` for that side, to leave it blank. Layout IDs must name page designs, and side restrictions must allow their placement.
- The template fails to load if an entry names an undeclared layout, sets a parameter the layout does not have, or sets a value the parameter does not allow. Parameter checks are per page for a page pair. TypeScript also checks declared layout IDs.
- Single opening and closing pages use ordinary page layouts allowed on the required side, or compatible legacy `right`/`left` layouts. They are not page pairs.
- The opening sequence need not meet the format's page-count rule; books can be built up from it. Validation checks its layouts and page composition against the formats of the default format's kind.
- Without `openingSpreads`, a new book starts with no spreads. An empty book offers every layout that can start it, including reusable page designs. In a facing full-sheet position, a page design starts on an allowed side with the other side blank. The Book check reports `book-empty` until a unit is added.

The starter includes ordinary opening and closing pages and composed photo/story pages in its new-book defaults. Only the Panorama, Chapter opener and full-spread Map are spread templates; contents, inset maps, picture lists and the other designs are independent page templates. Template files are copied into each new book; changing the built-in starter never rewrites an existing book's template.

## Switching layouts

The editor can switch a full sheet between one spread layout and two page layouts without changing its pagination. Choosing a page layout applies to the selected side, and choosing a spread layout merges both pages. Ordinary opening and closing pages stay single units. See [Page layouts](#page-layouts) for the editor controls and current automation limits.

Within a spread or page state, switching layouts keeps the ID-based state below. A sheet also remembers its spread state and each page state independently.

**An ID is the identity.** A box, element or parameter ID means the same thing in every layout that declares it, within its scope: spread parameters, the boxes of a spread and each box's parameters, the elements of a spread and each element's parameters. Each spread or page state keeps values keyed by these IDs; its layout decides which are shown. The same box ID on two facing page states names two independent assignments. Templates need no extra declarations, roles or migration code for this.

- **Same ID, same type.** A box ID has the same box type (photo or Markdown) in every layout, and a parameter ID has the same parameter type in every layout within its scope. A template that breaks this fails to load with an error naming both layouts. Labels, defaults and constraints (`min`/`max`, `step`, `maxLength`, `multiline`, enum `options`, date `precision`, file `accept`) may differ, so a layout can offer fewer columns or a shorter title than another.
- **Different meaning, different ID.** Reusing an ID shares its value. A closing page would declare `closingLine` rather than `heading`, because a closing line is not the spread heading. Differently named boxes are never matched automatically, and box order plays no part: a two-photo layout shows the boxes whose IDs it declares.
- **Content.** Photo and Markdown assignments show in every layout with a box of that ID. Content a layout has no box for stays in its spread or page state, is listed in the Inspector under *Set aside*, and shows again in any layout that has the box. Switching never deletes content, and sources stay in the project.
- **Placing kept content.** *Place in…* (or dragging the item onto a box of the same spread) moves kept content into a box of the current layout. If the box shows something, the two swap, so that content is kept instead of lost. A move is not a copy: the item is no longer kept, so it cannot appear twice when you switch back. Its crop focus moves with it; its per-layout crops were made for the old box's frames and do not. Box parameters belong to the box ID and stay. Dragging a kept item onto another spread, or a source from the strip onto any box, places another use of the source instead. *Discard* removes kept content from the spread; the source stays in the project, and Undo brings it back. Element settings kept for other layouts are listed by element name.
- **Latest edit wins.** There is one value per ID, so an edit made in any layout is what every later layout sees. Replacing a photo in one layout replaces it for all of them; an older assignment cannot come back by switching. Removing a photo or text is a real edit; visiting a layout without that box is not.
- **Parameters.** Spread, box and element parameter values follow the same rule. A value the current layout does not declare stays stored and returns with a layout that does. Values are stored only once set, so a layout whose parameter was never set shows its own default.
- **Rejected values.** When a stored value fails the target layout's constraints (for example a 120-character title where the layout allows 60, or a column count it does not offer), the value is kept unchanged, the layout uses its default, the switch says so, and the Book check warns. Setting the field in that layout replaces the value.
- **Crops.** A crop belongs to the layout it was set in, because frames differ. Returning to a layout restores its crop. A layout without its own crop fills its frame around the centre of the crop set last (the *focus*), clamped to the frame. Assigning another photo to a box starts over: no crop of the previous photo applies to it. Resetting a crop, or setting a centred fill, clears the focus.
- **Text flow.** Continuation is recomputed for the whole book after a switch, from the Markdown boxes each spread now shows.
- **Element editors.** Custom element editors never store their own state; their parameters follow the rules above.

### Between spreads and pages

A layout change reads only the layouts it replaces. Changing one page never takes content from, or changes, the page that stays visible. Splitting replaces the spread layout; merging replaces both shown page layouts.

For each ID the new layout declares, the value comes from:

1. A replaced layout that shows the ID, **including an empty box or a default parameter**. When merging, a stored value beats an empty/default; between two values the selected side wins, or the left side without a selection. A value moves to only one target; when splitting, the chosen side takes first.
2. The target state's own memory, when the replaced layouts did not show that ID.
3. For a page, the spread's stored memory that no shown layout uses.

Moving a box transfers its complete state: assignment, box parameters, focus and per-layout crops. It leaves its source state. Content the target stored for that ID moves to **Replaced**, with its original location, rather than silently returning on a later switch. Parameter values are overwritten like ordinary edits. Cleared boxes and reset/default parameters carry over as empty/default, so an older stored value cannot reappear by switching.

Content no target takes stays stored where it was. **Set aside** lists it by location: on the spread, on the left page or on the right page. **Replaced** lists overwritten content separately. **Place in…** explicitly returns either kind of content to a compatible shown box, including the facing page; an occupied destination swaps its assignment back. **Discard** removes that item, and Undo restores it.

For example, splitting a spread whose `hero` holds photo A into a left photo page moves A to the left. The right is blank until a layout is chosen or its remembered page returns. Giving the right a text layout never changes the left photo. Merging two pages with different `hero` photos uses the selected page's photo, while preserving the other content for later. Every change is one Undo step, restoring all stored states and replaced content exactly.

Selecting a layout is one edit: Undo restores the previous layout with everything it showed. Pointing at a layout in the picker shows what switching would do, for example *2 photos carried over · 2 photos kept outside this layout · text will reflow*. A selected photo or open edit popover on the spread closes when its layout changes, and an open element editor reports that its values changed, so nothing is saved into a layout it was not opened for.

State that no layout of the template declares (after the template drops a box, element or parameter) stays in `project.json` and is reported in the Book check rather than removed.

## Layout families

Layouts that are variants of one design, such as a photo grid in 2×2 and 3×3, can form a **layout family**. Every variant is still an ordinary layout with its own ID and a fixed set of boxes, so everything in [Switching layouts](#switching-layouts) applies unchanged: choosing a variant is a layout switch, with the same carried, kept and restored content, per-layout crops, rejected-value fallbacks and one Undo step. Families change only how the choice is presented.

```tsx
defineTemplate({
  …,
  layoutFamilies: {
    grid: { label: 'Photo grid', picker: { label: 'Grid size', choice: { tag: 'size', options: { '2x2': '2 × 2', '3x3': '3 × 3' } } } },
  },
  spreads: ({ spread }) => ({
    grid: spread({ label: 'Photo grid 2×2', family: 'grid', variant: { size: '2x2' }, boxes: box.photos(['a', 'b', 'c', 'd'], …), render: … }),
    grid9: spread({ label: 'Photo grid 3×3', family: 'grid', variant: { size: '3x3' }, boxes: box.photos(['a', 'b', 'e', 'c', 'd', 'f', 'g', 'h', 'i'], …), render: … }),
  }),
});
```

- **Declaring:** `layoutFamilies` declares each family by ID with a `label` and an optional `picker`. A layout joins one with `family`. `variant` holds free-form tags (strings, numbers or booleans) that tell the variants apart; ImageFlow gives them no meaning and passes them to the picker.
- **Rules, checked when the template loads:** the family is declared (TypeScript also rejects an unknown family); a family has at least two variants; its variants have the same `span` and `sides` restrictions; tags are on every variant of a family or on none, and no two variants have the same tags; a layout with tags belongs to a family.
- **Box IDs carry the content.** Choose the variants' box IDs so shared content lands where it belongs. The starter's 3×3 grid declares the 2×2 grid's four boxes in its upper-left cells, so growing the grid keeps those photos in place, and shrinking it keeps the other five outside the layout until the spread returns to 3×3.
- **Sidebar:** a family with a picker is one layout preview, named after the family and showing the spread's current variant (or the first one). Clicking it selects that layout, like any other preview. While the spread uses the family, its controls appear first in the spread's or page's settings, below the complete layout browser. A family without a picker shows a preview per variant, next to each other. Keep labels short: at a usual sidebar width, a page tile shows about 10 characters of its name and a spread tile about 22 before cutting it off with an ellipsis (the full name shows on hover). Put the distinguishing word first, so two cut-off names still differ: "Map chapter" and "Text chapter", not "Chapter · map" and "Chapter · text".
- **A choice picker** (`picker.choice`) is the usual picker: ImageFlow's own segmented choice, drawn by the app at once, with one option per variant. `tag` names the variant tag that tells the variants apart, and `options` names each of its values, in the order shown: `{ tag: 'size', options: { '2x2': '2 × 2', '3x3': '3 × 3' } }`. When the template loads, every variant must have the tag, with a value of its own that `options` names, and every option must belong to a variant. It needs no component, no imports and no template code at run time.
- **A component picker** (`picker.component`) is for choices one tag cannot express, such as two independent choices (below). A picker has a `choice` or a `component`, not both. The component runs in a sandboxed frame with the template's CSS, as a labelled settings field. Prefer compact controls, such as a segmented choice for two grid sizes, over preview illustrations; build them from [`<Choice>`](#app-controls) so they match the settings around them. Each `choose(id)` immediately switches layouts as one Undo step; `commit()` applies the current choice and `cancel()` leaves the controls. Undo reverts an applied choice. It receives `variants` (each with `id`, `label` and its `variant` tags), `current` (the variant chosen in the draft), `saved` (the spread's layout), `choose(id)`, `find(tags)` (the first variant whose tags include all the given ones, or `undefined`), `document`, `format`, `readOnly`, `commit()` and `cancel()`.
- **Only declared variants:** a component's `choose` with anything other than a variant ID of the family changes nothing and the inline picker reports the invalid choice. A picker with several independent choices decides itself what a combination without a variant does, for example by disabling that option or choosing the nearest variant: `find({ size: '3x3', text: true }) ?? find({ size: '3x3' })`. Prefer tags over hard-coded IDs, so a new variant needs only a new layout.
- **Changes from elsewhere:** a component picker keeps its frame and measured height while their saved layout and document context follow the book. While the book reloads or cannot be edited, the controls are disabled; messages from stale declarations cannot change the book.
- **Agents and commands** switch layout variants by ID with `switch_layout`; include `page: 'left' | 'right'` for a page family on a split sheet. To check a picker without the app, `check_book` draws it with `preview.target: { spread, picker: true }`, and `choose` clicks one of its controls by label and reports the variant chosen (see the MCP reference). `get_authoring_context` reports `layoutFamilies`, and `family` and `variant` on each layout, so agents see the same grouping.
- **Page families:** page designs can form families too. The picker shows the selected page's variant and changes only that page. Families contain only spread layouts or only page layouts; every page variant allows the same sides.
- **Scope today:** a finite list of explicitly declared variants, controlled from the sidebar's spread settings. The set of boxes is never derived from parameters, and unbounded counts (rows 1 to n) are not supported.

### App controls

`<Choice>` (from `imageflow`) is ImageFlow's own segmented choice: the same control, colours, sizes, selected, disabled and focus states, in light and dark, as the generated settings beside it. Use it in component pickers of layout families and custom element or document editors instead of styling buttons yourself; the app's own class names are internal and may change. It is a radio group: Tab reaches the selected option, and the arrow keys, Home and End choose another. `label` names it, shown above the choice unless `hideLabel` (a picker's single choice is already named by the picker's `label`). Options take `{ value, label, disabled? }` with string, number or boolean values. In an element editor, `<Control parameter>` already draws a parameter's control; `Choice` is for choices that are not one parameter, such as variants.

A picker with two independent choices, each disabled where no variant has the combination:

```tsx
function StagePicker({ variants, current, choose, find, readOnly }: LayoutPickerProps) {
  const { kind = 'cycling', photos = 1 } = variants.find(({ id }) => id === current)?.variant ?? {};
  const option = (label: string, tags: VariantTags) => ({ label, value: tags.kind ?? tags.photos, disabled: !find({ kind, photos, ...tags }) });
  return <>
    <Choice label="Stage type" value={kind} disabled={readOnly}
      options={[option('Cycling', { kind: 'cycling' }), option('Stay', { kind: 'stay' })]}
      onChange={(value) => choose(find({ kind: value, photos })!)} />
    <Choice label="Facing photos" value={photos} disabled={readOnly}
      options={[option('Full-page photo', { photos: 1 }), option('Two photos', { photos: 2 })]}
      onChange={(value) => choose(find({ kind, photos: value })!)} />
  </>;
}
```

## Dependencies

A template can use npm packages, such as a map or chart library (included in the contract-1 baseline):

1. Add the package to `dependencies` in `template/package.json` (create it if needed). Do not run `npm install` in `template/`.
2. Import the package as usual: `import maplibregl from 'maplibre-gl'`, and its CSS with `import 'maplibre-gl/dist/maplibre-gl.css'`.
3. Rebuild: an agent calls the `rebuild_dependencies` tool; in the app, choose **Templates → Rebuild Template Dependencies**; in an ImageFlow source checkout, run `node scripts/rebuild-template-dependencies.mjs /path/to/template`. ImageFlow installs the packages with the npm on your Mac (install Node.js if you have none) into its own cache outside the book, keyed by `package.json` and `package-lock.json` so an unchanged set is reused at once, and writes npm's updated `package-lock.json` back. Install scripts do not run, and `file:` dependencies, such as a package in `template/packages/`, install from the same folders. Since no build step runs, such a package can point `main` and `types` at its TypeScript source (`"main": "src/index.ts", "types": "src/index.ts"`): the rebuild compiles it while bundling and saves the source as its declarations. A package that names a built entry, such as `dist/index.js`, must keep that output in the template; when an entry is missing, the rebuild stops and says which. It then bundles every package the template imports into `template/vendor/`: `modules/` (ES modules, shared code split into chunks, CSS beside them), `types/` (the declarations those packages reach, in `types/packages/` by package name, so `.gitignore` rules for `node_modules` keep them), `LICENSES/` and `manifest.json` (packages and versions, the lockfile's hash, and which import maps to which module).

A book never contains installed packages, so it stays small: a `template/node_modules` folder from before is not used, and the Book check says so; **Rebuild Template Dependencies** offers to move it to the Trash. Books never read `node_modules`: book revisions, the folder watcher and **Save a Copy** skip it. Opening, previews, the Book check and export resolve package imports only through `vendor/manifest.json`, so a book renders the same code on every Mac, and the template hash, which covers `vendor/` but not `node_modules/`, identifies that code. A package import missing from the manifest is a compile error pointing at the rebuild, and so is a relative import into `node_modules/` (or a dot folder), which the template hash and copies leave out. When `package-lock.json` changes after a rebuild, the Book check warns (`template-dependencies`) and the book keeps the saved bundle until you rebuild. Exported templates and the library include `vendor/` and leave out `node_modules/`.

- **React** is the app's: packages that import `react` get the host's React and its hooks. React components from packages, including `memo` and `forwardRef` components such as react-map-gl's `<Map>`, are valid JSX in templates and type-check with their props. Bundling `react`, `react-dom` or `imageflow` is refused.
- **Types:** the rebuild resolves each import as written, subpaths included, through the package's `exports` (`types` conditions), `types` and `typesVersions`, then its `@types` package, and copies the declarations it reaches into `vendor/types`, including those of linked `file:` dependencies. The type check resolves bare imports among those copies as it would in `node_modules`, so `check_book` with `typescript: true` works without `node_modules` and without hand-written forwarding declarations; problems inside third-party declarations are not reported. `manifest.json` records each typed import's declaration entry under `types`. An import without declarations is typed as `any`, with a `template-dependencies` warning. The rebuild also maps each import, and every subpath a vendored package exports with declarations (so imports used only for types, or by other packages' declarations, resolve too), to its entry in `paths` of `template/tsconfig.json` (with a `vendor/types` fallback) and excludes `vendor/` there, so code editors and a standalone `tsc` see the same declarations as the book's check. When `tsconfig.json` extends the generated `.imageflow-sdk/tsconfig.json`, the rebuild carries that file's `paths` and `files` over, since TypeScript would otherwise drop them, and the app's rebuild first refreshes `.imageflow-sdk/` from the installed app.
- **Purity still applies:** a library may run freely in an [element editor](#element-editors). In a layout, asynchronous or GPU work such as drawing a map runs inside a [`<RenderedImage>`](#rendered-images); `render` itself stays synchronous ([Render function](#render-function)).
- **Stylesheets:** a package's CSS is bundled with the template's own, and inline `data:` images in it stay inline.
- Licences: `vendor/LICENSES/` holds each bundled package's licence file. Keep it when you share the template.

Rebuilding explicitly in the app or through MCP also refreshes the book's generated `.imageflow-sdk/` and `.claude/skills/imageflow-templates/` from the installed app, including removal of obsolete generated references. These folders are generated tooling; keep personal instructions elsewhere. Opening a book does not rewrite them. After updating ImageFlow, rebuild once to update local editor types and agent guidance; MCP reference topics always come from the installed app.

## Render function

`render(context)` is called per shown layout instance (the spread or one page) and must be a pure function of its input: no state, effects, timers, randomness, or data fetching. Rendering never changes the book's saved content. Work that loads declared external resources or finishes later, such as drawing a map, goes through [`<RenderedImage>`](#rendered-images), which the host runs, waits for and checks.

Book check and export enforce the parts of this that would make a printed page depend on something outside the book. While they render, a call from template code (including bundled libraries and module setup) to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `SharedWorker`, `importScripts`, a GPU canvas context (`webgl`, `webgl2`, `webgpu`, `bitmaprenderer`, on `HTMLCanvasElement` or `OffscreenCanvas`), `navigator.gpu`, `setTimeout`, `setInterval`, `requestAnimationFrame` or `requestIdleCallback` is a `render-impure` error naming the API and, when it happened while a layout rendered, its spread and page when applicable. Calls made in anchor and credit declarations are attributed the same way. PDF export reports such errors and asks for confirmation before saving. A 2D canvas is allowed. While a `<RenderedImage>` is drawing, these calls are its declared work and are not recorded. The editor's own previews and element editors are not checked, so an element editor may use these APIs (see [ADR 0006](https://github.com/wirhabenzeit/imageflow/blob/main/docs/decisions/0006-template-capabilities.md)). The check reports mistakes; it is not a sandbox, and the render frames' content security policy blocks other origins regardless.

```ts
type RenderContext = {
  params: SpreadParams;                     // this spread instance
  document: DocumentParams;
  boxes: Record<BoxId, {
    params: BoxParams;
    photo?: {                               // null for an empty box
      caption?: string; title?: string; credit?: string; altText?: string; width: number; height: number;
      captured?: { dateTime: string; offset: string | null };   // read from the file (see Photo metadata)
      location?: { latitude: number; longitude: number };
      camera?: { make?: string; model?: string };
    } | null;
    text?: { title?: string; part: number; parts: number; meta: TextMeta } | null;  // flow position and YAML header fields for Markdown boxes
  }>;
  elements: Record<ElementId, { params: ElementParams }>;
  page: { left?: number; right?: number; number?: number };  // page numbers: left/right, or number without facing pages
  side?: 'left' | 'right' | 'page';          // definite for a page() layout; see Page layouts
  format: ResolvedFormat;                   // trim, bleed, safe area in mm, for the chosen format
  formatId: string;                         // the chosen key of `formats`, or 'default'
  spread: string;                           // this spread's ID, its entry in book.spreads (the selected spread in a layout preview)
  layout: string;                           // the layout being drawn
  mode: 'edit' | 'export';                  // 'export' for export, Book check and MCP artwork
  view: 'canvas' | 'thumbnail' | 'layout-preview' | 'export';  // where this render is shown (see below)
  edit(...paths: EditPath[]): { 'data-edit'?: string };  // marks a node for click-to-edit
  geometry: BoundGeometry;                  // the geometry helpers with this format applied
  PhotoBox; MarkdownBox; Element;          // the platform components, typed to this layout's IDs
  Text;                                     // shows a string parameter and makes it editable
  book: {                                   // the whole book, as seen from this spread
    pages: number;
    anchor(id: string): Anchor | undefined; // the anchor with this ID (see Anchors)
    anchors(id?: string): Anchor[];         // all anchors with this ID, or all anchors, in page order
    spreads: BookSpread[];                  // every spread's pages and placed photos (see Book index)
    texts: BookText[];                      // every placed text, its header fields and boxes (see Texts)
  };
};
```

A page layout receives only its own state and page number. Render it in `<Page>` and use page-local geometry; [Page layouts](#page-layouts) describes the side and composition rules.

`mode` and `view` are fixed for the whole render. `mode` is `'edit'` for every render in the editor and `'export'` for PDF export, presentation, the Book check and MCP artwork (the Book check is `'export'` here, while `RenderedImage`'s own `mode` tells it apart as `'check'`). `view` says where an edit-mode render is shown: `'canvas'` is the interactive book, the only place anyone clicks; `'thumbnail'` is the sidebar and `'layout-preview'` the Inspector's layout previews, which show what the page will look like. `view === 'export'` exactly when `mode === 'export'`. Later versions may add views, so test for a view by name (`view === 'canvas'`, `view === 'layout-preview'`) and never treat the list as complete. Show editing scaffolding, such as a placeholder that invites a click, only on the canvas:

```tsx
{!chapters.length && ctx.view === 'canvas' && <p className="hint">Story spreads appear here.</p>}
```

A layout preview shows what the selected spread would look like in another layout, so a page that leaves out a picture until it has its data (a map without its GPX file, say) can place one there anyway, with a fixed view: ImageFlow shows the picture last drawn in that layout instead of drawing it ([Rendered images](#rendered-images)).

```tsx
if (!track && ctx.view === 'layout-preview') return <MapView view={countryView} />;
```

ImageFlow's own placeholders follow the same rule: empty `PhotoBox` and `MarkdownBox` placeholders, the `ctx.Text` empty state and the inherited-text underline appear only on the canvas. Thumbnails render empty content as export does; layout previews do too, except that an empty `PhotoBox` or `MarkdownBox` shows a small photo or text glyph so the layouts can be told apart before any content is placed. One difference to know when styling `[data-empty]`: `ctx.Text` carries `data-empty` only on the canvas, so in thumbnails and layout previews an empty text renders as in export, while empty `PhotoBox` and `MarkdownBox` boxes carry `data-empty` in every view.

### Caching expensive calculations

Pure does not mean every call has to start over. A template may cache the result of an expensive calculation that depends only on its arguments, such as parsing a GPX file, in a `Map` at module level, keyed by that input:

```ts
const tracks = new Map<string, Track>();
export function parseTrack(text: string): Track {
  let track = tracks.get(text);
  if (!track) { track = parseTrackText(text); tracks.set(text, track); }
  return track;
}
// Elsewhere: parseTrack(file(params.track)!.text)
```

- **Key by everything the result depends on:** the file's `text` from `file(id)`, not its ID, so a replaced file is parsed again.
- **Never change a cached result.** Every caller shares it; copy it before modifying.
- **Don't cache a failure.** A parse that throws should throw again, so every page that uses the file reports it.
- **A cache lasts for one render of the book.** The editor renders each change in new frames that load the template again, and the Book check and export render on their own. The cache saves repeated work within a render, such as a contents table and the pages it lists parsing the same files.
- **Keep no other state at module level.** Later versions may keep frames alive between edits ([#210](https://github.com/wirhabenzeit/imageflow/issues/210)); a cache keyed by its input stays correct then, while other module state would carry over from one revision to the next.

### Photo metadata

`photo.captured`, `photo.location` and `photo.camera` come from the photo file's EXIF data. Each is present only when the file records it in a usable form, and all three are read-only:

- **`captured`**: `{ dateTime, offset }`. `dateTime` is the camera's local wall-clock time, `YYYY-MM-DDTHH:mm:ss`, from the time the photo was taken (or, failing that, digitized), never the file's modification time. `offset` is the recorded UTC offset, such as `'+02:00'`, or `null` when the file has none. `null` means the time zone is unknown, not UTC: show `dateTime` as it is, and use `new Date(dateTime + offset)` for the instant only when `offset` is set. Placeholder dates such as `0000:00:00`, impossible dates and offsets outside −12:00 to +14:00 are left out.
- **`location`**: `{ latitude, longitude }` in WGS 84 degrees, north and east positive, rounded to 7 decimals. A coordinate without its hemisphere, out of range or with a zero denominator, or a fix the receiver marked void, gives no location.
- **`camera`**: `{ make?, model? }` as the camera records them, trimmed to at most 100 characters.

ImageFlow reads them from the original file whenever the book opens or a source changes, and never stores them in `photos.json`. Existing books therefore have them without re-importing anything, and replacing a linked photo's original refreshes them under the same photo ID, with crops and assignments unchanged. A photo without EXIF, or with EXIF ImageFlow cannot read, imports and renders as before. The user-written `caption`, `title`, `credit` and `altText` are separate and never overwritten. Writing an extracted field is rejected rather than ignored: in `photos.json` it is a validation error, and `set_photo_metadata` does not accept it.

The same fields appear on `ctx.boxes[id].photo`, on `ctx.book.spreads[].photos[].photo`, in custom editors' `context`, and in `inspect_book`'s `sources` view. [`photo-story.tsx`](examples/photo-story.tsx) builds a caption from them. Raw EXIF is not exposed.

## Rendered images

A picture that takes time to make, such as a map drawn by a WebGL library from remote tiles, renders through `<RenderedImage>` (included in the contract-1 baseline):

```tsx
import { RenderedImage } from 'imageflow';

<Element id="map" rect={rect}>
  <RenderedImage label="Map" inputs={{ style, longitude, latitude, zoom }} style={{ position: 'absolute', inset: 0 }}
    draw={async ({ width, height, pixelRatio, mode, signal }) => drawMap({ style, longitude, latitude, zoom }, { width, height, pixelRatio, signal })} />
</Element>
```

- **Drawing:** ImageFlow calls `draw` when the element mounts and again when `inputs` (JSON-like data, everything `draw` depends on) changes. It passes the box's size in CSS pixels (96 per inch), `pixelRatio` (device pixels per CSS pixel), `mode` (`'preview'`, `'check'` or `'export'`) and an `AbortSignal`. Resolve to a canvas, an `OffscreenCanvas` or an image `Blob`; ImageFlow shows it as an image that fills the box. Nothing is saved in the book.
- **Output:** `output="vector"` declares that `draw` returns SVG: it is drawn once for every view, at a `pixelRatio` of 1 (it does not depend on one), and returning pixels is an error. `output="raster"` declares pixels on purpose, such as satellite imagery or photographs. Without `output`, either is accepted, but a raster result is a `rendered-image-raster` Book check warning: a drawn picture such as a map or chart prints sharper and smaller as vectors, with the book's fonts. Prefer vectors for anything drawn.
- **Vector pictures:** resolve to SVG markup (a string), an `<svg>` element or a `Blob` of type `image/svg+xml`, and ImageFlow places the SVG into the page itself, not as an `<img>`, so the PDF gets vector paths and real text instead of pixels. Its text uses the template's own `@font-face` fonts and stylesheet like any other text on the page, so name the template's bundled families in `font-family` and keep to characters those fonts contain: PDF preflight rejects text that falls back to a system font. Stroked text (an SVG `stroke` on `<text>`, such as a label halo) prints as a Type 3 font, which preflight also rejects; draw a halo as filled copies of the text shifted around it instead. Like other SVG text, it is not part of the Book check's text-size and safe-area rules. The SVG needs a `viewBox`, which is scaled to cover the box as raster pictures are (`preserveAspectRatio="xMidYMid slice"` unless the SVG sets its own); a convenient choice is the target's `width` and `height` in CSS pixels. Its ids are made unique on the page, `<script>`, `<foreignObject>` and `on…` attributes are removed, and there is no resolution check. Because the SVG is part of the page, the template's CSS styles it too: colours written as `style="fill: var(--map-water, #cbd9d6)"` follow variables the layout sets, such as a colour theme's, without drawing the picture again (presentation attributes like `fill="…"` do not accept `var()`). Keep vector pictures to what the PDF needs: tens of thousands of paths are fine, millions make a slow, large PDF. The box carries `data-vector`; the capability is `rendered-vectors`.
- **Resolution:** previews draw at the screen's density (at most 2×; thumbnails and checks at 0.5×). Export draws at the format's target resolution ÷ 96, 300 ppi when the format sets none, so a picture is as sharp in the PDF as the format asks.
- **Waiting:** the Book check and every export page wait for all pictures on the page before they are final. Each picture may draw for 60 s (120 s in export), counted from when it starts drawing, not while it waits for others; the check or export waits as long as pictures keep finishing. In the editor and the presentation, only time the window draws counts: a hidden or minimised window, or one on another Space, gets no animation frames, which map libraries need to finish. In the editor, pictures fill in as they finish, over a striped placeholder, and the Book check lists failures as they happen and shows while pictures are still drawing. A failed picture shows its message over the picture drawn there before, if any; layered pictures that fail together, such as shaded relief under a map's lines, stack their messages. At most two draw at once in the book view and one elsewhere, so a long book does not open a GPU context per page.
- **Drawing again:** the picture is drawn again when `inputs`, the box's size or the output resolution changes. Each drawing uses the `draw` and values of the render that started it, so draw anything that must match the picture (such as a route over a map) from the same values as `inputs`.
- **Book view, thumbnails and presentation:** while a book window stays open, identical pictures can be reused across page switches, saves and presentations, in the book view as in the page and layout thumbnails. Cached pictures are restored before a replacement frame is shown, so editing one page does not blank or redraw an unchanged map on another. New pictures still draw progressively. This memory cache, shared by all open books, includes the layout, picture position, `draw`'s source, declared inputs, dimensions and pixel ratio. It is invalidated by changed network permissions, and by changed template code in the file that places the `<RenderedImage>` or in anything that file imports: an edit to a layout in `index.tsx` keeps a map placed from `map.tsx` cached, while an edit to `map.tsx`, a helper it imports or a package it uses draws the map again. Stylesheets are not counted, since vector pictures take the page's styles where they are placed; a raster picture that reads computed styles, or draws text in a template font, while drawing is not drawn again for a stylesheet edit. It holds an eighth of the computer's memory (1–4 GB), keeps each picture once, and stores raster pictures as WebP; a picture larger than 64 MB is drawn each time. The first view still needs to draw; checks, exports and printing always render afresh.
- **Layout previews:** the Inspector's layout previews show what each layout would look like for the selected spread. Drawing a map for every layout cost about a second per selected spread, so only the spread's own layout draws its pictures as they are (usually from the book view's copy). Another layout shows the same picture if it was drawn already, and otherwise the picture last drawn in that layout for another spread, so its preview has a real map, if not this spread's; a layout the book has not drawn yet is drawn once. Pass `standIn` (such as a schematic map) to show instead of drawing such a layout, or `layoutPreview="draw"` for a picture that must always match the spread, such as one that tells layouts apart. A page that places no picture until it has its data, such as a map without its GPX file, can place one in layout previews anyway (`ctx.view === 'layout-preview'`, [Render function](#render-function)), so its preview shows a real map too.
- **Cancellation:** `signal` is aborted when the element unmounts, a newer drawing replaces it, or the timeout passes; stop work and release GPU resources when it fires. A result after that is discarded, so an older drawing never replaces a newer one.
- **Too many pixels:** in a check or export, a raster picture with more than 1.25× the pixels the output asks for is scaled down to what it asks for before it is placed, and the check reports `rendered-image-oversized`. Drawing more than the target resolution only makes drawing slower; the PDF never gets the extra pixels.
- **Resolution:** a raster picture covers the box (`object-fit: cover`), so draw it at `width × pixelRatio` by `height × pixelRatio` pixels. A picture with fewer pixels on either axis fails with `rendered-image-failed`, since it would print blurred or stretched.
- **Failure:** throw or reject with a message, such as `Error('The map style could not be loaded.')`. The box shows the message, and the Book check reports `rendered-image-failed` for the element, so export stops instead of printing the page without its picture. Decide readiness yourself: the starter's map resolves on MapLibre's `idle` event and rejects on any `error` event, so a style or tile that failed to load fails the picture.
- **Network:** `draw` may reach the template's declared [`network`](#element-editors) origins once the user has allowed them; otherwise its requests are blocked and the picture fails. Its requests, WebGL contexts, workers and timers are not `render-impure`.
- `label` names the picture in messages (default `'Picture'`); `alt`, `className` and `style` apply to the box, whose class is `if-rendered-image` with `data-rendered="pending" | "ready" | "failed"`.

For a reusable map helper and vector-map example, see [SVG maps](#svg-maps).

## SVG maps

For a printable map, use `<RenderedImage output="vector">` with the starter template's `maplibre-svg` package. This is a template-local dependency, not an export of `imageflow` or a package to fetch from npm. The complete implementation is in `sample/starter/template/map.tsx`; `map-styles.ts` supplies palettes, contour tiles and attribution.

### Reuse the helper

Copy `sample/starter/template/packages/maplibre-svg/` into your template's `packages/maplibre-svg/`. Add `"maplibre-svg": "file:packages/maplibre-svg"` and the starter's pinned `maplibre-gl` version to `template/package.json` dependencies, then call `rebuild_dependencies`. Do not run npm install inside the template. The rebuild bundles the helper's TypeScript source and its declarations; no package build is needed. See [Dependencies](#dependencies).

Declare every style, tile, glyph and sprite origin in the template's `network`. The example below uses OpenFreeMap; a style with additional providers needs their origins too. Preserve the provider's attribution in the printed page or collect it through layout `credits` and `ctx.book.credits` ([Credits](#credits)).

### Minimal map element

This render fragment assumes a declared `map` element and a template with `network: ['https://tiles.openfreemap.org']`. Use it inside `<Page>` for a `page()` layout. Use the appropriate spread rectangle inside `<Spread>` for a spread layout.

```tsx
import { fonts, Page, RenderedImage } from 'imageflow';
import { drawMapSvg, projector } from 'maplibre-svg';

// The page must use this bundled font family (replace it with your own).
const labelFamily = 'Field Serif';
const safe = ctx.geometry.page('safe');
const rect = { ...safe, height: safe.height - 8 }; // reserve attribution space
const centre = { longitude: 17.75, latitude: 69.35, zoom: 8.5 };
const cssPerMm = 96 / 25.4;
const view = { ...centre, width: rect.width * cssPerMm, height: rect.height * cssPerMm };
const marker = projector(view)([17.75, 69.35]);

return <Page style={{ fontFamily: labelFamily }}>
  <ctx.Element id="map" rect={rect}>
    <RenderedImage label="Map" output="vector" inputs={view}
      style={{ position: 'absolute', inset: 0 }}
      draw={async ({ signal }) => {
        const module = await import('maplibre-gl');
        return drawMapSvg({
          maplibre: module.default ?? module,
          style: 'https://tiles.openfreemap.org/styles/positron', view, signal,
          // Inherit a bundled font from the page; omit characters it cannot set.
          text: label => fonts.settable(label, { family: labelFamily }),
        });
      }} />
    <svg viewBox={`0 0 ${view.width} ${view.height}`}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      <circle cx={marker[0]} cy={marker[1]} r="4" fill="#c8432b" />
    </svg>
  </ctx.Element>
  <p style={{ ...ctx.geometry.css({ ...safe, y: safe.y + rect.height + 2, height: 6 }), margin: 0, fontSize: '8pt' }}>© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors</p>
</Page>;
```

For the fonts helper's family/style arguments, see [Fonts and output](#fonts-and-output). Keep every changing draw input (including style and label options) in `inputs`. The marker and basemap must share the same view. The starter's editor saves longitude, latitude and print zoom as normal element parameters; an inset map on a split sheet is edited through MCP with the sheet ID and `page: 'left'` or `'right'`.

### Helper API and limits

- `drawMapSvg({ maplibre, style, view, signal?, ...options })` loads an off-screen MapLibre map, waits for tiles and label placement, returns SVG markup and releases the map. Tile/style failures reject; pass the host's abort signal.
- `mapToSvg(map, view, options?)` converts an already loaded, idle map.
- `projector(view)([longitude, latitude])` maps coordinates to the SVG's CSS-pixel viewBox. `view` contains longitude, latitude, zoom, width and height; size is CSS pixels at 96 per inch, not millimetres.
- Options: `font(stack)` chooses label classes/faces, `text(label, stack)` filters label text, `color(color, use)` maps paints (including CSS variables), `layers(layer)` filters layers, `avoid: [{ at: [longitude, latitude], radius }]` suppresses nearby basemap labels, and `className` styles the SVG root. Radius is CSS pixels.

The helper draws backgrounds, fills, flat extrusions, lines and symbol text. It omits icons, fill patterns, raster imagery, hillshade, line offsets and blur. It uses MapLibre's internal feature/style data, so keep the tested dependency version pinned and verify before upgrading. It does not provide a general rotated or pitched camera. Tracks, markers, custom labels and insets belong in your layout as SVG overlays. The starter demonstrates label fonts, terrain contours and theme-aware palettes.

Run `check_book` with `typescript: true`, then inspect page previews and export a PDF to check vector paths, labels, attribution and bundled fonts. MCP Book check does not run PDF print preflight. See [Rendered images](#rendered-images) for host SVG handling, font limitations, caching and failures.

## Click-to-edit

`ctx.edit(...paths)` marks the node that shows parameters, so clicking it in the editor opens a popover with a control for each parameter (text field, month or date picker, segmented choice, slider, colour). Spread the result onto the node:

```tsx
<h2 {...ctx.edit('heading')}>{ctx.params.heading}</h2>
<Element id="grid" {...ctx.edit('month')}>…</Element>
```

Paths name a spread parameter (`heading`), a document parameter (`document.paper`), an element parameter (`elements.grid.firstWeekday`), or a box parameter (`boxes.hero.showCaption`). With the `spread` builder, paths are type-checked. `<Element>` is an edit target for its own parameters without marking; marks on it add more. Outside the editor the marker stays as an invisible `data-edit` attribute, so checks can name the parameter a text block shows (for example in `text-overflows-box`); the Book check warns about paths the layout does not declare. Set `precision: 'month'` on a date parameter to edit it with a month picker; the value is the month's first day.

For the common case of one string parameter shown as text, `ctx.Text` reads the value and marks the node in one step:

```tsx
<ctx.Text parameter="heading" as="h2" presentation="inline" rect={ctx.geometry.page('right', 'safe')} />
<ctx.Text parameter="boxes.hero.credit" as="figcaption" presentation="inline" placeholder="Photo credit" />
```

Prefer `presentation="inline"` for a single user-written string printed on the page, such as a heading, label or caption: the user types it where it prints, in its own type ([inline-text](#inline-plain-text-inline-text)). Leave it out (the panel) when the string is better edited beside other controls, or is not visible text. At a zoom where the text is small on screen, ImageFlow opens the panel instead; zooming in first edits it on the page.

`parameter` takes the same paths as `ctx.edit`, limited to string parameters. `as` is one of `h1`–`h6`, `p` (default), `span`, `div`, `blockquote` or `figcaption`; `className`, `style`, `rect` and `issue()` markers work as on the platform components. When the value is empty, the editing canvas shows a dimmed placeholder in the template's own type (`placeholder`, else the parameter's `placeholder`, else its label) and marks the node `data-empty`; the exported book shows the empty node. The value is rendered as text, never as HTML, and newlines follow the node's CSS `white-space`. `fallback` displays inherited text when the saved value is empty or whitespace-only, without saving it. Set `fallbackLabel` to name its source: inherited text has a dotted underline on the canvas and the popover explains what clearing the override does. `hidden` suppresses the node explicitly; whitespace never means hidden. A template can bind it to a separate visibility parameter, as the calendar does with `showPlace`. Use `ctx.edit` for nodes that combine several parameters or show more than the value.

Templates read photo metadata (for captions) and page numbers through the context; they never receive file paths or image data, and they cannot change project data. Of a Markdown source they receive its header fields and, in a composition, its blocks ([Composing a text](#composing-a-text)).

## Anchors

A layout can declare anchors: places that other spreads refer to by ID, such as chapter openings for a table of contents or a map that a caption points to. Declare them with `anchors`, a function of the spread's saved values:

```tsx
story: spread({
  label: 'Photo and story',
  parameters: { heading },
  anchors: ({ params }) => [{ id: 'chapter', title: params.heading, side: 'right' }],
  render: (ctx) => …,
}),
contents: spread({
  label: 'Contents',
  render: (ctx) => <ol>{ctx.book.anchors('chapter').map((chapter) =>
    <li key={chapter.spread}>{chapter.title} · {chapter.page}</li>)}</ol>,
}),
// elsewhere: 'See the route on page ' + ctx.book.anchor('route')?.page
```

```ts
type AnchorDeclaration = { id: string; title?: string; side?: 'left' | 'right' };
type Anchor = { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' | 'page' };
```

- **One render pass.** Page numbers depend only on spread order and layout spans, never on rendered content. ImageFlow calls every spread's `anchors` with its resolved `params` and `document` values, its `boxes` as `render` sees them, its `spread` ID and the book's `texts` before any spread renders, so every layout reads the same anchors. Like `render`, `anchors` must be a pure function of its input. An `anchors` function that throws or returns an invalid declaration is a render error naming the layout.
- **Pages follow the book.** Inserting, moving, removing or switching a spread renumbers every anchor, as it does the folios. `side` picks the page of a two-page spread and defaults to the first. A single left or right page has only one page, whichever side is named. Without facing pages every unit is one page: `side` is ignored and the anchor's `side` is `'page'`.
- **Repeated layouts.** Anchors belong to spread instances, so a layout used five times declares five anchors with the same ID. `anchors(id)` lists all of them in page order. `anchor(id)` is for an ID that one spread declares.
- **Book check.** `anchor(id)` warns `anchor-missing` when no spread declares the ID, and `anchor-ambiguous` when several do. In that case it returns the first. Both warnings are on the spread that asked. `anchors(id)` returning an empty list is not a finding.
- **Previews.** Layout-picker previews read the anchors of the book as saved, so a contents layout previews with real pages.

A Markdown box's `boxes[id].text` carries its flow position and its source's [header fields](#text-metadata), so a layout can declare an anchor where a text starts, named after it:

```tsx
anchors: ({ params, boxes }) => {
  const title = typeof boxes.body.text?.meta.title === 'string' ? boxes.body.text.meta.title : params.heading;
  return boxes.body.text?.part === 1 && title ? [{ id: 'section', title }] : [];
},
```

A page without a Markdown box of its own, such as a route map facing its day's story, reads the book's texts: `anchors` also receives `book.texts`, as [`ctx.book.texts`](#text-metadata) lists them, and `spread`, the sheet's ID (with `side` for a page layout), as `render` does:

```tsx
anchors: ({ spread, book, params }) => {
  // The text that starts on this sheet's other page.
  const day = book.texts.find((text) => text.boxes.some((box) => box.spread === spread && box.part === 1));
  const title = typeof day?.meta.title === 'string' ? day.meta.title : params.heading;
  return title ? [{ id: 'stage', title }] : [];
},
```

Both are read from the saved book before any spread renders and are frozen, like the boxes.

An anchor marks a whole page, not a point found by measuring the render. Text flow decides which page a heading inside Markdown continuation lands on, so such headings cannot be anchors yet.

### Book index

`ctx.book.spreads` lists every spread of the book in order, with its pages and the photos placed on it, for photo credits, picture indexes and contents pages. No anchors are needed for it:

```ts
type BookPhotoPlacement = { page?: 'left' | 'right'; box: string; photoId: string | null; photo: Photo | null };
type BookSpread = {
  id: string;                                  // the spread's stable instance ID
  layout?: string;                             // the shown spread layout; absent when split
  pages?: Partial<Record<'left' | 'right', { layout?: string; photos: BookPhotoPlacement[] }>>;
  page: { left?: number; right?: number; number?: number };  // as ctx.page
  photos: { page?: 'left' | 'right'; box: string; photoId: string | null; photo: Photo | null }[];
};
```

```tsx
for (const spread of ctx.book.spreads)
  for (const { photo } of spread.photos) if (photo?.credit) credits.push([photo.credit, spread.page.left ?? spread.page.number]);
```

[`photo-story.tsx`](examples/photo-story.tsx) has a complete credits layout; the photobook starter's *Picture list* page lists every photo once with its pages and credit. It works out each entry's height from its text before rendering, so it knows where every entry goes: the list continues across every *Picture list spread* in book order, the last one reports `template:picture-list-full` in the Book check when photos are left over, and `template:picture-credit-cut` names a photo whose credit or page list is too long to show in full. To find or leave out the current spread, compare with `ctx.spread`: `ctx.book.spreads.filter(({ id }) => id !== ctx.spread)`.

- **From saved data, before render.** Like anchors, the index is built from the saved book and the template's declarations before any spread renders. It never looks at another spread's rendered output, so every spread, the editor's context, MCP artwork and export read the same index, and the same book always gives the same index. It is frozen; changing it throws. The Inspector's layout previews redraw when it changes, such as when a photo is placed or its credit edited on another spread.
- **Pages.** `page` is the spread's own `ctx.page`: `left` and `right`, one of them for a single page at a book end, or `number` in a format without facing pages. For a spread layout, which page a box is on is the layout's business. On a split sheet each placement carries `page`, and `pages.left`/`pages.right` expose the shown page layout and photos independently.
- **Photos.** `photos` lists the photo boxes of the spread's current layout, in declaration order, including empty ones. `photoId` is `null` for an empty box. `photo` is the photo's metadata, the same object shape as `ctx.boxes[id].photo`, or `null` when the box is empty or its photo is missing from the book. A photo placed in several boxes appears once per placement. Content a spread keeps from a layout it no longer uses is not listed, and a spread whose layout the template no longer declares lists no photos. Markdown boxes are not listed.
- **No images.** The index has metadata and assignments only, no photo URLs or rendered thumbnails.

#### Texts

`ctx.book.texts` lists every Markdown source the book places, in the order the book first shows them, with its [header fields](#text-metadata) and the boxes it flows through. A page without a Markdown box of its own reads a text's header here: a map marks the places of the story on its facing page, a photo page between two story pages carries their running header.

```ts
type BookTextPlacement = { spread: string; page?: 'left' | 'right'; box: string; part: number;
  pageNumbers: { left?: number; right?: number; number?: number } };
type BookText = { id: string; title?: string; meta: TextMeta; boxes: BookTextPlacement[] };
```

```tsx
// The text on this sheet's other page, or around this page: the last text that starts before it.
const page = ctx.page.left ?? ctx.page.right ?? ctx.page.number ?? 0;
const pagesOf = (text: BookText) => text.boxes.flatMap(({ pageNumbers: n }) => [n.left, n.right, n.number]).filter((p) => p !== undefined);
const beside = ctx.book.texts.find((text) => text.boxes.some((placed) => placed.spread === ctx.spread && placed.page !== ctx.side));
const around = ctx.book.texts.findLast((text) => Math.min(...pagesOf(text)) <= page);
const places = (beside ?? around)?.meta.places;
```

- **Example.** The photobook starter's *Inset map* marks the `places` of the story on its facing page, in print and in its map editor, and reports `template:places-invalid` for entries it cannot mark. Its *Story* page names its `section` anchor after its text's `title` where the text starts.
- **The template chooses.** Which text a page belongs to is the layout's decision: the one beside it, the one whose pages surround it, or one a parameter names by its `id`. ImageFlow lists facts and decides nothing.
- **Pages.** `pageNumbers` are the book pages of the box's spread, or of its page on a split sheet, as `ctx.page`. Which page of a spread layout a box is on is the layout's business. `part` is the box's place in the chain, as its `text.part`: assigned boxes count whether or not the text reaches them.
- **Same rules.** Like `spreads`, the list is built from the saved book before any spread renders and is frozen. Only shown layouts' boxes are listed, and a source whose file is missing is listed with `meta: {}`.

Page layouts declare anchors for their own page, whatever `side` their declaration names. Two page layouts on one sheet may therefore declare two anchors with the same ID. Use `anchors(id)` when that is intentional; `anchor(id)` warns about ambiguity per asking page. Only shown page layouts contribute anchors and credits; remembered hidden layouts do not.

### Credits

A layout declares what its spreads use that needs a credit, such as the data behind a map, with `credits`. Like `anchors`, it is a pure function of the spread's saved values, here with its boxes' and elements' values too (`boxes[id].params`, and a photo box's `boxes[id].photo` metadata or null), called for every spread before any spread renders:

```tsx
map: spread({
  elements: { map: { label: 'Map', parameters: mapParameters } },
  credits: ({ elements }) => [
    { id: 'openstreetmap', text: 'Map data © OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
    ...(elements.map.params.style === 'lines' ? [{ id: 'mapterhorn', text: 'Elevation © Mapterhorn' }] : []),
  ],
  render: …,
}),
```

`ctx.book.credits` lists them for the whole book: each `id` once, with the `text` and `url` of its first declaration, the `pages` of every spread that declares it (sorted, without repeats) and those `spreads`, in the order the book first uses them. It is frozen and the same on every spread, so a credits page prints exactly what the book uses, and nothing it does not.

IDs are whitespace-free tokens; a declaration with spaces in its ID is rejected. `side: 'left' | 'right'` credits only that page of a two-page spread, such as an inset map on the right page (`{ id: 'openstreetmap', text: '…', side: 'right' }`); without it, the credit covers both pages. When a later spread declares an ID with other `text` or `url` than the first, the book keeps the first and the Book check warns `credit-conflict` on that spread and page when applicable, so give different credits their own IDs, such as `'photo-' + photo.credit`.

Mark the node that prints credits with `data-credits` and their IDs, space-separated, such as `data-credits={ctx.book.credits.map(({ id }) => id).join(' ')}`. When the whole book renders, the Book check warns `credit-unprinted` for each credit the book uses that no page marks, on the first spread that uses it, so moving credits off the maps onto a credits page never loses them. The starter prints one consolidated map-resource attribution at the foot of its last page, the Picture list, which is the only layout it offers there. It prints each resource text once without page numbers; page usage remains available in the structured index for diagnostics. Terrain attribution is included only when a map style uses it.

## Editing UI

Saved data and its editing UI are separate. Parameters declare what is saved: IDs, types, defaults, constraints and scopes, which persistence, validation, Undo and project commands (including MCP) rely on. How they are edited is chosen at three levels, from no code to custom UI. Choose the smallest level, and the smallest editor, that does what was asked: a request for a changeable emoji is one string parameter (and a size if wanted), not a choice between emoji, text and uploaded artwork. [`editing-levels.tsx`](examples/editing-levels.tsx) shows all three.

1. **Generated controls (default).** Every parameter gets a control: text field, switch, slider and number, segmented choice or menu, colour, date or month, file chooser with import. Nothing to write.
2. **Arranged controls.** `controls` on the template, a spread, a box or an element arranges the generated controls of that scope's parameters: order, titled groups, labels, descriptions, and conditions. At the template level it arranges the document parameters in Book settings, below the fixed format choice.

   ```tsx
   controls: ['show', { group: 'Stamp', when: { show: true }, controls: [
     'text', { parameter: 'tilt', label: 'Rotation', description: 'Negative values turn it counter-clockwise.' }, 'ink',
   ] }],
   ```

   An entry is a parameter ID, `{ parameter, label?, description?, when? }`, or `{ group, description?, controls, when? }`. `when` names other parameters of the same scope and the values they must have (all must match; an array matches any of its values). For boxes, pass `controls` as `box.photo(label, parameters, { controls })` or in `box.markdown`'s options.
   - A parameter left out of `controls` gets no generated control. It keeps its value, its validation and its project commands, so use this for values only a custom editor or an agent sets. A document parameter left out of a non-empty template-level `controls` list loads with a `declaration-control-missing` warning in the Book check, since a new setting is easily forgotten there. A document editor's own parameters, and parameters a spread marks on the page as `document.<id>` with `ctx.edit` or `ctx.Text`, are exempt.
   - `controls: []` shows no generated controls for the scope while keeping every declaration. A group needs at least one entry.
   - A condition only hides a control. The value stays saved and validated, and comes back when the condition holds again. Conditions are presentation: they never remove a declaration or change a saved ID.
   - Click-to-edit follows the box's or element's `controls` for its own parameters. A parameter a node explicitly shows with `ctx.edit` or `ctx.Text` is always editable on that node.
   - The authoring types check entry IDs against the scope's parameters. Loading the template reports unknown or repeated IDs, a parameter a custom editor owns (an element editor's, or a document editor's at the template level), conditions on unknown parameters, on the control's own value, or on values the parameter can never have.
   - Controls that can hide themselves for good load with a `declaration-control-cycle` warning in the Book check: a control inside a group shown only depending on that control (a group shown while `show` is on that contains `show`), or controls whose conditions depend on each other (A shown only when B is on, B only when A is on). For layout (spread) parameters, the warning is given per spread: a spread that marks one of them on the page with `ctx.edit` or `ctx.Text` gets none, since that node's popover always shows it, while another spread of the same layout that marks none of them (for example because its values hide the marked node) gets the warning on itself. Marking a box's or element's own parameter does not count: its popover follows the same `controls` and conditions. For document parameters, the warning is dropped when any spread marks one of the cycle's parameters as `document.<id>`, since that node's popover shows it from any page.
3. **A custom editor** for an element, below.

Presentation uses the export artwork path (`ctx.mode === 'export'`), including final text flow and crop geometry. Templates should omit editing scaffolding there, just as for PDF output.

Photo capture time, location and camera are described under [Photo metadata](#photo-metadata). The editor's photo views also sort and group photos that have no EXIF capture time by their file's modification time, shown as an estimate; that estimate is editor-only and never reaches templates. Photo views compare camera wall times as shot, and show estimated modification times in the computer's local timezone, so mixed cameras and file dates group consistently. Sorting and grouping are per-book view preferences and do not change the rendered book.

### Where editing happens

Click a box, element, or marked node to edit it. Generated item controls and photo controls share a fixed position at the bottom center of the visible canvas; the selected item remains outlined on the page. The sidebar lists items without repeating their controls.

- **Photo boxes:** clicking a placed photo selects it to drag and pinch. Its toolbar has a **More photo actions** menu for **Replace photo…**, **Remove photo**, and **Crop values…**, alongside the box's own parameters and any other parameters the template marks the box with (such as a spread setting shown in its caption). An empty photo box (or one whose frame the template rotates) opens a popover with **Choose photo** and the same settings.
- **Markdown boxes:** clicking one opens a popover with its text (assign, import, show), its place in the text flow, its parameters and any parameters the template marks it with.
- **Elements:** an element with a custom editor opens it at the same bottom-center canvas position, with a scrolling body and a fixed header with × to close. The canvas stays scrollable, and the element's other parameters appear below the custom controls. Spread parameters the editor declares in `spread` are edited there too; other spread parameters marked on such an element stay in the sidebar. Any other element opens a popover with its generated controls.
- **Marked nodes:** a node marked with `ctx.Text` or `ctx.edit` opens a popover for those parameters. A node smaller than the box under it wins, so a heading over a photo edits the heading. A parameter may be shown by several nodes, such as `ctx.Text parameter="heading"` on both pages: each is its own place to edit, the selection outline follows the occurrence clicked and Tab reaches each, while all of them edit the same saved value. The sidebar lists the parameter once.
- **The sidebar** holds the spread's layout, the spread parameters nothing on the page edits, content kept for other layouts, and a list of what the page edits: marked nodes such as `ctx.Text` headings (in reading order), then the declared boxes and elements. The list shows what each holds and opens the same editors, so empty, overlapping and keyboard users reach everything. Boxes and elements are told apart by identity, never by position, so two at the same place each edit their own values. A box or element the layout does not render right now opens the same bottom panel with its declared parameters and a note that it is hidden. Format and document parameters live together in the template controls, named for the template. The app header uses the book’s file name. Menus open the editing surfaces; they do not duplicate custom controls.

## Element editors

An element can supply its own editor for parameters that generated controls handle poorly, such as marking days in a calendar or panning a map:

```tsx
const calendar = { month, firstWeekday, marked };
function CalendarEditor({ values, set, readOnly }: ElementEditorProps<typeof calendar, 'month' | 'marked'>) {
  // Render any UI; call set({ ... }) to apply a change. The book preview updates while the editor stays open.
}

elements: { grid: {
  label: 'Calendar grid',
  parameters: calendar,
  editor: { label: 'Edit calendar', parameters: ['month', 'marked'], component: CalendarEditor },
} },
```

- **Opening it:** clicking the element opens a non-modal panel, and so does the element's entry in the sidebar's list. With `presentation: 'inline'` it opens [on the page](#editing-on-the-page) instead.
- **Layout parameters with it:** a task can need a layout (spread) parameter too, such as a title shown with a calendar. List those in `spread`: `editor: { parameters: ['month', 'marked'], spread: ['title'], component }`. The editor reads all layout parameters as `spread`, changes the listed ones with `setSpread(changes)` or `<Control parameter="title" scope="spread" />`, and applies those changes immediately. They stay layout parameters: saved data, MCP's `set_parameter` and other layouts that declare them are unchanged; only where they are edited moves. A listed parameter gets no sidebar control and may not appear in the layout's `controls`; each one belongs to one editor. Document settings stay read-only to element editors; a [document editor](#document-editors) edits them. Included in the contract-1 baseline.
- **One editor for the element:** parameters the editor lists are edited only by it. The element's other parameters appear below it as generated controls (arranged by the element's `controls`). Both apply valid changes as they happen; the editor's `values` follow the generated controls too. Clicking × or outside the panel first applies anything still being typed in the editor's frame, including in `<Control>` fields. If the editor fails while applying, or does not answer within a few seconds, the panel stays open with an error; after a timeout, × closes it directly. Changes already applied remain saved.
- **Typed props:** `ElementEditorProps<P, K, D, S, SK>` types the props from the element's parameters `P`, the IDs the editor lists `K`, optionally the template's document parameters `D`, the layout parameters `S`, and the layout IDs the editor lists `SK`. `spread`, `setSpread` and `Control` with `scope="spread"` use those layout types and owned IDs. `values` and `document` then have each parameter's type (an enum's options, a number, a string), `set` accepts only the editor's own parameters with values of their type, and `Control` only the editor's own parameters, so `set({ zoon: 2 })`, `set({ size: 'huge' })` for an enum without that option, or `<Control parameter="opacity" />` for a parameter the generated controls edit fail type checking. An editor typed for other parameters than its declaration lists fails too. Declare the parameters as a constant to write `typeof calendar`; an editor written inline in `editor.component` is not typed from the declaration, so annotate its props the same way. `ElementEditorProps` without type arguments keeps the untyped props.
- **Sandbox:** the component runs in a frame on the render origin with the template's CSS, like the book previews. It receives `values` (all of the element's parameters, with the draft applied), `set(changes)`, `spread` and `setSpread(changes)` (above), `document`, `format`, `readOnly`, `commit()`, `cancel()`, `Control` and `importFile`. It cannot change project data itself.
- **ImageFlow's controls inside:** `<Control parameter="track" />` draws the app's own control for one of the editor's parameters, bound to the draft: the same field, slider, choice or file chooser (with import) as the generated controls, with their validation and accessibility, in the editor's appearance. Compose it with your own UI instead of rebuilding file handling or form controls. `label` overrides the parameter's label. For a choice that is not one parameter, [`<Choice>`](#app-controls) draws the app's segmented control.
- **Files:** `importFile(accept)` asks the app to import a file into the project and resolves to its file ID, or `undefined` when the user cancels; `<Control>` for a file parameter uses it for **Choose file…**. Assign the ID with `set` to save the assignment immediately; Undo can revert the assignment while keeping the imported file in the project. `file(id)` reads the new file at once.
- **What ImageFlow owns:** the non-modal panel, × to close, Escape and ⌘↩, read-only mode, validation against the parameter schema, and saving. Each valid `set()` or `setSpread()` change is undoable. Closing leaves applied changes in place. Escape discards only uncommitted typing.
- **Applying and closing:** `set()` applies changes immediately, so `set({ ... }); commit()` applies those changes and closes; `values` catches up on the next render. `commit()` finishes the active field and closes. `cancel()` closes without applying the active field; it does not revert earlier changes. These callbacks remain available to existing custom components.
- **Changes `set()` and `setSpread()` cannot make:** a key that is not one of the editor's parameters, or a value the parameter does not allow (an enum value outside its options, a number out of range), is not applied. The other changes in the same call are. Each such problem is reported once, in the frame's console and in the dialog, with the parameters the editor edits or the values the parameter takes; it does not prevent valid edits or closing. `<Control>` for a parameter the editor does not own fails the editor with a message listing the ones it does.
- **Context:** `context` is the spread the editor was opened from, read-only, with the same values `render` reads: `spread` and `layout` (its ID and layout), `params`, `document`, `boxes` (with each photo's metadata and each Markdown box's flow position and header fields), `elements`, `page`, `book` (page count, anchors, spreads and texts), `format` and `formatId`. The editor's own draft is applied to it: an element editor's element values (including the generated controls' draft) and the layout parameters it owns, or a document editor's own document parameters. The top-level `format` and an element editor's `document` are the context's, so they follow it too. Write helpers that need the page's place in the book against `Pick<RenderContext, 'page' | 'book' | 'document'>`, so `render` and the editor share them instead of saving a second, possibly inconsistent value. Included in the contract-1 baseline.
- **The context follows the book; the editor's values do not.** While the editor is open, every newer render of the book refreshes `context`: moving the spread, another photo, another format, or a changed document setting the editor does not edit. The draft is kept and nothing is reported. A change to the values the editor edits is a conflict, handled as below. Deleting the spread closes the editor.
- **Changes from elsewhere:** if what the editor works on changes while it is open (a saved value after Reload or Undo, or a template edit that changes a default or a declaration of the parameters it handles), the panel says so and refuses to save; the user reopens the editor on the current values. During a reload, controls pause visibly and resume when the preview is ready. A rejected or failed save also pauses the editor with a message; reopening starts from confirmed saved values.
- **Failures:** if the component throws while rendering, in an event handler or in async work, the panel shows the error and keeps Close available. Earlier applied changes remain saved. The editor counts as loaded once the component has mounted.
- **Network:** a template may list HTTPS origins in `network`, such as `network: ['https://tiles.openfreemap.org']` (or `https://*.example.com` for subdomains; no paths). Importing the template into the library lists these sites, with an option to allow them in every book made from that version; **Templates → Manage Templates…** shows them and can allow them or stop allowing them later. That library trust belongs to the template's hash: a book whose template still has exactly that hash needs no question. Built-in templates are trusted for the sites they declare, and so are the built-in templates of every earlier release, so a book made from an earlier version of a built-in template needs no question after an update changes it. A book you make with **New Book** from such a trusted template (or from one without sites) is yours: its template reaches every site it declares without asking, including sites you or your agent add later, and a newly declared site is only named in a notice. A book from elsewhere asks once, the first time it renders or one of its element editors opens: **Trust This Book** makes it yours from then on; until then the book stays offline, its [rendered images](#rendered-images) that need the sites fail, so the Book check reports them and export stops (each failure names, in `details.networkPending`, the sites that wait for the user's permission), and the question comes back when an editor opens. **Templates → Stop Trusting This Book's Template…** withdraws that trust. Once allowed, the book's element editors, previews, thumbnails, Book check and export may fetch, load images and fonts from, and open blob workers for the declared origins; undeclared origins stay blocked. Revoking the trust in Manage Templates renders open books again under the new policy, loads an open element editor again, and stops a running export, which then saves nothing. Printing such a book needs the network. Included in the contract-1 baseline.
- **Scope today:** the element's parameters and the layout parameters it lists, shown in a non-modal panel (`presentation: 'dialog'`, the default) or [on the page](#editing-on-the-page) (`presentation: 'inline'`); a sidebar placement is not available yet. Editors can read files of file parameters with `file()`, and reach remote resources only through `network`. The photobook starter's **Map** layout has a reference editor (below). The file-control smoke test uses a separate route editor fixture (`scripts/fixtures/route.tsx`) to check choosing a track and framing its viewport together.

The **Map** layout (`sample/starter/template/map.tsx`) is the full-capability example ([ADR 0006](https://github.com/wirhabenzeit/imageflow/blob/main/docs/decisions/0006-template-capabilities.md)). The map uses OpenFreeMap tiles, declared in `network`, in book styles drawn for print (in `map-styles.ts`: quiet palettes without icons, place names in the book's fonts) and OpenFreeMap's own Liberty, Bright and Positron. The default, Book, follows the book's colour theme: its SVG names each colour by its palette role as a CSS variable (`maplibre-svg`'s `color` option), and the map element sets the variables from the theme's palette, so switching between the light and the dark theme recolours the map without drawing it again; Lines follows the theme too, in the page's own colour variables (ink, muted, rule, accent and paper): contour lines of the terrain, shores, rivers, roads and borders as lines, water as a faint wash, for a map that sits on the page. Its contours come from Mapterhorn's open terrain tiles (also declared in `network`, credited in the attribution), which the `maplibre-contour` package turns into contour lines inside MapLibre, so they print as vector paths too; it is the default of the **Inset map** layout, which insets the map inside a single page's margins and can face a story or any other page design. Paper, Ink, Atlas and Night are fixed palettes. A line layer on areas (a shore, say) leaves out the edges where tiles cut the area, and area fills get a hairline of their own colour so their tile edges never show as seams. Its editor runs MapLibre GL from the saved dependency bundle, shows the same palette with real colours, and is shown [on the page](#editing-on-the-page): dragging and zooming frame the map in its printed place, with the tracks, the attribution and the map title where the page draws them. It owns the view (longitude, latitude and a print zoom that is independent of the screen size), saved as ordinary parameters as you move it; its list of GPX tracks (each with a colour and a label), its country names, the style and the track width are generated controls in its toolbar, where each list is a button such as *Tracks (n)* that opens it. The base map names each country at one point, often outside a regional map; a country name (a name with a longitude and latitude) sets it where the map should show it, and the base map's labels give way to it. A button beside the zoom buttons fits the view to all tracks. The layout draws the map with a [`<RenderedImage output="vector">`](#rendered-images) through `maplibre-svg`, a small package in the template's `packages/` folder ([dependencies](#dependencies), linked with `file:`): MapLibre loads the style and tiles and places the labels off screen, and `drawMapSvg` writes the drawn features out as SVG paths, and labels the page sets in the book's fonts (a class per label role, styled in `styles.css`, with `fonts.settable` keeping only what those fonts can set). Icons, fill patterns and raster relief are left out. The package draws only the base map; what the book adds goes on top in the layout, drawn with `projector(view)` from the same package so it lines up: the starter's GPX tracks, and in your own template markers, names or insets. `avoid` keeps the base map's labels clear of such markers, and `layers` leaves style layers out. A map that cannot be drawn, for example because the map server is down, fails the Book check with `rendered-image-failed`.

For setup, a minimal vector map, helper options and supported layers, see [SVG maps](#svg-maps).

## Document editors

A template can supply an editor for document parameters, for values that belong to the whole book but are best edited where the book shows them. The wall calendar's marked dates are one document parameter, edited by clicking the days of any month page:

```tsx
function MarkedDaysEditor({ values, set, context }: DocumentEditorProps<typeof documentParameters, 'markedDates'>) {
  const month = monthFor(context); // the same helper the month page's render uses
  // ... toggle a date of `month` in values.markedDates with set({ markedDates }) ...
}

export default defineTemplate({
  parameters: documentParameters,
  editors: { markedDays: { label: 'Marked days', parameters: ['markedDates'], component: MarkedDaysEditor } },
  spreads: ({ spread }) => ({
    month: spread({ /* ... */ render: (ctx) => <ol {...ctx.edit('document.markedDates')}>{/* the days */}</ol> }),
  }),
});
```

- **Opening it:** a node marked only with document parameters one editor owns, such as `ctx.edit('document.markedDates')`, opens that editor in the same non-modal panel as element editors, at the bottom of the canvas, with the clicked spread's `context`. So does the node's entry in the sidebar's list. A node that also shows other parameters keeps its popover.
- **Ownership:** each document parameter belongs to at most one editor, and the editor's parameters get no generated control in the template controls, which say where they are edited instead. They stay ordinary document parameters: saved data, validation, Undo and MCP's `set_parameter` are unchanged. Loading the template reports an editor that names an undeclared parameter, or a parameter two editors claim.
- **Props:** `values` (only the editor's own document parameters, with the draft applied) and `set(changes)` for them. Every other setting is read from `context.document`, so there is one current copy of each; the calendar's picker reads its language there. The other props are `context`, `format` (the context's), `readOnly`, `commit`, `cancel`, `Control` and `importFile`, as for element editors. There is no `spread` or `setSpread`; a document editor edits only document parameters. `DocumentEditorProps<D, K>` types the props from the document parameters `D` and the IDs the editor lists `K`.
- **Conflicts:** the rules of element editors apply, with the document editor's own parameters as its values. The context refreshes on a reorder, another photo, another format or another document setting. An outside change to the parameters it edits (Undo, Reload, an agent) stops it until it is reopened. Deleting its spread, or switching that spread to another layout (which removes the node it was opened from), closes it. A save queued before such a change is not applied, so an old draft never overwrites newer values.
- **Example:** the calendar starter's day picker, shown [on the page](#editing-on-the-page): clicking a day on a month page marks it and turns that column of days into buttons, in the page's own type (the click that opens a document editor on the page also acts in it, at the same place). A click marks a date once, for the year of the page, or unmarks it; ⌥-click marks or unmarks it every year. A plain click never changes a yearly mark. In the panel (its fallback) it is a month grid with a list that offers *Unmark every year* (or *Mark every year* for a one-off date). Removing a yearly mark keeps a one-off mark of the same day. The full text stays available under *All marked days*. Included in the contract-1 baseline.

## Editing on the page

An element editor or a document editor can ask to be shown on the page instead of in the panel, with `presentation: 'inline'`:

```tsx
export default defineTemplate({
  contract: 1,
  // ...
  elements: { map: { label: 'Map', parameters: mapParameters,
    editor: { parameters: ['longitude', 'latitude', 'zoom'], component: MapEditor, presentation: 'inline' } } },
});
```

- **Where it is drawn:** the component runs in its own sandboxed frame, as in the panel, placed over what it was opened from: the element, or for a document editor the marked node that was clicked (the calendar's column of days). The frame has that rectangle's printed size in CSS pixels, so the template's CSS in millimetres and points applies as on the page, and ImageFlow scales it with the page. It follows the page as it scrolls, zooms, resizes and re-renders, and as the format or layout changes the rectangle. Nothing in it is remounted by saving, by the book redrawing or by moving the canvas: a map keeps its camera, a field its focus. While the editor shows, the page hides that occurrence's own artwork, so nothing is drawn twice; the rest of the page stays visible around it, and shows through wherever the editor draws nothing. Artwork drawn over the rectangle by other nodes (a title over a map) is covered by the frame; draw it in the editor too if it matters for the composition, as the starter's map does with its title.
- **What the component receives:** the same props as in the panel, plus `presentation` (`'inline'` or `'dialog'`), so one component can serve both, such as the calendar's day column on the page and its month grid in the panel. Fill the frame (`position: absolute; inset: 0`), draw what the page draws, and make it interactive. The frame's background is transparent and its content uses light artwork colours; the panel's `--if-editor-*` appearance variables do not apply to page artwork. `--if-inline-scale` on the frame's root is the page's current scale, for UI that should keep its screen size whatever the zoom, such as map buttons: `zoom: calc(1 / var(--if-inline-scale))`.
- **Appearing without a flicker:** the page keeps its artwork, and the editor stays out of view, until the editor has mounted, its fonts have loaded and it has painted; closing removes the editor only once the page shows its artwork again. An editor that still loads something to draw, such as a map's first tiles, passes it to `waitUntil(promise)` while mounting; the editor appears when it settles, after a few seconds at most. `waitUntil` does nothing in the panel.
- **The other parameters:** an element's parameters the editor does not own are generated controls in a toolbar under the canvas, like the photo toolbar, with *Done*. A problem (a rejected change, a conflict, a failure, read-only) shows above the toolbar; nothing on the page moves.
- **Gestures and keys:** pointer, wheel and pinch gestures and keys inside the frame belong to the editor: they never select, crop or move what is under it, and book shortcuts do not run. The page outside it scrolls as usual. The frame takes focus when it opens. Escape closes it, discarding only unfinished typing; ⌘↩ and *Done* finish the active field and close. Clicking elsewhere on the page finishes the active field first, then acts on that click. Changes already applied stay saved, and each is one Undo step, as in the panel.
- **Where it falls back to the panel:** an element whose template CSS rotates, skews or mirrors it (its on-page rectangle is only a bounding box), one too small to use on screen, or one not on the page opens in the panel, with the same component and `presentation: 'dialog'`. So does every editor of a template that does not ask for `'inline'`. The sidebar's list of a spread's elements opens the same editor as a click on the page.
- **Output stays pure:** the inline editor exists only in the editing view. Thumbnails, the Book check, clean MCP artwork and PDF export never contain it or its toolbar, and always draw the saved values with `render`.

### Appearance in custom editors

Custom editor frames follow the app's appearance automatically, including changes while a dialog is open. The app's Settings offer Light, Dark, or System (the default, following macOS). No appearance attribute or opt-in is needed. Editors must support both light and dark appearances: inherit the host's text and background colors, and use its CSS variables for custom surfaces, controls and states:

```tsx
<div style={{
  color: 'var(--if-editor-text)',
  background: 'var(--if-editor-background)',
}}>…</div>
```

Available variables: `--if-editor-background`, `--if-editor-text`, `--if-editor-muted`, `--if-editor-control`, `--if-editor-border`, `--if-editor-selection`, `--if-editor-accent`, `--if-editor-focus`, `--if-editor-marked-background` and `--if-editor-marked-text`. They update live without recreating the editor or committing its draft. The calendar starter's day picker demonstrates both surfaces and selected states. Theme variables are scoped to the editor host; use explicit authored colors for book artwork. Never apply editor appearance styles to `.if-sheet`, print output, or template artwork.

## File parameters

A parameter can refer to a file the user adds to the project, for input that is not photos or Markdown, such as a GPX track for a map:

```tsx
import { file, p } from 'imageflow';

elements: { route: { label: 'Route map', parameters: { track: p.file({ label: 'GPX track', accept: ['.gpx'] }) } } },
render: (ctx) => {
  const track = file(ctx.elements.route.params.track);   // { name, extension, text } or undefined
  …
},
```

- **Choosing:** the generated control lists the project's files with an accepted extension, offers **Choose file…** to add one and **Remove** to clear the assignment. Imports follow the book's **Assets → Copy Assets into Book** setting and register a copied or linked file in `project.json`; assigning it is a normal edit. Undo removes the assignment and keeps the file; clearing never deletes a file.
- **Value:** the file's ID in the project's `files` registry, or `''`. Paths in the registry are relative to the project, so moving the project folder keeps its files.
- **Content:** `file(id)` returns the file's name, extension and UTF-8 text, read when the project loads (files are limited to 20 MB). Preview and export render from the same text. It returns `undefined` when nothing is assigned or the assigned file cannot be read.
- **Diagnostics:** ImageFlow reports an assigned file that is no longer registered, missing or unreadable, or whose extension is not in `accept`, as a Book check error for that element, which requires confirmation before PDF export. An unassigned file parameter is valid. The template parses the content. If it cannot, it should render without it and report a [template finding](#template-findings) that names the element, parameter and file.
- **Example:** the starter's Map layout draws a list of GPX tracks ([List parameters](#list-parameters)) over a basemap it renders (see [Element editors](#element-editors)). A sample GPX file is available at `sample/starter/files/senja-road.gpx`.

## Template findings

A template reports problems with its input, such as an assigned file it cannot parse, with `issue()`. Spread the result onto a rendered node, or onto `Spread`, `PhotoBox`, `MarkdownBox` or `Element`, which forward it to their own node; a hidden node works in export:

```tsx
<span hidden {...issue({
  code: 'gpx-invalid', message: source.name + ' has no track.',
  element: 'route', parameter: 'track', file: trackId, details: { points: 0 },
  suggestion: 'Assign a GPX file that contains a track or route.',
})} />
```

- `code` is lowercase (`a-z`, digits, `-`). The Book check and `check_book` report it as `template:<code>`, so it cannot collide with platform codes.
- The location is the given `box` or `element`, or else the box or element that contains the node. `parameter` names the parameter, and `file` the file ID of a file parameter; it is reported as the finding's `source`.
- `severity` is `warning` by default. `error` requires confirmation before PDF export, like other layout errors.
- `details` carries measured or related values (strings or numbers). `suggestion` is advice for a person or agent; ImageFlow never applies it.
- A finding is reported once per spread render, however many identical nodes carry it. Findings render from the same input every time, so editor, check and export report the same ones.

A plain `data-issue="…"` attribute still works. It reports a `template-issue` warning on the containing box or element. An `issue()` value that fails validation is reported as `template-issue-invalid`.

## Geometry helpers

`geometry` computes rectangles in millimetres in spread coordinates: x from the left page's trim edge (the right page starts at the trim width), y from the top trim edge. In a format without facing pages the sheet is one page, and x starts at its left trim edge. Pass a rectangle to a platform component's `rect` prop (`PhotoBox`, `MarkdownBox`, `Element`, `Text`), or `geometry.css(rect)` to any node's `style`, to position it absolutely inside `<Spread>` or `<Page>` as appropriate. Properties in `style` win over the ones `rect` sets, so `rect={area} style={{ height: 'auto' }}` lets a block grow.

A `page()` layout uses **page-local coordinates**, starting at its own left trim edge on either side. In that context, `ctx.geometry.page(area?)` takes no side, `ctx.geometry.design(canvas).page(...)` maps design coordinates to the current page, and `ctx.geometry.spread()` or a request for the facing page throws. Safe and bleed insets mirror from `ctx.side`. `<Page>` exposes that side as `data-side`. See [Page layouts](#page-layouts).

For a spread layout, `ctx.geometry` holds the same helpers with the spread's format already applied: `ctx.geometry.page(side, area?)` (`ctx.geometry.page(area?)` without facing pages), `ctx.geometry.spread(area?)` and `ctx.geometry.design(canvas)`, plus `inset`, `grid` and `css`. The functions below remain available for helpers outside `render`. The helpers return plain numbers, so ordinary CSS and inline styles stay available, and nothing scales type.

| Helper | Returns |
| --- | --- |
| `page(format, side, area?)` | One page. `area` is `trim` (default), `safe` (the format's safe insets, with the binding inset next to the fold) or `bleed` (outer edges extended into the bleed; the fold edge stays at the fold, because a page's binding bleed shows the facing page). Works for single first and last pages. |
| `page(format, area?)` | The page of a format without facing pages: `trim`, `safe` (left and right insets) or `bleed` (all four edges). For the top-level helper with facing pages a side is required; the bound helper in a `page()` layout already knows its side. |
| `spread(format, area?)` | Both pages. Its `safe` area keeps only the outer, top and bottom insets. Throws without facing pages. |
| `inset(rect, mm \| { top, right, bottom, left })` | A smaller rectangle. |
| `grid(rect, { columns, rows?, gap?, columnGap?, rowGap? })` | Equal cells in reading order, with gaps between cells only. |
| `design(format, { width, height })` | Design coordinates. `left(x, y, w, h)` and `right(…)` map a fixed design canvas to a page (`page(…)` without facing pages), scaling x with the trim width and y with the trim height. `width(v)` and `height(v)` convert design lengths such as gaps. |
| `css(rect)` | `{ position: 'absolute', left, top, width, height }` in `mm`. |

```tsx
render: (ctx) => {
  const text = ctx.geometry.page('right', 'safe');
  const cells = ctx.geometry.grid(ctx.geometry.page('left', 'safe'), { columns: 2, rows: 2, gap: 4 });
  return <Spread>
    {(['a', 'b', 'c', 'd'] as const).map((id, i) => <ctx.PhotoBox key={id} id={id} rect={cells[i]} />)}
    <ctx.MarkdownBox id="story" rect={ctx.geometry.inset(text, { top: 20 })} />
  </Spread>;
}
```

Use `page` and `spread` for physical layouts that keep margins in millimetres on every format. Use `design` to scale a composition drawn on a fixed canvas, as the starter does. These numbers are physical lengths for CSS, unlike the structured `mm()`, `pt()` and `inch()` values used in print-format declarations. The starter's layouts use these helpers. Do not reuse a spread helper that reads both `left()` and `right()` inside a page layout; give the page helper local `page()` rectangles instead.

## Platform components

| Component | Purpose |
| --- | --- |
| `<Spread>` | Root of a spread layout. Sizes the spread to two trims plus bleed, sets geometry CSS variables, and handles page halves. |
| `<Page>` | Root of a `page()` layout. Uses page-local coordinates, exposes `data-side`, and supplies mirrored safe/bleed variables; the host composes it with its facing page. See [Page layouts](#page-layouts). |
| `<PhotoBox id>` | Renders the assigned photo with its crop (the photo always covers the box; the saved crop picks the visible region), using a preview-size image in the editor and a rendition capped at the format maximum resolution in export (300 ppi when omitted). Its element is the box's geometry and drop zone, also for a photo dragged from another photo box, which swaps the two. Users select the photo in the editor and drag and pinch it; templates do not handle the crop. A render callback as its child draws the photo with the template's own markup (see PhotoBox render callbacks). |
| `<MarkdownBox id>` | Receives the flowed fragment of the assigned Markdown source. Its element is the box's geometry and drop zone: for Markdown files, texts from the strip and a text dragged from another Markdown box, which swaps the two (as `swap_content` does). `rects` draws one box over several rectangles ([One box over several rectangles](#one-box-over-several-rectangles)). |
| `<Element id>` | Wraps generated artwork so the editor can highlight it, and opens its parameters when clicked; an element can supply its own editor (see Element editors). |
| `<ctx.Text parameter>` | Shows a string parameter and makes it editable by clicking it (see Click-to-edit). Only on the render context, because it reads the layout's values. |
| `asset(path)` | Resolves a file in `template/assets/` for use in `src` or CSS. |

Rules:

- Each shown layout renders one root: `<Spread>` for a spread layout, `<Page>` for a page layout.
- Each declared box is rendered exactly once through its component; each declared element at most once.
- Boxes and elements are positioned and sized by template CSS on the component's element (`className`, `style`), or by `rect` (see Geometry helpers).
- `decorative` marks a component's text as ornament, so the Book check does not report it for the safe area, size or overlap (see [CSS contract](#fonts-and-output)).
- An empty box keeps its area in edit mode so it can receive drops. In export, its wrapper remains but the edit placeholder is omitted, as it is in thumbnails; templates can style `[data-empty]`. Layout previews mark each empty box with a small photo or text glyph instead, so a spread without content still shows which boxes take photos and which take text.

### PhotoBox render callbacks

A fixed CSS mask or filter on `.if-photo img` needs no callback. To compose the photo inside the template's own SVG or HTML, such as a shaped mask with an outline, a duotone filter or a photo combined with artwork, give the PhotoBox a render function as its child:

```tsx
<ctx.PhotoBox id="hero" rect={rect}>{(photo, box) =>
  <svg width={photo.box.width} height={photo.box.height}>
    <clipPath id={box.uid}><circle cx={photo.box.width / 2} cy={photo.box.height / 2} r={photo.box.width / 3} /></clipPath>
    <image href={photo.src} {...photo.image} preserveAspectRatio="none" clipPath={`url(#${box.uid})`} />
  </svg>}
</ctx.PhotoBox>
```

```ts
type PhotoRender = {
  src: string;          // the rendition ImageFlow chose (preview, thumbnail, or print-resolution file in export)
  alt: string;          // alt text, else title, else ''
  box: { width: number; height: number };                       // the box, CSS px
  image: { x: number; y: number; width: number; height: number }; // where the whole photo goes, CSS px from the box's top-left
  style: CSSProperties; // the same placement for an absolutely positioned <img>, in % of the box
  crop: { x: number; y: number; width: number; height: number };  // the visible part, as fractions of the photo
  placement: { centerX: number; centerY: number; zoom: number };  // the saved crop (or the gesture's, while cropping)
  ppi: number;          // effective resolution of the visible part at print size
};
type PhotoBoxState = { id: string; uid: string; params: BoxParams; photo: Photo | null };  // as ctx.boxes[id]
```

- **Units and coordinates.** Lengths are CSS pixels (96 per inch) of the printed page, with the origin at the box's top-left corner. They match the box's layout size whatever the editor's zoom, so an SVG sized `photo.box.width` × `photo.box.height` (or with that `viewBox`) maps one to one. `image` usually extends past the box, which clips everything to its own rectangle. For HTML, `<img src={photo.src} style={photo.style} />` places the photo the same way.
- **Honour the placement.** Draw the photo at `photo.image` (or with `photo.style`). That is what makes the printed crop the one the user chose and what the resolution check measured. ImageFlow cannot verify the geometry from the markup: finding `photo.src` in the output does not prove it is drawn in the right place.
- **What ImageFlow still owns.** Assignment and drops, the per-layout crop and its gestures, Quick Look, choosing the rendition for the editor, thumbnails and export, the `photo-resolution-low` check (computed from the box and the saved crop, as for the default renderer), and waiting for the image: the Book check, MCP artwork, and PDF export wait for HTML images and SVG `<image>` references in the callback's output to load, and report a photo that cannot be decoded. While the user crops, the callback is called again with the gesture's placement, so the mask or artwork follows the photo before the crop is saved. The editor does not cover it with a plain copy of the photo.
- **When it is called.** Only for a box with a photo that ImageFlow can show. An empty box, or one whose photo is missing, keeps the platform's placeholder and drop target, and the callback is not called. A box with `rect` is drawn at once. A box sized by CSS is measured before it is painted and drawn then. The editor's scrolling book draws callback boxes when their spread comes near the screen, as it loads default photos. Presentation draws them at once.
- **Pure.** The callback is part of rendering: the same rules apply as for `render`, and impure calls are attributed to the spread.
- **Errors.** A callback that throws fails the Book check, artwork and export like any other template error. In the editor's scrolling book, where boxes are drawn as they come near and again during crop gestures, only that box fails: it shows that the photo could not be drawn, the live Book check reports `photo-render-failed` for it, and it draws again on the next crop, size or parameter change.
- **Ids in print.** PDF export draw each page from a copy of its spread, so ids inside the copy get a suffix (`.p1`, `.p2`, …), and the copy's own references follow them: `url(#…)` in attributes and `<style>` elements, `href="#…"`, and `#id` selectors in `<style>` elements inside the spread. Selectors in the template's stylesheet cannot follow, so style callback output by class or attribute rather than by `#id`.
- **The box.** `box` has the same values as `ctx.boxes[id]` with resolved `params`, plus `uid`, which is unique in the book, for ids inside the callback's SVG. `box.photo` holds the photo's metadata and pixel size. For more than one id, derive them with a dot, such as `box.uid + '.mask'` and `box.uid + '.fade'`: box IDs never contain a dot, so a derived id cannot equal another box's `uid`. With the `spread` builder, `box.params` is typed from that box's parameters. A callback is ordinary template code, so it can be shared across boxes and layouts, packaged with the box parameters it reads (which show in the photo toolbar), and typed against them: `(photo: PhotoRender, box: PhotoBoxState<string, { tilt: number }>) => …` fails type checking on a box without `tilt`. Box parameters are one namespace per box, so prefix a treatment's parameters, and their values follow the box ID across layouts like `caption`.
- **Styling.** The default renderer's `.if-photo img` rules do not apply inside a callback box. The box gets `data-photo-render="custom"` and is a positioning context.

[`photo-frames.tsx`](examples/photo-frames.tsx) packages a shaped-mask treatment with its parameters and `controls`. The photobook starter's *Photo and note* layout draws its photo as an arch, a circle or a rectangle the same way.

## CSS contract

### Authoring

Templates style with inline React `style` objects (positions, sizes, and anything driven by parameters) and one plain CSS file (`styles.css`, plus optional imports) for fonts, Markdown typography, and rules shared across spreads. Native CSS nesting may be used. No CSS preprocessor, Tailwind, or CSS-in-JS library is part of the v1 build.

```tsx
<h1 style={{ position: 'absolute', left: '30mm', top: '40mm', color: params.accent }}>{params.heading}</h1>
<MarkdownBox id="body" className="editorial" style={{ position: 'absolute', left: '55%', top: '30mm', width: '110mm', height: '230mm' }} />
```

```css
.editorial {
  font: 10.5pt/1.45 'Source Serif 4';
  p { margin: 0; }
  p + p { text-indent: 1.2em; }
  h2 { font: 400 9pt Inter; letter-spacing: .12em; text-transform: uppercase; }
}
```

The platform validates the rendered result (computed styles and the exported PDF), so its checks do not depend on how styles were written.

### Geometry variables

`<Spread>` and `<Page>` set, in physical units from the resolved format:

```css
--trim-width; --trim-height;          /* one page */
--bleed-top; --bleed-bottom; --bleed-outside;
--safe-top; --safe-bottom; --safe-outside; --safe-binding;
/* without facing pages, instead of the outside and binding variables: */
--bleed-left; --bleed-right; --safe-left; --safe-right;
```

For `<Page>` the content box is always one trim. Its `data-side="left" | "right" | "page"` distinguishes the placement; outside/binding variables use that side's resolved insets. Position artwork locally rather than using spread-wide `.left-page` or `.right-page` classes.

Without facing pages the content box is one trim (`--trim-width` by `--trim-height`) and there is no gutter.

The spread's content box is the two trims side by side (`2 × --trim-width` by `--trim-height`), with the gutter at 50 %. Coordinates are relative to the trim; the platform adds the bleed outside. Utility classes extend an element into the bleed: `.bleed` (all outer edges it touches), `.left-page`, `.right-page` (position a full page, including its outer bleed).

### Markdown

Template CSS styles the elements inside a `MarkdownBox`: `p`, `h1`–`h6`, `em`, `strong`, `a`, `ul`, `ol`, `li`, `blockquote`. The platform adds and owns:

- `overflow-wrap: break-word` on Markdown boxes.
- Multi-column and fragmentation properties on Markdown boxes (`column-*`, `break-*` are set by the platform; `orphans`, `widows` may be set by templates).
- Continuation classes: `.split` on the part of an element that continues in a later box, `.cont` on the continuing part. Defaults: a continued paragraph has no first-line indent, a continued list item has no marker, and a split justified paragraph justifies its last line. Templates may restyle these.
- List markers stay inside the box (`list-style-position` or sufficient padding, checked by the platform).

Not allowed in Markdown boxes: CSS counters for list numbering, `float`, `position: absolute` on content, transitions and animations.

### Fonts and output

- Fonts are declared with `@font-face` in template CSS, from files in `template/fonts/`. Static files only; system fonts are not allowed. Export fails if the PDF contains Type 3 fonts or fonts not shipped with the template. These are platform rules, independent of the format. Omit `output.fonts`: the old `{ allowType3: false, allowSystemFonts: false }` field is deprecated, accepted only for compatibility, and does not change validation. Values of `true` remain invalid.
- Effects that create transparency (opacity, `rgba()` fills, shadows, blend modes, filters, gradients, rounded clipping) are allowed; whether they pass depends on the format's transparency policy, checked at export.
- Text below the format's minimum size and text outside the safe area are reported in edit mode.
- **Characters and strokes.** The Book check reports text whose characters the bundled font has no glyphs for (`font-coverage`, with the characters), since they would print in a system font, and stroked text (`text-stroked`: an SVG `stroke` on text or `-webkit-text-stroke`), since Chromium prints stroked glyphs as a Type 3 font. Both cover text inside SVG too, such as the labels of a vector map. Draw a halo as filled copies of the text shifted around it instead of a stroke.
- **`fonts`** (capability `font-coverage`) tells template code which characters its fonts can set, for text it draws itself, such as labels from map data: `fonts.missing(text, { family, weight?, style? })` returns the characters that cannot be set, `fonts.settable(text, font)` returns the text without them (letters with marks fall back to their base letter, ş → s), and `fonts.list()` the bundled faces. `family` may be a fallback stack, as a CSS string or a list: each character counts as settable when any bundled family of the stack has it, as the browser falls back character by character; the Book check reads text's whole `font-family` stack the same way. Faces are matched as the browser matches them (style, then weight by the CSS font matching rules: a request of 400 prefers 500 to 300), and a face's coverage is its font file's character map, narrowed by its `unicode-range`. An SVG picture placed in the page needs no embedded fonts: its text uses the template's `@font-face` families by name, or by a class the template's CSS styles.
- **Decorative type.** Display type that deliberately runs off the page, or sits behind other type, would raise these findings on every spread that uses it. Mark it `decorative` (a boolean prop of `ctx.Text`, `PhotoBox`, `MarkdownBox` and `Element`, or `data-decorative` on any node) and the Book check skips the text inside it for safe-area, minimum-size, overflow and overlap findings. PDF output is unchanged: the page edge still cuts the text, so only mark type whose cutting is intended. A Markdown box's text-flow overflow, which loses text, is still reported. Text inside SVG is already skipped by these checks.

## Validation

When the template is loaded:

- `id`, `version`, `contract` present; contract version supported; every capability in `requires` provided by this app.
- Exactly one of `format` or `formats`. Unknown declaration properties and `spreadFor` document mismatches are warnings (see [Declaring layouts](#declaring-layouts)).
- Unique, stable identifiers for spreads, boxes, elements, and parameters; valid parameter defaults.
- A valid print format.
- Unique `flowOrder` among Markdown boxes of a spread.
- A box ID has one box type, and a parameter ID one parameter type within its scope, across all layouts (see [Switching layouts](#switching-layouts)).

When a spread renders:

- Every declared box rendered once; no undeclared box or element ids.
- Assigned files of file parameters exist, are readable, and have an accepted extension; template findings from `issue()` or `data-issue`.
- Valid anchor declarations; each `ctx.book.anchor(id)` lookup finds exactly one anchor (otherwise a warning).
- No rendered content extends beyond the spread's bleed (Markdown overflow is handled by the flow and reported as unplaced text).

At export:

- The format's checks: page count rule, transparency policy, fonts, resolution of each placed photo, file size.

Errors in edit mode appear in Book check. PDF export reports layout errors and PDF preflight failures, then asks whether to export anyway. It still requires a successful render and correct PDF page count and dimensions. Warnings do not require confirmation.

## Stored project data

A spread instance in `project.json`:

```json
{
  "id": "spread-7f3a",
  "definition": "story",
  "params": { "heading": "At the water’s\nedge", "eyebrow": "01 / ARRIVAL" },
  "boxes": {
    "hero": {
      "photo": "ph-2c91",
      "crops": { "story": { "centerX": 0.5, "centerY": 0.45, "zoom": 1.1 } },
      "focus": { "centerX": 0.5, "centerY": 0.45 },
      "params": { "showCaption": true }
    },
    "body": { "text": "tx-arrival" },
    "second": { "photo": "ph-81d0" }
  },
  "elements": {}
}
```

`second` is content a `grid` layout showed; the `story` layout has no `second` box, so it is kept for the next layout that has one. `crops` holds one crop per layout ID; `focus` is the centre of the crop set last.

The project also stores the document parameter values, the template `id` and `version` it was last opened with, the text id → path mapping, and the file id → path mapping for file parameters (`files`). Photo metadata lives in `photos.json`.

### Page states

A spread shown as two pages stores `split: true` and `pages.left`/`pages.right`, each with `definition`, `params`, `boxes` and `elements`. A page without a definition is blank. The spread's own `definition`, `params`, `boxes` and `elements` remain its remembered spread state while the pages are shown. When merged, `split` is removed and the page states remain remembered. Replaced content is stored in `displaced`: entries have `from: 'spread' | 'left' | 'right'`, `box` and the saved box `state`.

The same `hero` ID on the left and right is two assignments, addressed by page. A layout switch can move a whole box state, including focus, box parameters and per-layout crops, between these states. See [Switching layouts](#switching-layouts) for matching, memory and replacement rules.

`project.json` and `photos.json` keep keys this version does not know when a book is opened and saved, so a field a newer build added without a format bump is not lost. Templates never see such keys, and the keys `__proto__`, `constructor` and `prototype` are refused anywhere in either file.

`project.json` may carry a `bookId` (a UUID) naming the book's lineage across copies. ImageFlow assigns one when a book is created, duplicated or saved as a copy, and to an older book with its first save; ordinary saves, Undo and Redo keep it, and a Finder copy shares it. Templates do not see it; do not edit it.

Any stored page state, split sheet or displaced content requires book `schemaVersion: 2`. Books without them remain format 1. Older apps refuse format 2 rather than dropping page data. Never edit manifests directly while the book is open; use page-addressed MCP commands for these edits ([Page layouts](#page-layouts)).

Template `openingSpreads` may also declare page pairs for new books. Those declarations use `layout` and optional `params` per side; the created project stores them as `pages` with `definition`, alongside `split: true`. See [Template library](#template-library).

## Authoring and compatibility details

Use the generated `.imageflow-sdk/tsconfig.json`, or a project `tsconfig.json` that extends it, to check templates without installing host packages. Run `npm run generate:authoring` and `npx tsc -p sample/starter/template` in this repository. For layouts in their own files, export the document parameters and a builder made from them:

```tsx
// document.ts
export const documentParameters = { accent: p.color({ label: 'Accent', default: '#223344' }) };
export const spread = spreadFor(documentParameters);

// spreads/story.tsx
export const story = spread({
  label: 'Story',
  parameters: { heading: p.string({ label: 'Heading', default: '' }) },
  render: (ctx) => <Spread>
    <ctx.Text parameter="heading" as="h1" style={{ color: ctx.document.accent }} />
  </Spread>,
});
// index.tsx: defineTemplate({ …, parameters: documentParameters, spreads: { story } })
```

Helpers shared between layouts can take a slice of the typed context, such as `Pick<RenderContext<{ label: string }, typeof documentParameters>, 'document' | 'geometry'>`, as the starter's `Paper` and `Caption` do. `mm`, `pt`, and `inch` produce structured lengths for the print-format declaration; use CSS strings such as `'30mm'` in React styles. They are not CSS values.

`MarkdownBox` accepts `columns` (default 1, rounded and clamped to 1–6). Use `style={{ columnGap: '5mm' }}` for the gap. Text continues down each column, then through the next assigned box in spread/flow order. Expose a box parameter and pass its resolved value to `columns` if users should control it. Column layout remains platform-owned; avoid overriding its flow machinery with CSS. `rects` draws one box over several rectangles, such as both pages of a spread; `alignHeads` starts their columns level below a head that opens the box (see [One box over several rectangles](#one-box-over-several-rectangles)).

Numeric `step` is a control increment, not a runtime divisibility constraint. Month precision changes the picker; it writes `YYYY-MM-01`, but existing valid ISO dates are not normalized. Use first-of-month defaults and bounds for month parameters.

Adjusting a selected photo draws it over the box's on-screen rectangle, so it assumes the box is upright. If template CSS rotates or skews a `PhotoBox` (or an ancestor inside the spread), the editor offers only the numeric crop values for it. Clicks act on the box or element drawn on top, in document order; content stacked with `z-index` is not accounted for.

Identifiers start with a letter or digit, then contain letters, digits, underscores or hyphens; reserved Object prototype names are rejected. Dots separate edit-path scopes and cannot occur in identifiers. PhotoBox, MarkdownBox and Element automatically expose their declared parameters; explicit edit marks add parameters. Ordinary nodes need `ctx.edit` or `ctx.Text`. Exported artwork keeps the invisible `data-edit` marks, so checks can name the parameter a text block shows. Avoid overlapping targets or marking several nodes with the identical path list: the current editor identifies targets by spread and path list.

### Persistence and evolution

`project.json` has `schemaVersion` (the book format: 1, or 2 for a book with page states, which ImageFlow writes only when a book has them; see [ADR 0009](https://github.com/wirhabenzeit/imageflow/blob/main/docs/decisions/0009-page-templates.md)), `title`, `template: { id, version }`, document `params`, `texts` (ID → relative path), and ordered `spreads`. Each spread has `id`, `definition` (its current layout), and one `params`, `boxes` and `elements` state shared by all its layouts; see [Switching layouts](#switching-layouts). The example above shows one spread, not a complete project. Photo metadata is keyed by stable photo ID in `photos.json`; dimensions are derived from image files. Crop centers are normalized 0–1; zoom is 1–20. Constraints are checked on rendering; invalid saved values remain stored and render using defaults. Sources remain in the project even when no box uses them.

New projects copy the starter template. Updating the app does not replace existing project templates. Every supported contract-1 runtime provides the baseline above. Extensions after the first public release will use `requires`; keep the app and authoring declarations aligned. Renaming an ID or moving a parameter between scopes requires an explicit project-data migration; there is no automatic migration framework. Photobook starter 0.9.0 replaced the document `paper` and `accent` parameters with `theme`, moved `textSize` from the story and text layouts to the document, replaced the grids' `gutter` with the document `spacing`, removed the calendar layout (the Wall calendar starter has its own) and anchors stories as `section` under `chapter` openers; books made from earlier versions keep their own template and are not migrated.

### Preview limitations

The editor renders the whole book for the canvas and again for thumbnails. Layout choices render independently and restart Markdown from the beginning; they are composition previews, not previews of the actual continuation fragment. Review the main book and exported proof for final flow. Large-book latency and memory use need separate measurement.

The API is the in-process `imageflow` template module. There is no documented public REST or automation API. Desktop IPC and frame messages in `src/desktop.ts` are internal implementation details.

### Enum maps and scaled CSS lengths

`p.enum({ label: 'Language', options: { en: 'English', de: 'Deutsch' }, default: 'en' })` normalizes to the existing array-of-options declaration with labels. Keys become string saved values, including unquoted numeric keys; TypeScript checks the string default against those keys. Maps follow JavaScript property enumeration order: array index keys (such as `'2024'`) are sorted first in ascending order, then other string keys keep insertion order. Use the array form when option order must be explicit. Array options and separate labels remain supported.

`const at = ctx.geometry.design({ width: 420, height: 297 })` exposes `scaleX` and `scaleY`. `at.length(19, 'pt', 'x')` returns a CSS length, rounded to two decimal places. Choose `x`, `y`, `min` or `max` explicitly, including for type sizes; positions still scale on their respective axes. Units are `mm`, `pt` or `px`. Canvas dimensions must be positive and finite. The calendar uses the x axis to preserve its existing typography.

### Generated authoring SDK

The canonical SDK is `authoring/`. `npm run generate:authoring` generates standalone snapshots for both shipped templates; the build runs it automatically. Their tiny `tsconfig.json` extends `./.imageflow-sdk/tsconfig.json`. No template maintains a declaration copy or synchronization test.

Creating a book writes the installed SDK into `template/.imageflow-sdk/`, and the installed agent skill, with this reference and the examples, into `.claude/skills/imageflow-templates/` at the book's root, where Claude Code and other agents that read project skills find it. The skill is generated tooling; it is not a book input and not part of the template. Rebuilding the template's dependencies (the `rebuild_dependencies` agent tool or **Templates → Rebuild Template Dependencies**) refreshes both the SDK snapshot and the generated agent skill from the installed app, so an older book's editors, standalone checks and local agent references use the current API. Exporting a template includes a fresh snapshot in the archive for external authoring, without changing its source folder. App import discards all archive-supplied SDK folders, at any depth; new books and subsequent exports use the installed SDK instead. Existing books are never rewritten when opened. The snapshot includes React declarations (the host's React, including React's component, ref and context types that package declarations name), a standalone TypeScript configuration and `api.json` identifying contract 1 and the SDK content digest. Outside ImageFlow, run `tsc -p .imageflow-sdk/tsconfig.json`, or extend that configuration from your own `tsconfig.json`.

`.imageflow-sdk/` is reserved for generated tooling. It is excluded from template hashes, saved-input revisions and runtime imports; the app always checks against its installed SDK. Authored source and other declaration files remain part of template identity. An export may contain different tooling bytes after an app update while retaining the same authored-template hash.

### Actual element geometry in editors

`context.elements[id].rect` is the element’s measured bounding rectangle in millimetres relative to the spread’s trim origin. It comes from the current page, including CSS sizing, rather than reconstructing a whole-spread rectangle. It is `null` before the current page is ready or when the element is not rendered. CSS rotation or skew yields a bounding rectangle. Changes of format, layout, element size, or DOM content/class/style that moves an element refresh the measurements; ordinary editor draft overlays preserve them.

The map editor waits for its first measurement, uses the actual output aspect ratio and width to frame the map, and keeps its existing map stable while the book redraws. Saved map settings remain ordinary parameters.

## Inline plain text (`inline-text`)

Use `<ctx.Text parameter="heading" presentation="inline" as="h1" />` to edit a plain string on the page. It is the recommended default for a single user-written string the page prints (headings, labels, captions); opt out where the panel serves the task better. Inline text is included in the contract-1 baseline under ADR 0008 and needs no `requires` entry. Existing `Text` calls keep the parameter panel; `presentation="inline"` chooses on-page editing for a particular node, with the same word and values as an editor's `presentation` (`'dialog'`, the default, keeps the panel). Older `requires: ['inline-text']` declarations remain valid. The starter headings use it. Installed-runtime capability discovery and the generated SDK include `inline-text`.

The activated occurrence uses the template's actual font, ancestors, dimensions and CSS at page zoom. Other occurrences continue to show the confirmed parameter until Apply succeeds. The parameter's scope and saved identity do not change. A custom editor that owns the parameter remains its sole editing surface: clicking that text (or using the Inspector/Tab) opens the owner, including layout parameters listed in an element editor's `spread`. The inline-text save path also rejects a draft if ownership changes before its save runs. Plain strings have no formatting; a string declared with `markdown: 'inline'` gets bold, italic and strikethrough (see below). An inline string declared `multiline: true` defaults to `white-space: pre-wrap` in both editing and artwork; template CSS classes and inline styles take precedence.

Typing is pending until Done, leaving the field, or Enter for a single line. For multiline strings, Enter inserts a line break and ⌘/Ctrl+Enter applies. Tab/Shift+Tab applies and moves to the next/previous occurrence in reading order. Escape and Discard drop only pending typing. Whitespace-only/empty strings retain the existing placeholder and display-only fallback behavior after exit. Paste inserts plain text, normalizes CR/CRLF to LF, and replaces line breaks with spaces for a single-line parameter. Text selection, caret keys and focused typing Undo/Redo belong to the text editor; each confirmed application becomes one book Undo entry. IME Enter/Escape are left to the input method while composing; a pending flush waits for composition to end.

Application validates the complete string (including `maxLength`), checks the original parameter declaration, layout and saved value again when the shared edit queue runs, and uses the normal revision-checked project save service. Failed saves, invalid text and external conflicts keep the editor and its pending text, with a selectable copy of the draft in the error area. Conflicting typing is never silently applied over newer saved values. Recovery instructions explicitly say to fix the text, retry Done, or copy the draft and choose Discard before continuing. Discard and reopen to resolve an external conflict. Outside pointer presses cannot start canvas gestures before applying the text. Normal clicks are performed after a successful apply; browser actions requiring trusted user activation (links, file inputs and controls marked `data-requires-user-activation`) instead show “Text saved. Click again to continue.” and require a new real click. Ordinary zoom/scroll/resize follows the same editor without remounting it. If the layout changes or the occurrence disappears, the pending draft remains recoverable rather than moving to another saved parameter.

The Inspector's marked-text action opens the existing parameter control, including from the keyboard. Targets under 48 × 12 screen pixels, rotated/skewed targets and read-only projects use the existing panel; an inline session keeps its draft if the page later becomes smaller. Whole-spread views often make headings that small: they are then edited in the panel, and on the page once the view is zoomed in far enough. Keep the printed type its intended size rather than enlarging it to stay above the threshold. Thumbnails, MCP artwork captures and PDF exports use only confirmed render output, without editable nodes, draft text or editor chrome.

## Formatted text (`formatted-text`)

Declare a string with `markdown: 'inline'` to let its value carry inline formatting:

```tsx
heading: p.string({ label: 'Heading', multiline: true, default: '', markdown: 'inline' }),
// …
<ctx.Text parameter="heading" presentation="inline" as="h1" />
```

- **Saved value:** the string, with a small Markdown subset: `**bold**`, `*italic*`, `***bold italic***` and `~~strikethrough~~`. A backslash keeps a marker literal (`\*`, `\~`, `\\`). Markers that do not pair up, or that touch a space on the wrong side (`5 * 3`), stay as typed. Nothing else is Markdown: `#`, `_`, links, code and HTML are shown as typed. Headings, lists and links belong in Markdown boxes.
- **Opt-in:** without the flag a string is plain, as before, so existing values never change meaning. The flag may differ between layouts like other constraints, but a value written with markers shows them literally where the flag is off.
- **Rendering:** `ctx.Text` shows the value as `<strong>`, `<em>` and `<s>` inside its node, never as HTML. Style them in the template's CSS, for example `h1 strong { font-weight: 800; }` for a heading that is already semibold. Display-only `fallback` text is shown plain. Where a template shows the value with its own markup, `<FormattedText value={ctx.params.heading} />` renders the same elements, and `plainText(value)` gives the visible text without markers, for anchor titles and other places where formatting cannot show. `ctx.params` holds the saved string with its markers. The starter template formats its headings (contents entries use `plainText`) and its map title (with `<FormattedText>`).
- **Length:** `maxLength` counts the visible characters, not the markers, in validation, the generated field and the inline editor.
- **Inline editing:** the text shows its formatting while you type. Typing a closing marker that matches its opener on the same line converts it: `**word**` turns bold once the second closing `*` is typed, `*word*` italic, `~~word~~` struck through. ⌘B, ⌘I and ⇧⌘X (Ctrl on other systems) toggle the selection, the word at the caret, or the style of the next typed text; the toolbar has the same three buttons. Undo right after a conversion brings the typed markers back as literal text, so a footnote star or `2*3*4` can stay. This editor keeps its own Undo history while typing; each applied edit is still one book Undo entry. Paste inserts plain text, whose markers are kept literally.
- **Other surfaces:** the generated text field and agents (`apply_project_changes`) read and write the saved string with its markers.

`node scripts/smoke-inline-text.mjs` checks the desktop workflow after building and staging the app. It is included in `npm run test:desktop`, run by the manual Full desktop suite; the automatic core smoke suite stays small.
