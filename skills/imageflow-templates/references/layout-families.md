# Layout families

Layouts that are variants of one design, such as a photo grid in 2×2 and 3×3, can form a **layout family**. Every variant is still an ordinary layout with its own ID and a fixed set of boxes, so everything in [Switching layouts](switching-layouts.md#switching-layouts) applies unchanged: choosing a variant is a layout switch, with the same carried, kept and restored content, per-layout crops, rejected-value fallbacks and one Undo step. Families change only how the choice is presented.

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
