# Template API (contract 1)

Status: implemented reference for the v1 runtime, including UI PR #7. The executable schemas in `src/template.tsx`, `src/parameters.ts`, `src/format.ts`, and `src/project.ts` govern validation. The authoring declarations are in `sample/starter/template/types/imageflow.d.ts`; the complete working example is `sample/starter/template/index.tsx`. Historical proposals are not alternative supported APIs.

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

The app bundles `index.tsx` with esbuild. `react` and `imageflow` are provided by the host and must not be bundled. Relative imports, CSS imports, and asset imports inside `template/` are allowed; other package imports are not supported. Templates must render deterministically without fetching data, timers, state, or effects. This is an authoring requirement, not a guarantee that arbitrary template JavaScript is safe; open only projects you trust.

## Declaration

The following sketch illustrates the scopes; `MonthGrid` and the abbreviated format are placeholders. Use the starter template for a complete compilable package.

```tsx
import { defineTemplate, p, mm, Spread, PhotoBox, MarkdownBox, Element } from 'imageflow';
import './styles.css';

export default defineTemplate({
  id: 'senja-starter',
  version: '0.1.0',
  contract: 1,

  // One print format, or several named `formats` the user chooses between; see below.
  format: {
    label: 'Saal Digital Professional Line 30 × 30 cm',
    trim: { width: mm(294), height: mm(294) },
    /* bleed, safe, structure, output … */
  },

  // Document scope
  parameters: {
    showPageNumbers: p.boolean({ label: 'Show page numbers', default: true }),
    accent: p.color({ label: 'Accent colour', default: '#2c5070' }),
  },

  spreads: {
    story: {
      label: 'Photo and story',
      parameters: {
        heading: p.string({ label: 'Heading', multiline: true, default: '' }),
        eyebrow: p.string({ label: 'Chapter label', default: '' }),
      },
      boxes: {
        hero: {
          type: 'photo',
          label: 'Main photograph',
          parameters: { showCaption: p.boolean({ label: 'Show caption', default: true }) },
        },
        body: { type: 'markdown', label: 'Story', flowOrder: 1 },
      },
      render: ({ params, boxes }) => (
        <Spread className="story">
          <PhotoBox id="hero" className="hero" />
          {boxes.hero.params.showCaption && boxes.hero.photo?.caption && (
            <p className="caption">{boxes.hero.photo.caption}</p>
          )}
          <p className="eyebrow">{params.eyebrow}</p>
          <h1 className="heading">{params.heading}</h1>
          <MarkdownBox id="body" className="body editorial" />
        </Spread>
      ),
    },

    calendar: {
      label: 'Calendar month',
      parameters: {
        year: p.integer({ label: 'Year', default: 2027 }),
        month: p.integer({ label: 'Month', min: 1, max: 12, default: 1 }),
      },
      boxes: { photo: { type: 'photo', label: 'Photo of the month' } },
      elements: { grid: { label: 'Calendar grid', parameters: { firstWeekday: p.enum({ label: 'Week starts', options: ['monday', 'sunday'], default: 'monday' }) } } },
      render: ({ params, elements }) => (
        <Spread className="calendar">
          <PhotoBox id="photo" className="left-page bleed" />
          <Element id="grid" className="grid">
            <MonthGrid year={params.year} month={params.month} firstWeekday={elements.grid.params.firstWeekday} />
          </Element>
        </Spread>
      ),
    },
  },
});
```

### Parameters

`p.*` helpers create plain, serializable schema objects; the editor generates sidebar controls from them, and `spreadFor(documentParameters)` supplies inferred render-context types. `defineTemplate` alone uses a broad context.

| Helper | Value | Options |
| --- | --- | --- |
| `p.boolean` | `boolean` | `default` |
| `p.integer` | `number` | `default`, `min`, `max`, `step` |
| `p.number` | `number` | `default`, `min`, `max`, `step`, `unit` (display only) |
| `p.string` | `string` | `default`, `multiline`, `maxLength`, `placeholder` |
| `p.enum` | one of `options` | `default`, `options` (values), `labels` |
| `p.color` | `#rrggbb` | `default` |
| `p.date` | ISO date `YYYY-MM-DD` | `default`, `min`, `max`, `precision` (`day` or `month`) |

Every parameter has a `label` and a `default`; a saved value outside the constraints is reported and replaced by the default for rendering, but kept in `project.json`.

Scopes: `parameters` at template level (document), on a spread definition (spread instance), on a box or element (element instance). Values are stored in `project.json` at the matching scope. There is no inheritance between scopes.

### Boxes and elements

- `boxes` declares content boxes. `type: 'photo'` accepts a photo from the photo index; `type: 'markdown'` accepts a Markdown file. Boxes may declare their own `parameters`.
- Markdown boxes on a spread need a unique `flowOrder` when the spread has more than one. Continuation follows project spread order, then `flowOrder`.
- `elements` declares generated artwork (calendar, ornaments with options) that has parameters but no assigned content.
- Identifiers are stable keys: renaming one is a breaking change for projects using the template.

### Print format

`format` is a single `PrintFormat` as sketched in `spikes/pdf-format/print-format-sketch.md` (PR #2): trim, bleed per edge, safe insets, structure (`delivery: 'pages' | 'spreads'`, `ends: 'single-pages' | 'inside-covers'`, page-count rule), and output constraints (container, colour space, transparency policy, resolution range, raster size, font rules, minimum text size). The platform resolves it into concrete geometry once.

A template declares either one `format` or several named `formats`, which the user chooses between under **Book settings → Format**:

```tsx
formats: {
  square: bookFormat('Square · 29 × 29 cm', 290, 290),
  landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
},
defaultFormat: 'square',   // optional; otherwise the first format
```

Each entry is a complete `PrintFormat`, so presets may differ in bleed, safe area, page-count rules and output limits, not only in trim. Every format is validated when the template loads (schema and geometry: PDF edges between 10 and 1000 mm, binding bleed within the facing page, safe insets leaving room inside the trim), so a broken preset is a template error rather than something a book discovers after switching to it. The choice is stored as `format` in `project.json` and applies to the whole book. A project without it uses `defaultFormat`, else the first format. A project naming a format the template no longer has is previewed in the default format, but the Book check reports an error, so print export is blocked until a format is chosen again; proof export still works. A template with a single `format` ignores the project's choice.

Changing the format re-renders the book: assignments, crops and text sources stay, while text flow, photo resolution and print checks are recomputed. Layouts adapt through `ctx.format` (resolved millimetres), `ctx.formatId` (the chosen key, or `'default'` for a single `format`), and the `--trim-*`, `--bleed-*` and `--safe-*` CSS variables of `<Spread>`. The starter template draws its layouts on a 290 × 290 design page and scales positions with the trim size; full-bleed boxes use the bleed variables directly.

Arbitrary dimensions within declared limits, rather than named presets, are not supported yet.

### Spread spans

Spread definitions render two facing pages by default. For formats with `ends: 'single-pages'`, a definition can declare `span: 'right'` (usable as the first page) or `span: 'left'` (usable as the last page); the inactive half is shown as an inside cover and not exported. Formats with `ends: 'inside-covers'` use full spreads throughout.

## Render function

`render(context)` is called per spread instance and must be a pure function of its input: no state, effects, timers, randomness, or data fetching.

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
  page: { left?: number; right?: number };  // page numbers of this spread
  format: ResolvedFormat;                   // trim, bleed, safe area in mm, for the chosen format
  formatId: string;                         // the chosen key of `formats`, or 'default'
  mode: 'edit' | 'export';
  edit(...paths: EditPath[]): { 'data-edit'?: string };  // marks a node for click-to-edit
};
```

### Click-to-edit

`ctx.edit(...paths)` marks the node that shows parameters, so clicking it in the editor opens a popover with a control for each parameter (text field, month or date picker, segmented choice, slider, colour). Spread the result onto the node:

```tsx
<h2 {...ctx.edit('heading')}>{ctx.params.heading}</h2>
<Element id="grid" {...ctx.edit('month')}>…</Element>
```

Paths name a spread parameter (`heading`), a document parameter (`document.paper`), an element parameter (`elements.grid.firstWeekday`), or a box parameter (`boxes.hero.showCaption`). With `spreadFor`, paths are type-checked. `<Element>` is an edit target for its own parameters without marking; marks on it add more. `ctx.edit` returns no attributes in export, and the Book check warns about paths the layout does not declare. Set `precision: 'month'` on a date parameter to edit it with a month picker; the value is the month's first day.

Templates read photo metadata (for captions) and page numbers through the context; they never receive file paths, image data, or Markdown source, and they cannot change project data.

## Platform components

| Component | Purpose |
| --- | --- |
| `<Spread>` | Root of every spread. Sizes the spread to two trims plus bleed, sets geometry CSS variables, and handles page halves. |
| `<PhotoBox id>` | Renders the assigned photo with its crop (the photo always covers the box; the saved crop picks the visible region), using a preview-size image in the editor and a rendition capped at the format maximum resolution in export (300 ppi when omitted). Its element is the box's geometry and drop zone. Users adjust the crop in the editor's crop mode; templates do not handle it. |
| `<MarkdownBox id>` | Receives the flowed fragment of the assigned Markdown source. Its element is the box's geometry and drop zone. |
| `<Element id>` | Wraps generated artwork so the editor can highlight it, and opens its parameters when clicked. |
| `asset(path)` | Resolves a file in `template/assets/` for use in `src` or CSS. |

Rules:

- Each declared box is rendered exactly once through its component; each declared element at most once.
- Boxes and elements are positioned and sized by template CSS on the component's element (`className`, `style`).
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
```

The spread's content box is the two trims side by side (`2 × --trim-width` by `--trim-height`), with the gutter at 50 %. Coordinates are relative to the trim; the platform adds the bleed outside. Utility classes extend an element into the bleed: `.bleed` (all outer edges it touches), `.left-page`, `.right-page` (position a full page, including its outer bleed).

### Markdown

Template CSS styles the elements inside a `MarkdownBox`: `p`, `h1`–`h6`, `em`, `strong`, `a`, `ul`, `ol`, `li`, `blockquote`. The platform adds and owns:

- `overflow-wrap: break-word` on Markdown boxes.
- Multi-column and fragmentation properties on Markdown boxes (`column-*`, `break-*` are set by the platform; `orphans`, `widows` may be set by templates).
- Continuation classes: `.split` on the part of an element that continues in a later box, `.cont` on the continuing part. Defaults: a continued paragraph has no first-line indent, a continued list item has no marker, and a split justified paragraph justifies its last line. Templates may restyle these.
- List markers stay inside the box (`list-style-position` or sufficient padding, checked by the platform).

Not allowed in Markdown boxes: CSS counters for list numbering, `float`, `position: absolute` on content, transitions and animations.

### Fonts and output

- Fonts are declared with `@font-face` in template CSS, from files in `template/fonts/`. Static files only; system fonts are not allowed. Export fails if the PDF contains Type 3 fonts or fonts not shipped with the template.
- Effects that create transparency (opacity, `rgba()` fills, shadows, blend modes, filters, gradients, rounded clipping) are allowed; whether they pass depends on the format's transparency policy, checked at export.
- Text below the format's minimum size and text outside the safe area are reported in edit mode.

## Validation

When the template is loaded:

- `id`, `version`, `contract` present; contract version supported.
- Unique, stable identifiers for spreads, boxes, elements, and parameters; valid parameter defaults.
- A valid print format.
- Unique `flowOrder` among Markdown boxes of a spread.

When a spread renders:

- Every declared box rendered once; no undeclared box or element ids.
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
    "hero": { "photo": "ph-2c91", "crop": { "centerX": 0.5, "centerY": 0.45, "zoom": 1.1 }, "params": { "showCaption": true } },
    "body": { "text": "tx-arrival" }
  },
  "elements": {}
}
```

The project also stores the document parameter values, the template `id` and `version` it was last opened with, and the text id → path mapping. Photo metadata lives in `photos.json`.

## Authoring and compatibility details

Use the project’s `template/tsconfig.json` and bundled `types/` to check templates without installing host packages. Run `npx tsc -p sample/starter/template` in this repository. For inferred parameter and edit-path types:

```tsx
const documentParameters = { accent: p.color({ label: 'Accent', default: '#223344' }) };
const spread = spreadFor(documentParameters);
const story = spread({
  label: 'Story',
  parameters: { heading: p.string({ label: 'Heading', default: '' }) },
  render: (ctx) => <Spread>
    <h1 {...ctx.edit('heading')} style={{ color: ctx.document.accent }}>
      {ctx.params.heading}
    </h1>
  </Spread>,
});
// Use parameters: documentParameters and spreads: { story } in defineTemplate.
```

Import `spreadFor` alongside the other helpers. `mm`, `pt`, and `inch` produce structured lengths for the print-format declaration; use CSS strings such as `'30mm'` in React styles. They are not CSS values.

`MarkdownBox` accepts `columns` (default 1, rounded and clamped to 1–6). Use `style={{ columnGap: '5mm' }}` for the gap. Text continues down each column, then through the next assigned box in spread/flow order. Expose a box parameter and pass its resolved value to `columns` if users should control it. Column layout remains platform-owned; avoid overriding its flow machinery with CSS.

Numeric `step` is a control increment, not a runtime divisibility constraint. Month precision changes the picker; it writes `YYYY-MM-01`, but existing valid ISO dates are not normalized. Use first-of-month defaults and bounds for month parameters.

Crop mode draws the photo over the box's on-screen rectangle, so it assumes the box is upright. If template CSS rotates or skews a `PhotoBox` (or an ancestor inside the spread), the editor offers only the numeric crop values for it.

Identifiers start with a letter or digit, then contain letters, digits, underscores or hyphens; reserved Object prototype names are rejected. Dots separate edit-path scopes and cannot occur in identifiers. PhotoBox, MarkdownBox and Element automatically expose their declared parameters; explicit edit marks add parameters. Ordinary nodes need `ctx.edit`. Export omits edit marks. Avoid overlapping targets or marking several nodes with the identical path list: the current editor identifies targets by spread and path list.

### Persistence and evolution

`project.json` has `schemaVersion: 1`, `title`, `template: { id, version }`, document `params`, `texts` (ID → relative path), and ordered `spreads`. Each spread has `id`, `definition`, `params`, `boxes`, `elements`, and an optional `archive` of prior layout state. The example above shows one spread, not a complete project. Photo metadata is keyed by stable photo ID in `photos.json`; dimensions are derived from image files. Crop centers are normalized 0–1; zoom is 1–20.

Layout switching archives the previous layout. Same-ID parameters with the same parameter type carry forward; same-ID boxes carry assignments only when their content type matches. Saved target-layout state is restored, then compatible current state takes precedence. This is structural matching, not semantic mapping. Constraints are checked on rendering; invalid saved values remain stored and render using defaults. Sources remain in the project even when no active box uses them.

New projects copy the starter template. Updating the app does not replace existing project templates. Contract 1 supports the additive edit marks, month picker and columns API, but an older app is not guaranteed to understand newer additions. Keep the app and authoring declarations aligned. Renaming an ID or moving a parameter between scopes requires an explicit project-data migration; there is no automatic migration framework. PR #7 moves the starter calendar month to `elements.grid.params.month`; replacing only the template in an older project does not migrate that saved value.

### Preview limitations

The editor renders the whole book for the canvas and again for thumbnails. Layout choices render independently and restart Markdown from the beginning; they are composition previews, not previews of the actual continuation fragment. Review the main book and exported proof for final flow. Large-book latency and memory use need separate measurement.

The API is the in-process `imageflow` template module. There is no documented public REST or automation API. Desktop IPC and frame messages in `src/desktop.ts` are internal implementation details.
