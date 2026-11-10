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
- Import JPEG, PNG, and WebP photos with the File menu, or drop them onto the photo strip or a photo box. Assign photos from the strip or Inspector. The Inspector also exposes crop controls and photo metadata.
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

[v1 implementation plan](https://github.com/wirhabenzeit/imageflow/blob/docs/content-template-contract/docs/v1-implementation-plan.md) · [Template API](https://github.com/wirhabenzeit/imageflow/blob/docs/content-template-contract/docs/template-api.md)
