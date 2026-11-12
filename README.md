# ImageFlow

ImageFlow is a macOS photobook editor. Its draft starter project is a 28-page WhiteWall Gallery Square book with sample photos, Markdown, and a template you can edit.

## Run locally

Use Node.js 22.20+ or 24.12+ on macOS.

```sh
npm ci
npm run dev
```

`npm run dev` starts a Vite dev server and opens the app with hot reloading. Changes to editor and render CSS apply in place, React components refresh without losing the open project, and main-process changes restart Electron and reopen the project. Template, Markdown, and photo changes in the project folder reload as before. Each run opens a fresh copy of the starter book in a temporary folder, and a new copy whenever `sample/starter` changes, so you always try the current starter; edits to that copy are thrown away with it. `npm run dev -- --last` reopens the project that was open last (for example a real book) instead. `npm start` runs the production build instead.

- Launching without a book opens the compact start window with recent books, **New Book…**, **Open…**, and **Explore a Sample**. New Book uses the shared starter picker, then asks for the document’s name and location. The current catalogue contains the photobook starter; #27 adds the calendar starter.
- Books are macOS document packages such as **Senja.imageflow**. Finder shows each as one document; double-click it to open. Every book opens in its own window. Reopening the same book focuses its existing window, while a Finder duplicate opens independently. Closing the last book returns to the start window; **ImageFlow → Show Start Window** brings it back at any time.
- The package contains all originals, text, template code, fonts, and file inputs. Move, duplicate, or back it up as one item. **File → Reveal in Finder**, **Book → Open Template Folder**, and **Edit Text Source…** in the text Inspector, keep external editing convenient. Templates are copied into each new book; changes to a starter never change an existing book.
- This is a clean-slate document format: the app opens `.imageflow` packages, with no legacy project-folder conversion. Book settings → **New imports** sets Copy into Book (default) or Link to Original Files for photos, Markdown and parameter files. Existing sources keep their storage; individual imports may override the default. **Book → Manage Sources…** provides status, Locate/Replace, Retry, Copy into Book, and **Include All Assets**. Linked files refresh after external saves; missing originals retain a clearly marked cached view.
- Add, duplicate, reorder, or delete spreads from the left panel. Drag a thumbnail to the insertion line to reorder; hold near the list's top or bottom to scroll. The move buttons, or ⌥⌘↑ / ⌥⌘↓ on a focused thumbnail, move one position at a time. Single-page book ends stay in place. Each move is one undoable edit. Select a layout and edit its settings in the Inspector. **On this spread** comes first; **Saved outside this layout** follows, collapsed by default, and remembers its expanded state during the session. Item controls float at the bottom center of the visible canvas, staying in place as you scroll. Custom component editors share this position, with a scrolling body and Cancel/Done kept visible. The selected item stays outlined on the page. Click a box or element, or pick it from the Inspector's **On this spread** list. Changes save to the project folder. Use **Undo** and **Redo** for edits made during the session.
- Import JPEG, PNG, and WebP photos with the Book menu or the Sources strip’s **Import** menu, or drop them onto the photo strip or a photo box. Drag photos from the strip onto photo boxes. Click a placed photo (or its entry in the Inspector's list) to select it: then drag it to move it inside its frame and pinch (or ctrl-scroll) or use the toolbar slider to zoom. Each gesture saves itself as one undoable edit; the toolbar also shows the resulting print resolution against the template’s minimum and target, a **More photo actions** cog menu for **Replace photo…**, **Remove photo**, and **Crop values…**, and the box's own options such as **Show caption**. An empty photo box opens an editor with **Choose photo…**. Escape, **Done** or a click elsewhere deselects. Dragging a photo that is not selected moves it onto another photo box, on any spread; the two swap. Photo metadata is edited in the photo’s own Inspector.
- Drop a Markdown file onto a text box, or click the box to assign an imported source or import one. Assigning the same source to several boxes continues the text through the book. Edit the Markdown in your own editor. ImageFlow reloads changes to text, photos, and templates.
- The **Book check** checks the whole book after every change. A labelled indicator at the right of the status bar shows errors and warnings, or **Book check: no issues**; click it to list them, with links to the affected spreads.
- **File → Save a Copy…** offers **Include all assets**, checked by default, to make a portable copy containing photos, Markdown and parameter files. Unchecked preserves links. Collection reports missing originals; autosave preserves current links.
- **Export proof PDF** saves the current layout for review. **Export print PDF** checks the whole book against the template’s print format before saving, and downsamples photos to the format’s maximum resolution. Preflight reports page count, photo resolution, missing content, unplaced text, and PDF resource issues. The starter offers a 290 × 290 mm square and a 320 × 240 mm landscape format (Book settings → Format), both with 3 mm outside, top, and bottom bleed.

| File or folder | Contents |
| --- | --- |
| `project.json` | Book title, spread order, assignments, crops, parameter values, and Markdown paths |
| `photos.json` | Stable photo IDs, relative copied paths or explicit linked locations, titles, captions, credits, and alt text |
| `photos/` | Original photos |
| `texts/` | Editable Markdown sources |
| `template/` | Project-owned TSX layout code, CSS, fonts, and assets |
| `files/` | Document-owned template file inputs, such as GPX tracks |
| `.imageflow/` | Writer ownership and recoverable save journals; do not delete pending recovery data |

Generated photo renditions and validated source snapshots live in app-owned caches outside the package. Snapshot caching uses APFS clones where possible. Original availability is tracked separately from cached views; only available originals satisfy print and collection. Proofs using unavailable sources require confirmation and carry a visible warning on affected pages. Recent-book metadata and small cover previews live in the app’s data folder, separate from book contents.

Open books you trust. Their templates run as code in the renderer. To test template changes, open a book and edit `template/index.tsx` or `template/styles.css`. Invalid templates show an error in the editor. The starter template ships `template/types/` and a `tsconfig.json`, so code editors type-check templates without installing packages; declare spreads with `spreadFor(documentParameters)` to get typed `params`, `boxes`, and `document` in `render`.

The starter's four sample photos are placeholders upscaled from 768 px originals. They pass the resolution check but will print soft; replace them before ordering a proof.

## Build and test

```sh
npm run package:mac
npm run test:desktop
```

The ad-hoc-signed app appears in `out/ImageFlow-darwin-arm64/ImageFlow.app` on Apple Silicon or `out/ImageFlow-darwin-x64/ImageFlow.app` on Intel. `npm run test:packaged` also checks the packaged document declaration, icon, real Finder open events, and packaged proof/print workflows. The desktop checks require Poppler and exercise PDF geometry, line breaks, preflight, imports, autosave, live reload, and randomized Markdown continuation.

The draft exports single-page or spread PDFs. The starter book targets the WhiteWall photo-paper format. Printer upload and a physical proof are separate validation steps.

[v1 implementation plan](docs/v1-implementation-plan.md) · [Template API and compatibility](docs/template-api.md) · [Historical design proposal](docs/content-template-contract.md)

[Authoring feedback foundations](docs/authoring-foundations.md) describes the internal revision-checked book checks and page artwork capture being prepared for MCP, including the current limits.

**ImageFlow → Settings…** (⌘,) opens a separate window with native macOS controls. You can keep it open while working on a book; choosing Settings again brings the same window forward. Settings and agent connections belong to the app; undo/redo, save state, revisions, source watchers, checks and export jobs belong to each book. Agent requests explicitly select an authorized book handle and never follow window focus. Closing one book keeps the others and the agent connection intact.

Appearance offers **Light**, **Dark**, and **System** (the default); changes apply immediately in both windows and are remembered on this computer, independently of the book. System follows macOS, including changes while the app is open. Custom template editor dialogs follow the app appearance using the host's theme colors, as demonstrated by the starter calendar and route editors. Book artwork, thumbnails and proof/print output retain their authored paper, photo and text colors.

On macOS the toolbar shares a title bar with the native window controls. The toolbar shows the project name, local save state, Undo/Redo, and **Export…** (Print or Proof). Book check is labeled in the bottom status bar; errors disable Print while Proof remains available. New and Open are in File (⌘N / ⌘O). The Book menu contains imports, source management, spread actions, Format, Book Settings, Book Check, Open Template Folder, and Reload Book (⌘R). Add a spread with ⇧⌘N, duplicate with ⌘D, move with ⌥⌘↑/↓, and delete with ⌘⌫; spread shortcuts are disabled while editing a field or using another editor.

Sidebars slide open and closed (or switch immediately with Reduce Motion enabled). Toggle either sidebar with the toolbar buttons or **View → Show/Hide Sidebar / Show/Hide Inspector** (⌥⌘1 / ⌥⌘2). Drag the inner dividers to resize; focus a divider and use Left/Right to adjust it by 10 pixels. Double-click or press Home to restore its default width. The Sources panel also has a draggable horizontal divider: Up/Down adjusts its height, Home or a double-click resets it. Taller Sources panels show more rows of fixed-size tiles and scroll vertically. Toggle Sources from the View menu (⌥⌘3). Panel sizes and visibility are remembered on this computer, separately from the project. Selecting artwork leaves a hidden Inspector closed. The canvas, thumbnails and layout previews refit to the available width.

The canvas shows the book as one **Vertical** column of spreads, or as a **Grid** with 1–4 columns. The grid follows book order left to right across each row and scrolls vertically. Choose the layout under **View → Vertical / Grid / Grid Columns** and toggle guides with **View → Show Guides**. Spreads scale to fit their share of the canvas width, and selecting a spread in the sidebar scrolls it into view. Editing works the same in both layouts. Each book remembers its layout on this computer.

The canvas scrolls through the whole book; the left sidebar contains spread thumbnails and expandable **Book settings**. The bottom **Photos / Texts** strip selects source content for the Inspector. Space, or double-clicking a text box, opens Quick Look. Clicking selects what is drawn on top: a photo is selected for dragging and pinching, an element with its own editor, such as the starter's calendar (month and marked days) or route map (Frame route), opens it, and template-marked text or a parameterized box/element opens a popover. Every parameter is also in the Inspector, which a click scrolls to. Done in an element editor saves the session as one undoable edit. Typed popover values commit on Enter or an outside click; Escape discards uncommitted typing. Choices apply immediately. Layout thumbnails illustrate composition; Markdown starts at the beginning in these previews.

Open **ImageFlow → Agent Connections…** to configure the [MCP connection](docs/mcp.md) for local agents.

When agent connections are enabled, **Agent · N** in the footer shows the number of connected clients. Click it to inspect or disable the connection.

[Linked source ownership and Save a Copy](docs/decisions/0005-linked-sources.md) describes persisted references, refresh/relinking, source snapshots, and collection semantics.
