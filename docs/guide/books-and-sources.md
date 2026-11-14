# Books and sources

## Books are documents

A book is a macOS document package such as **Senja.imageflow**. Finder shows it as one document; double-click it to open it. Every book opens in its own window. Opening a book that is already open brings its window forward, while a copy duplicated in Finder opens independently.

The package holds the book's originals, text, template code, fonts and file inputs, so you can move, duplicate or back it up as one item. **File → Show in Finder** reveals it. The template is copied into each new book when it is created, so changing a template in the library never changes an existing book.

| File or folder | Contents |
| --- | --- |
| `project.json` | Book title, spread order, assignments, crops, parameter values and Markdown paths |
| `photos.json` | Photo IDs, their files or linked locations, titles, captions, credits and alt text |
| `photos/` | Original photos |
| `texts/` | Editable Markdown sources |
| `template/` | The book's own copy of its template: layout code, CSS, fonts and assets |
| `files/` | Template file inputs, such as GPX tracks |
| `.imageflow/` | Save journals for recovery. Do not delete it |

Changes save automatically. **Undo** and **Redo** cover the edits of the current session, and **File → Revert To Last Opened** restores the book as it was when you opened it (and can itself be undone).

## Copy or link files

**Settings → General → New imports** chooses whether imported photos, Markdown and parameter files are copied into the book (the default) or linked to their original location. Every import follows this setting; files already in the book keep their storage. A chain symbol marks linked files.

Linked files refresh when they are saved elsewhere. When an original goes missing, the book keeps showing a marked cached copy, but print export and collection need the original back.

## Manage assets

**Book → Assets…** opens a window listing every photo, text and file in the book, with filters and badges for linked or unavailable files.

- Click, Shift-click or Command-click to select; Command-A selects everything in the current filter.
- Right-click (or Shift-F10) for actions on the selection. Space opens Quick Look, Return reveals the file, and Delete removes assets (with Undo).
- Linked files can be copied into the book, one by one or with **Copy All into Book**.
- Missing files are looked for again when the window opens or comes forward.

## Save a copy

**File → Duplicate…** makes a copy of the book. **Include all files**, on by default, copies linked photos, Markdown and parameter files into it, so the copy is portable. Without it, the copy keeps the links. Missing originals are reported.

## Edit text in your own editor

ImageFlow reloads photos, text and template files when they change on disk. **Open in Editor** in the text Inspector opens a Markdown source in your editor of choice.
