# Template API (v1 draft)

Status: accepted as the v1 baseline, 2026-11-09. Defines what a template declares, what it receives when rendering, which components and CSS the platform provides, and what the platform validates. It implements the decisions in [v1-decisions.md](v1-decisions.md); names may still change during implementation, and the open points at the end are settled while building.

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

The app bundles `index.tsx` with esbuild. `react` and `imageflow` are provided by the host and must not be bundled. Relative imports, CSS imports, and asset imports inside `template/` are allowed; anything else (network, Node modules, `fetch`, timers) is not.

## Declaration

```tsx
import { defineTemplate, p, mm, Spread, PhotoBox, MarkdownBox, Element } from 'imageflow';
import './styles.css';

export default defineTemplate({
  id: 'senja-starter',
  version: '0.1.0',
  contract: 1,

  // Exactly one print format in v1, see below.
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

`p.*` helpers create plain, serializable schema objects; the editor generates sidebar controls from them, and TypeScript infers the types of `params` in `render`.

| Helper | Value | Options |
| --- | --- | --- |
| `p.boolean` | `boolean` | `default` |
| `p.integer` | `number` | `default`, `min`, `max`, `step` |
| `p.number` | `number` | `default`, `min`, `max`, `step`, `unit` (display only) |
| `p.string` | `string` | `default`, `multiline`, `maxLength`, `placeholder` |
| `p.enum` | one of `options` | `default`, `options` (values), `labels` |
| `p.color` | `#rrggbb` | `default` |
| `p.date` | ISO date `YYYY-MM-DD` | `default`, `min`, `max` |

Every parameter has a `label` and a `default`; a saved value outside the constraints is reported and replaced by the default for rendering, but kept in `project.json`.

Scopes: `parameters` at template level (document), on a spread definition (spread instance), on a box or element (element instance). Values are stored in `project.json` at the matching scope. There is no inheritance between scopes.

### Boxes and elements

- `boxes` declares content boxes. `type: 'photo'` accepts a photo from the photo index; `type: 'markdown'` accepts a Markdown file. Boxes may declare their own `parameters`.
- Markdown boxes on a spread need a unique `flowOrder` when the spread has more than one. Continuation follows project spread order, then `flowOrder`.
- `elements` declares generated artwork (calendar, ornaments with options) that has parameters but no assigned content.
- Identifiers are stable keys: renaming one is a breaking change for projects using the template.

### Print format

`format` is a single `PrintFormat` as sketched in `spikes/pdf-format/print-format-sketch.md` (PR #2): trim, bleed per edge, safe insets, structure (`delivery: 'pages' | 'spreads'`, `ends: 'single-pages' | 'inside-covers'`, page-count rule), and output constraints (container, colour space, transparency policy, resolution range, raster size, font rules, minimum text size). The platform resolves it into concrete geometry once.

v1 allows exactly one format per template; a book for another printer or size uses another template. Allowing several named formats later would turn `format` into a map plus a project-level selection, without changing the `PrintFormat` shape.

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
  format: ResolvedFormat;                   // trim, bleed, safe area in mm
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
| `<PhotoBox id>` | Renders the assigned photo with its crop (`object-fit: cover` plus the saved crop), using a preview-size image in the editor and the original in export. Its element is the box's geometry and drop zone. |
| `<MarkdownBox id>` | Receives the flowed fragment of the assigned Markdown source. Its element is the box's geometry and drop zone. |
| `<Element id>` | Wraps generated artwork so the editor can highlight it, and opens its parameters when clicked. |
| `asset(path)` | Resolves a file in `template/assets/` for use in `src` or CSS. |

Rules:

- Each declared box is rendered exactly once through its component; each declared element at most once.
- Boxes and elements are positioned and sized by template CSS on the component's element (`className`, `style`).
- An empty box keeps its area in edit mode so it can receive drops. In export, it renders nothing; templates choose between keeping the space and collapsing it through CSS (`[data-empty]`).

## CSS contract

### Authoring

Templates style with inline React `style` objects (positions, sizes, and anything driven by parameters) and one plain CSS file (`styles.css`, plus optional imports) for fonts, Markdown typography, and rules shared across spreads. Native CSS nesting may be used. No CSS preprocessor, Tailwind, or CSS-in-JS library is part of the v1 build.

```tsx
<h1 style={{ position: 'absolute', left: mm(30), top: mm(40), color: params.accent }}>{params.heading}</h1>
<MarkdownBox id="body" className="editorial" style={{ position: 'absolute', left: '55%', top: mm(30), width: mm(110), height: mm(230) }} />
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

Errors in edit mode appear in the sidebar and do not block editing; errors at export block the export.

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

## Open points

- How page numbers, running heads, or other per-page elements outside spreads are expressed (a `page.left`/`page.right` context is proposed; a page-level component may be cleaner).
- Whether `p.*` helpers should be backed by a schema library (for example Zod or Valibot) or stay plain objects.
- How a template declares example content for its starter project (sample photos and texts for new projects).
- TypeScript inference from declarations to `render` context types; the shapes above assume it is achievable with `defineTemplate` generics.
- Crop model: keep the prototype's `centerX`/`centerY`/`zoom`, or store a crop rectangle.
