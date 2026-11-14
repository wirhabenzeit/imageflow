# Platform components

| Component | Purpose |
| --- | --- |
| `<Spread>` | Root of every spread. Sizes the spread to two trims plus bleed, sets geometry CSS variables, and handles page halves. |
| `<PhotoBox id>` | Renders the assigned photo with its crop (the photo always covers the box; the saved crop picks the visible region), using a preview-size image in the editor and a rendition capped at the format maximum resolution in export (300 ppi when omitted). Its element is the box's geometry and drop zone. Users select the photo in the editor and drag and pinch it; templates do not handle the crop. A render callback as its child draws the photo with the template's own markup (see PhotoBox render callbacks). |
| `<MarkdownBox id>` | Receives the flowed fragment of the assigned Markdown source. Its element is the box's geometry and drop zone. |
| `<Element id>` | Wraps generated artwork so the editor can highlight it, and opens its parameters when clicked; an element can supply its own editor (see Element editors). |
| `<ctx.Text parameter>` | Shows a string parameter and makes it editable by clicking it (see Click-to-edit). Only on the render context, because it reads the layout's values. |
| `asset(path)` | Resolves a file in `template/assets/` for use in `src` or CSS. |

Rules:

- Each declared box is rendered exactly once through its component; each declared element at most once.
- Boxes and elements are positioned and sized by template CSS on the component's element (`className`, `style`), or by `rect` (see Geometry helpers).
- An empty box keeps its area in edit mode so it can receive drops. In export, its wrapper remains but the edit placeholder is omitted, as it is in thumbnails and layout previews; templates can style `[data-empty]`.

## PhotoBox render callbacks

A fixed CSS mask or filter on `.if-photo img` needs no callback. To compose the photo inside the template's own SVG or HTML, such as a shaped mask with an outline, a duotone filter or a photo combined with artwork, give the PhotoBox a render function as its child:

```tsx
<ctx.PhotoBox id="hero" rect={rect}>{(photo, box) =>
  <svg width={photo.box.width} height={photo.box.height}>
    <clipPath id={box.uid}><circle cx={photo.box.width / 2} cy={photo.box.height / 2} r={photo.box.width / 3} /></clipPath>
    <image href={photo.src} {...photo.image} preserveAspectRatio="none" clipPath={`url(#${box.uid})`} />
  </svg>}
</ctx.PhotoBox>
```

```ts
type PhotoRender = {
  src: string;          // the rendition ImageFlow chose (preview, thumbnail, or print-resolution file in export)
  alt: string;          // alt text, else title, else ''
  box: { width: number; height: number };                       // the box, CSS px
  image: { x: number; y: number; width: number; height: number }; // where the whole photo goes, CSS px from the box's top-left
  style: CSSProperties; // the same placement for an absolutely positioned <img>, in % of the box
  crop: { x: number; y: number; width: number; height: number };  // the visible part, as fractions of the photo
  placement: { centerX: number; centerY: number; zoom: number };  // the saved crop (or the gesture's, while cropping)
  ppi: number;          // effective resolution of the visible part at print size
};
type PhotoBoxState = { id: string; uid: string; params: BoxParams; photo: Photo | null };  // as ctx.boxes[id]
```

- **Units and coordinates.** Lengths are CSS pixels (96 per inch) of the printed page, with the origin at the box's top-left corner. They match the box's layout size whatever the editor's zoom, so an SVG sized `photo.box.width` × `photo.box.height` (or with that `viewBox`) maps one to one. `image` usually extends past the box, which clips everything to its own rectangle. For HTML, `<img src={photo.src} style={photo.style} />` places the photo the same way.
- **Honour the placement.** Draw the photo at `photo.image` (or with `photo.style`). That is what makes the printed crop the one the user chose and what the resolution check measured. ImageFlow cannot verify the geometry from the markup: finding `photo.src` in the output does not prove it is drawn in the right place.
- **What ImageFlow still owns.** Assignment and drops, the per-layout crop and its gestures, Quick Look, choosing the rendition for the editor, thumbnails and export, the `photo-resolution-low` check (computed from the box and the saved crop, as for the default renderer), and waiting for the image: the Book check, MCP artwork, and proof and print export wait for HTML images and SVG `<image>` references in the callback's output to load, and report a photo that cannot be decoded. While the user crops, the callback is called again with the gesture's placement, so the mask or artwork follows the photo before the crop is saved. The editor does not cover it with a plain copy of the photo.
- **When it is called.** Only for a box with a photo that ImageFlow can show. An empty box, or one whose photo is missing, keeps the platform's placeholder and drop target, and the callback is not called. A box with `rect` is drawn at once. A box sized by CSS is measured before it is painted and drawn then. The editor's scrolling book draws callback boxes when their spread comes near the screen, as it loads default photos. Presentation draws them at once.
- **Pure.** The callback is part of rendering: the same rules apply as for `render`, and impure calls are attributed to the spread.
- **Errors.** A callback that throws fails the Book check, artwork and export like any other template error. In the editor's scrolling book, where boxes are drawn as they come near and again during crop gestures, only that box fails: it shows that the photo could not be drawn, the live Book check reports `photo-render-failed` for it, and it draws again on the next crop, size or parameter change.
- **Ids in print.** Proof and print export draw each page from a copy of its spread, so ids inside the copy get a suffix (`.p1`, `.p2`, …), and the copy's own references follow them: `url(#…)` in attributes and `<style>` elements, `href="#…"`, and `#id` selectors in `<style>` elements inside the spread. Selectors in the template's stylesheet cannot follow, so style callback output by class or attribute rather than by `#id`.
- **The box.** `box` has the same values as `ctx.boxes[id]` with resolved `params`, plus `uid`, which is unique in the book, for ids inside the callback's SVG. `box.photo` holds the photo's metadata and pixel size. For more than one id, derive them with a dot, such as `box.uid + '.mask'` and `box.uid + '.fade'`: box IDs never contain a dot, so a derived id cannot equal another box's `uid`. With the `spread` builder, `box.params` is typed from that box's parameters. A callback is ordinary template code, so it can be shared across boxes and layouts, packaged with the box parameters it reads (which show in the photo toolbar), and typed against them: `(photo: PhotoRender, box: PhotoBoxState<string, { tilt: number }>) => …` fails type checking on a box without `tilt`. Box parameters are one namespace per box, so prefix a treatment's parameters, and their values follow the box ID across layouts like `caption`.
- **Styling.** The default renderer's `.if-photo img` rules do not apply inside a callback box. The box gets `data-photo-render="custom"` and is a positioning context.

[`photo-frames.tsx`](../examples/photo-frames.tsx) packages a shaped-mask treatment with its parameters and `controls`. The photobook starter's *Photo and note* layout draws its photo as an arch, a circle or a rectangle the same way.
