# Project commands and preview targets

Pass these operations to `apply_project_changes` with `project`, `expectedRevision`, a unique `idempotencyKey`, and an Undo `label`. The same operations work in `check_book.draft.operations` with `project` and `expectedRevision`. A batch holds 1–100 operations in execution order. Use `dryRun: true` to validate without saving.

Use layout, format and parameter IDs from `get_authoring_context`; use spread and source IDs from `inspect_book`. A command that creates a spread can name it with `"ref":"chapter"`. Later commands and draft preview targets refer to it with the string `"$chapter"`. Use an earlier spread ID or reference in `after`, or use `null` to insert at the start. With no `after`, inserts append and duplicates follow the original.

## Exterior covers

Pass `cover: true` where a layout, box, or element operation would otherwise name a spread. Use `scope: "cover"` for whole-cover parameters. Run these operations as a batch or check them as a draft.

```json
[
  { "op": "switch_layout", "cover": true, "definition": "wrapPhoto" },
  { "op": "set_parameter", "scope": "cover", "key": "title", "value": "Along the coast" },
  { "op": "assign_source", "cover": true, "box": "hero", "kind": "photo", "source": "registered-photo-id" }
]
```

## Layout and book operations

| Operation | Example |
| --- | --- |
| Set the title | `{"op":"set_title","title":"Kyrgyzstan"}` |
| Choose a print format | `{"op":"select_format","format":"portrait"}` |
| Insert a spread | `{"op":"insert_spread","definition":"story","after":"arrival","ref":"chapter","params":{"heading":"Chapter One"}}` |
| Insert two independent facing pages | `{"op":"insert_page_pair","after":"$chapter","ref":"pair","pages":{"left":{"definition":"story"},"right":{"definition":"photo"}}}` |
| Clear one page of a split sheet, keeping its saved content | `{"op":"clear_page","spread":"$pair","page":"left"}` |
| Exchange the two pages of a split sheet | `{"op":"swap_pages","spread":"$pair"}` |
| Duplicate a spread | `{"op":"duplicate_spread","spread":"$chapter","ref":"copy"}` |
| Move a spread | `{"op":"move_spread","spread":"$copy","after":null}` |
| Remove a spread | `{"op":"remove_spread","spread":"$copy"}` |
| Switch a layout or family variant | `{"op":"switch_layout","spread":"$pair","page":"right","definition":"photo-framed"}` |

Spread and page inserts can supply initial `params`, `boxes` and `elements` by ID. In a page pair, omit a side to leave it blank. See [Page layouts](page-layouts.md) and [Switching layouts](switching-layouts.md) for compatible placements and saved content.

## Parameter and list operations

Use `scope:"document"` with just a `key`, or `scope:"spread"` with a `spread` and `key`. Use `scope:"box"` or `scope:"element"` with the owning box or element ID in `owner`. Add `page:"left"` or `"right"` when addressing a split page. Omit `page` for unsplit units.

| Operation | Example |
| --- | --- |
| Set a parameter | `{"op":"set_parameter","scope":"element","spread":"$pair","page":"left","owner":"map","key":"track","value":"stage-1"}` |
| Remove a saved value, including one whose declaration was removed | `{"op":"reset_parameter","scope":"document","key":"colophon"}` |
| Append a list item | `{"op":"insert_list_item","scope":"document","key":"credits","item":{"id":"guide","name":"Aida"}}` |
| Change fields on a list item | `{"op":"update_list_item","scope":"document","key":"credits","id":"guide","values":{"name":"Aida A."}}` |
| Move a list item to the start | `{"op":"move_list_item","scope":"document","key":"credits","id":"guide","after":null}` |
| Remove a list item | `{"op":"remove_list_item","scope":"document","key":"credits","id":"guide"}` |

See [Parameters](parameters.md) and [List parameters](list-parameters.md) for value types and list defaults.

## Source, crop and metadata operations

| Operation | Example |
| --- | --- |
| Assign a photo or Markdown source | `{"op":"assign_source","spread":"$pair","page":"right","box":"hero","kind":"photo","source":"photo-1"}` |
| Clear a box | `{"op":"clear_box","spread":"$pair","page":"right","box":"hero"}` |
| Exchange content between boxes | `{"op":"swap_content","from":{"spread":"arrival","box":"hero"},"to":{"spread":"$pair","page":"right","box":"hero"}}` |
| Set a photo crop | `{"op":"set_crop","spread":"arrival","box":"hero","centerX":0.5,"centerY":0.5,"zoom":1.25}` |
| Update or clear photo metadata | `{"op":"set_photo_metadata","photo":"photo-1","values":{"caption":"First morning","credit":null}}` |

## Preview targets

Put one of these objects in `check_book.preview.target`. Page-number targets and draft previews require `expectedRevision`.

| Target | Example |
| --- | --- |
| Whole spread | `{"spread":"arrival"}` |
| One side of a spread | `{"spread":"arrival","side":"left"}` |
| Page by its positive book page number | `{"page":3}` |
| Box close-up, optionally on a split page | `{"spread":"$pair","page":"right","box":"hero"}` |
| Element close-up, optionally on a split page | `{"spread":"$pair","page":"left","element":"map"}` |
| Contact sheet of up to 12 spreads | `{"spreads":["arrival","$pair"],"columns":2}` |

Use `side:"page"` for a format without facing pages. Close-ups and `inspect_book` element requests use `page:"left"` or `"right"` to locate a box or element on a split sheet. Contact sheets need a `preview.maxEdge` of at least 128 pixels.
