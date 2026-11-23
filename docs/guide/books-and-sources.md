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

**Assets → Copy Assets into Book** controls new imports for this book. Checked (the default), it copies photos, Markdown and parameter files into the package. Uncheck it to link to original files instead. Existing assets keep their storage. A chain symbol marks linked files.

Linked files refresh after external saves, so a photo you re-export from Lightroom to the same file shows its new version. If an original goes missing, its last preview (for a photo) or a cached copy (for a text or file) may remain visible with a warning. PDF export asks for confirmation when used originals are unavailable and marks affected pages. Copying linked files into the book requires the originals.

## Manage assets

**Assets → Manage Assets…** lists the book's photos, texts and files, with filters and availability badges.

- Click, Shift-click or Command-click to select. Command-A selects the current filter.
- Right-click or press Shift-F10 for actions. Space opens Quick Look, Return reveals files, and Delete removes assets with Undo.
- **Copy N Selected into Book** copies the selected linked files into the book. With nothing selected, the button reads **Copy All N into Book**.
- Missing files are checked again when the window opens or regains focus. **Locate…** finds one missing file; **Locate Folder…** finds every missing file in the folder you choose, whatever is selected, and approves access to them.
- **Import…** adds photos, Markdown and parameter files, and you can drop files from Finder onto the list. In the bottom panel's **Assets** tab, which lists only parameter files, it adds only those. Files other than photos and Markdown import only when a file parameter of the template accepts their type, such as `.gpx`; other files are skipped. New files follow **Copy Assets into Book**. A file the book already holds, linked or copied, found by its path or by its contents, is not added again; the status bar says how many were already in the book. **Edit → Undo** removes what an import added.
- Removing a parameter file that is still assigned asks first and names where it is used. **Remove** clears those assignments and takes the file out of the book in one step; **Undo** restores the file and every assignment. Copied files stay in the package for Undo, and removing a link never touches the original.

## Photos from Lightroom Classic

ImageFlow can lay out photos straight from a Lightroom Classic catalog without exporting them first. It shows a 1400-pixel preview that Lightroom renders, and lays the photo out at its full size after Lightroom's crop, so resolution checks stay right. When you edit a photo in Lightroom, its preview in ImageFlow refreshes within a few seconds; a change of title, caption or rating updates what the book shows without rendering again.

**Install the plugin once.** In **Settings → Sources**, choose **Install Plugin** on the Lightroom Classic card. ImageFlow copies its plugin into Lightroom's Modules folder (`~/Library/Application Support/Adobe/Lightroom/Modules`). Quit and reopen Lightroom Classic if it is running. If **File → Plug-in Manager** in Lightroom lists ImageFlow as disabled, enable it there. Settings says when a newer plugin comes with an ImageFlow update; choose **Update Plugin** and reopen Lightroom.

**Add photos**, either way:

- In Lightroom, select photos and choose **File → Plug-in Extras → Send to ImageFlow** (also in **Library → Plug-in Extras**). They go into the book in front in ImageFlow; if no book is open, ImageFlow asks for one.
- In ImageFlow, choose **Assets → Import Selected from Lightroom Classic…**. It says how many photos are selected in Lightroom and adds them once you confirm. The status bar counts the previews while Lightroom renders them.

Videos are left out. A photo the book holds already is not added again, and **Edit → Undo** removes what an import added. A Lightroom photo takes its title, caption and credit (Lightroom's copyright, else its creator) from Lightroom; whatever you type in the Inspector wins, and **Revert** goes back to Lightroom's. ImageFlow never writes into the catalog.

**When Lightroom is not running**, or another catalog is open, the photos show as **Offline** and are drawn from their last preview. Choose **Open Lightroom Classic** in the asset's menu or at the bottom of **Assets → Manage Assets…**; the photos come back once the plugin connects. A photo removed from the catalog shows as missing.

**Export.** In this version a PDF export uses the previews of Lightroom photos, marks those pages ORIGINAL UNAVAILABLE and asks you to confirm a proof. Full-resolution renders from Lightroom at export time, and **Copy into Book** for these photos, follow in a later version. Until then, export the photos from Lightroom to files and import those for print.

The plugin and ImageFlow talk only on this Mac: ImageFlow listens on the loopback address with a key that only your user account can read, and nothing else on the network reaches it.

## Save a copy

**File → Duplicate…** creates a copy. **Include all files**, checked by default, copies linked files into it for portability. Uncheck it to preserve links. Missing originals are reported.

## Edit files externally

ImageFlow reloads photos, Markdown and template files after changes on disk. **Open in Editor** in the text Inspector opens a Markdown source in your default editor. External file edits are separate from the book's Undo history.

## Sync between Macs

A book can sync through a folder your Macs share, such as one in iCloud Drive or Dropbox, a Syncthing folder or a network drive. Don't put the book itself in that folder: each Mac keeps its own copy of the book, and the shared folder holds ImageFlow's sync records, which never change once they are written.

- **File → Sync → Sync with Folder…** links the open book to a folder and syncs it. Choose the same folder on every Mac.
- **File → Open from Sync Folder…** makes a new book on this Mac from a book another Mac synced. It is not trusted yet, so it asks before its template reaches any website.
- **File → Sync → Sync Now**, or a click on the sync status in the status bar, sends this Mac's changes and takes the other Mac's. The status shows whether the book is in sync, has changes to sync or fetch, changed on two Macs, or is waiting for the folder to catch up.
- When a book changed on both Macs, sync keeps this Mac's version as a separate copy beside the book ("Conflict" and the date in its name) and continues with the version in the folder. If the folder has several versions, you choose one to continue with.
- Photos copied into the book on another Mac arrive as previews first. Their originals download in the background after **File → Open from Sync Folder…** and after each sync, with progress and Cancel in the status bar; the book stays usable meanwhile, and Book check says "Original not downloaded yet" until they arrive. To keep only previews on this Mac, turn off **Settings → General → Keep originals of synced books on this Mac**; **File → Sync → Download Originals** then fetches them when you need them, for example to print. Linked photos stay where each Mac keeps them; use **Locate Folder…** on each Mac.
- If a sync stops partway through, for example because the disk is full, the book stays openable and the status says why. The next sync continues with the folder's version, and keeps this Mac's version as a copy only if you edited the book since.
