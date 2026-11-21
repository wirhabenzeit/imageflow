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

Linked files refresh after external saves, so a photo you re-export from Lightroom to the same file shows its new version. If an original goes missing, its last preview (for a photo) or a cached copy (for a text or file) may remain visible with a warning. PDF export asks for confirmation when used originals are unavailable and marks affected pages. Copying linked files into the book requires the originals.

## Manage assets

**Book → Assets…** lists the book's photos, texts and files, with filters and availability badges.

- Click, Shift-click or Command-click to select. Command-A selects the current filter.
- Right-click or press Shift-F10 for actions. Space opens Quick Look, Return reveals files, and Delete removes assets with Undo.
- **Copy N Selected into Book** copies the selected linked files into the book. With nothing selected, the button reads **Copy All N into Book**.
- Missing files are checked again when the window opens or regains focus. **Locate…** finds one missing file; **Locate Folder…** finds every missing file in the folder you choose, whatever is selected, and approves access to them.
- **Import…** adds photos, Markdown and parameter files, and you can drop files from Finder onto the list. In the bottom panel's **Assets** tab, which lists only parameter files, it adds only those. Files other than photos and Markdown import only when a file parameter of the template accepts their type, such as `.gpx`; other files are skipped. New files follow **Copy Assets into Book**. A file the book already holds, linked or copied, found by its path or by its contents, is not added again; the status bar says how many were already in the book. **Edit → Undo** removes what an import added.
- Removing a parameter file that is still assigned asks first and names where it is used. **Remove** clears those assignments and takes the file out of the book in one step; **Undo** restores the file and every assignment. Copied files stay in the package for Undo, and removing a link never touches the original.

## Save a copy

**File → Duplicate…** creates a copy. **Include all files**, checked by default, copies linked files into it for portability. Uncheck it to preserve links. Missing originals are reported.

## Edit files externally

ImageFlow reloads photos, Markdown and template files after changes on disk. **Open in Editor** in the text Inspector opens a Markdown source in your default editor. External file edits are separate from the book's Undo history.
