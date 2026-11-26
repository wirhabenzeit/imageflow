# Declaration

The following sketch illustrates the scopes; `MonthGrid` and the abbreviated format are placeholders. Use [`minimal.tsx`](../examples/minimal.tsx) for a complete, compilable starting point.

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
        hero: box.photo('Main photograph', { showCaption: p.boolean({ label: 'Show caption', default: true, shows: 'caption' }) }),
        body: box.markdown('Story', { flowOrder: 1 }),
      },
      render: (ctx) => (
        <Spread className="story">
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />
          <ctx.Caption box="hero" className="caption" />
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

## Declaring layouts

Declare `spreads` as a function of `{ spread, page }`. Use `spread()` for a full spread and `page()` for a reusable single page; see [Page layouts](page-layouts.md). Its `spread` builder types each layout's `ctx.params`, `ctx.boxes`, `ctx.elements` and edit paths from the layout's own declarations, and `ctx.document` from the template's `parameters`, so the document settings are declared once. `defineTemplate` calls the function and validates the resulting record; the builder itself only exists for TypeScript and returns the declaration (`page()` also sets `span: 'page'`).

`spreads` can also be a plain record. Its spreads are then typed only broadly (`UntypedRenderContext`), unless they come from `spreadFor(documentParameters)`, which returns the same builder for spreads declared outside `defineTemplate`, such as in their own files. Pass it the same object as the template's `parameters`: a spread typed with document parameters the template does not declare, or declares with values the spread could not accept (a number for a string, an enum with more options), fails type checking, whether `spreads` is a record or a function that returns it, and the Book check warns about it (`declaration-document-mismatch`), because `ctx.document` would lack those values at runtime.

The authoring types reject declaration mistakes that used to load silently:

- A template needs exactly one of `format` or `formats`; `defaultFormat` must name one of the `formats`.
- Unknown properties, such as `paramters` for `parameters`, `lable` or `mutliline` in a parameter, or `flowOrdr` in a box, fail type checking, usually with a "did you mean" hint. This covers spreads, their box and element declarations, and parameters (checked against the parameter's `type`), whether they come from the `spread` builder and `p.*`/`box.*` helpers or are written as plain objects. Values TypeScript only sees as a wider type, such as a declaration built by a function returning `BoxDeclaration`, are checked at runtime only.

At runtime, for templates that are not type-checked, an unknown property anywhere in the declaration (template, format, spread, box, element, element editor or parameter) is reported as a `declaration-unknown-property` warning that names the property, its path and the property it probably meant. It is a warning rather than an error so that contract-1 templates that loaded before keep loading. When an unknown property makes the declaration invalid, for example `lable` leaving `label` missing, the declaration error lists it next to the schema error.

## Reusable declarations and typed IDs

Declarations are plain objects, so share them as constants. `box.photo(label, parameters?)` and `box.markdown(label, { flowOrder?, parameters? })` declare boxes without repeating `type`. `box.photos(ids, label, parameters?)` declares several photo boxes with explicit IDs, typed without casts: `boxes: box.photos(['one', 'two', 'three'], (id, i) => 'Photo ' + (i + 1))`. The ID stays where the box is declared, which keeps its saved identity explicit:

```tsx
const caption = p.boolean({ label: 'Show caption', default: false });
const story = box.markdown('Story', { flowOrder: 1 });
spread({ label: 'Story', boxes: { hero: box.photo('Main photo', { caption }), story }, render: (ctx) => … })
```

With the `spread` builder, the render context types every parameter, box and element of its layout. `ctx.PhotoBox`, `ctx.MarkdownBox` and `ctx.Element` are the platform components restricted to that layout's IDs, so `<ctx.PhotoBox id="heor" />` fails type checking. The top-level components accept any ID for extracted helpers. `MarkdownBox` takes `columns` as a number or a numeric string, so an enum value such as `'2'` needs no cast. Runtime validation still checks every rendered box and element, for code that is not type-checked.
