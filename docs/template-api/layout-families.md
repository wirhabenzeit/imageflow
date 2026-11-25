# Layout families

Layouts that are variants of one design, such as a photo grid in 2×2 and 3×3, can form a **layout family**. Every variant is still an ordinary layout with its own ID and a fixed set of boxes, so everything in [Switching layouts](switching-layouts.md#switching-layouts) applies unchanged: choosing a variant is a layout switch, with the same carried, kept and restored content, per-layout crops, rejected-value fallbacks and one Undo step. Families change only how the choice is presented.

```tsx
defineTemplate({
  …,
  layoutFamilies: {
    grid: { label: 'Photo grid', picker: { label: 'Grid size', choice: { tag: 'size', options: { '2x2': '2 × 2', '3x3': '3 × 3' } } } },
  },
  spreads: ({ spread }) => ({
    grid: spread({ label: 'Photo grid 2×2', family: 'grid', variant: { size: '2x2' }, boxes: box.photos(['a', 'b', 'c', 'd'], …), render: … }),
    grid9: spread({ label: 'Photo grid 3×3', family: 'grid', variant: { size: '3x3' }, boxes: box.photos(['a', 'b', 'e', 'c', 'd', 'f', 'g', 'h', 'i'], …), render: … }),
  }),
});
```

- **Declaring:** `layoutFamilies` declares each family by ID with a `label` and an optional `picker`. A layout joins one with `family`. `variant` holds free-form tags (strings, numbers or booleans) that tell the variants apart; ImageFlow gives them no meaning and passes them to the picker.
- **Rules, checked when the template loads:** the family is declared (TypeScript also rejects an unknown family); a family has at least two variants; its variants have the same `span` and `sides` restrictions; tags are on every variant of a family or on none, and no two variants have the same tags; a layout with tags belongs to a family.
- **Box IDs carry the content.** Choose the variants' box IDs so shared content lands where it belongs. The starter's 3×3 grid declares the 2×2 grid's four boxes in its upper-left cells, so growing the grid keeps those photos in place, and shrinking it keeps the other five outside the layout until the spread returns to 3×3.
- **Sidebar:** a family with a picker is one layout preview, named after the family and showing the spread's current variant (or the first one). Clicking it selects that layout, like any other preview. While the spread uses the family, its controls appear first in the spread's or page's settings, below the complete layout browser. A family without a picker shows a preview per variant, next to each other. Keep labels short: at a usual sidebar width, a page tile shows about 10 characters of its name and a spread tile about 22 before cutting it off with an ellipsis (the full name shows on hover). Put the distinguishing word first, so two cut-off names still differ: "Map chapter" and "Text chapter", not "Chapter · map" and "Chapter · text".
- **A choice picker** (`picker.choice`) is the usual picker: ImageFlow's own segmented choice, drawn by the app at once, with one option per variant. `tag` names the variant tag that tells the variants apart, and `options` names each of its values, in the order shown: `{ tag: 'size', options: { '2x2': '2 × 2', '3x3': '3 × 3' } }`. When the template loads, every variant must have the tag, with a value of its own that `options` names, and every option must belong to a variant. It needs no component, no imports and no template code at run time.
- **A component picker** (`picker.component`) is for choices one tag cannot express, such as two independent choices (below). A picker has a `choice` or a `component`, not both. The component runs in a sandboxed frame with the template's CSS, as a labelled settings field. Prefer compact controls, such as a segmented choice for two grid sizes, over preview illustrations; build them from [`<Choice>`](#app-controls) so they match the settings around them. Each `choose(id)` immediately switches layouts as one Undo step; `commit()` applies the current choice and `cancel()` leaves the controls. Undo reverts an applied choice. It receives `variants` (each with `id`, `label` and its `variant` tags), `current` (the variant chosen in the draft), `saved` (the spread's layout), `choose(id)`, `find(tags)` (the first variant whose tags include all the given ones, or `undefined`), `document`, `format`, `readOnly`, `commit()` and `cancel()`.
- **Only declared variants:** a component's `choose` with anything other than a variant ID of the family changes nothing and the inline picker reports the invalid choice. A picker with several independent choices decides itself what a combination without a variant does, for example by disabling that option or choosing the nearest variant: `find({ size: '3x3', text: true }) ?? find({ size: '3x3' })`. Prefer tags over hard-coded IDs, so a new variant needs only a new layout.
- **Changes from elsewhere:** a component picker keeps its frame and measured height while their saved layout and document context follow the book. While the book reloads or cannot be edited, the controls are disabled; messages from stale declarations cannot change the book.
- **Agents and commands** switch layout variants by ID with `switch_layout`; include `page: 'left' | 'right'` for a page family on a split sheet. To check a picker without the app, `check_book` draws it with `preview.target: { spread, picker: true }`, and `choose` clicks one of its controls by label and reports the variant chosen (see the MCP reference). `get_authoring_context` reports `layoutFamilies`, and `family` and `variant` on each layout, so agents see the same grouping.
- **Page families:** page designs can form families too. The picker shows the selected page's variant and changes only that page. Families contain only spread layouts or only page layouts; every page variant allows the same sides.
- **Scope today:** a finite list of explicitly declared variants, controlled from the sidebar's spread settings. The set of boxes is never derived from parameters, and unbounded counts (rows 1 to n) are not supported.

## App controls

`<Choice>` (from `imageflow`) is ImageFlow's own segmented choice: the same control, colours, sizes, selected, disabled and focus states, in light and dark, as the generated settings beside it. Use it in component pickers of layout families and custom element or document editors instead of styling buttons yourself; the app's own class names are internal and may change. It is a radio group: Tab reaches the selected option, and the arrow keys, Home and End choose another. Where its options do not fit in one row, it is drawn as a menu instead. `label` names it, shown above the choice unless `hideLabel` (a picker's single choice is already named by the picker's `label`). Options take `{ value, label, disabled? }` with string, number or boolean values. In an element editor, `<Control parameter>` already draws a parameter's control; `Choice` is for choices that are not one parameter, such as variants.

A picker with two independent choices, each disabled where no variant has the combination:

```tsx
function StagePicker({ variants, current, choose, find, readOnly }: LayoutPickerProps) {
  const { kind = 'cycling', photos = 1 } = variants.find(({ id }) => id === current)?.variant ?? {};
  const option = (label: string, tags: VariantTags) => ({ label, value: tags.kind ?? tags.photos, disabled: !find({ kind, photos, ...tags }) });
  return <>
    <Choice label="Stage type" value={kind} disabled={readOnly}
      options={[option('Cycling', { kind: 'cycling' }), option('Stay', { kind: 'stay' })]}
      onChange={(value) => choose(find({ kind: value, photos })!)} />
    <Choice label="Facing photos" value={photos} disabled={readOnly}
      options={[option('Full-page photo', { photos: 1 }), option('Two photos', { photos: 2 })]}
      onChange={(value) => choose(find({ kind, photos: value })!)} />
  </>;
}
```
