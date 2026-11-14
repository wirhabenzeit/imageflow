# Rendered images

A picture that takes time to make, such as a map drawn by a WebGL library from remote tiles, renders through `<RenderedImage>` (included in the contract-1 baseline):

```tsx
import { RenderedImage } from 'imageflow';

<Element id="map" rect={rect}>
  <RenderedImage label="Map" inputs={{ style, longitude, latitude, zoom }} style={{ position: 'absolute', inset: 0 }}
    draw={async ({ width, height, pixelRatio, mode, signal }) => drawMap({ style, longitude, latitude, zoom }, { width, height, pixelRatio, signal })} />
</Element>
```

- **Drawing:** ImageFlow calls `draw` when the element mounts and again when `inputs` (JSON-like data, everything `draw` depends on) changes. It passes the box's size in CSS pixels (96 per inch), `pixelRatio` (device pixels per CSS pixel), `mode` (`'preview'`, `'check'` or `'export'`) and an `AbortSignal`. Resolve to a canvas, an `OffscreenCanvas` or an image `Blob`; ImageFlow shows it as an image that fills the box. Nothing is saved in the book.
- **Resolution:** previews draw at the screen's density (at most 2×; thumbnails and checks at 0.5×). Export draws at the format's target resolution ÷ 96, 300 ppi when the format sets none, so a picture is as sharp in the PDF as the format asks.
- **Waiting:** the Book check and every export page wait for all pictures on the page before they are final. Each picture may draw for 60 s (120 s in export), counted from when it starts drawing, not while it waits for others; the check or export waits as long as pictures keep finishing. In the editor, pictures fill in as they finish, over a striped placeholder, and the Book check lists failures as they happen and shows while pictures are still drawing. At most two draw at once in the book view and one elsewhere, so a long book does not open a GPU context per page.
- **Drawing again:** the picture is drawn again when `inputs`, the box's size or the output resolution changes. Each drawing uses the `draw` and values of the render that started it, so draw anything that must match the picture (such as a route over a map) from the same values as `inputs`.
- **Page and layout thumbnails:** while a book window stays open, identical pictures can be reused across page switches and saves. Cached pictures are restored before a replacement thumbnail frame is shown, so editing one page does not blank an unchanged map on another. New pictures still draw progressively. This bounded memory cache includes the layout, picture position, declared inputs, dimensions and pixel ratio, and is invalidated by changed template code or network permissions. The first view still needs to draw; checks, exports and printing always render afresh.
- **Cancellation:** `signal` is aborted when the element unmounts, a newer drawing replaces it, or the timeout passes; stop work and release GPU resources when it fires. A result after that is discarded, so an older drawing never replaces a newer one.
- **Resolution:** the picture covers the box (`object-fit: cover`), so draw it at `width × pixelRatio` by `height × pixelRatio` pixels. A picture with fewer pixels on either axis fails with `rendered-image-failed`, since it would print blurred or stretched.
- **Failure:** throw or reject with a message, such as `Error('The map style could not be loaded.')`. The box shows the message, and the Book check reports `rendered-image-failed` for the element, so export stops instead of printing the page without its picture. Decide readiness yourself: the starter's map resolves on MapLibre's `idle` event and rejects on any `error` event, so a style or tile that failed to load fails the picture.
- **Network:** `draw` may reach the template's declared [`network`](element-editors.md#element-editors) origins once the user has allowed them; otherwise its requests are blocked and the picture fails. Its requests, WebGL contexts, workers and timers are not `render-impure`.
- `label` names the picture in messages (default `'Picture'`); `alt`, `className` and `style` apply to the box, whose class is `if-rendered-image` with `data-rendered="pending" | "ready" | "failed"`.
