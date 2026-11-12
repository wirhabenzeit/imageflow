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

`imageflow` exports `defineTemplate`, `spreadFor`, `p`, `mm`, `pt`, `inch`, `printFormat`, `Spread`, `PhotoBox`, `MarkdownBox`, `Element`, `asset`, `file`, `geometry`, `box`, `issue` and `capabilities`. A build fails with a hint to update ImageFlow when a template uses an export the installed app does not have.

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

Agents receive them with `get_authoring_context` and `includeExamples`. To start a template, copy `minimal.tsx` (or the closest example) and add layouts. To extend one, copy a single layout and its declarations. The starter template is the complete reference book, not a required starting point.

The examples use the generic `serif` and `sans-serif` font families, so they preview anywhere but **print export rejects them**: print preflight accepts only fonts bundled inside `template/` and loaded with `@font-face` from CSS the template imports. Before printing, add font files to `template/fonts/`, import a stylesheet that declares them, and use those families. The starter template shows the pattern ([Fonts and output](#fonts-and-output)).

### Requirements and compatibility

Template contract 1 has grown by additive features. A template lists the ones it uses in `requires`, so an app without one of them names it instead of failing inside a layout:

```ts
defineTemplate({ id: 'travel', version: '2.0.0', contract: 1, requires: ['anchors', 'geometry'], … })
```

| Capability | Provides |
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

`capabilities` lists what the installed app provides, and `get_authoring_context` reports it as `capabilities.templateApi`. Apps older than `requires` ignore it, but their bundler still rejects an import of a helper they lack. An app update never rewrites a project's template folder. Renaming an ID, moving a parameter to another scope or changing an ID's type needs an explicit migration in the template and in `project.json`; ImageFlow never reinterprets or deletes saved values on its own.

## Declaration

The following sketch illustrates the scopes; `MonthGrid` and the abbreviated format are placeholders. Use [`minimal.tsx`](examples/minimal.tsx) for a complete, compilable starting point.

```tsx
import { box, defineTemplate, mm, p, printFormat, Spread } from 'imageflow';
import './styles.css';

export default defineTemplate({
  id: 'senja-starter',
  version: '0.1.0',
  contract: 1,
  requires: ['spread-builder', 'bound-geometry', 'text-component', 'format-helper', 'box-helpers', 'typed-components'],

  // One print format, or several named `formats` the user chooses between; see below.
  format: printFormat({
    label: 'Square · 30 × 30 cm',
    trim: { width: mm(294), height: mm(294) },
    /* bleed, safe, pageCount, output … */
  }),

  // Document scope: Book settings, read through ctx.document.
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

`spreads` can also be a plain record. Its spreads are then typed only broadly (`UntypedRenderContext`), unless they come from `spreadFor(documentParameters)`, which returns the same builder for spreads declared outside `defineTemplate`, such as in their own files. Pass it the same object as the template's `parameters`: a spread typed with document parameters the template does not declare fails type checking, whether `spreads` is a record or a function that returns it, and the Book check warns about it (`declaration-document-mismatch`), because `ctx.document` would lack those values at runtime.

The authoring types reject declaration mistakes that used to load silently:

- A template needs exactly one of `format` or `formats`; `defaultFormat` must name one of the `formats`.
- Unknown properties, such as `paramters` for `parameters`, `lable` or `mutliline` in a parameter, or `flowOrdr` in a box, fail type checking, usually with a "did you mean" hint. This covers spreads and their box and element declarations whether they come from the `spread` builder or are written as plain objects, and the options of `p.*` and `box.*`. Values TypeScript only sees as a wider type, such as a declaration built by a function returning `BoxDeclaration`, are checked at runtime only.

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
| `p.enum` | one of `options` | `default`, `options` (values), `labels` |
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

A template declares either one `format` or several named `formats`, which the user chooses between under **Book settings → Format**:

```tsx
formats: {
  square: bookFormat('Square · 29 × 29 cm', 290, 290),
  landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
},
defaultFormat: 'square',   // optional; otherwise the first format
```

`printFormat({ label, trim, bleed, safe, pageCount, delivery?, ends?, output? })` builds a complete `PrintFormat` with less repetition. `bleed` and `safe` take one length for all four sides (`mm(12)`), `{ all, …sides }` where named sides override `all` (`{ all: mm(3), binding: mm(0) }`), or all four sides. `delivery` defaults to `'pages'`, `ends` to `'single-pages'`, and `output` to `{ container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' }`, with given fields replacing those. The result is an ordinary `PrintFormat`, reported in full by `get_authoring_context` and Book settings. It describes geometry, not a printer's product: page counts, resolution, minimum text size, font rules and file-size limits come from the printer's specification.

Each entry is a complete `PrintFormat`, so presets may differ in bleed, safe area, page-count rules and output limits, not only in trim. Every format is validated when the template loads (schema and geometry: PDF edges between 10 and 1000 mm, binding bleed within the facing page, safe insets leaving room inside the trim), so a broken preset is a template error rather than something a book discovers after switching to it. The choice is stored as `format` in `project.json` and applies to the whole book. A project without it uses `defaultFormat`, else the first format. A project naming a format the template no longer has is previewed in the default format, but the Book check reports an error, so print export is blocked until a format is chosen again; proof export still works. A template with a single `format` ignores the project's choice.

Changing the format re-renders the book: assignments, crops and text sources stay, while text flow, photo resolution and print checks are recomputed. Layouts adapt through `ctx.format` (resolved millimetres), `ctx.geometry` (the geometry helpers for that format), `ctx.formatId` (the chosen key, or `'default'` for a single `format`), and the `--trim-*`, `--bleed-*` and `--safe-*` CSS variables of `<Spread>`. The starter template draws its layouts on a 290 × 290 design page and scales positions with the trim size; full-bleed boxes use the bleed variables directly.

Arbitrary dimensions within declared limits, rather than named presets, are not supported yet.

### Spread spans

Spread definitions render two facing pages by default. For formats with `ends: 'single-pages'`, a definition can declare `span: 'right'` (usable as the first page) or `span: 'left'` (usable as the last page); the inactive half is shown as an inside cover and not exported. Formats with `ends: 'inside-covers'` use full spreads throughout.

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

`parameter` takes the same paths as `ctx.edit`, limited to string parameters. `as` is one of `h1`–`h6`, `p` (default), `span`, `div`, `blockquote` or `figcaption`; `className`, `style`, `rect` and `issue()` markers work as on the platform components. When the value is empty, the editor shows a dimmed placeholder in the template's own type (`placeholder`, else the parameter's `placeholder`, else its label) and marks the node `data-empty`; the exported book shows the empty node. The value is rendered as text, never as HTML, and newlines follow the node's CSS `white-space`. Use `ctx.edit` for nodes that combine several parameters or show more than the value.

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
type Anchor = { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' };
```

- **One render pass.** Page numbers depend only on spread order and layout spans, never on rendered content. ImageFlow calls every spread's `anchors` with its resolved `params` and `document` values before any spread renders, so every layout reads the same anchors. Like `render`, `anchors` must be a pure function of its input. An `anchors` function that throws or returns an invalid declaration is a render error naming the layout.
- **Pages follow the book.** Inserting, moving, removing or switching a spread renumbers every anchor, as it does the folios. `side` picks the page of a two-page spread and defaults to the first. A single left or right page has only one page, whichever side is named.
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
   - A condition only hides a control. The value stays saved and validated, and comes back when the condition holds again. Conditions are presentation: they never remove a declaration or change a saved ID.
   - Click-to-edit follows the box's or element's `controls` for its own parameters. A parameter a node explicitly shows with `ctx.edit` or `ctx.Text` is always editable on that node.
   - The authoring types check entry IDs against the scope's parameters. Loading the template reports unknown or repeated IDs, a parameter a custom editor owns, conditions on unknown parameters, on the control's own value, or on values the parameter can never have.
3. **A custom editor** for an element, below.

### Element editors

An element can supply its own editor for parameters that generated controls handle poorly, such as marking days in a calendar or panning a map:

```tsx
function CalendarEditor({ values, set, readOnly }: ElementEditorProps) {
  // Render any UI; call set({ ... }) to change the draft. The editor previews the draft itself.
}

elements: { grid: {
  label: 'Calendar grid',
  parameters: { month, firstWeekday, marked },
  editor: { label: 'Edit calendar', parameters: ['month', 'marked'], component: CalendarEditor },
} },
```

- **Opening it:** clicking the element opens the editor in a dialog, and so does the editor's button in the element's Inspector section.
- **One editor for the element:** parameters the editor lists are edited only by it. The element's other parameters appear below it in the same dialog as generated controls (arranged by the element's `controls`), in the same draft, so Done saves the whole element as one edit.
- **Sandbox:** the component runs in a frame on the render origin with the template's CSS, like the book previews. It receives `values` (all of the element's parameters, with the draft applied), `set(changes)`, `document`, `format`, `readOnly`, `commit()`, `cancel()`, `Control` and `importFile`. It cannot change project data itself.
- **ImageFlow's controls inside:** `<Control parameter="track" />` draws the app's own control for one of the editor's parameters, bound to the draft: the same field, slider, choice or file chooser (with import) as the generated controls, with their validation and accessibility, in the editor's appearance. Compose it with your own UI instead of rebuilding file handling or form controls. `label` overrides the parameter's label.
- **Files:** `importFile(accept)` asks the app to import a file into the project and resolves to its file ID, or `undefined` when the user cancels; `<Control>` for a file parameter uses it for its **Choose…** button. Assign the ID with `set`, so Done saves it and Cancel discards the assignment; the imported file stays in the project. `file(id)` reads the new file at once.
- **What ImageFlow owns:** the dialog, Cancel and Done, Escape and ⌘↩, focus, read-only mode, validation against the parameter schema, and saving. One editing session is one undoable edit; Cancel leaves the saved values unchanged.
- **Draft and commit:** `set()` takes effect immediately, so `set({ ... }); commit()` in one handler saves those changes; `values` catches up on the next render.
- **Changes from elsewhere:** if what the editor works on changes while it is open (a saved value after Reload or Undo, or a template edit that changes a default or a declaration of the parameters it handles), the dialog says so and refuses to save; the user reopens the editor on the current values.
- **Failures:** if the component throws while rendering, in an event handler or in async work, the dialog shows the error and offers only Cancel. The editor counts as loaded once the component has mounted.
- **Scope today:** element parameters only, shown in a dialog (`presentation: 'dialog'`). Editors can read files of file parameters with `file()`; remote resources such as map tiles are not available. The starter has two reference examples: the calendar editor (month and marked days, with **Week starts** as a generated control below it) and the route map's **Edit route** editor. Choosing a track and framing it are one task, so that editor owns the GPX `track` (drawn with `<Control parameter="track" />`, including import) and the viewport, kept as three ordinary number parameters (`centerX`, `centerY`, `zoom`) and edited together by dragging, scrolling, buttons or arrow keys. It draws only the GPX track, without a basemap, so export stays offline.

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

- **Choosing:** the generated control lists the project's files with an accepted extension, offers **Choose…** to add one, and **None** to clear the assignment. Adding a file copies it into `files/` and registers it in `project.json`; assigning it is a normal edit. Undo removes the assignment and keeps the file; clearing never deletes a file.
- **Value:** the file's ID in the project's `files` registry, or `''`. Paths in the registry are relative to the project, so moving the project folder keeps its files.
- **Content:** `file(id)` returns the file's name, extension and UTF-8 text, read when the project loads (files are limited to 20 MB). Preview and export render from the same text. It returns `undefined` when nothing is assigned or the assigned file cannot be read.
- **Diagnostics:** ImageFlow reports an assigned file that is no longer registered, missing or unreadable, or whose extension is not in `accept`, as a Book check error for that element, which blocks print export. An unassigned file parameter is valid. The template parses the content. If it cannot, it should render without it and report a [template finding](#template-findings) that names the element, parameter and file.
- **Example:** the starter's Panorama layout has a Route map element that draws an assigned GPX track as a line in an inset (`sample/starter/files/senja-road.gpx`). It has no basemap: remote map styles and tiles would make export depend on the network, and are not part of the contract.

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

`geometry` computes rectangles in millimetres in spread coordinates: x from the left page's trim edge (the right page starts at the trim width), y from the top trim edge. Pass a rectangle to a platform component's `rect` prop (`PhotoBox`, `MarkdownBox`, `Element`, `Text`), or `geometry.css(rect)` to any node's `style`, to position it absolutely inside `<Spread>`. Properties in `style` win over the ones `rect` sets, so `rect={area} style={{ height: 'auto' }}` lets a block grow.

`ctx.geometry` holds the same helpers with the spread's format already applied: `ctx.geometry.page(side, area?)`, `ctx.geometry.spread(area?)` and `ctx.geometry.design(canvas)`, plus `inset`, `grid` and `css`. The functions below remain available for helpers outside `render`. The helpers return plain numbers, so ordinary CSS and inline styles stay available, and nothing scales type.

| Helper | Returns |
| --- | --- |
| `page(format, side, area?)` | One page. `area` is `trim` (default), `safe` (the format's safe insets, with the binding inset next to the fold) or `bleed` (outer edges extended into the bleed; the fold edge stays at the fold, because a page's binding bleed shows the facing page). Works for single first and last pages. |
| `spread(format, area?)` | Both pages. Its `safe` area keeps only the outer, top and bottom insets. |
| `inset(rect, mm \| { top, right, bottom, left })` | A smaller rectangle. |
| `grid(rect, { columns, rows?, gap?, columnGap?, rowGap? })` | Equal cells in reading order, with gaps between cells only. |
| `design(format, { width, height })` | Design coordinates. `left(x, y, w, h)` and `right(…)` map a fixed design canvas to a page, scaling x with the trim width and y with the trim height. `width(v)` and `height(v)` convert design lengths such as gaps. |
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

Use `page` and `spread` for physical layouts that keep margins in millimetres on every format. Use `design` to scale a composition drawn on a fixed canvas, as the starter does. These numbers are physical lengths for CSS, unlike the structured `mm()`, `pt()` and `inch()` values used in print-format declarations. The starter's layouts use these helpers; a recorded baseline (`tests/fixtures/starter-geometry.json`, checked by `scripts/smoke-starter-geometry.mjs`) confirms that they render the same millimetre geometry as the earlier hand-written CSS in both formats.

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

Use the project’s `template/tsconfig.json` and bundled `types/` to check templates without installing host packages. Run `npx tsc -p sample/starter/template` in this repository. For layouts in their own files, export the document parameters and a builder made from them:

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

New projects copy the starter template. Updating the app does not replace existing project templates. Contract 1 supports the additive edit marks, month picker and columns API, but an older app is not guaranteed to understand newer additions. Keep the app and authoring declarations aligned. Renaming an ID or moving a parameter between scopes requires an explicit project-data migration; there is no automatic migration framework. PR #7 moves the starter calendar month to `elements.grid.params.month`; replacing only the template in an older project does not migrate that saved value.

### Preview limitations

The editor renders the whole book for the canvas and again for thumbnails. Layout choices render independently and restart Markdown from the beginning; they are composition previews, not previews of the actual continuation fragment. Review the main book and exported proof for final flow. Large-book latency and memory use need separate measurement.

The API is the in-process `imageflow` template module. There is no documented public REST or automation API. Desktop IPC and frame messages in `src/desktop.ts` are internal implementation details.
