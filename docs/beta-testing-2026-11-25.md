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
- **UI-007.** Show in Lightroom Classic, in the menu of an asset and of a placed photo, selects the photos in Lightroom. It
  stays in Develop when Lightroom is there. It needs plugin 1.2.0, and was tried with Lightroom by hand.
- **UI-009.** The tooltip of a book's size in the Sync window says what it is by kind, how much is no longer used, and from
  when Clean Up can free it.
- **UI-010.** The Assets window lists copied files that neither the book nor this session's Undo needs, and moves them to the
  Trash when asked.
- **UI-011, UI-012.** The panel for small text is only its field. A book setting's Undo entry names the setting.

## Second session of 25 November

- **API-014.** Originals that are elsewhere, such as those of a closed Lightroom catalog, are a warning with the first three
  places and their number. `include: ["occurrences"]` of `check_book` lists all.
- **API-022.** `render.photoResolution` says how many photos were measured, how many not, and which prints at the fewest ppi.
  Photos drawn from previews were always measured by their originals' size. A placed photo whose preview is loading was
  reported as missing and is not any more.
- **API-016, API-017, API-018, API-023.** `import_sources` has top-level parameters; `LAYOUT_NOT_FOUND` names likely layouts;
  an insert without `after` goes before a closing page; a target may be the start of a spread ID and is looked up first.
- **UI-013.** A conflict copy is named by this Mac's time. Telling the user and comparing the two is #321.

## Evening session of 25 November (beta.24)

Its register numbered again from UI-013 and API-014, so its IDs are marked *evening* here.

- **UI-016 evening.** A photo or text that a layout change set aside is not counted as used: no check mark in the Photos strip,
  listed under Unused, "Not placed" in the Inspector, with "Set aside on page 39" as a link and in the asset menu's places.
  Remove from Book still clears it everywhere.
- **UI-015 evening.** A segmented choice that is wider than its place, a layout family's picker, `<Choice>` or a setting
  with up to four options, is drawn as a menu, measured rather than counted. The Inspector no longer scrolls sideways.
- **UI-014 evening.** A placed photo's caption is edited where the photo is: **Caption…** in the selected photo's toolbar,
  **Edit Caption…** in its context menu on the page and in the Inspector's list, and a field in the box's popover and the
  cover's Inspector. A box parameter declared `p.boolean({ shows: 'caption' })` is switched on by a photo's first caption;
  the starter 0.13.3 declares it for Show caption.
- **UI-013 evening.** A HEIC photo is named in the import notice and in `import_sources`' error, with the ways around it.
  Import itself is #328.
- **API-015 evening.** A sync pull's history entry says how many spreads it added, removed and changed, and names the
  template, text and other files it wrote, also when it changed only those. It cannot name the Mac the version came from,
  and the template's earlier contents are not kept (#316).
- **API-014 evening.** `list_book_checkpoints` counts an agent entry's changes and spreads; `include: ["changes"]` or an
  `idempotencyKey` returns the lists.
- **API-016 evening.** The preview target table lists `{spread, picker: true}` and cover targets.
- **API-018 evening, #232.** The bridge names its version to the app. `list_projects` and `get_authoring_context` say when
  the connection was started by another version, and arguments that arrive empty are answered with what that means.
  Whether a client then starts a new conversation is the client's.
- **API-005 evening.** Fixture findings that differ between formats only in what was measured are listed once.
- **UI-012.** New Spread and Duplicate Spread, and crop values typed in, have names in Undo and the history.
- **API-017 evening** is #329, beside #319. Apple Photos as a source is #327.

## To retest

- **UI-007**, the rarer cases with Lightroom: a filter or a collapsed stack that hides the photo, and several photos.
- With Lightroom Classic and about 1,000 photos: `check_book` and `get_authoring_context` during the import, and
  Lightroom's CPU once the previews have come. The fixes were tested with the tests' stand-in for the plugin only.
- **API-009 in beta.22** (`list_projects`) is probably another cause: that version held the book during the whole upload
  of a sync, and agent calls wait while a book is held. #302 (beta.23) uploads before it holds the book.
- **UI-004.** Since #302 a sync uploads a few previews at once and shows how many of how many.
- **From #269**, in beta.21 and later: UI-001, UI-002, UI-003, API-002, API-003, API-006 and API-008.

## Open

- The rest of UI-008, with Lightroom.
- API-013 (#316), which needs a design.
- Every preview that comes moves the book's revision, so a commit during an import can still meet `REVISION_CONFLICT`.
- A book opened read-only still waits for missing previews.
- API-015 (a contact sheet of photos that are not placed) and API-021 (parameter values in fixtures), next.
- API-019 (#319), API-020 (#320) and UI-013 (#321), which need decisions.
