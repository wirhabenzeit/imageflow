# Print format

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

Each entry is a complete `PrintFormat`, so presets may differ in bleed, safe area, page-count rules and output limits, not only in trim. Every format is validated when the template loads (schema and geometry: PDF edges between 10 and 1000 mm, binding bleed within the facing page, safe insets leaving room inside the trim), so a broken preset is a template error rather than something a book discovers after switching to it. The choice is stored as `format` in `project.json` and applies to the whole book. A project without it uses `defaultFormat`, else the first format. A project naming a format the template no longer has is previewed in the default format, but the Book check reports an error, so export asks for confirmation until a format is chosen again. A template with a single `format` ignores the project's choice.

Changing the format re-renders the book: assignments, crops and text sources stay, while text flow, photo resolution and print checks are recomputed. Layouts adapt through `ctx.format` (resolved millimetres), `ctx.geometry` (the geometry helpers for that format), `ctx.formatId` (the chosen key, or `'default'` for a single `format`), and the `--trim-*`, `--bleed-*` and `--safe-*` CSS variables of `<Spread>`. The starter template draws its layouts on a 290 × 290 design page and scales positions with the trim size; full-bleed boxes use the bleed variables directly.

Arbitrary dimensions within declared limits, rather than named presets, are not supported yet.

## Formats without facing pages

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

## Spread spans

`span` says which pages a layout occupies, and so which formats it fits:

| `span` | Fits | Pages |
|---|---|---|
| `'spread'` | formats with facing pages | two facing pages |
| `'right'`, `'left'` | formats with facing pages, `ends: 'single-pages'` and `delivery: 'pages'` | a single first page (`right`) or last page (`left`); the inactive half is shown as an inside cover and not exported |
| `'page'` | formats without facing pages (`facingPages: false`) | one page |

`span` defaults to `'page'` when no format of the template has facing pages, and to `'spread'` otherwise, so a calendar template does not repeat it on every layout. A layout whose `span` fits none of the template's formats loads with a `declaration-span-unused` warning.

## Book ends

The template and the format each have one job. The template offers layouts with a `span`: a `right` layout for the opening, a `left` layout for the closing, and full spreads in between. The format states what the printer expects, and export follows the format alone. `ends` is therefore a requirement, not a permission:

| `ends` | First spread | Last spread | In between |
|---|---|---|---|
| `'single-pages'` (e.g. Blurb) | must be `span: 'right'` | must be `span: 'left'` | full spreads |
| `'inside-covers'` (e.g. Saal) | full spread; left half printed on the inside cover | full spread; right half printed on the inside cover | full spreads |

- **Page sequence.** A book that breaks the rule gets a `page-sequence` error naming the first or last spread, with the span to switch it to. Export asks for confirmation before saving a PDF with these errors. A book of only its opening page is reported as missing its closing page.
- **`delivery` and `ends`.** Single end pages need page delivery: `delivery: 'spreads'` with `ends: 'single-pages'` is a schema error, because a PDF of whole spreads cannot open on a single right page. `printFormat` defaults `ends` to `'inside-covers'` when `delivery` is `'spreads'`, else to `'single-pages'`. `right` and `left` layouts fit only formats with `ends: 'single-pages'` and `delivery: 'pages'`; in other formats they are filtered and reported like `span: 'page'` layouts.
- **Editor.** With `'single-pages'`, nothing is inserted before the opening page or after the closing page, spreads do not move into or out of the end positions, and the end pages are not duplicated. The layout picker at the first and last positions offers the `right` and `left` layouts (and, for a misplaced full spread, other full spreads). An empty book starts with a `right` layout. Removing an end spread stays possible and is reported by the page sequence. The MCP commands `insert_spread`, `duplicate_spread` and `move_spread` follow the same rules and fail with `INVALID_POSITION`; `switch_layout` fails with `INCOMPATIBLE_LAYOUT` naming the span the position requires.
- **Declaration check.** A template with a `'single-pages'` format but no `right` or no `left` layout loads with a `declaration-ends-missing` warning.
- **Opening spreads** may be only the start of a book, so full spreads may come first or last among them; single pages must still be at their own end.

A template may offer formats of both kinds side by side. The layout picker, new spreads and fixtures use only the layouts that fit the chosen format. A book that switches to a format its layouts do not fit still previews (a page layout is drawn on a spread, a spread layout on one page), but the Book check reports a `page-sequence` error naming each such spread or page, and export asks for confirmation until its layouts are switched. The picker of a mismatched spread offers the layouts that fit the new format. Switching back to the earlier format restores the book; assignments, crops and text sources are kept, as with any format change. Opening spreads are checked against the formats of the default format's kind, because a new book starts in the default format.
