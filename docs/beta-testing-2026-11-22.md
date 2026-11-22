# Follow-up to the 22 November 2026 beta session

The session tested ImageFlow 1.0.0-beta.20 on the Kyrgyzstan book with an agent and the user editing at once. It
recorded eight MCP and API findings and three app findings. This change addresses all eleven.

## MCP and API

- **API-007, calls failing while the user edits.** A check, inspection or context call whose inputs change while it
  runs is repeated up to four times, each after the book has been quiet for 400 ms. A failed attempt has saved nothing,
  so repeating it is safe. The call fails with `SOURCE_CHANGED` only when the book keeps changing for 30 s. The error
  then names the inputs the watcher saw change, in the message and in `details.changedInputs`. A dry run of
  `apply_project_changes`, or a draft check, against a revision that has since changed is planned at the current
  revision. Its reply carries `revisionMoved` and a `notice`. A commit still needs the exact revision, and so does a
  draft with a page-number preview, whose page may now show another spread.
- **API-005, 20 KB `check_book` replies.** `render.counts` counts the printed units, story flow entries and anchors.
  The lists are returned only for the previewed, inspected and drafted spreads. `include: ["units", "flow", "anchors"]`
  returns any of them for the whole book. `render.errors` and `render.warnings` repeated `diagnostics` and are left out.
- **API-001, 59 KB for two reference topics.** A `get_authoring_context` call with `docs`, `includeExamples` or
  `includeSource` returns only what it asks for, plus the revision, template identity and diagnostics.
  `includeTemplate: true` returns the full context as before. Like `template`, the output fields `templateFiles`,
  `topics` and `capabilities` are now optional.
- **API-002, built-in template source.** A new `read_library_template` tool lists a library template's files and
  reads one text file. With `project`, it marks each file `same`, `changed`, `library-only` or `book-only` against the
  book's `template/`. The starter now has a `CHANGELOG.md` covering 0.12.0 to 0.13.2.
- **API-008, pickers.** A `picker: true` preview target draws a layout family's picker, the app's choice or the
  template's component, for the saved variant or a given `current` one. `choose` clicks a control by its label. The
  metadata then reports the variant chosen, or a notice when the control is disabled or the choice is not a variant.
  Nothing is saved. The `smoke-mcp-picker` desktop test covers both picker kinds.
- **API-003, a fork that looks like an outdated starter.** Templates may declare `basedOn: { id, version }`, which
  joins the contract-1 baseline as `template-lineage`. A fork can then take an `id` of its own and still open in a book
  made from the original, because the ID check also accepts `basedOn.id`. `templateIdentity.current.basedOn` shows
  agents the template is a fork. The template library docs describe how to bring starter changes into a fork.
- **API-004, `matchesSavedHash: false`.** The saved hash records the library template the book was made from. Nothing
  updates it after the book is created, so the report's guess that saving the book updates it was wrong. A mismatch
  never affects rendering or export, and now comes with a `note` that says so. When the template keeps the original ID
  and has no `basedOn`, the note suggests forking properly.
- **API-006, page count reported as an error in a draft.** In a draft check, `page-sequence` is a warning that says a
  save would make it an error. The saved book's check still reports it as an error.
- **Undocumented revision behaviour.** The authoring workflow now says that template edits change the revision, how
  calls behave while the user edits, and what `revisionMoved` means.

## App

- **UI-001, cut-off layout names.** Layout tiles show their full name on hover; a family tile also names its current
  variant. The template docs recommend short labels: about 10 characters for a page tile and 22 for a spread tile.
- **UI-002, dragging stories between boxes.** A story box with its own text can be dragged onto another story box to
  swap the two texts, or onto an empty one to move it, as one Undo step. This reuses `swap_content`. Only the dragged
  box's assignment moves. The report suggested moving the whole story with its first box, but a story continues by
  being assigned to several boxes, so the other boxes keep it.
- **UI-003, Show in Assets.** The Inspector's "On this page" and "On this spread" rows now have a context menu with
  Quick Look and Show in Assets, like the canvas. Show in Assets selects the photo, and its details, caption included,
  appear in the Inspector. The starter's **Show caption** description now names this route, and the starter moved to
  0.13.2.

## Verification

- `npm run build` passes, and all unit tests pass.
- These desktop smoke tests pass: `smoke-mcp`, `smoke-mcp-pages`, `smoke-mcp-picker` (new), `smoke-cover`,
  `smoke-draft`, `smoke-text-swap` (new), `smoke-starter-pages`, `smoke-template-library`, `smoke-ui-details` and
  `smoke-asset-panel`.
- Not run: the full desktop suite and the smoke tests that need visible windows (`smoke-mcp-context`,
  `smoke-inline-editors`).
- No smoke test covers the Inspector's native context menu, and nobody has looked at the hover tooltip or the story
  drag chip in light and dark appearance.
- Still to retest in the app with a real concurrent session: whether checks now succeed while the user edits, as
  API-007 intends.

The session's open in-app checks were the Quote layout, the running head, the Photo grid picker, the shortened labels,
the Hero set caption switches and a PDF export. They concern the book's template, not this change.
