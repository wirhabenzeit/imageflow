# ImageFlow

ImageFlow is a macOS photobook editor. Its draft starter project is a 28-page WhiteWall Gallery Square book with sample photos, Markdown, and a template you can edit.

## Run locally

Use Node.js 22.20+ or 24.12+ on macOS.

```sh
npm ci
npm run dev
```

`npm run dev` starts a Vite dev server and opens the app with hot reloading. Changes to editor and render CSS apply in place, React components refresh without losing the open project, and main-process changes restart Electron and reopen the project. Template, Markdown, and photo changes in the project folder reload as before. `npm start` runs the production build instead.

- Choose **New project…** to create an editable copy of the starter book. **Try the Senja sample** opens a read-only two-page proof example.
- Add, duplicate, reorder, or delete spreads from the left panel. Select a layout and edit its settings in the Inspector. Changes save to the project folder. Use **Undo** and **Redo** for edits made during the session.
- Import JPEG, PNG, and WebP photos with the File menu, or drop them onto the photo strip or a photo box. Drag photos from the strip onto photo boxes. Double-click a placed photo, or choose **Adjust crop…** in the Inspector, to pan and zoom it inside its frame; the crop toolbar shows the resulting print resolution against the template’s minimum and target. Enter or **Done** saves the crop as one undoable edit, Escape cancels. Photo metadata is edited in the photo’s own Inspector.
- Drop a Markdown file onto a text box or assign an imported source in the Inspector. Assigning the same source to several boxes continues the text through the book. Edit the Markdown in your own editor. ImageFlow reloads changes to text, photos, and templates.
- The **Book check** in the inspector lists errors and warnings for the whole book, with links to the affected spreads. It updates after every change.
- **Export proof PDF** saves the current layout for review. **Export print PDF** checks the whole book against the template’s print format before saving, and downsamples photos to the format’s maximum resolution. Preflight reports page count, photo resolution, missing content, unplaced text, and PDF resource issues. The starter uses 290 × 290 mm trim and 3 mm outside, top, and bottom bleed.

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

The canvas scrolls through the whole book; the left sidebar contains spread thumbnails and expandable **Book settings**. The bottom **Photos / Texts** strip selects source content for the Inspector. Space, or double-clicking a text box, opens Quick Look; double-clicking a photo opens crop mode. Click template-marked text or a parameterized box/element to edit it in a popover. Elements with their own editor, such as the starter's calendar (month and marked days), open it on double-click or from their popover; Done saves the session as one undoable edit. Typed popover values commit on Enter or an outside click; Escape discards uncommitted typing. Choices apply immediately. Layout thumbnails illustrate composition; Markdown starts at the beginning in these previews.
