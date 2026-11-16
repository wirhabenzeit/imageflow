# 0009: Page templates

Status: accepted, 2026-11-16; §3 revised the same day after review on #183 (the facing page never changes, empty and default values carry over, replaced content is set aside explicitly). Phase 1 (page-scoped addressing and book format 2) and phase 2 (the change planner and every reference consumer reading every state) implemented; phase 3 (page render API, sheet composition and page-scoped editing) implemented; the storage and rendering gates are lifted, with unaddressed command and Inspector edits refused while pages are shown (see *Release gates*). Motivated by beta feedback: a user builds more and more spread layouts that combine one left-page design with one right-page design, each with its own parameters for both sides.

## Problem

A spread layout is the only unit a template can design. A book whose spreads pair a few page designs (photo page, text page, quote page, …) needs one spread layout for every left × right combination, with prefixed parameters (`leftHeading`, `rightHeading`, `leftPhoto`, …). The number of layouts grows with the square of the page designs, every combination duplicates code, and switching one side means picking another whole spread.

Single pages already exist, but only for the ends of a book: `span: 'left'` and `span: 'right'` layouts are the closing and opening pages of formats with `ends: 'single-pages'`, and `span: 'page'` is the unit of a format without facing pages. A spread in the middle of the book cannot be made of two pages.

## Principle

**A spread is shown either by one spread layout or by two page layouts, one per side. Spread and pages store their content separately; changing between layouts moves content with matching IDs out of the layouts it replaces, and never touches a page that stays visible.**

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
  displaced?: { from: 'spread' | 'left' | 'right', box, state }[],   // content a layout change replaced (§3)
}
PageState = { definition?, params, boxes, elements }  // a page remembers its layout and content; no definition: the blank page
```

- Each state follows today's switching rules within itself: a value is stored once set, content a layout has no box for is kept, crops are keyed by layout ID.
- Two page layouts with the same box ID on one spread (the same page layout on both sides, say) are two boxes, one per page.
- A page remembers its layout while the spread shows a spread layout, so splitting again restores it (§3).
- Content stored in a state that no layout shows is listed in the Inspector under *Set aside* as today, with where it is stored (*on the spread*, *on the left page*, *on the right page*). It shows again in any layout that has its box.
- Content a layout change replaced (`displaced`) is listed separately, under *Replaced*, with where it came from. It never shows again by itself; *Place in…* returns it and *Discard* removes it.

**Book format 2.** `projectSchema` strips unknown keys, so an older app would open a book with page states, drop them and save the loss. A book with any stored `pages`, `split` or `displaced` is written with `schemaVersion: 2`; other books stay at 1, so they still open in earlier versions. Older apps refuse format 2 with the existing *saved by a newer version* message.

**Release gates.** Format 2 is defined before the app can handle everything it stores, so a build refuses, with a request to update, any book that uses what it cannot handle yet:

- **Stored page states and replaced content** (`pages`, `displaced`) hold references to photos, texts and files (box assignments, and file sources in parameters). Code that enumerated references (asset usage, source removal, commands) read only the spread's own state, so it would have reported such sources as unused, and removing one would have left a dangling reference. Phase 2 lifted this gate: every reference consumer reads every state.
- **A spread shown as pages** (`split`) is drawn as two page layouts in one sheet, including blank pages. Phase 3 lifted this gate after a desktop smoke verified independent page editing and a four-page PDF export.

A release must not ship a build that accepts a part of format 2 it does not fully handle. Lifting the storage and rendering gates is not approval to release page templates: the remaining checks, editor, commands and contract work below must land first. Until commands accept page addressing, spread-targeted commands refuse split spreads except for `switch_layout`; the Inspector disables remembered spread fields and offers layout merging.

### 3. Changing layouts: where content comes from

Every layout change replaces the layout of one or more states (the *replaced* states) and gives one or more states a new layout (the *targets*):

| Change | Replaced | Targets |
|---|---|---|
| A spread layout on a full spread | the spread | the spread |
| A page layout on one page | that page | that page |
| A page layout on a side of a full spread (*splitting*) | the spread | both pages: the chosen side gets the new layout, the other side its remembered layout or the blank page |
| A spread layout on a spread shown as pages (*merging*) | both pages | the spread |

> **Invariant: a page that stays visible never changes.** Changing one page's layout reads and writes only that page. The facing page is neither a source nor a target; content reaches it only through an explicit *Place in…*, a merge or *Swap pages*.

For each ID a target's new layout declares (its parameters, boxes and each box's parameters, elements and each element's parameters), the value comes from the first of:

1. **A replaced layout that shows it.** What a replaced layout shows is final, *including nothing*: an empty box, and a parameter at its default because no value is stored. An emptied box and a reset parameter therefore carry over as empty and default, and nothing older can come back in their place. When more than one replaced layout shows the ID (both pages show a `hero` when merging), a value beats an empty box or a default, and between two values the selected side wins (the left page when no side is selected). A value goes to one target only; when splitting, the chosen side takes first.
2. **The target's own memory.** Otherwise the target keeps what it stores itself, as within one state today.
3. **The spread's memory, for a page.** Otherwise a page takes what the spread state stores and no layout shows, such as content kept from before the split.

A value that moves is taken out of the state it came from. What the target stored for the ID before is **replaced**:

- A **parameter value** (spread, page, element or box parameter) is overwritten, as an edit overwrites it today. Undo restores it.
- **Content** (a photo or text, with its box parameters, focus and crops) is **set aside as replaced**: it moves to the spread's `displaced` list with where it came from. Nothing is deleted, and nothing replaced comes back by a later switch.

Values in a replaced state that no target takes stay in that state, unchanged. Nothing contradicted them, so restoring them with that state's layout later is correct.

The whole box state moves: assignment, box parameters, focus and per-layout crops. Crops are keyed by layout ID, which is unique in the template, so a round trip restores them; unlike *Place in…* today, the crops are not left behind.

**Splitting.** Choosing a page layout while a side of a full spread is selected splits the spread. The selected side gets the page layout; the other side returns to its remembered page layout, or becomes a blank page when it has none.

**The blank page is ImageFlow's own.** It is a page layout every template has without declaring it: the paper, no boxes, no parameters, no artwork. Books need blank pages anyway (facing a chapter opener, before the closing page), so it is also offered in the sidebar's page layouts. A page showing it stores nothing, and its stored content stays as for any other layout. A template cannot replace it; declaring its own default for new pages is a later extension.

**Merging.** Choosing a spread layout on a split spread, from either page, replaces both pages.

Every change is one Undo step and restores every state exactly, `displaced` included. Pointing at a layout in the picker describes the moves, for example *Hero and title move to the left page · story kept on the spread · right page becomes blank*, and names content that would be replaced.

### 4. Worked examples

**Splitting a spread.** A spread layout shows `hero` (photo A), `title` and `story`. The user selects the left half and chooses a page layout with `hero` and `title`: both move to the left page, the right page is blank, and `story` stays stored on the spread. Choosing a text page with `story` for the right page then moves `story` there (rule 3). Switching back to the original spread layout brings all three back, with edits made on the pages.

**The facing page stays.** The left page shows a text layout without `hero`; the right page shows photo B in its `hero`. Choosing a photo page with `hero` for the left page fills its hero from the left page's own memory, then the spread's, and otherwise leaves it empty. B stays on the right page.

**Merging and splitting again.** The left page shows hero A, the right page hero B, both page layouts with a `hero`.

| Step | Spread | Left page | Right page | Replaced |
|---|---|---|---|---|
| Select left, choose a spread layout with `hero` | shows **A** (two values: selected side wins) | stores its layout, hero empty | stores its layout and **B** (not taken) | — |
| Then select left, choose that page layout again | — | shows **A** (rule 1) | restored layout shows **B** (rule 2) | — |
| *Instead:* select right, choose a page layout with `hero` | — | restored layout, hero empty | shows **A** (rule 1) | **B**, from the right page |

The last row is the awkward case: the left page comes back with an empty hero, because A left it when the spread was merged, and B, which the right page stored, is replaced by A. B is listed under *Replaced* rather than returning on its own later. *Swap pages* (§5) is the direct gesture when the user wants the pages exchanged.

**Clearing, then merging and splitting.** The spread stores photo X in `hero` and title "Old", kept from an earlier spread layout: the one it showed when it was split had neither, so the pages took nothing for them. The left page shows photo A in `hero` and title "New"; the right page's layout has neither.

| Step | Spread | Left page | Replaced |
|---|---|---|---|
| Remove A from the left hero; reset the left title | stores X, "Old" | hero empty, title default | — |
| Select left, choose a spread layout with `hero` and `title` | hero empty, title default (rule 1: empty and default are final) | stores its layout | **X**, from the spread; "Old" is overwritten |
| Select right, choose a page layout with `hero` and `title` | — | restored layout: hero empty, title default | — |

In the last step the right page takes the empty hero and default title from the spread (rule 1). X and "Old" do not come back on either page. Without rule 1's *including nothing*, the merge would have shown X and "Old" again; and if X had swapped into the left page's memory, as an earlier draft of this rule had it, the last step would have shown X on the left page.

### 5. Editor

- **Selection is `{ spread, side? }`.** Clicking a half of any spread, full or split, selects that side; on a full spread the side only matters as the target of a page layout. On a split spread the Inspector shows the selected page's layout, parameters and content. The spread remains the unit for reorder, duplicate, delete and the filmstrip. ←/→ move between pages.
- **Layout sidebar.** Spread layouts and page layouts are listed in two groups. A page layout is previewed as a single page, on the selected side. Clicking it applies it to the selected side (the left page when the whole spread is selected); dragging it onto a half of a spread applies it there, the side found from the pointer's position relative to the fold. Page layouts with `sides` are offered only for that side.
- **Swap pages** exchanges the two page states of a split spread, layouts included. It is offered only when each page's layout is allowed on the other side (`sides`); the blank page is allowed on both. A spread with one page (an end page) has nothing to swap. Moving a single page to another spread is not offered, because it changes the pagination.
- **End pages** are selected, switched and edited like any page. They have no other side, so the spread toolbar's reorder and delete rules for them are unchanged.

### 6. Book-wide behaviour

- **Text flow** keys positions by spread, side and box, and orders a split spread's boxes left page first, each page by `flowOrder`.
- **Anchors** are declared per page layout; the side is the page's, whatever the declaration names.
- **`ctx.book.spreads`** gives each split spread its pages: `pages: { left?: { layout, photos }, right?: { layout, photos } }` beside `layout` and `photos`, which describe what is shown (`layout` is the spread layout, or absent when split).
- **Book check** findings on a page name its side. Fixtures render every page layout on both sides it allows, to catch mirroring mistakes.
- **Commands and MCP.** `switch_layout`, `assign_source`, `clear_box`, `set_crop`, `swap_content`, `set_parameter`/`reset_parameter` (spread scope) and inspection targets take `page?: 'left' | 'right'`. Edit paths (`heading`, `boxes.hero.showCaption`) resolve within the page they are rendered on. `get_authoring_context` reports page layouts with `span` and `sides`. `openingSpreads` entries accept `{ pages: { left, right } }`.
- **Element and document editors.** An element editor opened on a page gets that page's parameters as `spread`/`setSpread` and `context.side`.
- **Formats without facing pages.** A format change never restructures the book. In a format without facing pages, a spread shown as pages does not fit, like a spread layout today: the Book check reports it as an error that blocks export and names the fix, choosing a page layout for that unit. That choice is a merge (§3) into the unit's own state, with content from the selected page; the other page keeps its state, so switching back to a format with facing pages and splitting again restores it. Converting each such spread into two units automatically would change the pagination as a side effect of a format change, and is not done.

### 7. Rendering and export

A split spread is still one sheet. The platform draws both pages into the ordinary `<Spread>` sheet, each `<Page>` in a container positioned at its trim edge and clipped at the fold, exactly as a spread layout would draw them. `sheetPages`, `trimBox`, binding bleed (the facing page shows in it), page and spread delivery, thumbnails and presentation work on sheets and do not change.

### 8. Contract

The contract-1 baseline is open until the first public release ([ADR 0008](0008-baseline-freeze-at-release.md)). If page templates ship before it, they join `contract1Capabilities`; otherwise they are the extension `page-layouts`, declared in `requires`. Existing templates are unaffected: their layouts are spread or end-page layouts, and their books never split.

## Alternatives considered

- **Strict separation.** Page states start empty; the user moves content in with *Place in…*. Simplest and fully predictable, but splitting a spread with a hero and a title into a page with a hero and a title would empty both, and the template's IDs would mean the same thing everywhere except between spreads and pages.
- **Copy on split.** Copying instead of moving keeps the spread's values as they were. Returning to the spread then shows the old values and loses edits made on the page, which breaks *latest edit wins*.
- **Shared storage.** Letting a spread layout's boxes alias one page (`page: 'left'` on a box) makes the binding permanent and one-sided, and still needs a rule when both pages declare the ID. Moving content when the layout changes makes it unnecessary.
- **Swapping replaced values into memory.** An earlier draft of §3 moved a replaced value into the state the incoming value came from. That state's memory could later restore it: a reset title or an emptied box came back on the other page after a merge and a split. Replaced content now goes to the explicit `displaced` list, and replaced parameter values are overwritten as an edit would overwrite them.
- **Taking content from the facing page.** The earlier draft took any shown value, including the facing page's, so giving one page a layout with `hero` could move the other page's photo. Only replaced layouts are sources now.
- **One flat namespace.** Impossible: the same page layout on both sides gives two boxes with one ID on one spread.
- **Spread coordinates for page layouts.** Page layouts drawn in spread coordinates (as end pages are today) cannot be used on both sides without the template branching on the side for every rectangle.

## Implementation plan

Effort as relative size (S, M, L).

1. **Page-scoped DOM addressing and book format 2 (M). Done** (see [below](#phase-1-as-implemented)). An invisible refactor before any feature, with the book format that stores page states. DOM lookups (the `[data-box]`/`[data-element]` selectors in `src/render.tsx` and `src/rendered-image.tsx`: validation, findings, overflow, safe-area and flow measurement, editor geometry, inline editing, inspection and close-ups) are scoped by page container, so two `hero` boxes can share a sheet.
2. **Slot-aware state access and the change planner (L). Done**, except the app's per-page state access, which moves to phases 3 and 5 (see [below](#phase-2-as-implemented)). Box, element and parameter access in the app goes through `scopeState` and the page (`.boxes[` 65 uses in 10 files, `.definition` 118 in 18, `.elements[` 24 in 7), and the app reads `page` from the frame's geometry and findings; the crop editor and element editors send it back. One pure function in `src/layouts.ts` plans every change by §3 and replaces `planLayoutChange`/`switchLayout`; `describeLayoutChange` describes moves and replacements across states. The planner is the riskiest part of this design. Besides the worked examples, property tests run random sequences of layout changes, clears, resets, Undo and Swap pages on random templates and check that:
   - content is conserved: every photo and text assignment is in exactly one state or in `displaced`, never two;
   - a page that stays visible is unchanged by the other page's change;
   - results are deterministic for the same book, change and selection;
   - a cleared box or reset parameter is never shown again with an older value unless the user places it;
   - Undo restores every state exactly.

   Every code path that reads or rewrites references (asset usage, source removal and relinking, saving a copy with its assets, commands, authoring context) goes through one function that lists a spread's states and its replaced content. A test seeds a book whose photos, texts and files are referenced only from page states, page parameters and `displaced`, and checks every such consumer. With it, phase 2 sets `pageStatesSupported` and lifts the first release gate.
3. **Render API (M). Done** (see [below](#phase-3-as-implemented)). With it, the app's box, element and parameter access by page (deferred from phase 2), since only drawn pages give the frame's geometry and findings a page to report. `page()` builder, `<Page>`, `ctx.side`, side-aware `ctx.geometry` and `design().page()`, `ctx.page` per side; `pageSequence`, `layoutChoices`, `spanFits`/`spanAllowedAt`, `declaration-check.ts`, `spread-order.ts` insertion rules and `editing.ts` first-spread layouts learn page layouts. Composition of two pages into one sheet in `SpreadView`. Authoring types and `template-types.ts` checks.
4. **Book context, checks and fixtures (M).** Flow keys and order, anchors, `ctx.book.spreads`, editor contexts, Book check findings with sides, fixtures on both sides, `layout-preview.ts` cache keys, purity attribution by page.
5. **Editor (L).** Selection with sides, Inspector for a page, *Set aside* by location, sidebar groups, drag onto a half, hover previews, Swap pages, end pages accepting page layouts.
6. **Commands and MCP (M).** `page` on the commands in §6, `openingSpreads` with pages, `get_authoring_context`, `mcp-contract.ts` and `mcp-results.ts`.
7. **Docs and samples (S).** New *Page layouts* topic in `docs/template-api/`, updates to *Switching layouts*, *Geometry* and *Layout families*, the user guide's editing page, and page layouts in the starter that replace some of its left × right spread pairs.

Phases 1 and 2 carry most of the risk and land before any visible feature.

### Phase 1 as implemented

- **Book format 2** (`src/project.ts`). `schemaVersion` accepts 1 and 2; spreads accept `pages` (each page a `PageState`: `definition`, `params`, `boxes`, `elements`, with the spread's rules) and `split`, which needs at least one page. Parsing sets `schemaVersion` to `bookFormatOf(project)`, so every save writes the lowest format that holds the book: 2 only while a spread stores page states, 1 again once none does. Formats above 2 are refused with the update message, as before. `scopeState(spread, page?)` returns the state a box, element or parameter lives in.
- **Page-scoped lookups** (`src/page-scope.ts`). Page containers are marked `data-if-page`, prefixed so a template's own `data-page` markup is not mistaken for one. Every lookup of a box or element by ID in the render frame (`src/render.tsx`, `src/rendered-image.tsx`) goes through `findDeclared`, `declaredNodes` or `ownerOf`, which name the page; no page means the spread's own layout. Validation checks each drawn layout's boxes and elements against that layout, and refuses page containers on a spread that is not shown as pages, since only ImageFlow draws them.
- **`displaced`** stores replaced content (§3) with `from` and `box`; only a photo or text can be set aside. It makes a book format 2.
- **Release gates.** `pageStatesSupported` and `pageLayoutsShown` are false: a book with `pages`, `displaced` or `split` is refused before validation with a request to update (`unsupportedBookMessage`) and left unchanged, and `projectSchema` refuses it for saves and revisions. `spreadSchema` itself is ungated, so format 2's spread is tested on its own. Phase 2 sets the first, phase 3 the second.
- **Pages in results.** Findings (`Issue`, diagnostics' `location`), the editor's box geometry, element inspection and rendered-image failures carry `page` for a box or element on a page. Every edit target carries `page` itself, also a standalone `ctx.edit('heading')` that is no box or element: target keys (`spread@left|…`; keys without a page are unchanged), occurrence numbers and an open editor's anchor are per page, and the inline-editing and crop-preview messages carry it. Live crop placements and photo-box `uid`s (`ifl-…`, `ifr-…`) are keyed by page. MCP output schemas do not list `page` yet, because `location` already allows extra fields and the schemas are at their size budget; phase 6 documents it with the `page` inputs.
- Nothing draws page containers yet, so every lookup resolves to the spread, and books, findings and messages are unchanged.

### Phase 2 as implemented

- **The planner** (`planLayoutChange` in `src/layouts.ts`) takes a `LayoutTarget`: `{ definition }` for a spread layout (with `side`, the selected side, when it merges), `{ definition, page }` for a page layout, `{ page }` for the blank page. It returns the changed spread without touching its input; `switchLayout` applies it in place and returns the same description. Every existing caller (Inspector, family picker, context menu, `switch_layout`) goes through it; with spread layouts only, a change replaces and targets the spread itself, so its behaviour is unchanged.
- **Granularity.** A box is one ID: its whole state (assignment, box parameters, focus, per-layout crops) moves, and a box *has a value* when it holds a photo or text. Layout parameters and each element parameter are IDs of their own; one *has a value* when it is stored.
- **Rules 2 and 3.** A page keeps its own value when it has one; otherwise it takes the spread's. A page box that is empty but has box parameters therefore takes the spread's box state, parameters included. An ID a replaced layout showed empty is claimed by the target that takes first, so the other target of a split falls back to its own memory for it, as for a value.
- **The blank page** is a page state without `definition` (`blankPage`, `stateLayout`). Splitting creates a state only for the chosen page; the other side without a remembered layout stays without one and shows the blank page.
- **Descriptions** (`describeLayoutChange`) name moves, content left in a state no longer shown, the blank side and replaced content, for example *Title and Hero move to the left page · Story kept on the spread · right page becomes blank*. A change within one state keeps the earlier summary (*2 photos set aside · Title will reset*). Rejected values are judged against the layout that showed them before the move.
- **Swap pages** (`swapPages`) exchanges the two page states; the caller checks `sides`.
- **References.** `storedStates` and `storedBoxes` (`src/project.ts`) list a spread's states and its boxes, replaced content included. Asset usage, file assignment and clearing, source usage, source removal, `set_photo_metadata` and `keptOutside` (which the authoring context reports) read them. Removing a photo also removes its crops and focus, and drops replaced content left without a source.
- **The Inspector** still lists and places only content kept in the spread's own state; content on pages and replaced content is listed with its location in phase 5.
- **Tests.** `tests/page-changes.test.ts` checks the worked examples of §4, and 300 random templates with 40 random edits, changes and page swaps each against the invariants: content is conserved, the facing page is unchanged, results are deterministic and leave the input as it was (so Undo's snapshot restores every state), rule 1 shows what a replaced layout showed (a value over an empty box or default, the selected side's first), rules 2 and 3 fill the rest from memory, and no change shows a value nobody stored. `tests/page-references.test.ts` seeds books whose sources are referenced only from page states, page parameters and replaced content.

### Phase 3 as implemented

- **Page API.** The `spreads` callback receives `page()` alongside `spread()`. It sets `span: 'page'`; page layouts accept optional `sides`, checked against their family and the side drawn. `<Page>` is exported by the runtime and authoring SDK. The page builder infers parameters and box IDs as the spread builder does, and gives `ctx.side` a definite `left`, `right` or `page` value. The contract capability decision remains in phase 6.
- **Geometry.** `ctx.geometry.page(area?)` and `design(canvas).page(...)` return page-local coordinates with safe and bleed insets mirrored by side. Reading the facing page's geometry or asking for spread geometry from a page layout throws. `<Page>` supplies side and inset CSS variables. Legacy `<Spread>` templates, including non-facing page templates, keep working.
- **Sheets.** `SpreadView` draws two page layouts into one sheet, each in its own `data-if-page` container clipped at the fold. Missing definitions draw the platform's blank page. Each page reads only its own state and receives only its own page number. Export still works on sheets. `pageLayoutsShown` is true, and split format-2 books open and save.
- **Pagination.** `layoutFootprint` keeps a split spread's footprint independent of its remembered spread layout. Numbering, presentation, authoring context, insertion and reorder use it. Ordinary page layouts can serve as single opening and closing pages, subject to `sides`; legacy `left`/`right` layouts keep working. Page layouts no longer receive the unused-span warning in a facing-only template.
- **Editing access deferred from phase 2.** Canvas targets, photo movement and assignment, imports, cropping, marked controls, inline text and custom element/document editors carry their page. `scopeSpread` provides existing single-layout helpers a view of that state, sharing its nested records. Queued text and custom-editor saves check the selected page's layout and values. Geometry and hidden artwork in inline editors are scoped by page.
- **Book-wide groundwork brought forward.** Text chains distinguish identical box IDs on the two pages and run in left-to-right order. Anchors, credits and the read-only photo index enumerate shown states rather than a hidden spread layout. Page-aware file checks and parameter warnings are needed before lifting the render gate. Phase 4 still owns fixtures on both allowed sides, cache-key auditing and complete findings/purity attribution by side.
- **Verification.** `tests/page-rendering.test.ts` covers geometry, composition, blank pages, page numbers, text-chain identity, side restrictions, end-page insertion/reorder and independent/stale editor saves. `scripts/smoke-page-layouts.mjs` opens a split book in the desktop app, edits only its right-page heading and exports four PDF pages. Existing format-2 tests now cover split-book opening and saving.
- **Editor rollout remains phase 5.** There is no new side selection, grouped page-layout sidebar, split/swap gesture or page Inspector in this phase. Existing page-scoped canvas interactions work for books already storing split pages. The Inspector labels these spreads as shown as pages, disables remembered spread fields, hides their spread-only content list and allows the remembered layout to be chosen to merge. Commands targeting such spreads refuse with `SPREAD_SHOWN_AS_PAGES`, except `switch_layout`. The flat photo index includes shown-page photos with their page identity, and the starter's picture list uses that identity for page numbers while tolerating an absent spread layout; starter page designs remain phase 7.

## Deferred

- **Values shared by both pages.** A split spread has no state both pages read, such as a chapter title across the spread, and this decision adds none. Document parameters and anchors cover most uses. A possible later extension is a spread-level frame around two page layouts: spread parameters (and perhaps a background or running head) that both pages read through the context, stored in the spread's own state and moving by the rule in §3 like any other value.
- **A template's own default page** for new pages, instead of ImageFlow's blank page.
