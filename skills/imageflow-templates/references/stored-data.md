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
