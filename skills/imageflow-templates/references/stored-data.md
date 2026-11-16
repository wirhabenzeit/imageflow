# Stored project data

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

## Page states

A spread shown as two pages stores `split: true` and `pages.left`/`pages.right`, each with `definition`, `params`, `boxes` and `elements`. A page without a definition is blank. The spread's own `definition`, `params`, `boxes` and `elements` remain its remembered spread state while the pages are shown. When merged, `split` is removed and the page states remain remembered. Replaced content is stored in `displaced`: entries have `from: 'spread' | 'left' | 'right'`, `box` and the saved box `state`.

The same `hero` ID on the left and right is two assignments, addressed by page. A layout switch can move a whole box state, including focus, box parameters and per-layout crops, between these states. See [Switching layouts](switching-layouts.md) for matching, memory and replacement rules.

Any stored page state, split sheet or displaced content requires book `schemaVersion: 2`. Books without them remain format 1. Older apps refuse format 2 rather than dropping page data. Never edit manifests directly while the book is open; current MCP mutation commands do not yet address page states, so use the editor for these edits.

Template `openingSpreads` may also declare page pairs for new books. Those declarations use `layout` and optional `params` per side; the created project stores them as `pages` with `definition`, alongside `split: true`. See [Template library](template-library.md).
