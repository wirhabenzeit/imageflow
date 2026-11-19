# Anchors

A layout can declare anchors: places that other spreads refer to by ID, such as chapter openings for a table of contents or a map that a caption points to. Declare them with `anchors`, a function of the spread's saved values:

```tsx
story: spread({
  label: 'Photo and story',
  parameters: { heading },
  anchors: ({ params }) => [{ id: 'chapter', title: params.heading, side: 'right' }],
  render: (ctx) => …,
}),
contents: spread({
  label: 'Contents',
  render: (ctx) => <ol>{ctx.book.anchors('chapter').map((chapter) =>
    <li key={chapter.spread}>{chapter.title} · {chapter.page}</li>)}</ol>,
}),
// elsewhere: 'See the route on page ' + ctx.book.anchor('route')?.page
```

```ts
type AnchorDeclaration = { id: string; title?: string; side?: 'left' | 'right' };
type Anchor = { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' | 'page' };
```

- **One render pass.** Page numbers depend only on spread order and layout spans, never on rendered content. ImageFlow calls every spread's `anchors` with its resolved `params` and `document` values, its `boxes` as `render` sees them, its `spread` ID and the book's `texts` before any spread renders, so every layout reads the same anchors. Like `render`, `anchors` must be a pure function of its input. An `anchors` function that throws or returns an invalid declaration is a render error naming the layout.
- **Pages follow the book.** Inserting, moving, removing or switching a spread renumbers every anchor, as it does the folios. `side` picks the page of a two-page spread and defaults to the first. A single left or right page has only one page, whichever side is named. Without facing pages every unit is one page: `side` is ignored and the anchor's `side` is `'page'`.
- **Repeated layouts.** Anchors belong to spread instances, so a layout used five times declares five anchors with the same ID. `anchors(id)` lists all of them in page order. `anchor(id)` is for an ID that one spread declares.
- **Book check.** `anchor(id)` warns `anchor-missing` when no spread declares the ID, and `anchor-ambiguous` when several do. In that case it returns the first. Both warnings are on the spread that asked. `anchors(id)` returning an empty list is not a finding.
- **Previews.** Layout-picker previews read the anchors of the book as saved, so a contents layout previews with real pages.

A Markdown box's `boxes[id].text` carries its flow position and its source's [header fields](boxes-and-elements.md#text-metadata), so a layout can declare an anchor where a text starts, named after it:

```tsx
anchors: ({ params, boxes }) => {
  const title = typeof boxes.body.text?.meta.title === 'string' ? boxes.body.text.meta.title : params.heading;
  return boxes.body.text?.part === 1 && title ? [{ id: 'section', title }] : [];
},
```

A page without a Markdown box of its own, such as a route map facing its day's story, reads the book's texts: `anchors` also receives `book.texts`, as [`ctx.book.texts`](boxes-and-elements.md#text-metadata) lists them, and `spread`, the sheet's ID (with `side` for a page layout), as `render` does:

```tsx
anchors: ({ spread, book, params }) => {
  // The text that starts on this sheet's other page.
  const day = book.texts.find((text) => text.boxes.some((box) => box.spread === spread && box.part === 1));
  const title = typeof day?.meta.title === 'string' ? day.meta.title : params.heading;
  return title ? [{ id: 'stage', title }] : [];
},
```

Both are read from the saved book before any spread renders and are frozen, like the boxes.

An anchor marks a whole page, not a point found by measuring the render. Text flow decides which page a heading inside Markdown continuation lands on, so such headings cannot be anchors yet.

## Book index

`ctx.book.spreads` lists every spread of the book in order, with its pages and the photos placed on it, for photo credits, picture indexes and contents pages. No anchors are needed for it:

```ts
type BookPhotoPlacement = { page?: 'left' | 'right'; box: string; photoId: string | null; photo: Photo | null };
type BookSpread = {
  id: string;                                  // the spread's stable instance ID
  layout?: string;                             // the shown spread layout; absent when split
  pages?: Partial<Record<'left' | 'right', { layout?: string; photos: BookPhotoPlacement[] }>>;
  page: { left?: number; right?: number; number?: number };  // as ctx.page
  photos: { page?: 'left' | 'right'; box: string; photoId: string | null; photo: Photo | null }[];
};
```

```tsx
for (const spread of ctx.book.spreads)
  for (const { photo } of spread.photos) if (photo?.credit) credits.push([photo.credit, spread.page.left ?? spread.page.number]);
```

[`photo-story.tsx`](../examples/photo-story.tsx) has a complete credits layout; the photobook starter's *Picture list* page lists every photo once with its pages and credit. It works out each entry's height from its text before rendering, so it knows where every entry goes: the list continues across every *Picture list spread* in book order, the last one reports `template:picture-list-full` in the Book check when photos are left over, and `template:picture-credit-cut` names a photo whose credit or page list is too long to show in full. To find or leave out the current spread, compare with `ctx.spread`: `ctx.book.spreads.filter(({ id }) => id !== ctx.spread)`.

- **From saved data, before render.** Like anchors, the index is built from the saved book and the template's declarations before any spread renders. It never looks at another spread's rendered output, so every spread, the editor's context, MCP artwork and export read the same index, and the same book always gives the same index. It is frozen; changing it throws. The Inspector's layout previews redraw when it changes, such as when a photo is placed or its credit edited on another spread.
- **Pages.** `page` is the spread's own `ctx.page`: `left` and `right`, one of them for a single page at a book end, or `number` in a format without facing pages. For a spread layout, which page a box is on is the layout's business. On a split sheet each placement carries `page`, and `pages.left`/`pages.right` expose the shown page layout and photos independently.
- **Photos.** `photos` lists the photo boxes of the spread's current layout, in declaration order, including empty ones. `photoId` is `null` for an empty box. `photo` is the photo's metadata, the same object shape as `ctx.boxes[id].photo`, or `null` when the box is empty or its photo is missing from the book. A photo placed in several boxes appears once per placement. Content a spread keeps from a layout it no longer uses is not listed, and a spread whose layout the template no longer declares lists no photos. Markdown boxes are not listed.
- **No images.** The index has metadata and assignments only, no photo URLs or rendered thumbnails.

### Texts

`ctx.book.texts` lists every Markdown source the book places, in the order the book first shows them, with its [header fields](boxes-and-elements.md#text-metadata) and the boxes it flows through. A page without a Markdown box of its own reads a text's header here: a map marks the places of the story on its facing page, a photo page between two story pages carries their running header.

```ts
type BookTextPlacement = { spread: string; page?: 'left' | 'right'; box: string; part: number;
  pageNumbers: { left?: number; right?: number; number?: number } };
type BookText = { id: string; title?: string; meta: TextMeta; boxes: BookTextPlacement[] };
```

```tsx
// The text on this sheet's other page, or around this page: the last text that starts before it.
const page = ctx.page.left ?? ctx.page.right ?? ctx.page.number ?? 0;
const pagesOf = (text: BookText) => text.boxes.flatMap(({ pageNumbers: n }) => [n.left, n.right, n.number]).filter((p) => p !== undefined);
const beside = ctx.book.texts.find((text) => text.boxes.some((placed) => placed.spread === ctx.spread && placed.page !== ctx.side));
const around = ctx.book.texts.findLast((text) => Math.min(...pagesOf(text)) <= page);
const places = (beside ?? around)?.meta.places;
```

- **Example.** The photobook starter's *Inset map* marks the `places` of the story on its facing page, in print and in its map editor, and reports `template:places-invalid` for entries it cannot mark. Its *Story* page names its `section` anchor after its text's `title` where the text starts.
- **The template chooses.** Which text a page belongs to is the layout's decision: the one beside it, the one whose pages surround it, or one a parameter names by its `id`. ImageFlow lists facts and decides nothing.
- **Pages.** `pageNumbers` are the book pages of the box's spread, or of its page on a split sheet, as `ctx.page`. Which page of a spread layout a box is on is the layout's business. `part` is the box's place in the chain, as its `text.part`: assigned boxes count whether or not the text reaches them.
- **Same rules.** Like `spreads`, the list is built from the saved book before any spread renders and is frozen. Only shown layouts' boxes are listed, and a source whose file is missing is listed with `meta: {}`.

Page layouts declare anchors for their own page, whatever `side` their declaration names. Two page layouts on one sheet may therefore declare two anchors with the same ID. Use `anchors(id)` when that is intentional; `anchor(id)` warns about ambiguity per asking page. Only shown page layouts contribute anchors and credits; remembered hidden layouts do not.

## Credits

A layout declares what its spreads use that needs a credit, such as the data behind a map, with `credits`. Like `anchors`, it is a pure function of the spread's saved values, here with its boxes' and elements' values too (`boxes[id].params`, and a photo box's `boxes[id].photo` metadata or null), called for every spread before any spread renders:

```tsx
map: spread({
  elements: { map: { label: 'Map', parameters: mapParameters } },
  credits: ({ elements }) => [
    { id: 'openstreetmap', text: 'Map data © OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
    ...(elements.map.params.style === 'lines' ? [{ id: 'mapterhorn', text: 'Elevation © Mapterhorn' }] : []),
  ],
  render: …,
}),
```

`ctx.book.credits` lists them for the whole book: each `id` once, with the `text` and `url` of its first declaration, the `pages` of every spread that declares it (sorted, without repeats) and those `spreads`, in the order the book first uses them. It is frozen and the same on every spread, so a credits page prints exactly what the book uses, and nothing it does not.

IDs are whitespace-free tokens; a declaration with spaces in its ID is rejected. `side: 'left' | 'right'` credits only that page of a two-page spread, such as an inset map on the right page (`{ id: 'openstreetmap', text: '…', side: 'right' }`); without it, the credit covers both pages. When a later spread declares an ID with other `text` or `url` than the first, the book keeps the first and the Book check warns `credit-conflict` on that spread and page when applicable, so give different credits their own IDs, such as `'photo-' + photo.credit`.

Mark the node that prints credits with `data-credits` and their IDs, space-separated, such as `data-credits={ctx.book.credits.map(({ id }) => id).join(' ')}`. When the whole book renders, the Book check warns `credit-unprinted` for each credit the book uses that no page marks, on the first spread that uses it, so moving credits off the maps onto a credits page never loses them. The starter prints one consolidated map-resource attribution at the foot of its last page, the Picture list, which is the only layout it offers there. It prints each resource text once without page numbers; page usage remains available in the structured index for diagnostics. Terrain attribution is included only when a map style uses it.

