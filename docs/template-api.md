# Template API (contract 1)

Status: implemented reference for the v1 runtime, including UI PR #7. The executable schemas in `src/template.tsx`, `src/parameters.ts`, `src/format.ts`, and `src/project.ts` govern validation. The authoring declarations are in `authoring/imageflow.d.ts`; the complete working example is `sample/starter/template/index.tsx`. Historical proposals are not alternative supported APIs.

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

`imageflow` exports `defineTemplate`, `spreadFor`, `p`, `mm`, `pt`, `inch`, `printFormat`, `Spread`, `PhotoBox`, `MarkdownBox`, `Element`, `asset`, `file`, `geometry`, `box`, `issue`, `capabilities` and `RenderedImage`. A build fails with a hint to update ImageFlow when a template uses an export the installed app does not have.

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

Agents receive them with `get_authoring_context` and `includeExamples`. To start a template, copy `minimal.tsx` (or the closest example) and add layouts. To extend one, copy a single layout and its declarations. The starter template is the complete reference book, not a required starting point.

The examples use the generic `serif` and `sans-serif` font families, so they preview anywhere but **print export rejects them**: print preflight accepts only fonts bundled inside `template/` and loaded with `@font-face` from CSS the template imports. Before printing, add font files to `template/fonts/`, import a stylesheet that declares them, and use those families. The starter template shows the pattern ([Fonts and output](#fonts-and-output)).

### Requirements and compatibility

Every supported contract-1 runtime provides the complete baseline below, including document editors, network declarations and rendered images. A template selects it with `contract: 1`; no `requires` list is needed:

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
| `layout-families` | `layoutFamilies`, `family` and `variant` on layouts, and a family's own layout picker. |
| `editor-spread-parameters` | `spread` on an element editor: layout parameters edited together with the element's, with `setSpread` and `<Control scope="spread">`. |
| `opening-spreads` | `openingSpreads`, the spreads a new book starts with. |
| `single-pages` | Formats without facing pages (`facingPages: false`) and `span: 'page'` layouts. |
| `editor-context` | `context` in element and document editors: the spread they were opened from, as `render` sees it, kept current. |
| `document-editors` | `editors`: editors of document parameters, opened from nodes marked with them. |
| `editor-network` | Declared HTTPS origins for editors and rendering, subject to user approval. |
| `rendered-images` | `<RenderedImage>` for host-managed asynchronous pictures in preview, check and export. |

`requires` is reserved for additive extensions introduced after this baseline. Unsupported extensions are rejected when the template loads, with an update hint. Older templates that list baseline features in `requires` remain valid. `capabilities` continues to list all supported feature names, including the baseline, for compatibility and feature discovery. `get_authoring_context` reports the contract, its `baseline`, all `capabilities` and module `exports` as `capabilities.templateApi`.

The baseline is fixed in `src/runtime-exports.ts` and must not shrink or grow when later extensions are added. Earlier development builds are not supported implementations of the frozen contract-1 baseline; use a supported v1 runtime rather than adding a list of baseline flags to target them. See [ADR 0007](decisions/0007-template-v1-baseline.md).

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

### Declaring spreads

Declare `spreads` as a function of `{ spread }`. Its `spread` builder types each layout's `ctx.params`, `ctx.boxes`, `ctx.elements` and edit paths from the layout's own declarations, and `ctx.document` from the template's `parameters`, so the document settings are declared once. `defineTemplate` calls the function and validates the resulting record; the builder itself only exists for TypeScript and returns each definition unchanged.

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

### Parameters

`p.*` helpers create plain, serializable schema objects; the editor generates controls from them, and the `spread` builder infers render-context types from them. A spread declared as a plain object gets a broad context.

| Helper | Value | Options |
| --- | --- | --- |
| `p.boolean` | `boolean` | `default` |
| `p.integer` | `number` | `default`, `min`, `max`, `step` |
| `p.number` | `number` | `default`, `min`, `max`, `step`, `unit` (display only) |
| `p.string` | `string` | `default`, `multiline`, `maxLength`, `placeholder` |
| `p.enum` | one of `options` | `default`, `options` (an array of values or a value-to-label map), optional `labels` for arrays |
| `p.color` | `#rrggbb` | `default` |
| `p.date` | ISO date `YYYY-MM-DD` | `default`, `min`, `max`, `precision` (`day` or `month`) |
| `p.file` | file ID, or `''` when none is assigned | `accept` (lowercase extensions such as `'.gpx'`); see File parameters |

Every parameter has a `label` and a `default` (`p.file` supplies `''`); a saved value outside the constraints is reported and replaced by the default for rendering, but kept in `project.json`.

Scopes: `parameters` at template level (document), on a spread definition (spread instance), on a box or element (element instance). Values are stored in `project.json` at the matching scope. There is no inheritance between scopes.

### Boxes and elements

- `boxes` declares content boxes. `type: 'photo'` accepts a photo from the photo index; `type: 'markdown'` accepts a Markdown file. Boxes may declare their own `parameters`.
- Markdown boxes on a spread need a unique `flowOrder` when the spread has more than one. Continuation follows project spread order, then `flowOrder`.
- `elements` declares generated artwork (calendar, ornaments with options) that has parameters but no assigned content.
- Identifiers are stable keys: renaming one is a breaking change for projects using the template.

### Print format

`format` is a single `PrintFormat` as sketched in `spikes/pdf-format/print-format-sketch.md` (PR #2): trim, bleed per edge, safe insets, structure (`delivery: 'pages' | 'spreads'`, `ends: 'single-pages' | 'inside-covers'`, page-count rule), and output constraints (container, colour space, transparency policy, resolution range, raster size, font rules, minimum text size). The platform resolves it into concrete geometry once.

A template declares either one `format` or several named `formats`, which the user chooses between under **the template’s settings → Format**:

```tsx
formats: {
  square: bookFormat('Square · 29 × 29 cm', 290, 290),
  landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
},
defaultFormat: 'square',   // optional; otherwise the first format
```

`printFormat({ label, trim, bleed, safe, pageCount, delivery?, ends?, output? })` builds a complete `PrintFormat` with less repetition. `bleed` and `safe` take one length for all four sides (`mm(12)`), `{ all, …sides }` where named sides override `all` (`{ all: mm(3), binding: mm(0) }`), or all four sides. `delivery` defaults to `'pages'`, `ends` to `'single-pages'`, and `output` to `{ container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' }`, with given fields replacing those. The result is an ordinary `PrintFormat`, reported in full by `get_authoring_context` and the template controls. It describes geometry, not a printer's product: page counts, resolution, minimum text size, font rules and file-size limits come from the printer's specification.

Each entry is a complete `PrintFormat`, so presets may differ in bleed, safe area, page-count rules and output limits, not only in trim. Every format is validated when the template loads (schema and geometry: PDF edges between 10 and 1000 mm, binding bleed within the facing page, safe insets leaving room inside the trim), so a broken preset is a template error rather than something a book discovers after switching to it. The choice is stored as `format` in `project.json` and applies to the whole book. A project without it uses `defaultFormat`, else the first format. A project naming a format the template no longer has is previewed in the default format, but the Book check reports an error, so print export is blocked until a format is chosen again; proof export still works. A template with a single `format` ignores the project's choice.

Changing the format re-renders the book: assignments, crops and text sources stay, while text flow, photo resolution and print checks are recomputed. Layouts adapt through `ctx.format` (resolved millimetres), `ctx.geometry` (the geometry helpers for that format), `ctx.formatId` (the chosen key, or `'default'` for a single `format`), and the `--trim-*`, `--bleed-*` and `--safe-*` CSS variables of `<Spread>`. The starter template draws its layouts on a 290 × 290 design page and scales positions with the trim size; full-bleed boxes use the bleed variables directly.

Arbitrary dimensions within declared limits, rather than named presets, are not supported yet.

#### Formats without facing pages

Wall calendars, cards, loose print series and posters have no facing pages. Declare them with `facingPages: false`, and every unit of the book is one page: the editor, the thumbnails, the Book check and both exports work page by page instead of spread by spread. The name follows print convention (InDesign's *Facing Pages* setting).

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
| `'page'` | formats without facing pages (`facingPages: false`) | one page |

`span` defaults to `'page'` when no format of the template has facing pages, and to `'spread'` otherwise, so a calendar template does not repeat it on every layout. A layout whose `span` fits none of the template's formats loads with a `declaration-span-unused` warning.

#### Book ends

The template and the format each have one job. The template offers layouts with a `span`: a `right` layout for the opening, a `left` layout for the closing, and full spreads in between. The format states what the printer expects, and export follows the format alone. `ends` is therefore a requirement, not a permission:

| `ends` | First spread | Last spread | In between |
|---|---|---|---|
| `'single-pages'` (e.g. Blurb) | must be `span: 'right'` | must be `span: 'left'` | full spreads |
| `'inside-covers'` (e.g. Saal) | full spread; left half printed on the inside cover | full spread; right half printed on the inside cover | full spreads |

- **Page sequence.** A book that breaks the rule gets a `page-sequence` error naming the first or last spread, with the span to switch it to. Print export is blocked; proof export still works. A book of only its opening page is reported as missing its closing page.
- **`delivery` and `ends`.** Single end pages need page delivery: `delivery: 'spreads'` with `ends: 'single-pages'` is a schema error, because a PDF of whole spreads cannot open on a single right page. `printFormat` defaults `ends` to `'inside-covers'` when `delivery` is `'spreads'`, else to `'single-pages'`. `right` and `left` layouts fit only formats with `ends: 'single-pages'` and `delivery: 'pages'`; in other formats they are filtered and reported like `span: 'page'` layouts.
- **Editor.** With `'single-pages'`, nothing is inserted before the opening page or after the closing page, spreads do not move into or out of the end positions, and the end pages are not duplicated. The layout picker at the first and last positions offers the `right` and `left` layouts (and, for a misplaced full spread, other full spreads). An empty book starts with a `right` layout. Removing an end spread stays possible and is reported by the page sequence. The MCP commands `insert_spread`, `duplicate_spread` and `move_spread` follow the same rules and fail with `INVALID_POSITION`; `switch_layout` fails with `INCOMPATIBLE_LAYOUT` naming the span the position requires.
- **Declaration check.** A template with a `'single-pages'` format but no `right` or no `left` layout loads with a `declaration-ends-missing` warning.
- **Opening spreads** may be only the start of a book, so full spreads may come first or last among them; single pages must still be at their own end.

A template may offer formats of both kinds side by side. The layout picker, new spreads and fixtures use only the layouts that fit the chosen format. A book that switches to a format its layouts do not fit still previews (a page layout is drawn on a spread, a spread layout on one page), but the Book check reports a `page-sequence` error naming each such spread or page, and print export is blocked until its layouts are switched; proof export still works. The picker of a mismatched spread offers the layouts that fit the new format. Switching back to the earlier format restores the book; assignments, crops and text sources are kept, as with any format change. Opening spreads are checked against the formats of the default format's kind, because a new book starts in the default format.

### Template library

New books are made from the templates in the library: the built-in starter and the templates imported with **Templates → Manage Templates… → Import…**. Import loads the template like a book would and refuses one that fails to load. Before a template that bundles npm packages or declares `network` sites enters the library, the import lists the packages with their versions and licences and the sites its editors connect to, and **Templates → Manage Templates…** keeps showing them ([Dependencies](#dependencies), [Element editors](#element-editors)). The library keeps one entry per `id`, compared by `version` as dot-separated numbers: a newer version replaces the entry, while an older version, or the same version with other files, asks first. So bump `version` when you change a template you have shared. `label` (up to 80 characters) and `description` (up to 300) are what the library shows; without a label it shows the ID. A book copies its template when it is created, and `project.json` records the source's hash as `template.hash`; the library is never read while a book renders.

To share a template, export it as an `.imageflow-template` file: **Export…** in **Templates → Manage Templates…** saves a library entry, built-in ones included. To share an edited book template, import its template folder into the library first. The file is a zip of the template's files, leaving out dotfiles and `node_modules/`, and exporting the same files always gives the same bytes. Importing it, from **Import Templates…** or by opening it in Finder, gives the same hash as the folder it came from. A zip made with Finder's **Compress** works too, when it holds the template folder or its contents. Files with paths outside the template, links, encrypted entries or damaged data are refused before anything is written.

### Opening spreads

`openingSpreads` lists the spreads a new book starts with, in order. The editor offers them in an empty book now, and new books get them once books can be created from any template (#63). Each entry names a layout and may set some of that layout's own parameters:

```ts
defineTemplate({
  …,
  spreads: ({ spread }) => ({ title: spread({ span: 'right', … }), story: spread({ … }), closing: spread({ span: 'left', … }) }),
  openingSpreads: [{ layout: 'title' }, { layout: 'story', params: { heading: 'Day one' } }, { layout: 'closing' }],
});
```

- The template fails to load if an entry names a layout that `spreads` does not declare, sets a parameter the layout does not have, or sets a value the parameter does not allow. TypeScript reports an undeclared layout as a property missing from `spreads`.
- Single pages must sit at a book end that every declared format allows: a `right` page only first and a `left` page only last, in formats with `ends: 'single-pages'`.
- The opening spreads don't need to meet the format's page count. Books are built up from them.
- Without `openingSpreads`, a new book starts with no spreads. A book with no spreads is valid: the editor shows an empty state that offers the opening spreads, if the template has any, and every layout that can start a book. The Book check reports `book-empty` as an error, so neither proof nor print export is possible yet. Deleting the last spread also leaves an empty book.

The starter declares a title page, one *Photo and story* spread and the closing page.

### Switching layouts

A spread can switch to any layout of the template with the same page footprint: a full spread to another full spread, a single left or right page to another of the same side. Changing between a spread and a single page changes the book's pagination and is not offered as a layout switch.

**An ID is the identity.** A box, element or parameter ID means the same thing in every layout that declares it, within its scope: spread parameters, the boxes of a spread and each box's parameters, the elements of a spread and each element's parameters. The spread keeps one state for all its layouts, keyed by these IDs; the layout decides which of it is shown. Templates need no extra declarations, roles or migration code for this.

- **Same ID, same type.** A box ID has the same box type (photo or Markdown) in every layout, and a parameter ID has the same parameter type in every layout within its scope. A template that breaks this fails to load with an error naming both layouts. Labels, defaults and constraints (`min`/`max`, `step`, `maxLength`, `multiline`, enum `options`, date `precision`, file `accept`) may differ, so a layout can offer fewer columns or a shorter title than another.
- **Different meaning, different ID.** Reusing an ID shares its value. The starter's closing page declares `closingLine` rather than `heading`, because a closing line is not the spread heading. Differently named boxes are never matched automatically, and box order plays no part: a two-photo layout shows the boxes whose IDs it declares.
- **Content.** Photo and Markdown assignments show in every layout with a box of that ID. Content a layout has no box for stays on the spread, is listed in the Inspector as *Saved outside this layout*, and shows again in any layout that has the box. Switching never deletes content, and sources stay in the project.
- **Placing kept content.** *Place in…* (or dragging the item onto a box of the same spread) moves kept content into a box of the current layout. If the box shows something, the two swap, so that content is kept instead of lost. A move is not a copy: the item is no longer kept, so it cannot appear twice when you switch back. Its crop focus moves with it; its per-layout crops were made for the old box's frames and do not. Box parameters belong to the box ID and stay. Dragging a kept item onto another spread, or a source from the strip onto any box, places another use of the source instead. *Discard* removes kept content from the spread; the source stays in the project, and Undo brings it back. Element settings kept for other layouts are listed by element name.
- **Latest edit wins.** There is one value per ID, so an edit made in any layout is what every later layout sees. Replacing a photo in one layout replaces it for all of them; an older assignment cannot come back by switching. Removing a photo or text is a real edit; visiting a layout without that box is not.
- **Parameters.** Spread, box and element parameter values follow the same rule. A value the current layout does not declare stays stored and returns with a layout that does. Values are stored only once set, so a layout whose parameter was never set shows its own default.
- **Rejected values.** When a stored value fails the target layout's constraints (for example a 120-character title where the layout allows 60, or a column count it does not offer), the value is kept unchanged, the layout uses its default, the switch says so, and the Book check warns. Setting the field in that layout replaces the value.
- **Crops.** A crop belongs to the layout it was set in, because frames differ. Returning to a layout restores its crop. A layout without its own crop fills its frame around the centre of the crop set last (the *focus*), clamped to the frame. Assigning another photo to a box starts over: no crop of the previous photo applies to it. Resetting a crop, or setting a centred fill, clears the focus.
- **Text flow.** Continuation is recomputed for the whole book after a switch, from the Markdown boxes each spread now shows.
- **Element editors.** Custom element editors never store their own state; their parameters follow the rules above.

Selecting a layout is one edit: Undo restores the previous layout with everything it showed. Pointing at a layout in the picker shows what switching would do, for example *2 photos carried over · 2 photos kept outside this layout · text will reflow*. A selected photo or open edit popover on the spread closes when its layout changes, and an open element editor reports that its values changed, so nothing is saved into a layout it was not opened for.

State that no layout of the template declares (after the template drops a box, element or parameter) stays in `project.json` and is reported in the Book check rather than removed.

### Layout families

Layouts that are variants of one design, such as a photo grid in 2×2 and 3×3, can form a **layout family**. Every variant is still an ordinary layout with its own ID and a fixed set of boxes, so everything in [Switching layouts](#switching-layouts) applies unchanged: choosing a variant is a layout switch, with the same carried, kept and restored content, per-layout crops, rejected-value fallbacks and one Undo step. Families change only how the choice is presented.

```tsx
function GridSizePicker({ variants, current, choose, readOnly }: LayoutPickerProps) {
  return <div role="radiogroup" aria-label="Grid size">
    {variants.map(({ id, variant }) => <button key={id} type="button" role="radio" aria-checked={id === current}
      disabled={readOnly} onClick={() => choose(id)}>{variant.size}</button>)}
  </div>;
}

defineTemplate({
  …,
  layoutFamilies: { grid: { label: 'Photo grid', picker: { label: 'Grid size', component: GridSizePicker } } },
  spreads: ({ spread }) => ({
    grid: spread({ label: 'Photo grid 2×2', family: 'grid', variant: { size: '2x2' }, boxes: box.photos(['a', 'b', 'c', 'd'], …), render: … }),
    grid9: spread({ label: 'Photo grid 3×3', family: 'grid', variant: { size: '3x3' }, boxes: box.photos(['a', 'b', 'e', 'c', 'd', 'f', 'g', 'h', 'i'], …), render: … }),
  }),
});
```

- **Declaring:** `layoutFamilies` declares each family by ID with a `label` and an optional `picker`. A layout joins one with `family`. `variant` holds free-form tags (strings, numbers or booleans) that tell the variants apart; ImageFlow gives them no meaning and passes them to the picker.
- **Rules, checked when the template loads:** the family is declared (TypeScript also rejects an unknown family); a family has at least two variants; its variants have the same `span`; tags are on every variant of a family or on none, and no two variants have the same tags; a layout with tags belongs to a family.
- **Box IDs carry the content.** Choose the variants' box IDs so shared content lands where it belongs. The starter's 3×3 grid declares the 2×2 grid's four boxes in its upper-left cells, so growing the grid keeps those photos in place, and shrinking it keeps the other five outside the layout until the spread returns to 3×3.
- **Sidebar:** a family with a picker is one layout preview, named after the family and showing the spread's current variant (or the first one). Clicking it selects that layout, like any other preview. While the spread uses the family, its controls appear automatically beside the spread's other settings, below the complete layout browser. A family without a picker shows a preview per variant, next to each other.
- **The picker** runs in a sandboxed frame with the template's CSS, as a labelled settings field. Prefer compact controls, such as a segmented choice for two grid sizes, over preview illustrations. Each `choose(id)` immediately switches layouts as one Undo step; `commit()` applies the current choice and `cancel()` leaves the controls. Undo reverts an applied choice. It receives `variants` (each with `id`, `label` and its `variant` tags), `current` (the variant chosen in the draft), `saved` (the spread's layout), `choose(id)`, `find(tags)` (the first variant whose tags include all the given ones, or `undefined`), `document`, `format`, `readOnly`, `commit()` and `cancel()`.
- **Only declared variants:** `choose` with anything other than a variant ID of the family changes nothing and the inline picker reports the invalid choice. A picker with several independent choices decides itself what a combination without a variant does, for example by disabling that option or choosing the nearest variant: `find({ size: '3x3', text: true }) ?? find({ size: '3x3' })`. Prefer tags over hard-coded IDs, so a new variant needs only a new layout.
- **Changes from elsewhere:** the controls keep their frame and measured height while their saved layout and document context follow the book. While the book reloads or cannot be edited, the controls are disabled; messages from stale declarations cannot change the book.
- **Agents and commands** keep switching layouts by ID with `switch_layout`. `get_authoring_context` reports `layoutFamilies`, and `family` and `variant` on each layout, so agents see the same grouping.
- **Scope today:** a finite list of explicitly declared variants, controlled from the sidebar's spread settings. The set of boxes is never derived from parameters, and unbounded counts (rows 1 to n) are not supported.

## Dependencies

A template can use npm packages, such as a map or chart library (included in the contract-1 baseline):

1. Add a `package.json` in `template/` and run `npm install` there.
2. Import the package as usual: `import maplibregl from 'maplibre-gl'`, and its CSS with `import 'maplibre-gl/dist/maplibre-gl.css'`.
3. Run `node scripts/rebuild-template-dependencies.mjs /path/to/template` from the ImageFlow source checkout. ImageFlow bundles every package the template imports into `template/vendor/`: `modules/` (ES modules, shared code split into chunks, CSS beside them), `types/` (the declarations those packages reach, in `types/packages/` by package name, so `.gitignore` rules for `node_modules` keep them), `LICENSES/` and `manifest.json` (packages and versions, the lockfile's hash, and which import maps to which module).

Books never read `node_modules`: book revisions, the folder watcher and **Save a Copy** skip it. Opening, previews, the Book check and export resolve package imports only through `vendor/manifest.json`, so a book renders the same code on every Mac, and the template hash, which covers `vendor/` but not `node_modules/`, identifies that code. A package import missing from the manifest is a compile error pointing at the rebuild, and so is a relative import into `node_modules/` (or a dot folder), which the template hash and copies leave out. When `package-lock.json` changes after a rebuild, the Book check warns (`template-dependencies`) and the book keeps the saved bundle until you rebuild. Exported templates and the library include `vendor/` and leave out `node_modules/`.

- **React** is the app's: packages that import `react` get the host's React and its hooks. Bundling `react`, `react-dom` or `imageflow` is refused.
- **Types:** the type check resolves packages from `vendor/types`, so `check_book` with `typescript: true` works without `node_modules`; problems inside third-party declarations are not reported. A package without declarations (and no `@types` package) is typed as `any`, with a `template-dependencies` warning. The rebuild also points `paths` in `template/tsconfig.json` at `vendor/types` and excludes `vendor/` there, so code editors see the same declarations.
- **Purity still applies:** a library may run freely in an [element editor](#element-editors). In a layout, asynchronous or GPU work such as drawing a map runs inside a [`<RenderedImage>`](#rendered-images); `render` itself stays synchronous ([Render function](#render-function)).
- **Stylesheets:** a package's CSS is bundled with the template's own, and inline `data:` images in it stay inline.
- Licences: `vendor/LICENSES/` holds each bundled package's licence file. Keep it when you share the template.

## Render function

`render(context)` is called per spread instance and must be a pure function of its input: no state, effects, timers, randomness, or data fetching. Rendering never changes the book's saved content. Work that loads declared external resources or finishes later, such as drawing a map, goes through [`<RenderedImage>`](#rendered-images), which the host runs, waits for and checks.

Book check and export enforce the parts of this that would make a printed page depend on something outside the book. While they render, a call from template code (including bundled libraries and module setup) to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `SharedWorker`, `importScripts`, a GPU canvas context (`webgl`, `webgl2`, `webgpu`, `bitmaprenderer`, on `HTMLCanvasElement` or `OffscreenCanvas`), `navigator.gpu`, `setTimeout`, `setInterval`, `requestAnimationFrame` or `requestIdleCallback` is a `render-impure` error naming the API and, when it happened while a layout rendered, its spread. Print export refuses a book with such an error. A 2D canvas is allowed. While a `<RenderedImage>` is drawing, these calls are its declared work and are not recorded. The editor's own previews and element editors are not checked, so an element editor may use these APIs (see [ADR 0006](decisions/0006-template-capabilities.md)). The check reports mistakes; it is not a sandbox, and the render frames' content security policy blocks other origins regardless.

```ts
type RenderContext = {
  params: SpreadParams;                     // this spread instance
  document: DocumentParams;
  boxes: Record<BoxId, {
    params: BoxParams;
    photo?: { caption?: string; title?: string; credit?: string; altText?: string; width: number; height: number } | null;
    text?: { title?: string; part: number; parts: number } | null;  // flow position for Markdown boxes
  }>;
  elements: Record<ElementId, { params: ElementParams }>;
  page: { left?: number; right?: number; number?: number };  // page numbers: left/right, or number without facing pages
  format: ResolvedFormat;                   // trim, bleed, safe area in mm, for the chosen format
  formatId: string;                         // the chosen key of `formats`, or 'default'
  mode: 'edit' | 'export';
  edit(...paths: EditPath[]): { 'data-edit'?: string };  // marks a node for click-to-edit
  geometry: BoundGeometry;                  // the geometry helpers with this format applied
  PhotoBox; MarkdownBox; Element;          // the platform components, typed to this layout's IDs
  Text;                                     // shows a string parameter and makes it editable
  book: {                                   // the whole book, as seen from this spread
    pages: number;
    anchor(id: string): Anchor | undefined; // the anchor with this ID (see Anchors)
    anchors(id?: string): Anchor[];         // all anchors with this ID, or all anchors, in page order
  };
};
```

### Rendered images

A picture that takes time to make, such as a map drawn by a WebGL library from remote tiles, renders through `<RenderedImage>` (included in the contract-1 baseline):

```tsx
import { RenderedImage } from 'imageflow';

<Element id="map" rect={rect}>
  <RenderedImage label="Map" inputs={{ style, longitude, latitude, zoom }} style={{ position: 'absolute', inset: 0 }}
    draw={async ({ width, height, pixelRatio, mode, signal }) => drawMap({ style, longitude, latitude, zoom }, { width, height, pixelRatio, signal })} />
</Element>
```

- **Drawing:** ImageFlow calls `draw` when the element mounts and again when `inputs` (JSON-like data, everything `draw` depends on) changes. It passes the box's size in CSS pixels (96 per inch), `pixelRatio` (device pixels per CSS pixel), `mode` (`'preview'`, `'check'` or `'export'`) and an `AbortSignal`. Resolve to a canvas, an `OffscreenCanvas` or an image `Blob`; ImageFlow shows it as an image that fills the box. Nothing is saved in the book.
- **Resolution:** previews draw at the screen's density (at most 2×; thumbnails and checks at 0.5×). Export draws at the format's target resolution ÷ 96, 300 ppi when the format sets none, so a picture is as sharp in the PDF as the format asks.
- **Waiting:** the Book check and every export page wait for all pictures on the page before they are final. Each picture may draw for 60 s (120 s in export), counted from when it starts drawing, not while it waits for others; the check or export waits as long as pictures keep finishing. In the editor, pictures fill in as they finish, over a striped placeholder, and the Book check lists failures as they happen and shows while pictures are still drawing. At most two draw at once in the book view and one elsewhere, so a long book does not open a GPU context per page.
- **Drawing again:** the picture is drawn again when `inputs`, the box's size or the output resolution changes. Each drawing uses the `draw` and values of the render that started it, so draw anything that must match the picture (such as a route over a map) from the same values as `inputs`.
- **Page and layout thumbnails:** while a book window stays open, identical pictures can be reused across page switches and saves. Cached pictures are restored before a replacement thumbnail frame is shown, so editing one page does not blank an unchanged map on another. New pictures still draw progressively. This bounded memory cache includes the layout, picture position, declared inputs, dimensions and pixel ratio, and is invalidated by changed template code or network permissions. The first view still needs to draw; checks, exports and printing always render afresh.
- **Cancellation:** `signal` is aborted when the element unmounts, a newer drawing replaces it, or the timeout passes; stop work and release GPU resources when it fires. A result after that is discarded, so an older drawing never replaces a newer one.
- **Resolution:** the picture covers the box (`object-fit: cover`), so draw it at `width × pixelRatio` by `height × pixelRatio` pixels. A picture with fewer pixels on either axis fails with `rendered-image-failed`, since it would print blurred or stretched.
- **Failure:** throw or reject with a message, such as `Error('The map style could not be loaded.')`. The box shows the message, and the Book check reports `rendered-image-failed` for the element, so export stops instead of printing the page without its picture. Decide readiness yourself: the starter's map resolves on MapLibre's `idle` event and rejects on any `error` event, so a style or tile that failed to load fails the picture.
- **Network:** `draw` may reach the template's declared [`network`](#element-editors) origins once the user has allowed them; otherwise its requests are blocked and the picture fails. Its requests, WebGL contexts, workers and timers are not `render-impure`.
- `label` names the picture in messages (default `'Picture'`); `alt`, `className` and `style` apply to the box, whose class is `if-rendered-image` with `data-rendered="pending" | "ready" | "failed"`.

### Click-to-edit

`ctx.edit(...paths)` marks the node that shows parameters, so clicking it in the editor opens a popover with a control for each parameter (text field, month or date picker, segmented choice, slider, colour). Spread the result onto the node:

```tsx
<h2 {...ctx.edit('heading')}>{ctx.params.heading}</h2>
<Element id="grid" {...ctx.edit('month')}>…</Element>
```

Paths name a spread parameter (`heading`), a document parameter (`document.paper`), an element parameter (`elements.grid.firstWeekday`), or a box parameter (`boxes.hero.showCaption`). With the `spread` builder, paths are type-checked. `<Element>` is an edit target for its own parameters without marking; marks on it add more. Outside the editor the marker stays as an invisible `data-edit` attribute, so checks can name the parameter a text block shows (for example in `text-overflows-box`); the Book check warns about paths the layout does not declare. Set `precision: 'month'` on a date parameter to edit it with a month picker; the value is the month's first day.

For the common case of one string parameter shown as text, `ctx.Text` reads the value and marks the node in one step:

```tsx
<ctx.Text parameter="heading" as="h2" rect={ctx.geometry.page('right', 'safe')} />
<ctx.Text parameter="boxes.hero.credit" as="figcaption" placeholder="Photo credit" />
```

`parameter` takes the same paths as `ctx.edit`, limited to string parameters. `as` is one of `h1`–`h6`, `p` (default), `span`, `div`, `blockquote` or `figcaption`; `className`, `style`, `rect` and `issue()` markers work as on the platform components. When the value is empty, the editor shows a dimmed placeholder in the template's own type (`placeholder`, else the parameter's `placeholder`, else its label) and marks the node `data-empty`; the exported book shows the empty node. The value is rendered as text, never as HTML, and newlines follow the node's CSS `white-space`. `fallback` displays inherited text when the saved value is empty or whitespace-only, without saving it. Set `fallbackLabel` to name its source: inherited text has a dotted underline in edit mode and the popover explains what clearing the override does. `hidden` suppresses the node explicitly; whitespace never means hidden. A template can bind it to a separate visibility parameter, as the calendar does with `showPlace`. Use `ctx.edit` for nodes that combine several parameters or show more than the value.

Templates read photo metadata (for captions) and page numbers through the context; they never receive file paths, image data, or Markdown source, and they cannot change project data.


### Anchors

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

- **One render pass.** Page numbers depend only on spread order and layout spans, never on rendered content. ImageFlow calls every spread's `anchors` with its resolved `params` and `document` values before any spread renders, so every layout reads the same anchors. Like `render`, `anchors` must be a pure function of its input. An `anchors` function that throws or returns an invalid declaration is a render error naming the layout.
- **Pages follow the book.** Inserting, moving, removing or switching a spread renumbers every anchor, as it does the folios. `side` picks the page of a two-page spread and defaults to the first. A single left or right page has only one page, whichever side is named. Without facing pages every unit is one page: `side` is ignored and the anchor's `side` is `'page'`.
- **Repeated layouts.** Anchors belong to spread instances, so a layout used five times declares five anchors with the same ID. `anchors(id)` lists all of them in page order. `anchor(id)` is for an ID that one spread declares.
- **Book check.** `anchor(id)` warns `anchor-missing` when no spread declares the ID, and `anchor-ambiguous` when several do. In that case it returns the first. Both warnings are on the spread that asked. `anchors(id)` returning an empty list is not a finding.
- **Previews.** Layout-picker previews read the anchors of the book as saved, so a contents layout previews with real pages.

An anchor marks a whole page, not a point found by measuring the render. Text flow decides which page a heading inside Markdown continuation lands on, so such headings cannot be anchors yet.

### Editing UI

Saved data and its editing UI are separate. Parameters declare what is saved: IDs, types, defaults, constraints and scopes, which persistence, validation, Undo and project commands (including MCP) rely on. How they are edited is chosen at three levels, from no code to custom UI. Choose the smallest level, and the smallest editor, that does what was asked: a request for a changeable emoji is one string parameter (and a size if wanted), not a choice between emoji, text and uploaded artwork. [`editing-levels.tsx`](examples/editing-levels.tsx) shows all three.

1. **Generated controls (default).** Every parameter gets a control: text field, switch, slider and number, segmented choice or menu, colour, date or month, file chooser with import. Nothing to write.
2. **Arranged controls.** `controls` on a spread, box or element arranges the generated controls of that scope's parameters: order, titled groups, labels, descriptions, and conditions.

   ```tsx
   controls: ['show', { group: 'Stamp', when: { show: true }, controls: [
     'text', { parameter: 'tilt', label: 'Rotation', description: 'Negative values turn it counter-clockwise.' }, 'ink',
   ] }],
   ```

   An entry is a parameter ID, `{ parameter, label?, description?, when? }`, or `{ group, description?, controls, when? }`. `when` names other parameters of the same scope and the values they must have (all must match; an array matches any of its values). For boxes, pass `controls` as `box.photo(label, parameters, { controls })` or in `box.markdown`'s options.
   - A parameter left out of `controls` gets no generated control. It keeps its value, its validation and its project commands, so use this for values only a custom editor or an agent sets.
   - `controls: []` shows no generated controls for the scope while keeping every declaration. A group needs at least one entry.
   - A condition only hides a control. The value stays saved and validated, and comes back when the condition holds again. Conditions are presentation: they never remove a declaration or change a saved ID.
   - Click-to-edit follows the box's or element's `controls` for its own parameters. A parameter a node explicitly shows with `ctx.edit` or `ctx.Text` is always editable on that node.
   - The authoring types check entry IDs against the scope's parameters. Loading the template reports unknown or repeated IDs, a parameter a custom editor owns, conditions on unknown parameters, on the control's own value, or on values the parameter can never have.
   - Controls that can hide themselves for good load with a `declaration-control-cycle` warning in the Book check: a control inside a group shown only depending on that control (a group shown while `show` is on that contains `show`), or controls whose conditions depend on each other (A shown only when B is on, B only when A is on). For layout (spread) parameters, the warning is given per spread: a spread that marks one of them on the page with `ctx.edit` or `ctx.Text` gets none, since that node's popover always shows it, while another spread of the same layout that marks none of them (for example because its values hide the marked node) gets the warning on itself. Marking a box's or element's own parameter does not count: its popover follows the same `controls` and conditions.
3. **A custom editor** for an element, below.

#### Where editing happens

Click a box, element, or marked node to edit it. Generated item controls and photo controls share a fixed position at the bottom center of the visible canvas; the selected item remains outlined on the page. The sidebar lists items without repeating their controls.

- **Photo boxes:** clicking a placed photo selects it to drag and pinch. Its toolbar has a **More photo actions** menu for **Replace photo…**, **Remove photo**, and **Crop values…**, alongside the box's own parameters and any other parameters the template marks the box with (such as a spread setting shown in its caption). An empty photo box (or one whose frame the template rotates) opens a popover with **Choose photo** and the same settings.
- **Markdown boxes:** clicking one opens a popover with its text (assign, import, show), its place in the text flow, its parameters and any parameters the template marks it with.
- **Elements:** an element with a custom editor opens it at the same bottom-center canvas position, with a scrolling body and a fixed header with × to close. The canvas stays scrollable, and the element's other parameters appear below the custom controls. Spread parameters the editor declares in `spread` are edited there too; other spread parameters marked on such an element stay in the sidebar. Any other element opens a popover with its generated controls.
- **Marked nodes:** a node marked with `ctx.Text` or `ctx.edit` opens a popover for those parameters. A node smaller than the box under it wins, so a heading over a photo edits the heading. A parameter may be shown by several nodes, such as `ctx.Text parameter="heading"` on both pages: each is its own place to edit, the selection outline follows the occurrence clicked and Tab reaches each, while all of them edit the same saved value. The sidebar lists the parameter once.
- **The sidebar** holds the spread's layout, the spread parameters nothing on the page edits, content kept for other layouts, and a list of what the page edits: marked nodes such as `ctx.Text` headings (in reading order), then the declared boxes and elements. The list shows what each holds and opens the same editors, so empty, overlapping and keyboard users reach everything. Boxes and elements are told apart by identity, never by position, so two at the same place each edit their own values. A box or element the layout does not render right now opens the same bottom panel with its declared parameters and a note that it is hidden. Format and document parameters live together in the template controls, named for the template. The app header uses the book’s file name. Menus open the editing surfaces; they do not duplicate custom controls.

### Element editors

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

- **Opening it:** clicking the element opens a non-modal panel, and so does the element's entry in the sidebar's list.
- **Layout parameters with it:** a task can need a layout (spread) parameter too, such as a title shown with a calendar. List those in `spread`: `editor: { parameters: ['month', 'marked'], spread: ['title'], component }`. The editor reads all layout parameters as `spread`, changes the listed ones with `setSpread(changes)` or `<Control parameter="title" scope="spread" />`, and applies those changes immediately. They stay layout parameters: saved data, MCP's `set_parameter` and other layouts that declare them are unchanged; only where they are edited moves. A listed parameter gets no sidebar control and may not appear in the layout's `controls`; each one belongs to one editor. Document settings stay read-only to element editors; a [document editor](#document-editors) edits them. Included in the contract-1 baseline.
- **One editor for the element:** parameters the editor lists are edited only by it. The element's other parameters appear below it as generated controls (arranged by the element's `controls`). Both apply valid changes as they happen; the editor's `values` follow the generated controls too. Clicking × or outside the panel first applies anything still being typed in the editor's frame, including in `<Control>` fields. If the editor fails while applying, or does not answer within a few seconds, the panel stays open with an error; after a timeout, × closes it directly. Changes already applied remain saved.
- **Typed props:** `ElementEditorProps<P, K, D, S, SK>` types the props from the element's parameters `P`, the IDs the editor lists `K`, optionally the template's document parameters `D`, the layout parameters `S`, and the layout IDs the editor lists `SK`. `spread`, `setSpread` and `Control` with `scope="spread"` use those layout types and owned IDs. `values` and `document` then have each parameter's type (an enum's options, a number, a string), `set` accepts only the editor's own parameters with values of their type, and `Control` only the editor's own parameters, so `set({ zoon: 2 })`, `set({ size: 'huge' })` for an enum without that option, or `<Control parameter="opacity" />` for a parameter the generated controls edit fail type checking. An editor typed for other parameters than its declaration lists fails too. Declare the parameters as a constant to write `typeof calendar`; an editor written inline in `editor.component` is not typed from the declaration, so annotate its props the same way. `ElementEditorProps` without type arguments keeps the untyped props.
- **Sandbox:** the component runs in a frame on the render origin with the template's CSS, like the book previews. It receives `values` (all of the element's parameters, with the draft applied), `set(changes)`, `spread` and `setSpread(changes)` (above), `document`, `format`, `readOnly`, `commit()`, `cancel()`, `Control` and `importFile`. It cannot change project data itself.
- **ImageFlow's controls inside:** `<Control parameter="track" />` draws the app's own control for one of the editor's parameters, bound to the draft: the same field, slider, choice or file chooser (with import) as the generated controls, with their validation and accessibility, in the editor's appearance. Compose it with your own UI instead of rebuilding file handling or form controls. `label` overrides the parameter's label.
- **Files:** `importFile(accept)` asks the app to import a file into the project and resolves to its file ID, or `undefined` when the user cancels; `<Control>` for a file parameter uses it for **Choose file…**. Assign the ID with `set` to save the assignment immediately; Undo can revert the assignment while keeping the imported file in the project. `file(id)` reads the new file at once.
- **What ImageFlow owns:** the non-modal panel, × to close, Escape and ⌘↩, read-only mode, validation against the parameter schema, and saving. Each valid `set()` or `setSpread()` change is undoable. Closing leaves applied changes in place. Escape discards only uncommitted typing.
- **Applying and closing:** `set()` applies changes immediately, so `set({ ... }); commit()` applies those changes and closes; `values` catches up on the next render. `commit()` finishes the active field and closes. `cancel()` closes without applying the active field; it does not revert earlier changes. These callbacks remain available to existing custom components.
- **Changes `set()` and `setSpread()` cannot make:** a key that is not one of the editor's parameters, or a value the parameter does not allow (an enum value outside its options, a number out of range), is not applied. The other changes in the same call are. Each such problem is reported once, in the frame's console and in the dialog, with the parameters the editor edits or the values the parameter takes; it does not prevent valid edits or closing. `<Control>` for a parameter the editor does not own fails the editor with a message listing the ones it does.
- **Context:** `context` is the spread the editor was opened from, read-only, with the same values `render` reads: `spread` and `layout` (its ID and layout), `params`, `document`, `boxes` (with each photo's metadata), `elements`, `page`, `book` (page count and anchors), `format` and `formatId`. Markdown boxes' `text` is `null`, since flow positions are known only to the book render. The editor's own draft is applied to it: an element editor's element values (including the generated controls' draft) and the layout parameters it owns, or a document editor's own document parameters. The top-level `format` and an element editor's `document` are the context's, so they follow it too. Write helpers that need the page's place in the book against `Pick<RenderContext, 'page' | 'book' | 'document'>`, so `render` and the editor share them instead of saving a second, possibly inconsistent value. Included in the contract-1 baseline.
- **The context follows the book; the editor's values do not.** While the editor is open, every newer render of the book refreshes `context`: moving the spread, another photo, another format, or a changed document setting the editor does not edit. The draft is kept and nothing is reported. A change to the values the editor edits is a conflict, handled as below. Deleting the spread closes the editor.
- **Changes from elsewhere:** if what the editor works on changes while it is open (a saved value after Reload or Undo, or a template edit that changes a default or a declaration of the parameters it handles), the panel says so and refuses to save; the user reopens the editor on the current values. During a reload, controls pause visibly and resume when the preview is ready. A rejected or failed save also pauses the editor with a message; reopening starts from confirmed saved values.
- **Failures:** if the component throws while rendering, in an event handler or in async work, the panel shows the error and keeps Close available. Earlier applied changes remain saved. The editor counts as loaded once the component has mounted.
- **Network:** a template may list HTTPS origins in `network`, such as `network: ['https://tiles.openfreemap.org']` (or `https://*.example.com` for subdomains; no paths). Importing the template into the library lists these sites, with an option to allow them in every book made from that version; **Templates → Manage Templates…** shows them and can allow them or stop allowing them later. That trust belongs to the template's hash: a book whose template still has exactly that hash, needs no question, and any change to the template's files asks again. Built-in templates are trusted for the sites they declare. Otherwise, the first time the book renders, or one of its element editors opens, ImageFlow asks the user to allow them, once per book and version of the template: the answer, too, ends when the template's files change. Once allowed, that book's element editors, previews, thumbnails, Book check and export may fetch, load images and fonts from, and open blob workers for those origins; undeclared origins stay blocked. Until then the book stays offline: its [rendered images](#rendered-images) that need the sites fail, so the Book check reports them and export stops, and the question comes back when an editor opens. Revoking the trust in Manage Templates, or changing the template, renders open books again under the new policy, loads an open element editor again, and stops a running export, which then saves nothing. Printing such a book needs the network. Included in the contract-1 baseline.
- **Scope today:** the element's parameters and the layout parameters it lists, shown in a non-modal panel (`presentation: 'dialog'` remains the accepted declaration); a sidebar placement is not available yet. Editors can read files of file parameters with `file()`, and reach remote resources only through `network`. The starter has three reference examples: the **Map** layout's editor (below), the calendar editor (month and marked days, the layout's **Calendar title** through `spread`, and **Week starts** as a generated control below it) and the route map's **Edit route** editor. Choosing a track and framing it are one task, so that editor owns the GPX `track` (drawn with `<Control parameter="track" />`, including import) and the viewport, kept as three ordinary number parameters (`centerX`, `centerY`, `zoom`) and edited together by dragging, scrolling, buttons or arrow keys. It draws only the GPX track, without a basemap, so export stays offline.

The **Map** layout (`sample/starter/template/map.tsx`) is the full-capability example ([ADR 0006](decisions/0006-template-capabilities.md)). Its editor runs MapLibre GL from the saved dependency bundle with OpenFreeMap styles (Liberty, Bright, Positron), declared in `network`; it owns the GPX track, the style and the view (longitude, latitude and a print zoom that is independent of the screen size). The view is saved as ordinary parameters as you move it. The layout draws the map with a [`<RenderedImage>`](#rendered-images): live at screen resolution in the preview, and again at the format's target resolution for export, with the track over it as SVG so the line stays vector in the PDF. A map that cannot be drawn, for example because the map server is down, fails the Book check with `rendered-image-failed`.

### Document editors

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
- **Example:** the calendar starter's day picker. A click marks a date once, for the year of the page; a day covered by a yearly date shows as marked and is not toggled, and the list below the month offers *Unmark every year* (or *Mark every year* for a one-off date). Removing a yearly mark keeps a one-off mark of the same day. The full text stays available under *All marked days*. Included in the contract-1 baseline.

#### Appearance in custom editors

Custom editor frames follow the app's appearance automatically, including changes while a dialog is open. The app's Settings offer Light, Dark, or System (the default, following macOS). No appearance attribute or opt-in is needed. Editors must support both light and dark appearances: inherit the host's text and background colors, and use its CSS variables for custom surfaces, controls and states:

```tsx
<div style={{
  color: 'var(--if-editor-text)',
  background: 'var(--if-editor-background)',
}}>…</div>
```

Available variables: `--if-editor-background`, `--if-editor-text`, `--if-editor-muted`, `--if-editor-control`, `--if-editor-border`, `--if-editor-selection`, `--if-editor-accent`, `--if-editor-focus`, `--if-editor-marked-background` and `--if-editor-marked-text`. They update live without recreating the editor or committing its draft. The starter calendar and route editors demonstrate both surfaces and selected states. Theme variables are scoped to the editor host; use explicit authored colors for book artwork. Never apply editor appearance styles to `.if-sheet`, print output, or template artwork.

### File parameters

A parameter can refer to a file the user adds to the project, for input that is not photos or Markdown, such as a GPX track for a map:

```tsx
import { file, p } from 'imageflow';

elements: { route: { label: 'Route map', parameters: { track: p.file({ label: 'GPX track', accept: ['.gpx'] }) } } },
render: (ctx) => {
  const track = file(ctx.elements.route.params.track);   // { name, extension, text } or undefined
  …
},
```

- **Choosing:** the generated control lists the project's files with an accepted extension, offers **Choose file…** to add one and **Remove** to clear the assignment. Imports follow **Settings → General → New imports** and register a copied or linked file in `project.json`; assigning it is a normal edit. Undo removes the assignment and keeps the file; clearing never deletes a file.
- **Value:** the file's ID in the project's `files` registry, or `''`. Paths in the registry are relative to the project, so moving the project folder keeps its files.
- **Content:** `file(id)` returns the file's name, extension and UTF-8 text, read when the project loads (files are limited to 20 MB). Preview and export render from the same text. It returns `undefined` when nothing is assigned or the assigned file cannot be read.
- **Diagnostics:** ImageFlow reports an assigned file that is no longer registered, missing or unreadable, or whose extension is not in `accept`, as a Book check error for that element, which blocks print export. An unassigned file parameter is valid. The template parses the content. If it cannot, it should render without it and report a [template finding](#template-findings) that names the element, parameter and file.
- **Example:** the starter's Map layout draws a GPX track over a basemap it renders (see [Element editors](#element-editors)). The Panorama layout has a Route map element that draws an assigned GPX track as a line in an inset (`sample/starter/files/senja-road.gpx`), without a basemap.

### Template findings

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
- `severity` is `warning` by default. `error` blocks print export, like other layout errors.
- `details` carries measured or related values (strings or numbers). `suggestion` is advice for a person or agent; ImageFlow never applies it.
- A finding is reported once per spread render, however many identical nodes carry it. Findings render from the same input every time, so editor, check and export report the same ones.

A plain `data-issue="…"` attribute still works. It reports a `template-issue` warning on the containing box or element. An `issue()` value that fails validation is reported as `template-issue-invalid`.

## Geometry helpers

`geometry` computes rectangles in millimetres in spread coordinates: x from the left page's trim edge (the right page starts at the trim width), y from the top trim edge. In a format without facing pages the sheet is one page, and x starts at its left trim edge. Pass a rectangle to a platform component's `rect` prop (`PhotoBox`, `MarkdownBox`, `Element`, `Text`), or `geometry.css(rect)` to any node's `style`, to position it absolutely inside `<Spread>`. Properties in `style` win over the ones `rect` sets, so `rect={area} style={{ height: 'auto' }}` lets a block grow.

`ctx.geometry` holds the same helpers with the spread's format already applied: `ctx.geometry.page(side, area?)` (`ctx.geometry.page(area?)` without facing pages), `ctx.geometry.spread(area?)` and `ctx.geometry.design(canvas)`, plus `inset`, `grid` and `css`. The functions below remain available for helpers outside `render`. The helpers return plain numbers, so ordinary CSS and inline styles stay available, and nothing scales type.

| Helper | Returns |
| --- | --- |
| `page(format, side, area?)` | One page. `area` is `trim` (default), `safe` (the format's safe insets, with the binding inset next to the fold) or `bleed` (outer edges extended into the bleed; the fold edge stays at the fold, because a page's binding bleed shows the facing page). Works for single first and last pages. |
| `page(format, area?)` | The page of a format without facing pages: `trim`, `safe` (left and right insets) or `bleed` (all four edges). With facing pages a side is required. |
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

Use `page` and `spread` for physical layouts that keep margins in millimetres on every format. Use `design` to scale a composition drawn on a fixed canvas, as the starter does. These numbers are physical lengths for CSS, unlike the structured `mm()`, `pt()` and `inch()` values used in print-format declarations. The starter's layouts use these helpers.

## Platform components

| Component | Purpose |
| --- | --- |
| `<Spread>` | Root of every spread. Sizes the spread to two trims plus bleed, sets geometry CSS variables, and handles page halves. |
| `<PhotoBox id>` | Renders the assigned photo with its crop (the photo always covers the box; the saved crop picks the visible region), using a preview-size image in the editor and a rendition capped at the format maximum resolution in export (300 ppi when omitted). Its element is the box's geometry and drop zone. Users select the photo in the editor and drag and pinch it; templates do not handle the crop. |
| `<MarkdownBox id>` | Receives the flowed fragment of the assigned Markdown source. Its element is the box's geometry and drop zone. |
| `<Element id>` | Wraps generated artwork so the editor can highlight it, and opens its parameters when clicked; an element can supply its own editor (see Element editors). |
| `<ctx.Text parameter>` | Shows a string parameter and makes it editable by clicking it (see Click-to-edit). Only on the render context, because it reads the layout's values. |
| `asset(path)` | Resolves a file in `template/assets/` for use in `src` or CSS. |

Rules:

- Each declared box is rendered exactly once through its component; each declared element at most once.
- Boxes and elements are positioned and sized by template CSS on the component's element (`className`, `style`), or by `rect` (see Geometry helpers).
- An empty box keeps its area in edit mode so it can receive drops. In export, its wrapper remains but the edit placeholder is omitted; templates can style `[data-empty]`.

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

`<Spread>` sets, in physical units from the resolved format:

```css
--trim-width; --trim-height;          /* one page */
--bleed-top; --bleed-bottom; --bleed-outside;
--safe-top; --safe-bottom; --safe-outside; --safe-binding;
/* without facing pages, instead of the outside and binding variables: */
--bleed-left; --bleed-right; --safe-left; --safe-right;
```

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

## Validation

When the template is loaded:

- `id`, `version`, `contract` present; contract version supported; every capability in `requires` provided by this app.
- Exactly one of `format` or `formats`. Unknown declaration properties and `spreadFor` document mismatches are warnings (see [Declaring spreads](#declaring-spreads)).
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

Errors in edit mode appear in Book check. Print export blocks on render errors and PDF preflight failures. Proof export permits reported layout errors, but still requires a successful render and correct PDF page count and dimensions. Warnings do not block print export.

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

`MarkdownBox` accepts `columns` (default 1, rounded and clamped to 1–6). Use `style={{ columnGap: '5mm' }}` for the gap. Text continues down each column, then through the next assigned box in spread/flow order. Expose a box parameter and pass its resolved value to `columns` if users should control it. Column layout remains platform-owned; avoid overriding its flow machinery with CSS.

Numeric `step` is a control increment, not a runtime divisibility constraint. Month precision changes the picker; it writes `YYYY-MM-01`, but existing valid ISO dates are not normalized. Use first-of-month defaults and bounds for month parameters.

Adjusting a selected photo draws it over the box's on-screen rectangle, so it assumes the box is upright. If template CSS rotates or skews a `PhotoBox` (or an ancestor inside the spread), the editor offers only the numeric crop values for it. Clicks act on the box or element drawn on top, in document order; content stacked with `z-index` is not accounted for.

Identifiers start with a letter or digit, then contain letters, digits, underscores or hyphens; reserved Object prototype names are rejected. Dots separate edit-path scopes and cannot occur in identifiers. PhotoBox, MarkdownBox and Element automatically expose their declared parameters; explicit edit marks add parameters. Ordinary nodes need `ctx.edit` or `ctx.Text`. Exported artwork keeps the invisible `data-edit` marks, so checks can name the parameter a text block shows. Avoid overlapping targets or marking several nodes with the identical path list: the current editor identifies targets by spread and path list.

### Persistence and evolution

`project.json` has `schemaVersion: 1`, `title`, `template: { id, version }`, document `params`, `texts` (ID → relative path), and ordered `spreads`. Each spread has `id`, `definition` (its current layout), and one `params`, `boxes` and `elements` state shared by all its layouts; see [Switching layouts](#switching-layouts). The example above shows one spread, not a complete project. Photo metadata is keyed by stable photo ID in `photos.json`; dimensions are derived from image files. Crop centers are normalized 0–1; zoom is 1–20. Constraints are checked on rendering; invalid saved values remain stored and render using defaults. Sources remain in the project even when no box uses them.

New projects copy the starter template. Updating the app does not replace existing project templates. Every supported contract-1 runtime provides the baseline above. Later extensions use `requires`; keep the app and authoring declarations aligned. Renaming an ID or moving a parameter between scopes requires an explicit project-data migration; there is no automatic migration framework. PR #7 moves the starter calendar month to `elements.grid.params.month`; replacing only the template in an older project does not migrate that saved value.

### Preview limitations

The editor renders the whole book for the canvas and again for thumbnails. Layout choices render independently and restart Markdown from the beginning; they are composition previews, not previews of the actual continuation fragment. Review the main book and exported proof for final flow. Large-book latency and memory use need separate measurement.

The API is the in-process `imageflow` template module. There is no documented public REST or automation API. Desktop IPC and frame messages in `src/desktop.ts` are internal implementation details.

### Enum maps and scaled CSS lengths

`p.enum({ label: 'Language', options: { en: 'English', de: 'Deutsch' }, default: 'en' })` normalizes to the existing array-of-options declaration with labels. Keys become string saved values, including unquoted numeric keys; TypeScript checks the string default against those keys. Maps follow JavaScript property enumeration order: array index keys (such as `'2024'`) are sorted first in ascending order, then other string keys keep insertion order. Use the array form when option order must be explicit. Array options and separate labels remain supported.

`const at = ctx.geometry.design({ width: 420, height: 297 })` exposes `scaleX` and `scaleY`. `at.length(19, 'pt', 'x')` returns a CSS length, rounded to two decimal places. Choose `x`, `y`, `min` or `max` explicitly, including for type sizes; positions still scale on their respective axes. Units are `mm`, `pt` or `px`. Canvas dimensions must be positive and finite. The calendar uses the x axis to preserve its existing typography.

### Generated authoring SDK

The canonical SDK is `authoring/`. `npm run generate:authoring` generates standalone snapshots for both shipped templates; the build runs it automatically. Their tiny `tsconfig.json` extends `./.imageflow-sdk/tsconfig.json`. No template maintains a declaration copy or synchronization test.

Creating a book writes the installed SDK into `template/.imageflow-sdk/`. Exporting a template includes a fresh snapshot in the archive for external authoring, without changing its source folder. App import discards all archive-supplied SDK folders, at any depth; new books and subsequent exports use the installed SDK instead. Existing books are never rewritten when opened. The snapshot includes React declarations, a standalone TypeScript configuration and `api.json` identifying contract 1 and the SDK content digest. Outside ImageFlow, run `tsc -p .imageflow-sdk/tsconfig.json`, or extend that configuration from your own `tsconfig.json`.

`.imageflow-sdk/` is reserved for generated tooling. It is excluded from template hashes, saved-input revisions and runtime imports; the app always checks against its installed SDK. Authored source and other declaration files remain part of template identity. An export may contain different tooling bytes after an app update while retaining the same authored-template hash.

### Actual element geometry in editors

`context.elements[id].rect` is the element’s measured bounding rectangle in millimetres relative to the spread’s trim origin. It comes from the current page, including CSS sizing, rather than reconstructing a whole-spread rectangle. It is `null` before the current page is ready or when the element is not rendered. CSS rotation or skew yields a bounding rectangle. Changes of format, layout, element size, or DOM content/class/style that moves an element refresh the measurements; ordinary editor draft overlays preserve them.

The map editor waits for its first measurement, uses the actual output aspect ratio and width to frame the map, and keeps its existing map stable while the book redraws. Saved map settings remain ordinary parameters.
