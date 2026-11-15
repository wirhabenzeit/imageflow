# Compatibility checks

These checks show when a change affects books, templates or agents that already exist. **Nothing here is frozen yet.**
Contract 1 and the book format stay open until the first public release (ADR 0008, #77). Until then the checks make
changes visible. They don't stop design changes.

## Compatibility books

`books/` holds one book per built-in starter, made by `node scripts/compat-books.mjs --write` from the starter's
complete sample book: the sample's content (which File › New no longer copies into new books), its own copy of the
template, and that template's hash in `project.json`. They are kept apart from `sample/`, which keeps evolving. The photos and template files are byte-identical
to the samples', so git stores them only once.

- `tests/compat-books.test.ts` (unit tests, every CI run): each book opens with the current schema, resolves every
  source, bundles its own template copy with the recorded hash, and is not changed by opening. A book with a newer
  `schemaVersion` is refused with a request to update ImageFlow and left unchanged.
- `scripts/smoke-compat-books.mjs` (desktop smoke suite): each book renders without errors or warnings, keeps the
  format, page count and trim size in `expected.json`, exports a print PDF with one trimmed page per book page, and no
  file changes. It also opens a newer-format book in the app and checks the update message.

If one of these fails, the app no longer opens an existing book the way it did. Fix the app. Recreating the books
hides the break from every book people have already made.

Until the release, recreate the books when a starter changes in a way you want covered, and update `expected.json`
in the same commit. At the release, recreate them a final time from the release commit. From then on they don't change.

## Compatibility surface

`api-snapshot.json` records the surfaces existing books, templates and agents depend on. Help text and doc comments are
left out:

- **Book format:** `schemaVersion` and the JSON Schemas of `project.json` and `photos.json`.
- **Template API:** the `imageflow` runtime exports, `contract1Capabilities`, `capabilities`, and every declaration in
  the shipped `authoring/*.d.ts` files.
- **MCP tools:** each tool's read-only flag and its argument and result schemas.

`npm run compat:report` compares the current code with the snapshot. CI runs it after the unit tests. When something
differs, CI lists what was removed, changed or added as a warning and in the job summary. It never fails the build.
When the change is intended, run `npm run compat:snapshot` and commit the updated `api-snapshot.json` with it, so the
pull request diff shows the API change.

Removed or changed entries are the ones that can break existing books, templates or agents. Added entries are usually
safe extensions.
