# Render function

`render(context)` is called per spread instance and must be a pure function of its input: no state, effects, timers, randomness, or data fetching. Rendering never changes the book's saved content. Work that loads declared external resources or finishes later, such as drawing a map, goes through [`<RenderedImage>`](rendered-images.md#rendered-images), which the host runs, waits for and checks.

Book check and export enforce the parts of this that would make a printed page depend on something outside the book. While they render, a call from template code (including bundled libraries and module setup) to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, `SharedWorker`, `importScripts`, a GPU canvas context (`webgl`, `webgl2`, `webgpu`, `bitmaprenderer`, on `HTMLCanvasElement` or `OffscreenCanvas`), `navigator.gpu`, `setTimeout`, `setInterval`, `requestAnimationFrame` or `requestIdleCallback` is a `render-impure` error naming the API and, when it happened while a layout rendered, its spread. PDF export reports such errors and asks for confirmation before saving. A 2D canvas is allowed. While a `<RenderedImage>` is drawing, these calls are its declared work and are not recorded. The editor's own previews and element editors are not checked, so an element editor may use these APIs (see [ADR 0006](https://github.com/wirhabenzeit/imageflow/blob/main/docs/decisions/0006-template-capabilities.md)). The check reports mistakes; it is not a sandbox, and the render frames' content security policy blocks other origins regardless.

```ts
type RenderContext = {
  params: SpreadParams;                     // this spread instance
  document: DocumentParams;
  boxes: Record<BoxId, {
    params: BoxParams;
    photo?: {                               // null for an empty box
      caption?: string; title?: string; credit?: string; altText?: string; width: number; height: number;
      captured?: { dateTime: string; offset: string | null };   // read from the file (see Photo metadata)
      location?: { latitude: number; longitude: number };
      camera?: { make?: string; model?: string };
    } | null;
    text?: { title?: string; part: number; parts: number } | null;  // flow position for Markdown boxes
  }>;
  elements: Record<ElementId, { params: ElementParams }>;
  page: { left?: number; right?: number; number?: number };  // page numbers: left/right, or number without facing pages
  format: ResolvedFormat;                   // trim, bleed, safe area in mm, for the chosen format
  formatId: string;                         // the chosen key of `formats`, or 'default'
  spread: string;                           // this spread's ID, its entry in book.spreads (the selected spread in a layout preview)
  layout: string;                           // the layout being drawn
  mode: 'edit' | 'export';                  // 'export' for export, Book check and MCP artwork
  view: 'canvas' | 'thumbnail' | 'layout-preview' | 'export';  // where this render is shown (see below)
  edit(...paths: EditPath[]): { 'data-edit'?: string };  // marks a node for click-to-edit
  geometry: BoundGeometry;                  // the geometry helpers with this format applied
  PhotoBox; MarkdownBox; Element;          // the platform components, typed to this layout's IDs
  Text;                                     // shows a string parameter and makes it editable
  book: {                                   // the whole book, as seen from this spread
    pages: number;
    anchor(id: string): Anchor | undefined; // the anchor with this ID (see Anchors)
    anchors(id?: string): Anchor[];         // all anchors with this ID, or all anchors, in page order
    spreads: BookSpread[];                  // every spread's pages and placed photos (see Book index)
  };
};
```

`mode` and `view` are fixed for the whole render. `mode` is `'edit'` for every render in the editor and `'export'` for PDF export, presentation, the Book check and MCP artwork (the Book check is `'export'` here, while `RenderedImage`'s own `mode` tells it apart as `'check'`). `view` says where an edit-mode render is shown: `'canvas'` is the interactive book, the only place anyone clicks; `'thumbnail'` is the sidebar and `'layout-preview'` the Inspector's layout previews, which show what the page will look like. `view === 'export'` exactly when `mode === 'export'`. Later versions may add views, so test only `view === 'canvas'` and never treat the list as complete. Show editing scaffolding, such as a placeholder that invites a click, only on the canvas:

```tsx
{!chapters.length && ctx.view === 'canvas' && <p className="hint">Story spreads appear here.</p>}
```

ImageFlow's own placeholders follow the same rule: empty `PhotoBox` and `MarkdownBox` placeholders, the `ctx.Text` empty state and the inherited-text underline appear only on the canvas. Thumbnails and layout previews render empty content as export does. One difference to know when styling `[data-empty]`: `ctx.Text` carries `data-empty` only on the canvas, so in thumbnails and layout previews an empty text renders as in export, while empty `PhotoBox` and `MarkdownBox` boxes carry `data-empty` in every view.

## Photo metadata

`photo.captured`, `photo.location` and `photo.camera` come from the photo file's EXIF data. Each is present only when the file records it in a usable form, and all three are read-only:

- **`captured`**: `{ dateTime, offset }`. `dateTime` is the camera's local wall-clock time, `YYYY-MM-DDTHH:mm:ss`, from the time the photo was taken (or, failing that, digitized), never the file's modification time. `offset` is the recorded UTC offset, such as `'+02:00'`, or `null` when the file has none. `null` means the time zone is unknown, not UTC: show `dateTime` as it is, and use `new Date(dateTime + offset)` for the instant only when `offset` is set. Placeholder dates such as `0000:00:00`, impossible dates and offsets outside −12:00 to +14:00 are left out.
- **`location`**: `{ latitude, longitude }` in WGS 84 degrees, north and east positive, rounded to 7 decimals. A coordinate without its hemisphere, out of range or with a zero denominator, or a fix the receiver marked void, gives no location.
- **`camera`**: `{ make?, model? }` as the camera records them, trimmed to at most 100 characters.

ImageFlow reads them from the original file whenever the book opens or a source changes, and never stores them in `photos.json`. Existing books therefore have them without re-importing anything, and replacing a linked photo's original refreshes them under the same photo ID, with crops and assignments unchanged. A photo without EXIF, or with EXIF ImageFlow cannot read, imports and renders as before. The user-written `caption`, `title`, `credit` and `altText` are separate and never overwritten. Writing an extracted field is rejected rather than ignored: in `photos.json` it is a validation error, and `set_photo_metadata` does not accept it.

The same fields appear on `ctx.boxes[id].photo`, on `ctx.book.spreads[].photos[].photo`, in custom editors' `context`, and in `inspect_book`'s `sources` view. [`photo-story.tsx`](../examples/photo-story.tsx) builds a caption from them. Raw EXIF is not exposed.
