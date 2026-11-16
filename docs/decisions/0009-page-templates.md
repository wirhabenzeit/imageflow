# 0009: Page templates

Status: accepted, 2026-11-16. Phase 1 (page-scoped addressing and book format 2) implemented; the page states it stores are not yet shown or edited. Motivated by beta feedback: a user builds more and more spread layouts that combine one left-page design with one right-page design, each with its own parameters for both sides.

## Problem

A spread layout is the only unit a template can design. A book whose spreads pair a few page designs (photo page, text page, quote page, …) needs one spread layout for every left × right combination, with prefixed parameters (`leftHeading`, `rightHeading`, `leftPhoto`, …). The number of layouts grows with the square of the page designs, every combination duplicates code, and switching one side means picking another whole spread.

Single pages already exist, but only for the ends of a book: `span: 'left'` and `span: 'right'` layouts are the closing and opening pages of formats with `ends: 'single-pages'`, and `span: 'page'` is the unit of a format without facing pages. A spread in the middle of the book cannot be made of two pages.

## Principle

**A spread is shown either by one spread layout or by two page layouts, one per side. Spread and pages store their content separately; changing between layouts moves content with matching IDs to where it is shown now.**

The rule of [Switching layouts](../template-api/switching-layouts.md) ("an ID is the identity", "latest edit wins", "switching never deletes content") continues to hold across the boundary between spreads and pages. Templates declare nothing extra for content to carry over.

## Decision

### 1. Template API

- **Declaring.** The `spreads` builder gains `page({...})` next to `spread({...})`. A page layout has `span: 'page'`, the same declarations as a spread layout (`label`, `parameters`, `boxes`, `elements`, `family`, `variant`, `anchors`, `render`), and an optional `sides: ['left']` or `['right']` to restrict it to one side. Page and spread layouts share one record, so layout IDs stay unique and `switch_layout` keeps addressing layouts by ID.
- **`span: 'page'` changes meaning.** It is a single page: the unit of a format without facing pages, as today, and in a format with facing pages one side of a spread. One page layout can therefore serve a calendar format and a photobook format. `pageSequence` no longer reports a page layout in a facing format as misplaced, and `declaration-span-unused` no longer fires for page layouts in templates whose formats all have facing pages.
- **End pages are ordinary single pages.** The opening right page and closing left page of `ends: 'single-pages'` formats are units with one page, shown by a page layout for that side (`sides: ['right']`, `sides: ['left']`, or none). `span: 'left'` and `span: 'right'` are deprecated: existing end-page layouts, drawn in spread coordinates, keep working and keep their books, and new templates declare end pages with `page()`.
- **Page-local coordinates.** A page layout renders into `<Page>` (new platform component) instead of `<Spread>`. Its geometry is the page's own: x from the page's left trim edge. `ctx.geometry.page(area?)` takes the side from context, `ctx.geometry.design(canvas).page(x, y, w, h)` replaces `left()`/`right()`, and `safe`/`bleed` areas apply the outside and binding insets of the side the page is on. `ctx.geometry.spread()` throws in a page layout.
- **Knowing the side.** `ctx.side` is `'left'`, `'right'` or `'page'` (format without facing pages). `<Page>` carries `data-side`, and the CSS variables `--safe-outside`, `--safe-binding` and `--bleed-outside` are those of that side, so a template mirrors with CSS or with `ctx.side`.
- **Page numbers.** `ctx.page` holds only the page's own number (`{ left }` or `{ right }`, `{ number }` without facing pages), so helpers such as the starter's folio, which test `page.left` and `page.right`, keep working.
- **No reading the facing page.** A page layout's render does not see the other side's layout or values. It would couple the two renders and their caching; `ctx.book.spreads` already gives read access to the book.
- **Families** work unchanged within page layouts: a family's variants have the same span and `sides`, and a page with a family layout shows that family's picker.
- **Same ID, same type** is checked across spread and page layouts together, because content moves between them (§3).

### 2. Data model

A spread keeps up to three states: its own (for spread layouts, as today) and one per page.

```ts
{
  id, definition,                 // the spread layout, or the last one when split
  params, boxes, elements,        // spread state, as today
  pages?: {                       // present once the spread was split
    left?: PageState, right?: PageState,
  },
  split?: true,                   // the pages are shown, not `definition`
}
PageState = { definition, params, boxes, elements }   // a page remembers its layout and content
```

- Each state follows today's switching rules within itself: a value is stored once set, content a layout has no box for is kept, crops are keyed by layout ID.
- Two page layouts with the same box ID on one spread (the same page layout on both sides, say) are two boxes, one per page.
- A page remembers its layout while the spread shows a spread layout, so splitting again restores it (§3).
- Stored state that no layout shows is listed in the Inspector under *Set aside* with where it is stored (*on the spread*, *on the left page*, *on the right page*), with *Place in…* and *Discard* as today.

**Book format 2.** `projectSchema` strips unknown keys, so an older app would open a book with page states, drop them and save the loss. A book with any split spread, or any stored `pages`, is written with `schemaVersion: 2`; other books stay at 1, so they still open in earlier versions. Older apps refuse format 2 with the existing *saved by a newer version* message.

### 3. Changing layouts: where content comes from

One rule decides every layout change: within a page, from a spread to pages, from pages to a spread, and the other side being restored.

> **Content that is shown follows the new layout, selected side first. A page's own stored content fills what is left, then the spread's. Anything that is pushed out swaps into the place the incoming content came from.**

For each ID the new layout(s) declare, in this order:

1. **Shown now.** If the ID is shown on the spread before the change, its value moves to the new layout. When it is shown in more than one place (both pages show a `hero`), the selected side's value wins; without a selected side, the left page's.
2. **The target's own memory.** Otherwise the page (or spread) uses what it stored itself.
3. **The spread's leftovers.** Otherwise a page takes what the spread state stores and no layout shows.
4. **Swap, never drop.** A value replaced in the target moves into the state the incoming value left, so nothing is deleted and no content is stored in two places.

The whole box state moves: assignment, box parameters, focus and per-layout crops. Crops are keyed by layout ID, which is unique in the template, so a round trip restores them; unlike *Place in…* today, the crops are not left behind. Spread, element and page parameters move by the same rule.

**Splitting.** Choosing a page layout while a side of a full spread is selected splits the spread. The selected side gets the page layout; the other side returns to its remembered page layout, or becomes a blank page when it has none.

**The blank page is ImageFlow's own.** It is a page layout every template has without declaring it: the paper, no boxes, no parameters, no artwork. Books need blank pages anyway (facing a chapter opener, before the closing page), so it is also offered in the sidebar's page layouts. A page showing it stores nothing, and its stored content stays as for any other layout. A template cannot replace it; declaring its own default for new pages is a later extension.

**Merging.** Choosing a spread layout on a split spread, from either page, replaces both pages.

Every change is one Undo step. Pointing at a layout in the picker describes the moves, for example *Hero and title move to the left page · story kept on the spread · right page becomes blank*.

### 4. Worked examples

**Splitting a spread.** A spread layout shows `hero` (photo A), `title` and `story`. The user selects the left half and chooses a page layout with `hero` and `title`: both move to the left page, the right page is blank, and `story` stays stored on the spread. Choosing a text page with `story` for the right page then moves `story` there. Switching back to the original spread layout brings all three back, with edits made on the pages.

**Merging and splitting again.** The left page shows hero A, the right page hero B, both page layouts with a `hero`.

| Step | Spread | Left page | Right page |
|---|---|---|---|
| Select left, choose a spread layout with `hero` | shows **A** (selected side wins) | stores its layout, hero empty | stores its layout and **B** |
| Then select left, choose that page layout again | — | shows **A** (shown content) | restored layout shows **B** (own memory) |
| *Instead:* select right, choose a page layout with `hero` | stores **B** (swapped in) | restored layout, hero empty | shows **A** (shown beats stored B) |

The last row is the awkward case: the left page comes back with an empty hero, because A left it when the spread was merged. Letting the right page's stored B win would hide A on every page, and placing B on the left page would be a guess. *Swap pages* (§5) is the direct gesture when the user wants the pages exchanged.

### 5. Editor

- **Selection is `{ spread, side? }`.** Clicking a half of any spread, full or split, selects that side; on a full spread the side only matters as the target of a page layout. On a split spread the Inspector shows the selected page's layout, parameters and content. The spread remains the unit for reorder, duplicate, delete and the filmstrip. ←/→ move between pages.
- **Layout sidebar.** Spread layouts and page layouts are listed in two groups. A page layout is previewed as a single page, on the selected side. Clicking it applies it to the selected side (the left page when the whole spread is selected); dragging it onto a half of a spread applies it there, the side found from the pointer's position relative to the fold. Page layouts with `sides` are offered only for that side.
- **Swap pages** exchanges the two page states of a split spread. Moving a single page to another spread is not offered, because it changes the pagination.
- **End pages** are selected, switched and edited like any page. They have no other side, so the spread toolbar's reorder and delete rules for them are unchanged.

### 6. Book-wide behaviour

- **Text flow** keys positions by spread, side and box, and orders a split spread's boxes left page first, each page by `flowOrder`.
- **Anchors** are declared per page layout; the side is the page's, whatever the declaration names.
- **`ctx.book.spreads`** gives each split spread its pages: `pages: { left?: { layout, photos }, right?: { layout, photos } }` beside `layout` and `photos`, which describe what is shown (`layout` is the spread layout, or absent when split).
- **Book check** findings on a page name its side. Fixtures render every page layout on both sides it allows, to catch mirroring mistakes.
- **Commands and MCP.** `switch_layout`, `assign_source`, `clear_box`, `set_crop`, `swap_content`, `set_parameter`/`reset_parameter` (spread scope) and inspection targets take `page?: 'left' | 'right'`. Edit paths (`heading`, `boxes.hero.showCaption`) resolve within the page they are rendered on. `get_authoring_context` reports page layouts with `span` and `sides`. `openingSpreads` entries accept `{ pages: { left, right } }`.
- **Element and document editors.** An element editor opened on a page gets that page's parameters as `spread`/`setSpread` and `context.side`.

### 7. Rendering and export

A split spread is still one sheet. The platform draws both pages into the ordinary `<Spread>` sheet, each `<Page>` in a container positioned at its trim edge and clipped at the fold, exactly as a spread layout would draw them. `sheetPages`, `trimBox`, binding bleed (the facing page shows in it), page and spread delivery, thumbnails and presentation work on sheets and do not change.

### 8. Contract

The contract-1 baseline is open until the first public release ([ADR 0008](0008-baseline-freeze-at-release.md)). If page templates ship before it, they join `contract1Capabilities`; otherwise they are the extension `page-layouts`, declared in `requires`. Existing templates are unaffected: their layouts are spread or end-page layouts, and their books never split.

## Alternatives considered

- **Strict separation.** Page states start empty; the user moves content in with *Place in…*. Simplest and fully predictable, but splitting a spread with a hero and a title into a page with a hero and a title would empty both, and the template's IDs would mean the same thing everywhere except between spreads and pages.
- **Copy on split.** Copying instead of moving keeps the spread's values as they were. Returning to the spread then shows the old values and loses edits made on the page, which breaks *latest edit wins*.
- **Shared storage.** Letting a spread layout's boxes alias one page (`page: 'left'` on a box) makes the binding permanent and one-sided, and still needs a rule when both pages declare the ID. Moving content when the layout changes makes it unnecessary.
- **One flat namespace.** Impossible: the same page layout on both sides gives two boxes with one ID on one spread.
- **Spread coordinates for page layouts.** Page layouts drawn in spread coordinates (as end pages are today) cannot be used on both sides without the template branching on the side for every rectangle.

## Implementation plan

Effort as relative size (S, M, L).

1. **Page-scoped DOM addressing and book format 2 (M). Done** (see [below](#phase-1-as-implemented)). An invisible refactor before any feature, with the book format that stores page states. DOM lookups (the `[data-box]`/`[data-element]` selectors in `src/render.tsx` and `src/rendered-image.tsx`: validation, findings, overflow, safe-area and flow measurement, editor geometry, inline editing, inspection and close-ups) are scoped by page container, so two `hero` boxes can share a sheet.
2. **Slot-aware state access and the carry rule (L).** Box, element and parameter access in the app goes through `scopeState` and the page (`.boxes[` 65 uses in 10 files, `.definition` 118 in 18, `.elements[` 24 in 7), and the app reads `page` from the frame's geometry and findings. One function in `src/layouts.ts` plans every change by §3 and replaces `planLayoutChange`/`switchLayout`; `describeLayoutChange` describes moves across states. Unit tests cover the worked examples, Undo and the format-1 round trip.
3. **Render API (M).** `page()` builder, `<Page>`, `ctx.side`, side-aware `ctx.geometry` and `design().page()`, `ctx.page` per side; `pageSequence`, `layoutChoices`, `spanFits`/`spanAllowedAt`, `declaration-check.ts`, `spread-order.ts` insertion rules and `editing.ts` first-spread layouts learn page layouts. Composition of two pages into one sheet in `SpreadView`. Authoring types and `template-types.ts` checks.
4. **Book context, checks and fixtures (M).** Flow keys and order, anchors, `ctx.book.spreads`, editor contexts, Book check findings with sides, fixtures on both sides, `layout-preview.ts` cache keys, purity attribution by page.
5. **Editor (L).** Selection with sides, Inspector for a page, *Set aside* by location, sidebar groups, drag onto a half, hover previews, Swap pages, end pages accepting page layouts.
6. **Commands and MCP (M).** `page` on the commands in §6, `openingSpreads` with pages, `get_authoring_context`, `mcp-contract.ts` and `mcp-results.ts`.
7. **Docs and samples (S).** New *Page layouts* topic in `docs/template-api/`, updates to *Switching layouts*, *Geometry* and *Layout families*, the user guide's editing page, and page layouts in the starter that replace some of its left × right spread pairs.

Phases 1 and 2 carry most of the risk and land before any visible feature.

### Phase 1 as implemented

- **Book format 2** (`src/project.ts`). `schemaVersion` accepts 1 and 2; spreads accept `pages` (each page a `PageState`: `definition`, `params`, `boxes`, `elements`, with the spread's rules) and `split`, which needs at least one page. Parsing sets `schemaVersion` to `bookFormatOf(project)`, so every save writes the lowest format that holds the book: 2 only while a spread stores page states, 1 again once none does. Formats above 2 are refused with the update message, as before. `scopeState(spread, page?)` returns the state a box, element or parameter lives in.
- **Page-scoped lookups** (`src/page-scope.ts`). Page containers are marked `data-if-page`, prefixed so a template's own `data-page` markup is not mistaken for one. Every lookup of a box or element by ID in the render frame (`src/render.tsx`, `src/rendered-image.tsx`) goes through `findDeclared`, `declaredNodes` or `ownerOf`, which name the page; no page means the spread's own layout. Validation checks each drawn layout's boxes and elements against that layout, and refuses page containers on a spread that is not shown as pages, since only ImageFlow draws them.
- **Pages in results.** Findings (`Issue`, diagnostics' `location`), the editor's box and edit-target geometry, element inspection and rendered-image failures carry `page` for a box or element on a page. MCP output schemas do not list it yet, because `location` already allows extra fields and the schemas are at their size budget; phase 6 documents it with the `page` inputs.
- Nothing draws page containers yet, so every lookup resolves to the spread, and books, findings and messages are unchanged.

## Deferred

- **Values shared by both pages.** A split spread has no state both pages read, such as a chapter title across the spread, and this decision adds none. Document parameters and anchors cover most uses. A possible later extension is a spread-level frame around two page layouts: spread parameters (and perhaps a background or running head) that both pages read through the context, stored in the spread's own state and moving by the rule in §3 like any other value.
- **A template's own default page** for new pages, instead of ImageFlow's blank page.
