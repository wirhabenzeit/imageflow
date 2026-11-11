# ImageFlow

ImageFlow is a macOS photobook editor. Its draft starter project is a 28-page WhiteWall Gallery Square book with sample photos, Markdown, and a template you can edit.

## Run locally

Use Node.js 22.20+ or 24.12+ on macOS.

```sh
npm ci
npm run dev
```

`npm run dev` starts a Vite dev server and opens the app with hot reloading. Changes to editor and render CSS apply in place, React components refresh without losing the open project, and main-process changes restart Electron and reopen the project. Template, Markdown, and photo changes in the project folder reload as before. Each run opens a fresh copy of the starter book in a temporary folder, and a new copy whenever `sample/starter` changes, so you always try the current starter; edits to that copy are thrown away with it. `npm run dev -- --last` reopens the project that was open last (for example a real book) instead. `npm start` runs the production build instead.

- Choose **New project…** to create an editable copy of the starter book. **Try the Senja sample** opens a read-only two-page proof example.
- Add, duplicate, reorder, or delete spreads from the left panel. Select a layout and edit its settings in the Inspector. Changes save to the project folder. Use **Undo** and **Redo** for edits made during the session.
- Import JPEG, PNG, and WebP photos with the File menu or the Sources strip’s **Import** menu, or drop them onto the photo strip or a photo box. Drag photos from the strip onto photo boxes. Click a placed photo to select it, or choose **Adjust crop…** in the Inspector: then drag it to move it inside its frame and pinch (or ctrl-scroll) or use the toolbar slider to zoom. Each gesture saves itself as one undoable edit; the toolbar also shows the resulting print resolution against the template’s minimum and target, and the box's own options such as **Show caption**. Escape, **Done** or a click elsewhere deselects. Dragging a photo that is not selected moves it onto another photo box, on any spread; the two swap. Photo metadata is edited in the photo’s own Inspector.
- Drop a Markdown file onto a text box or assign an imported source in the Inspector. Assigning the same source to several boxes continues the text through the book. Edit the Markdown in your own editor. ImageFlow reloads changes to text, photos, and templates.
- The **Book check** checks the whole book after every change. A labelled indicator at the right of the status bar shows errors and warnings, or **Book check: no issues**; click it to list them, with links to the affected spreads.
- **Export proof PDF** saves the current layout for review. **Export print PDF** checks the whole book against the template’s print format before saving, and downsamples photos to the format’s maximum resolution. Preflight reports page count, photo resolution, missing content, unplaced text, and PDF resource issues. The starter offers a 290 × 290 mm square and a 320 × 240 mm landscape format (Book settings → Format), both with 3 mm outside, top, and bottom bleed.

| File or folder | Contents |
| --- | --- |
| `project.json` | Book title, spread order, assignments, crops, parameter values, and Markdown paths |
| `photos.json` | Photo IDs, paths, titles, captions, credits, and alt text |
| `photos/` | Original photos |
| `texts/` | Editable Markdown sources |
| `template/` | Project-owned TSX layout code, CSS, fonts, and assets |
| `.imageflow/` | Disposable image cache with previews and colour-managed export copies |

Open projects you trust. Their templates run as code in the renderer. To test template changes, open a project folder and edit `template/index.tsx` or `template/styles.css`. Invalid templates show an error in the editor. The starter template ships `template/types/` and a `tsconfig.json`, so code editors type-check templates without installing packages; declare spreads with `spreadFor(documentParameters)` to get typed `params`, `boxes`, and `document` in `render`.

The starter's four sample photos are placeholders upscaled from 768 px originals. They pass the resolution check but will print soft; replace them before ordering a proof.

## Build and test

```sh
npm run package:mac
npm run test:desktop
```

The ad-hoc-signed app appears in `out/ImageFlow-darwin-arm64/ImageFlow.app` on Apple Silicon or `out/ImageFlow-darwin-x64/ImageFlow.app` on Intel. The desktop checks require Poppler and exercise PDF geometry, line breaks, preflight, imports, autosave, live reload, and randomized Markdown continuation.

The draft exports single-page or spread PDFs. The starter book targets the WhiteWall photo-paper format. Printer upload and a physical proof are separate validation steps.

[v1 implementation plan](docs/v1-implementation-plan.md) · [Template API and compatibility](docs/template-api.md) · [Historical design proposal](docs/content-template-contract.md)

[Authoring feedback foundations](docs/authoring-foundations.md) describes the internal revision-checked book checks and page artwork capture being prepared for MCP, including the current limits.

The editor and custom template editor dialogs follow the macOS Light/Dark appearance automatically, including changes while they are open. Custom editors use the host's theme colors, as demonstrated by the starter calendar and route editors. Book artwork, thumbnails and proof/print output retain their authored paper, photo and text colors.

On macOS the toolbar shares a title bar with the native window controls. The toolbar shows the project name, local save state, Undo/Redo, and **Export…** (Print or Proof). Book check is labeled in the bottom status bar; errors disable Print while Proof remains available. New, Open and Reload are in the File menu with ⌘N, ⌘O and ⌘R.

Sidebars slide open and closed (or switch immediately with Reduce Motion enabled). Toggle either sidebar with the toolbar buttons or **View → Show/Hide Sidebar / Show/Hide Inspector** (⌥⌘1 / ⌥⌘2). Drag the inner dividers to resize; focus a divider and use Left/Right to adjust it by 10 pixels. Double-click or press Home to restore its default width. Panel sizes and visibility are remembered on this computer, separately from the project. Selecting artwork leaves a hidden Inspector closed. The canvas, thumbnails and layout previews refit to the available width.

The canvas scrolls through the whole book; the left sidebar contains spread thumbnails and expandable **Book settings**. The bottom **Photos / Texts** strip selects source content for the Inspector. Space, or double-clicking a text box, opens Quick Look. Clicking selects what is drawn on top: a photo is selected for dragging and pinching, an element with its own editor, such as the starter's calendar (month and marked days) or route map (Frame route), opens it, and template-marked text or a parameterized box/element opens a popover. Every parameter is also in the Inspector, which a click scrolls to. Done in an element editor saves the session as one undoable edit. Typed popover values commit on Enter or an outside click; Escape discards uncommitted typing. Choices apply immediately. Layout thumbnails illustrate composition; Markdown starts at the beginning in these previews.

Open **ImageFlow → Agent Connections…** to configure the [MCP connection](docs/mcp.md) for local agents.

When agent connections are enabled, **Agent · N** in the footer shows the number of connected clients. Click it to inspect or disable the connection.
