# Authoring workflow

How an agent edits an ImageFlow book through the MCP server. The template API topics describe what a template can declare; this topic describes the order of work and which tool does what.

## Orientation

1. Call `list_projects` to get the handle and input revision of the open, authorized book.
2. Call `get_authoring_context`. It returns the parsed template declarations (`template`), saved and current template identity, the files under `template/`, a table of contents of the API reference (`topics`) and the shipped examples (`examples`). Ask for the topics you need with `docs: ['list-parameters', …]`, for example sources with `includeExamples: ['minimal']`, and for template or Markdown files with `includeSource`.
3. Call `inspect_book` for the saved spreads, sources and parameter values. The `elements` view measures boxes and elements of one spread after whole-book text flow.

## Editing

- Edit `template/` TSX, CSS and assets directly with your workspace tools.
- Edit registered Markdown at its source location; linked Markdown stays outside the package.
- Use `apply_project_changes` for sheet/page changes in `project.json` and metadata changes in `photos.json`. See [Project commands and preview targets](project-commands.md) for examples. Address split-page content with `page: 'left' | 'right'` beside `spread`; unaddressed content commands return `SPREAD_SHOWN_AS_PAGES`.
- While an editor is active, dry runs and draft checks still validate against saved inputs. Saves that change only other spreads go through; a blocked save (one touching the editor's spread or page, or anything book-wide) reports `EDIT_IN_PROGRESS` with the active editor when available. `inspect_book` with `view: "summary"` also shows it.
- Copy new content into `inbox/` and call `import_sources`. Then assign the returned IDs with a command batch.
- Parameter commands use saved scopes: `document`, `spread`, `box` or `element`. An element editor can also own spread parameters; use `scope: 'spread'` for those fields, not `scope: 'element'`.
- Mark a single user-written string the page prints with `<ctx.Text presentation="inline">`, so it is typed where it prints ([inline-text](inline-text.md)). Small text at whole-spread zoom opens the panel, which offers to zoom in.
- To find the parameter a request means, read each parameter's description with its unit, range and options. Give new parameters a description when their meaning or direction is not obvious from the label.
- To start or extend a template, read the [package](package.md) topic's example table, fetch the closest example with `includeExamples` and copy its layout.
- For an empty book, inspect `template.openingSpreads` and insert suitable layouts with `insert_spread` or facing page pairs with `insert_page_pair`. `openingSpreads` describes new-book defaults and is not applied again automatically.
- Use a layout family when layouts are variants of one design (`template.layoutFamilies`; `family` and `variant` on each layout). Give a family a `choice` picker, which the app draws, unless it needs a component for more than one tag; pickers choose by variant tags, not hard-coded IDs. Switch variants with `switch_layout` and the layout ID of the variant ([Layout families](layout-families.md)).

## Verifying

- Call `check_book` with a spread preview after every edit. Images include whole-book text flow. Layout errors carry the spread and template source line; text that runs out of its box or overlaps other text is reported per block.
- Set `typescript: true` to type-check template sources against the installed runtime. Type errors do not suppress usable images.
- Preview a new or unused layout before saving it: call `check_book` with `draft.operations` (an `insert_spread` with a `ref`) and target the preview at its `$ref`. Then apply the same operations with `apply_project_changes` to save them.
- Use `preview.target.spreads` for a contact sheet of up to 12 spreads, and `box` or `element` targets for close-ups. `guides` and `labels` add trim, safe-area and box outlines.
- Stress-test layouts with `check_book` `fixtures`: synthetic typical, long, empty, portrait-photo, valid-GPX and malformed-file content per format, with a coverage matrix and a bannered fixture contact sheet that is never the saved book. Coverage names the checks that did not run.

## Revisions

Every result carries the input `revision`. Pass it as `expectedRevision` to commands, page-number previews and drafts. A `REVISION_CONFLICT` means the book changed: inspect or check again before editing. Commands need a unique `idempotencyKey`, so a retry of the same request after a lost reply returns the original result instead of applying the batch twice, also after ImageFlow restarts. After reopening a book, `list_book_checkpoints` with the key confirms whether a batch was committed and lists what changed since.
