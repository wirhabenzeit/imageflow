# ImageFlow

ImageFlow is a macOS photobook editor. Its draft starter project is a 28-page WhiteWall Gallery Square book with sample photos, Markdown, and a template you can edit.

## Run locally

Use Node.js 22.20+ or 24.12+ on macOS.

```sh
npm ci
npm run dev
```

`npm run dev` starts a Vite dev server and opens the app with hot reloading. Changes to editor and render CSS apply in place, React components refresh without losing the open project, and main-process changes restart Electron and reopen the project. Template, Markdown, and photo changes in the project folder reload as before. Each run opens a fresh copy of the starter book in a temporary folder, and a new copy whenever `sample/starter` changes, so you always try the current starter; edits to that copy are thrown away with it. `npm run dev -- --last` reopens the project that was open last (for example a real book) instead. `npm run dev -- --starter calendar` opens a fresh copy of the calendar starter instead of the photobook. `npm start` runs the production build instead.

- Launching without a book opens the compact start window with recent books, **New Book…** and **Open…**. New Book shows the template library, then asks for the document’s name and location. The built-in Photobook and Wall calendar templates can include their sample photos, texts and spreads; other templates start with their opening spreads or empty.
- **Templates → Manage Templates…** opens a selectable library list with a fixed detail pane for formats, layouts, packages and network permissions. Opening-page previews are generated and cached automatically. Import folders or `.imageflow-template` files, export entries, or move imported entries to the Trash. Arrow keys select, Delete trashes an imported template, and dropping a template file imports it. The library keeps one entry per template ID; replacing it never changes existing books. `IMAGEFLOW_TEMPLATES` points the app at another library folder.
- Books are macOS document packages such as **Senja.imageflow**. Finder shows each as one document; double-click it to open. Every book opens in its own window. Reopening the same book focuses its existing window, while a Finder duplicate opens independently. Closing the last book returns to the start window; **Window → Welcome to ImageFlow** brings it back at any time.
- The package contains all originals, text, template code, fonts, and file inputs. Move, duplicate, or back it up as one item. **File → Show in Finder** and **Open in Editor** in the text Inspector, keep external editing convenient. Templates are copied into each new book; changes to a starter never change an existing book.
- **Settings → General → New imports** chooses Copy into Book (default) or Link to Original Files for photos, Markdown and parameter files. Every import control follows this app default. Existing files keep their storage. **Book → Assets…** opens a separate, filterable window with compact rows and status badges for linked or unavailable files. A chain symbol marks linked files. Click, Shift-click, or Command-click to select; Command-A selects the current filter. Right-click (or Shift+F10) acts on the selection. Space opens Quick Look, Return reveals files, and Delete removes assets with Undo. Linked selections can be copied into the book. Missing files retry when the window opens or gains focus. **Copy All into Book** appears when there are linked assets. Linked files refresh after external saves; missing originals retain a marked cached view.
- Add, duplicate, reorder, or delete spreads from the left panel. Drag a thumbnail to the insertion line to reorder; hold near the list's top or bottom to scroll. The move buttons, or ⌥⌘↑ / ⌥⌘↓ on a focused thumbnail, move one position at a time. Single-page book ends stay in place. Each move is one undoable edit. Select a layout and edit its settings in the Inspector. **On this spread** comes first; **Set aside** follows, collapsed by default, and remembers its expanded state during the session. Item controls float at the bottom center of the visible canvas, staying in place as you scroll. Custom component editors share this position, with a scrolling body and an × to close. The canvas remains scrollable while editing. The selected item stays outlined on the page. Click a box or element, or pick it from the Inspector's **On this spread** list. Changes save to the project folder. Use **Undo** and **Redo** for edits made during the session.
- Import JPEG, PNG, and WebP photos with File → Import or the Sources strip’s **Import** menu, or drop them onto the photo strip or a photo box. Drag photos from the strip onto photo boxes. Click a placed photo (or its entry in the Inspector's list) to select it: then drag it to move it inside its frame and pinch (or ctrl-scroll) or use the toolbar slider to zoom. Each gesture saves itself as one undoable edit; the toolbar also shows the resulting print resolution against the template’s minimum and target, a **More photo actions** cog menu for **Replace photo…**, **Remove photo**, and **Crop values…**, and the box's own options such as **Show caption**. An empty photo box opens an editor with **Choose photo…**. Escape, **Done** or a click elsewhere deselects. Dragging a photo that is not selected moves it onto another photo box, on any spread; the two swap. Photo metadata is edited in the photo’s own Inspector.
- Drop a Markdown file onto a text box, or click the box to assign an imported source or import one. Assigning the same source to several boxes continues the text through the book. Edit the Markdown in your own editor. ImageFlow reloads changes to text, photos, and templates.
- The **Book check** checks the whole book after every change. An icon at the right of the status bar shows progress and an issue count; click it to list findings, with links to the affected spreads.
- **File → Duplicate…** offers **Include all files**, checked by default, to make a portable copy containing photos, Markdown and parameter files. Unchecked preserves links. Collection reports missing originals; autosave preserves current links.
- **Export PDF…** saves the current layout for review. **Export for Print…** checks the whole book against the template’s print format before saving, and downsamples photos to the format’s maximum resolution. Preflight reports page count, photo resolution, missing content, unplaced text, and PDF resource issues. The starter offers a 290 × 290 mm square and a 320 × 240 mm landscape format (template settings → Format), both with 3 mm outside, top, and bottom bleed.

The **Wall calendar** starter (`sample/calendar`) is a landscape calendar without facing pages, in 45 × 30 cm (A3, 6835 × 4866 px) and 60 × 45 cm (A2, 9417 × 6677 px), both at 400 dpi with 31 px of bleed on each side: a cover, then one page per month. The cover is optional and any number of pages prints. Each page is a full-bleed photo with a dark strip on the right that holds the place, written down the strip, a thin rule, the month, and its days with two-letter weekdays; weekends are lighter. Book settings choose the **First month**, the language of month and day names, and the strip colour. **Marked days** are dates for the whole calendar, such as `25.12` every year or `2027-04-16` once, shown in their month whatever the page order. Clicking a month's days opens the day picker for that month: a click marks the date once, Option-click toggles a yearly mark, shown with a ring, and **All marked days** shows the full list as text. Months follow the page order, so adding, removing or moving month pages renumbers them. The cover has its own title and year text. A month's **Place** defaults to its photo's caption.

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

Set `APPLE_SIGNING_IDENTITY` to a Developer ID Application identity to sign with hardened runtime. `npm run package:mac:release` also notarizes and staples the app and DMG, verifies their tickets, and creates the update ZIP. [Mac signing and notarization](docs/signing.md) covers the credentials, GitHub Actions secret setup, artifact names and verification. `npm run test:packaged:existing` checks a release build without rebuilding it, including its MCP bridge.

To prepare a downloadable release, follow [Releasing ImageFlow](docs/releasing.md). Pushing a matching version tag creates signed Apple silicon ZIP and DMG assets in a draft GitHub Release for manual review and publishing.

For everyday pull requests, GitHub Actions runs `check` (build, app/template/API type checks, and unit tests on Linux) and `desktop` (two focused Apple silicon Mac smoke checks). `npm run test:desktop:smoke` checks app launch, book opening and rendering, proof PDF output, durable saves and orderly shutdown. It builds and stages the app but leaves unit tests to `check`.

The separate **Full desktop suite** workflow runs `npm run test:desktop` only when started manually from Actions, for example before a release. It covers documents, files, layouts, the template library, the calendar starter, linked sources, drafts and MCP. UI polish, animation and timing are checked by hand rather than by smoke scripts. Packaged-app checks belong to the release workflow.

Both workflows use Node.js 22 from the supported `engines.node` range, install Poppler for the PDF checks, cache npm and Electron downloads, and cancel older runs for the same ref. If the repository becomes private, the PR workflow's `desktop` job runs only on pushes to `main` to conserve macOS minutes.

Once both jobs have passed on GitHub, require the `check` and `desktop` status checks in the `main` branch protection rule or ruleset. Select the checks produced by this workflow, with GitHub Actions as their source. Revisit the required `desktop` check if the repository becomes private, since its PR job will then be skipped.

The draft exports single-page or spread PDFs. The starter book targets the WhiteWall photo-paper format. Printer upload and a physical proof are separate validation steps.

[v1 implementation plan](docs/v1-implementation-plan.md) · [Template API and compatibility](docs/template-api.md) · [Historical design proposal](docs/content-template-contract.md)

[Authoring feedback foundations](docs/authoring-foundations.md) describes the internal revision-checked book checks and page artwork capture being prepared for MCP, including the current limits.

**ImageFlow → Settings…** (⌘,) opens a separate window with native macOS controls. You can keep it open while working on a book; choosing Settings again brings the same window forward. Settings and agent connections belong to the app; undo/redo, save state, revisions, source watchers, checks and export jobs belong to each book. Agent requests explicitly select an authorized book handle and never follow window focus. Closing one book keeps the others and the agent connection intact.

Appearance offers **Light**, **Dark**, and **System** (the default); changes apply immediately in both windows and are remembered on this computer, independently of the book. System follows macOS, including changes while the app is open. Custom template editor dialogs follow the app appearance using the host's theme colors, as demonstrated by the starter calendar and route editors. Book artwork, thumbnails and proof/print output retain their authored paper, photo and text colors.

On macOS the toolbar shares a title bar with the native window controls. It shows the file name and draggable document icon, Undo/Redo, and Export. Command-click the title for its location. Book check uses a quiet status-bar icon with an issue count; errors disable Export for Print. File contains New/Open (⌘N / ⌘O), Import (⇧⌘I), Duplicate (⇧⌘S), Rename, Move To, Revert To Last Opened, Export PDF (⌘E) and Export for Print (⇧⌘E). Last Opened restores content and settings and can itself be undone. The Spread menu contains New (⇧⌘N), Duplicate (⌘D), Move (⌥⌘↑/↓) and Delete (⌫); editing a field protects its keyboard commands. Book contains Assets and Check Book. Format and template controls share one sidebar section. View adds Zoom and Full Screen. Text fields use native text Undo; the rest of the book shares its named Undo history.

Sidebars slide open and closed (or switch immediately with Reduce Motion enabled). Toggle either sidebar with the toolbar buttons or **View → Show/Hide Sidebar / Show/Hide Inspector** (⌃⌘S / ⌥⌘I). Drag the inner dividers to resize; focus a divider and use Left/Right to adjust it by 10 pixels. Double-click or press Home to restore its default width. The Sources panel also has a draggable horizontal divider: Up/Down adjusts its height, Home or a double-click resets it. Taller Sources panels show more rows of fixed-size tiles and scroll vertically. Toggle Sources from the View menu (⌥⌘3). Panel sizes and visibility are remembered on this computer, separately from the project. Selecting artwork leaves a hidden Inspector closed. The canvas, thumbnails and layout previews refit to the available width.

The canvas shows the book as one **Vertical** column of spreads, or as a **Grid** with 1–4 columns. The grid follows book order left to right across each row and scrolls vertically. Choose the layout under **View → Vertical / Grid / Columns** and toggle guides with **View → Show Guides**. Spreads scale to fit their share of the canvas width, and selecting a spread in the sidebar scrolls it into view. Editing works the same in both layouts. Each book remembers its layout on this computer.

The canvas scrolls through the whole book; the left sidebar contains spread thumbnails and expandable template settings. The bottom **Photos / Texts** strip selects source content for the Inspector. Space, or double-clicking a text box, opens Quick Look. Clicking selects what is drawn on top: a photo is selected for dragging and pinching, an element with its own editor, such as the starter's calendar (month and marked days) or route map (Frame route), opens it, and template-marked text or a parameterized box/element opens a popover. Every parameter is also in the Inspector, which a click scrolls to. Custom element controls apply changes as you edit; each change is undoable. Closing with × or clicking outside applies any text still being typed; Escape discards only uncommitted typing. Typed popover values commit on Enter or an outside click; Escape discards uncommitted typing. Choices apply immediately. Layout thumbnails illustrate composition; Markdown starts at the beginning in these previews.

Open **Settings → Agents** to configure the [MCP connection](docs/mcp.md) for local agents.

When agent connections are enabled, **Agent · N** in the footer shows the number of connected clients. Click it to inspect or disable the connection.

[Linked source ownership and Save a Copy](docs/decisions/0005-linked-sources.md) describes persisted references, refresh/relinking, source snapshots, and collection semantics.

Starter headings support on-page typing. Done or leaving the field applies pending text; Enter inserts a line in multiline headings and ⌘Enter applies. Escape or Discard drops pending typing. Use the Inspector’s text action for the parameter control.
