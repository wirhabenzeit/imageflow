# Senja Photobook Studio

An interactive prototype for editing a square photobook spread by spread. The starter book contains eight pages of sample text and generated Senja imagery.

## Try the editor

Open `dist/senja-preview.html` in a browser to use the standalone editor. Generate this file with `npm run build` if it is missing. Book edits are held in the current tab session.

- Select a spread in the Book panel. Add, duplicate, delete, or reorder spreads.
- Select a layout in the Inspector. Switching layouts retains the spread’s existing content.
- Use **Import folder** or **Add photos** in the Filmstrip to bring in JPEGs. Drag a photo onto a frame, or select the photo and then the frame. Checkmarks show which photos are used in the book, with a count for repeated placements.
- Click a text frame and type directly on the spread. The Inspector has five text styles and three alignments. Select a photo frame to import a JPEG up to 50 MB, then drag or use arrow keys to position its crop.
- Select **Preview** to review the book without editing controls.

## Run the editor with PDF export

Install Node.js 22.12 or newer and the macOS Xcode Command Line Tools (`xcode-select --install` if needed).

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), or the address printed by Vite. The local server exports the complete book using original JPEGs and the same frame positions, text line breaks, and image crops shown in the editor.

Each PDF page has an 846 × 846 pt trim area and 9 pt bleed on top, bottom, and outside. The prototype emits a standard Quartz PDF. PDF/X and printer color requirements need separate validation.

Run `npm run build` to type-check, bundle the app, and produce the standalone preview. Run `npm run preview` to serve the built app with the local export endpoint.
