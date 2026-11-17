# Page layouts

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

## Declaring and rendering a page

`page()` sets `span: 'page'` and types the layout's parameters, boxes, elements, edit paths and document parameters like `spread()`. Page and spread layouts share the `spreads` record, so every layout ID must be unique. A page can declare the same parameters, controls, boxes, elements, anchors, credits, family and variant tags as a spread. Optional `sides: ['left']` or `sides: ['right']` restricts a facing page's placement; omit it to allow both sides.

Page coordinates start at that page's left trim edge. `ctx.geometry.page(area?)` returns its trim, safe or bleed rectangle; `ctx.geometry.design(canvas).page(x, y, width, height)` scales a design into those local coordinates. `ctx.geometry.spread()` and requests for the facing page's geometry throw. Use `ctx.side` (`'left'`, `'right'`, or `'page'` without facing pages) to mirror artwork when needed. `<Page>` exposes the same value as `data-side` and supplies the side's outside/binding safe and bleed variables.

`ctx.page` contains only this page's number: `{ left }`, `{ right }`, or `{ number }` without facing pages. A page reads only its own parameters, boxes and elements. The whole-book index remains available through `ctx.book`; anchors and credits declared by a page belong to that page, regardless of a declaration's `side`. Text flow visits the left page first, then the right, using each page's own `flowOrder`. Identical box IDs on the two pages are independent boxes.

## Choosing pages in the editor

Click either half of a sheet to select that side. The Inspector shows **Left page** or **Right page** once a spread is split, with that page's settings and content. Left/right arrows move through pages; thumbnails, reorder, duplicate and delete still operate on whole sheets.

The layout browser shows all designs in one grid: two double-page designs or four single-page designs fit across, with equal gaps. A patterned blank-page tile sits in the same grid. Choosing a page design splits a full spread: the selected side gets the chosen design, and the facing side restores its remembered page or starts blank. With a whole sheet selected, the target is the left page. Dragging a layout onto a half uses the drop position. Page designs keep the same positions when the selected side changes. Designs with a side restriction remain visible but disabled on the other side. A page preview shows one page; assistive descriptions explain content moves and replacements without hover tooltips.

Choosing a spread layout merges the two pages into one layout. **Blank page** clears the selected full-sheet side's layout while keeping its stored content. **Book → Swap Pages** exchanges the complete page states; it is enabled only when each layout permits the opposite side. Each action is one Undo step. See [Switching layouts](switching-layouts.md) for content transfer rules.

Opening and closing units in a `single-pages` format use ordinary page layouts that allow the required side, without creating a split sheet. A template with only page designs can start a facing book and add sheets: a full sheet begins with a design on an allowed side and a blank facing page. The platform blank-page choice is currently offered for full-sheet positions.

## Beta testing and automation

The editor supports page selection, page settings and source assignment, cropping, inline text and element editors, layout changes, content recovery, Undo, saving/reopening and PDF export. To test a reusable design, place it on both sides, edit just one page, switch or merge layouts, Undo, save/reopen, and export. Test each allowed side in every offered format; synthetic layout fixtures also render page designs on their allowed sides.

MCP content commands accept `page: 'left' | 'right'` beside the sheet's `spread` ID for split sheets. This applies to parameters (including list items), source assignments, crops, clearing boxes and each endpoint of `swap_content`. `scope: 'spread'` means the selected page's layout parameters when `page` is present. Omit `page` for document parameters, book ends and non-facing units. Unaddressed content commands on split sheets return `SPREAD_SHOWN_AS_PAGES`; page addressing on an unsplit unit is rejected.

Use `switch_layout` with `page` to split a full facing sheet or change its selected side, or choose a spread layout to merge it. The selected side wins when merging. `clear_page` shows a blank side while retaining content for recovery; `swap_pages` exchanges page states if their side restrictions allow it. `insert_page_pair` inserts a sheet with `pages.left` and/or `pages.right`, each with a `definition`, optional `params`, `boxes` and `elements`; an omitted side is blank. It supports `after` and `ref` like `insert_spread`. Whole-sheet duplicate, move and remove commands also work on split sheets. All commands retain the normal revision checks, atomic batches, drafts and shared Undo.

`inspect_book(view: 'parameters')` returns `pageDeclarations.left/right` for a split sheet (null for a blank page), beside its saved `pages` values. It does not label hidden spread declarations as visible. Element inspection accepts `page`; whole-sheet inspection includes each measured node's page. Detail previews use `{ spread, page, box }` or `{ spread, page, element }`, so identical IDs on facing pages stay separate. Whole-page preview targets still use `{ spread, side }`, or a physical `{ page: number }` with `expectedRevision`.
