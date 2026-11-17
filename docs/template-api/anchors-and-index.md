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

- **One render pass.** Page numbers depend only on spread order and layout spans, never on rendered content. ImageFlow calls every spread's `anchors` with its resolved `params` and `document` values before any spread renders, so every layout reads the same anchors. Like `render`, `anchors` must be a pure function of its input. An `anchors` function that throws or returns an invalid declaration is a render error naming the layout.
- **Pages follow the book.** Inserting, moving, removing or switching a spread renumbers every anchor, as it does the folios. `side` picks the page of a two-page spread and defaults to the first. A single left or right page has only one page, whichever side is named. Without facing pages every unit is one page: `side` is ignored and the anchor's `side` is `'page'`.
- **Repeated layouts.** Anchors belong to spread instances, so a layout used five times declares five anchors with the same ID. `anchors(id)` lists all of them in page order. `anchor(id)` is for an ID that one spread declares.
- **Book check.** `anchor(id)` warns `anchor-missing` when no spread declares the ID, and `anchor-ambiguous` when several do. In that case it returns the first. Both warnings are on the spread that asked. `anchors(id)` returning an empty list is not a finding.
- **Previews.** Layout-picker previews read the anchors of the book as saved, so a contents layout previews with real pages.

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

