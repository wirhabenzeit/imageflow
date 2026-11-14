# Geometry helpers

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
