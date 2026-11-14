# Books and sources

## Book documents

A book is a macOS document package such as **Senja.imageflow**. Double-click it in Finder to open it. Each book has its own window; reopening it brings that window forward.

Move, duplicate or back up the package as one item. **File → Show in Finder** reveals it. Each book has its own template copy, so library updates do not change existing books.

| File or folder | Contents |
| --- | --- |
| `project.json` | Title, spread order, assignments, crops, settings and Markdown paths |
| `photos.json` | Photo IDs, file locations, titles, captions, credits and alt text |
| `photos/` | Copied photos |
| `texts/` | Copied and newly created Markdown sources |
| `template/` | Layout code, CSS, fonts and assets |
| `files/` | Copied template inputs, such as GPX tracks |
| `.imageflow/` | Recovery data; do not delete it |

Changes save automatically. **Undo** and **Redo** cover edits made in ImageFlow during the current session. **File → Revert To → Last Opened** restores the book's saved state from when you opened it; the revert can be undone.

## Copy or link files

**Book → Copy Assets into Book** controls new imports for this book. Checked (the default), it copies photos, Markdown and parameter files into the package. Uncheck it to link to original files instead. Existing assets keep their storage. A chain symbol marks linked files.

Linked files refresh after external saves. If an original goes missing, a cached copy may remain visible with a warning. Print export and copying linked files into the book require the originals.

## Manage assets

**Book → Assets…** lists the book's photos, texts and files, with filters and availability badges.

- Click, Shift-click or Command-click to select. Command-A selects the current filter.
- Right-click or press Shift-F10 for actions. Space opens Quick Look, Return reveals files, and Delete removes assets with Undo.
- Copy linked selections into the book, or clear the selection to copy all linked assets.
- Missing files are checked again when the window opens or regains focus.

## Save a copy

**File → Duplicate…** creates a copy. **Include all files**, checked by default, copies linked files into it for portability. Uncheck it to preserve links. Missing originals are reported.

## Edit files externally

ImageFlow reloads photos, Markdown and template files after changes on disk. **Open in Editor** in the text Inspector opens a Markdown source in your default editor. External file edits are separate from the book's Undo history.
