# Follow-up to the 24–25 November 2026 beta session

The session tested ImageFlow 1.0.0-beta.23 (beta.22 for the first sync) on the Kyrgyzstan book, with 992 photos imported
from Lightroom Classic.

## Fixed

- **API-009, calls that time out while previews load**, and probably much of **UI-008, Lightroom's load after an import**.
  A check loaded the book read-only, which fetched missing previews as an export does: it waited for the whole background
  fetch, then asked Lightroom for the same previews again, from facts read before they came. Its call kept its place in
  the book's queue after it timed out. A check now asks for no previews and names placed photos that are still loading
  (`photo-preview-loading`); its abort ends the load. A call for topics or examples alone does not look at the book.
- **UI-005, UI-006.** The status bar counts previews as they come. Reloads for them no longer say that files changed.
- **API-007.** A check stands for the revision it names when only `project.json`, `photos.json` or photos from Lightroom
  changed while it rendered, and `superseded` names the revision now. Changed template files, texts and photo files still
  reject it, and are retried as before. Layout fixtures still need a book that is not saved meanwhile.
- **API-012, API-005.** Contact sheets draw pages at the spreads' scale. A draft of a document setting lists no spreads, and
  a fixture that passed is named by its layout, case and format alone.
- **API-010, API-011.** `replace_source` swaps a photo in every box, shown or set aside. `remove_sources` takes sources out
  of the book as Remove from Book does.
- Save a Copy and a sync's reload wait for no previews.
- **UI-011, UI-012.** The panel for small text is only its field. A book setting's Undo entry names the setting.

## To retest

- With Lightroom Classic and about 1,000 photos: `check_book` and `get_authoring_context` during the import, and
  Lightroom's CPU once the previews have come. The fixes were tested with the tests' stand-in for the plugin only.
- **API-009 in beta.22** (`list_projects`) is probably another cause: that version held the book during the whole upload
  of a sync, and agent calls wait while a book is held. #302 (beta.23) uploads before it holds the book.
- **UI-004.** Since #302 a sync uploads a few previews at once and shows how many of how many.
- **From #269**, in beta.21 and later: UI-001, UI-002, UI-003, API-002, API-003, API-006 and API-008.

## Open

- UI-007 (Show in Lightroom) and the rest of UI-008, with Lightroom.
- UI-009 (what takes up sync storage) and UI-010 (files an undone import leaves), next: a breakdown per book, and a list of
  unused files in Assets to move to the Trash.
- API-013, which needs a design.
- Every preview that comes moves the book's revision, so a commit during an import can still meet `REVISION_CONFLICT`.
- A book opened read-only still waits for missing previews.
