import { box, Choice, defineTemplate, FormattedText, geometry, issue, mm, p, plainText, printFormat, pt, Page, Spread } from 'imageflow';
import type { BookSpread, ImageFlowNode, LayoutPickerProps, Photo, PhotoBoxState, PhotoRender, Rect, RenderContext, ResolvedFormat } from 'imageflow';
import './styles.css';
import { insetMapParameters, MapEditor, mapEditorParameters, mapOrigin, mapParameters, MapView } from './map';
import { elevationOrigin, mapCredits } from './map-styles';
import type { MapEditorProps } from './map';

// Layouts are drawn on a 290 × 290 design page, measured from the trim edge of the left or right page.
// `ctx.geometry.design(canvas)` scales them to the chosen format: horizontal values with the trim width, vertical
// values with the trim height. Type sizes stay in points. Full-bleed photos use `ctx.geometry.page(side, 'bleed')`:
// they reach into the bleed on the outside, top and bottom, and the edge at the fold stays at the fold.
const page = 290;
const canvas = { width: page, height: page };
const margin = 30;

// One print format per size; they share bleed, safe area, page count and output rules.
const bookFormat = (label: string, width: number, height: number) => printFormat({
  label,
  trim: { width: mm(width), height: mm(height) },
  bleed: { all: mm(3), binding: mm(0) },
  safe: mm(5),
  pageCount: { min: 28, max: 112, step: 4 },
  output: {
    resolution: { minimum: 180, target: 250, maximum: 300 }, minimumTextSize: pt(8),
    maximumFileSize: { pages: 500_000_000 },
  },
});

// Book settings. The theme sets every colour of the book (paper, text, rules and the shades over photos) in
// styles.css, so pages never pick colours of their own and a book switches between light and dark in one step.
const documentParameters = {
  theme: p.enum({ label: 'Colour theme', default: 'light', options: { light: 'Light', dark: 'Dark' },
    description: 'The colours of the whole book. Light is warm off-white paper with dark ink. Dark is near-black paper with light text, which suits night, snow and moody photographs.' }),
  headingFont: p.enum({ label: 'Headings', default: 'serif', options: { serif: 'Serif', sans: 'Sans' },
    description: 'The typeface of titles and headings. Stories and notes stay in the serif text face.' }),
  textSize: p.number({ label: 'Text size', default: 10.5, min: 8, max: 14, step: .5, unit: 'pt',
    description: 'Type size of stories and notes in the whole book. Larger text fits less on a page, so it continues on later pages sooner.' }),
  spacing: p.enum({ label: 'Photo spacing', default: 'regular', options: { tight: 'Tight', regular: 'Regular', airy: 'Airy' },
    description: 'The gap between photos in grids, collages and framed pairs.' }),
  showPageNumbers: p.boolean({ label: 'Page numbers', default: true,
    description: 'Page numbers at the foot of each page. Pages covered by a photo never show one.' }),
};
type Document = { theme: 'light' | 'dark'; headingFont: 'serif' | 'sans'; textSize: number; spacing: 'tight' | 'regular' | 'airy'; showPageNumbers: boolean };
// The gap between photos, in design units.
const gaps = { tight: 2.5, regular: 6, airy: 11 } as const;
// The context shared helpers need, typed with the same document parameters the template declares.
type Context = RenderContext<{ label: string }, typeof documentParameters>;

/** The theme's classes on a spread, or on an inline editor that draws page artwork. */
const bookClass = (document: Pick<Document, 'theme' | 'headingFont'>) => 'field-book theme-' + document.theme + ' headings-' + document.headingFont;

/** Paper, folios, and spread root. Pass `bled` for pages covered by a photo, which get no page number. */
function Paper({ context, bled = {}, children }: {
  context: Pick<Context, 'document' | 'page'>; bled?: { left?: boolean; right?: boolean }; children?: ImageFlowNode;
}) {
  const { document, page } = context;
  return <Spread className={bookClass(document)} style={{ '--text-size': document.textSize + 'pt' }}>
    <div className="bleed paper" />
    {children}
    {document.showPageNumbers && page.left && !bled.left && <span className="folio left-folio">{page.left}</span>}
    {document.showPageNumbers && page.right && !bled.right && <span className="folio right-folio">{page.right}</span>}
  </Spread>;
}

/** Reusable page paper. Its geometry and folio belong only to the side being rendered. */
function PagePaper({ context, bled = false, children }: {
  context: Pick<Context, 'document' | 'page' | 'side' | 'geometry'>; bled?: boolean; children?: ImageFlowNode;
}) {
  const { document, page } = context;
  const number = page.left ?? page.right ?? page.number;
  return <Page className={bookClass(document)} style={{ '--text-size': document.textSize + 'pt' }}>
    <div className="paper" style={context.geometry.css(context.geometry.page('bleed'))} />
    {children}
    {document.showPageNumbers && number && !bled && <span className={'folio ' + (context.side === 'left' ? 'left-folio' : 'right-folio')}>{number}</span>}
  </Page>;
}

function Caption({ context, box, rect, className = 'caption' }: {
  context: Pick<Context, 'geometry'>; box: { params: { caption: boolean }; photo: Photo | null }; rect: Rect; className?: string;
}) {
  return box.params.caption && box.photo?.caption ? <p className={className} style={context.geometry.css(rect)}>{box.photo.caption}</p> : null;
}

/** A shade over the lower part of a photo, so white type stays readable. It never takes a click from the photo. */
const Shade = ({ context, rect }: { context: Pick<Context, 'geometry'>; rect: Rect }) =>
  <div className="shade" style={context.geometry.css(rect)} />;

// Shared parameters. An ID means the same thing in every layout that declares it, so switching layouts keeps the
// heading, the note and each photo's caption setting.
// Page text supports **bold**, *italic* and ~~strikethrough~~ (styles.css picks the faces).
const heading = p.string({ label: 'Heading', default: 'Field notes', multiline: true, maxLength: 90, markdown: 'inline' });
const note = p.string({ label: 'Note', default: '', multiline: true, maxLength: 400, placeholder: 'A few lines about these photos', markdown: 'inline',
  description: 'A short text beside the photos. Leave it empty for no text.' });
const oneLine = (text: string) => plainText(text).replace(/\s+/g, ' ').trim();
// For layouts that draw the photo's caption. Declare the toggle only where it has an effect: the editor shows a
// control for every declared parameter. The value is shared by every layout with this box, so it returns when the
// spread switches back to a layout that draws captions.
const caption = p.boolean({ label: 'Show caption', default: false, description: 'Prints the caption from the photo’s details. Edit it in the photo’s Inspector.' });
const captioned = (label: string) => box.photo(label, { caption });
const columns = p.enum({ label: 'Columns', default: '1', options: ['1', '2', '3'], labels: { 1: 'Full width', 2: '2 columns', 3: '3 columns' } });
const body = (label: string, flowOrder = 1) => box.markdown(label, { flowOrder, parameters: { columns } });

// A shaped photo, drawn by a PhotoBox render callback: the photo goes exactly where the user's crop puts it
// (`photo.image`), clipped by an arch or a circle. The box clips everything else to its rectangle.
const shapes = { rectangle: 'Rectangle', arch: 'Arch', circle: 'Circle' } as const;
const shapedPhoto = box.photo('Photo', {
  caption,
  shape: p.enum({ label: 'Shape', default: 'arch', options: shapes, description: 'The outline of the photo. Arch rounds the top; Circle shows the middle of the frame.' }),
});
function ShapedPhoto(photo: PhotoRender, state: PhotoBoxState<string, { shape: keyof typeof shapes }>) {
  const { width, height } = photo.box;
  if (state.params.shape === 'rectangle') return <img src={photo.src} alt={photo.alt} style={photo.style} />;
  const r = state.params.shape === 'circle' ? Math.min(width, height) / 2 : width / 2;
  const outline = state.params.shape === 'circle'
    ? `M ${width / 2 - r} ${height / 2} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`
    : `M 0 ${height} V ${r} A ${r} ${r} 0 0 1 ${width} ${r} V ${height} Z`;
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={photo.alt}>
    <defs><clipPath id={state.uid}><path d={outline} /></clipPath></defs>
    <image href={photo.src} x={photo.image.x} y={photo.image.y} width={photo.image.width} height={photo.image.height}
      preserveAspectRatio="none" clipPath={`url(#${state.uid})`} />
  </svg>;
}

// Layout families: a segmented choice between the variants, by one of their tags, beside the spread's other settings.
function variantPicker(tag: string, label: string, names: Record<string, string>) {
  return function VariantPicker({ variants, current, choose, readOnly }: LayoutPickerProps) {
    return <Choice label={label} hideLabel value={current} onChange={choose} disabled={readOnly}
      options={variants.map(({ id, variant }) => ({ value: id, label: names[String(variant[tag])] ?? String(variant[tag]) }))} />;
  };
}

// The photo grid comes in two sizes in the `pageGrid` family. Their box IDs are fixed:
// the 2×2 boxes stay in the upper left of the 3×3 grid, so switching sizes keeps those photos where they were and
// keeps the other five outside the 2×2 layout until the page switches back.
const gridSizes = {
  '2x2': { columns: 2, ids: ['hero', 'second', 'third', 'fourth'] },
  '3x3': { columns: 3, ids: ['hero', 'second', 'fifth', 'third', 'fourth', 'sixth', 'seventh', 'eighth', 'ninth'] },
} as const;
const cellLabels = { 2: ['Upper left', 'Upper right', 'Lower left', 'Lower right'],
  3: ['Top left', 'Top middle', 'Top right', 'Middle left', 'Centre', 'Middle right', 'Bottom left', 'Bottom middle', 'Bottom right'] };
const gridBoxes = <const S extends keyof typeof gridSizes>(size: S) => {
  const { columns, ids } = gridSizes[size];
  return box.photos(ids, (_id, i) => cellLabels[columns][i]);
};
// The credits of everything the book uses (ctx.book.credits), each with the pages it is on. The node is marked with
// their IDs (data-credits), so the Book check knows they are printed.
function Credits({ context, rect }: { context: Context; rect: Rect }) {
  const credits = context.book.credits;
  if (!credits.length) return null;
  return <p className="book-credits" data-credits={credits.map(({ id }) => id).join(' ')} style={context.geometry.css(rect)}>
    {credits.map(({ text, pages }) => text + (pages.length ? ' (' + pageRanges([...pages]).toLowerCase() + ')' : '')).join(' · ')}
  </p>;
}

// Which pages each photo box covers, for the picture list. Boxes not listed are on the left page; `both` is a photo
// across the spread.
const boxPages: Record<string, Record<string, 'both'>> = {
  opener: { hero: 'both' },
  panorama: { hero: 'both' },
};
function pagesOf(spread: BookSpread, box: string, side?: 'left' | 'right'): number[] {
  if (side) { const number = spread.page[side]; return number === undefined ? [] : [number]; }
  const { left, right, number } = spread.page;
  if (number !== undefined) return [number];
  const pages = boxPages[spread.layout ?? '']?.[box] === 'both' ? [left, right] : [left ?? right];
  return pages.filter((at): at is number => at !== undefined);
}

/** Every photo in the book once, with the pages it is on, in book order. */
function pictureList(spreads: readonly BookSpread[]) {
  const pictures = new Map<string, { photo: Photo; pages: number[] }>();
  for (const spread of spreads) for (const { box, page, photoId, photo } of spread.photos) {
    if (!photoId || !photo) continue;
    const entry = pictures.get(photoId) ?? pictures.set(photoId, { photo, pages: [] }).get(photoId)!;
    for (const at of pagesOf(spread, box, page)) if (!entry.pages.includes(at)) entry.pages.push(at);
  }
  return [...pictures.values()];
}

// The picture list runs over every Picture list page in book order: the closing page holds what fits, and
// additional list pages before it hold more. Nothing is cut off silently: an entry's height is worked out from its
// text before anything renders (one line for the title, then as many lines as its pages and its credit need), so
// where each entry goes is known in advance, and the Book check warns about photos that do not fit and about a credit
// or page list too long to show in full.
const pictureLayouts = ['pictures', 'credits'];
const pictureColumnGap = 8; // mm
// Line heights in millimetres, matching styles.css: a 9 pt title line, 8 pt detail lines, and the space between.
const pictureLine = { title: 4.2, detail: 3.7, gap: .4, after: 2.2 };
const maxDetailLines = 3;
// Generous average width of an 8 pt sans character, in millimetres, so the estimate errs towards an extra line.
const detailCharWidth = 1.7;

function pictureColumns(layout: string, place: (x: number, y: number, width: number, height: number) => Rect): Rect[] {
  const area = place(margin, 58, page - 2 * margin, layout === 'pictures' ? 202 : 160);
  const width = (area.width - pictureColumnGap) / 2;
  return [{ ...area, width }, { ...area, x: area.x + width + pictureColumnGap, width }];
}

/** `1, 2, 3, 5` as `1–3, 5`. */
function pageRanges(pages: number[]) {
  const sorted = [...pages].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(j > i ? sorted[i] + '–' + sorted[j] : String(sorted[i]));
    i = j;
  }
  return (sorted.length > 1 ? 'Pages ' : 'Page ') + runs.join(', ');
}

type PictureEntry = { title: string; pages: string; credit: string; lines: { pages: number; credit: number }; clipped: boolean; rect: Rect };
type PictureContext = Pick<Context, 'book' | 'spread' | 'layout' | 'geometry' | 'view' | 'format' | 'side'>;

/** Allocates the book's picture entries in page order and returns this page's part of the list. */
function picturePage(ctx: PictureContext) {
  // List allocation covers all list layouts, even when this render is one local closing page.
  const at = geometry.design(ctx.format, canvas);
  // Built from the book index before anything renders, so the list follows every photo placed, moved or removed.
  const pictures = pictureList(ctx.book.spreads);
  // The page being drawn counts with its candidate layout, so previews show the entries that would appear there.
  const lists = ctx.book.spreads.flatMap(({ id, layout, pages }) => {
    // A full-spread candidate replaces both pages; a page candidate changes only its own side.
    if (id === ctx.spread && !ctx.side) return [{ id, layout: ctx.layout }];
    if (pages) return (['left', 'right'] as const).map(side => ({ id, side,
      layout: id === ctx.spread && side === ctx.side ? ctx.layout : pages[side]?.layout ?? '' }));
    return [{ id, layout: id === ctx.spread ? ctx.layout : layout ?? '' }];
  }).filter(({ layout }) => pictureLayouts.includes(layout));
  const own: PictureEntry[] = [];
  let next = 0;
  for (const list of lists) {
    for (const column of pictureColumns(list.layout, at.left)) {
      const perLine = Math.max(10, Math.floor(column.width / detailCharWidth));
      const linesFor = (text: string) => text ? Math.ceil(text.length / perLine) : 0;
      let y = column.y;
      while (next < pictures.length) {
        const { photo, pages } = pictures[next];
        const entry = { title: photo.caption || photo.title || 'Untitled', pages: pageRanges(pages), credit: photo.credit ?? '' };
        const wanted = { pages: linesFor(entry.pages), credit: linesFor(entry.credit) };
        const lines = { pages: Math.min(wanted.pages, maxDetailLines), credit: Math.min(wanted.credit, maxDetailLines) };
        const height = pictureLine.title + (lines.pages + lines.credit) * pictureLine.detail + (lines.credit ? 2 : 1) * pictureLine.gap + pictureLine.after;
        if (y + height - pictureLine.after > column.y + column.height) break;
        // Text longer than its lines is shortened here, with the Book check warning below, rather than cut by the box.
        const fit = (text: string, count: number) => text.length > count * perLine ? text.slice(0, count * perLine - 1).trimEnd() + '…' : text;
        if (list.id === ctx.spread && (!('side' in list) || list.side === ctx.side)) own.push({ ...entry, pages: fit(entry.pages, lines.pages), credit: fit(entry.credit, lines.credit), lines,
          clipped: wanted.pages > lines.pages || wanted.credit > lines.credit, rect: { ...column, y, height: height - pictureLine.after } });
        y += height;
        next++;
      }
    }
  }
  const lastList = lists.at(-1);
  const last = lastList?.id === ctx.spread && (!('side' in lastList) || lastList.side === ctx.side);
  return { pictures, entries: own, listed: next, missing: last ? pictures.length - next : 0 };
}

const listsSomething = (ctx: PictureContext) => {
  const { pictures, entries } = picturePage(ctx);
  return entries.length > 0 || pictures.length === 0;
};

function PictureList(props: { context: PictureContext; columns: Rect[] }) {
  const ctx = props.context;
  const { pictures, entries, listed, missing } = picturePage(ctx);
  const clipped = entries.filter((entry) => entry.clipped);
  return <>
    {entries.map((entry, i) => <div key={i} className="picture" style={ctx.geometry.css(entry.rect)}>
      <span className="picture-title">{entry.title}</span>
      <span className="picture-detail" style={{ '--lines': String(entry.lines.pages) }}>{entry.pages}</span>
      {entry.credit && <span className="picture-detail" style={{ '--lines': String(entry.lines.credit) }}>{entry.credit}</span>}
    </div>)}
    {missing > 0 && <span hidden {...issue({
      code: 'picture-list-full',
      message: `The picture list has room for ${listed} of the book's ${pictures.length} photos; ${missing} are not listed.`,
      suggestion: 'Add a Picture list page before this page; the list continues across it.',
    })} />}
    {clipped.length > 0 && <span hidden {...issue({
      code: 'picture-credit-cut',
      message: `The picture list cannot show all of ${clipped.map(({ title }) => '“' + title + '”').join(', ')}: its credit or page list is longer than ${maxDetailLines} lines.`,
      suggestion: 'Shorten the photo’s credit, or place the photo on fewer pages.',
    })} />}
    {!pictures.length && ctx.view === 'canvas' &&
      <p className="caption" style={ctx.geometry.css({ ...props.columns[0], height: pictureLine.title + pictureLine.detail })}>
        Photos placed in the book are listed here with their pages.</p>}
  </>;
}

// The map title sits over the map. The inline map editor draws it too, at the same place, so framing the view shows
// the page as printed; it stays an ordinary layout parameter, edited where the page shows it.
const mapTitleRect = (format: ResolvedFormat) => geometry.design(format, canvas).left(margin, margin, 150, 22);
function MapLayoutEditor(props: MapEditorProps) {
  const title = props.spread.mapTitle;
  const map = props.context.elements.map.rect;
  const at = mapTitleRect(props.format);
  const document = props.document as Partial<Document>;
  // Inside the page's own theme (`.field-book`), so the title prints exactly as it shows here.
  return <MapEditor {...props}>
    {typeof title === 'string' && title && map && <div className={bookClass({ theme: document.theme ?? 'light', headingFont: document.headingFont ?? 'serif' }) + ' map-title-layer'}>
      <h2 className="map-title map-title-overlay" style={geometry.css({ ...at, x: at.x - map.x, y: at.y - map.y })}><FormattedText value={title} /></h2>
    </div>}
  </MapEditor>;
}

const compass = <svg viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" strokeWidth="3" />
  <path d="M50 16 62 60 50 54 38 60z" fill="currentColor" />
</svg>;

export default defineTemplate({
  id: 'imageflow-starter',
  version: '0.11.0',
  label: 'Photobook',
  description: 'A travel journal with full-bleed photographs, stories, grids, maps and a picture list, in a light or a dark theme.',
  preview: './preview.jpg',
  contract: 1,
  // The map layouts load OpenFreeMap styles and tiles, and Mapterhorn elevation for contour lines, once the user allows
  // it, in their editor, the page and export.
  network: [mapOrigin, elevationOrigin],
  formats: {
    square: bookFormat('WhiteWall Gallery Square · 29 × 29 cm', 290, 290),
    landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
  },
  defaultFormat: 'square',
  parameters: documentParameters,
  controls: [
    { group: 'Look', controls: ['theme', 'headingFont'] },
    { group: 'Pages', controls: ['textSize', 'spacing', 'showPageNumbers'] },
  ],
  // Layouts that are variants of one design. The sidebar shows each family once, and its picker chooses the variant.
  layoutFamilies: {
    pagePhoto: { label: 'Photo page', picker: { label: 'Photo style', component: variantPicker('style', 'Photo style', { bleed: 'Full bleed', framed: 'Framed', shaped: 'Shaped' }) } },
    pageGrid: { label: 'Photo grid page', picker: { label: 'Grid size', component: variantPicker('size', 'Grid size', { '2x2': '2 × 2', '3x3': '3 × 3' }) } },
  },
  // The builders type each layout's context from its own declarations and the document parameters above.
  spreads: ({ spread, page: pageLayout }) => ({
    // Book ends: a first right page and a last left page.
    title: pageLayout({
      label: 'Title page', sides: ['right'],
      parameters: { heading, subtitle: p.string({ label: 'Subtitle', default: 'A book made in ImageFlow', markdown: 'inline' }) },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx}>
          <div className="compass" style={ctx.geometry.css(at.page(margin, 60, 14, 14))}>{compass}</div>
          <ctx.Text presentation="inline" parameter="heading" as="h1" rect={at.page(margin, 120, page - 2 * margin, 110)} />
          <div className="rule" style={ctx.geometry.css(at.page(margin, 232, 24, .6))} />
          <ctx.Text presentation="inline" parameter="subtitle" className="subtitle" rect={at.page(margin, 240, page - 2 * margin, 20)} />
        </PagePaper>;
      },
    }),
    cover: pageLayout({
      label: 'Title photo', sides: ['right'],
      parameters: { heading, subtitle: p.string({ label: 'Subtitle', default: 'A book made in ImageFlow', markdown: 'inline' }) },
      boxes: { hero: box.photo('Title photo') },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const right = ctx.geometry.page('bleed');
        return <PagePaper context={ctx} bled>
          <ctx.PhotoBox id="hero" rect={right} />
          <Shade context={ctx} rect={{ ...right, y: right.y + right.height * .45, height: right.height * .55 }} />
          {/* The title stands on the subtitle, however many lines it takes. */}
          <div className="cover-title" style={ctx.geometry.css(at.page(margin, 110, page - 2 * margin, 156))}>
            <ctx.Text presentation="inline" parameter="heading" as="h1" className="on-photo" />
            <ctx.Text presentation="inline" parameter="subtitle" className="subtitle on-photo" />
          </div>
        </PagePaper>;
      },
    }),
    // The closing page adds a colophon and the book's collected credits below its picture list.
    credits: pageLayout({
      label: 'Picture list', sides: ['left'],
      parameters: {
        listHeading: p.string({ label: 'Heading', default: 'Pictures', markdown: 'inline' }),
        colophon: p.string({ label: 'Colophon', default: 'Made with ImageFlow.', multiline: true, maxLength: 300, markdown: 'inline',
          description: 'A few closing lines under the list: who made the book, when, or a dedication.' }),
      },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx}>
          {/* No heading over an empty list when earlier Picture list pages already hold every photo. */}
          {listsSomething(ctx) &&
            <ctx.Text presentation="inline" parameter="listHeading" as="h3" rect={at.page(margin, 36, page - 2 * margin, 14)} />}
          <PictureList context={ctx} columns={pictureColumns('credits', at.page)} />
          <ctx.Text presentation="inline" parameter="colophon" className="colophon" rect={at.page(margin, 226, page - 2 * margin, 18)} />
          <Credits context={ctx} rect={at.page(margin, 246, page - 2 * margin, 14)} />
        </PagePaper>;
      },
    }),

    // Page designs combine freely on either side; their IDs carry content into and out of spread layouts.
    photo: pageLayout({
      label: 'Full-bleed photo', family: 'pagePhoto', variant: { style: 'bleed' }, boxes: { hero: captioned('Photo') },
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx} bled>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('bleed')} />
          <Caption context={ctx} box={ctx.boxes.hero} className="caption overlay" rect={at.page(margin, 266, page - 2 * margin, 10)} />
        </PagePaper>;
      },
    }),
    photoFramed: pageLayout({
      label: 'Framed photo', family: 'pagePhoto', variant: { style: 'framed' }, boxes: { hero: captioned('Photo') },
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx}>
          <ctx.PhotoBox id="hero" rect={at.page(30, 44, 230, 190)} />
          <Caption context={ctx} box={ctx.boxes.hero} rect={at.page(30, 240, 230, 20)} />
        </PagePaper>;
      },
    }),
    photoShaped: pageLayout({
      label: 'Shaped photo', family: 'pagePhoto', variant: { style: 'shaped' }, boxes: { hero: shapedPhoto },
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx}>
          <ctx.PhotoBox id="hero" rect={at.page(48, 36, 194, 216)}>{ShapedPhoto}</ctx.PhotoBox>
          <Caption context={ctx} box={ctx.boxes.hero} className="caption centred" rect={at.page(48, 258, 194, 10)} />
        </PagePaper>;
      },
    }),
    textPage: pageLayout({
      label: 'Story page', parameters: { heading }, boxes: { body: body('Story') },
      anchors: ({ params }) => oneLine(params.heading) ? [{ id: 'section', title: oneLine(params.heading) }] : [],
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        const titled = !!oneLine(ctx.params.heading);
        return <PagePaper context={ctx}>
          {titled && <ctx.Text presentation="inline" parameter="heading" as="h2" rect={at.page(margin, 36, 230, 42)} />}
          <ctx.MarkdownBox id="body" {...ctx.edit('document.textSize')} className="reading" columns={ctx.boxes.body.params.columns}
            rect={at.page(margin, titled ? 90 : 36, 230, titled ? 172 : 226)} />
        </PagePaper>;
      },
    }),
    notePage: pageLayout({
      label: 'Notes page', parameters: { heading, note },
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx}>
          <ctx.Text presentation="inline" parameter="heading" as="h2" rect={at.page(margin, 150, 230, 58)} />
          <ctx.Text presentation="inline" parameter="note" className="note" rect={at.page(margin, 220, 220, 42)} />
        </PagePaper>;
      },
    }),
    quotePage: pageLayout({
      label: 'Quote page', parameters: {
        quote: p.string({ label: 'Quote', default: 'Each turn opened a different view of the same water.', multiline: true, maxLength: 240, markdown: 'inline',
          description: 'One or two sentences, set large. Longer passages belong in a story.' }),
        attribution: p.string({ label: 'Attribution', default: '', maxLength: 80, placeholder: 'Who said it, or where', markdown: 'inline' }),
      },
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx}>
          <div className="statement" style={ctx.geometry.css(at.page(50, 60, 190, 170))}>
            <div className="rule" />
            <ctx.Text presentation="inline" parameter="quote" as="blockquote" className="quote" />
            <ctx.Text presentation="inline" parameter="attribution" className="attribution" />
          </div>
        </PagePaper>;
      },
    }),
    gridPage: pageLayout({ label: 'Photo grid page 2×2', family: 'pageGrid', variant: { size: '2x2' }, boxes: gridBoxes('2x2'),
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        const cells = ctx.geometry.grid(at.page(24, 24, 242, 242), { columns: 2, rows: 2, gap: at.width(gaps[ctx.document.spacing]) });
        return <PagePaper context={ctx}>{gridSizes['2x2'].ids.map((id, i) => <ctx.PhotoBox key={id} id={id} rect={cells[i]} />)}</PagePaper>;
      },
    }),
    gridPage9: pageLayout({ label: 'Photo grid page 3×3', family: 'pageGrid', variant: { size: '3x3' }, boxes: gridBoxes('3x3'),
      render: ctx => {
        const at = ctx.geometry.design(canvas);
        const cells = ctx.geometry.grid(at.page(24, 24, 242, 242), { columns: 3, rows: 3, gap: at.width(gaps[ctx.document.spacing]) });
        return <PagePaper context={ctx}>{gridSizes['3x3'].ids.map((id, i) => <ctx.PhotoBox key={id} id={id} rect={cells[i]} />)}</PagePaper>;
      },
    }),

    contents: pageLayout({
      label: 'Contents',
      parameters: { contentsHeading: p.string({ label: 'Contents heading', default: 'Contents', markdown: 'inline' }) },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        // Every spread declares its anchors before any spread renders, so this page follows inserts, moves and
        // layout switches like the folios do. Chapter openers are numbered; stories and texts are listed under them.
        const entries = ctx.book.anchors().filter(({ id }) => id === 'chapter' || id === 'section');
        let chapter = 0;
        return <PagePaper context={ctx}>
          <ctx.Text presentation="inline" parameter="contentsHeading" as="h2" rect={at.page(margin, 40, page - 2 * margin, 44)} />
          <ol className="contents" style={ctx.geometry.css(at.page(margin, 100, page - 2 * margin, 160))}>
            {entries.map((entry) => <li key={entry.spread + entry.side} className={entry.id}>
              <span>{entry.id === 'chapter' && <span className="chapter-number">{String(++chapter).padStart(2, '0')}</span>}{entry.title}</span>
              <span className="contents-page">{entry.page}</span>
            </li>)}
          </ol>
          {!entries.length && ctx.view === 'canvas' &&
            <p className="caption" style={ctx.geometry.css(at.page(margin, 100, page - 2 * margin, 10))}>Chapter openers and story pages appear here.</p>}
        </PagePaper>;
      },
    }),
    opener: spread({
      label: 'Chapter opener',
      parameters: {
        heading,
        eyebrow: p.string({ label: 'Chapter label', default: '', maxLength: 40, placeholder: 'Chapter 1', markdown: 'inline',
          description: 'The small line above the heading. Empty shows the chapter’s number, counted from the book’s chapter openers.' }),
      },
      boxes: { hero: box.photo('Chapter photo') },
      anchors: ({ params }) => [{ id: 'chapter', title: oneLine(params.heading), side: 'left' }],
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const all = ctx.geometry.spread('bleed');
        const number = ctx.book.anchors('chapter').findIndex(({ spread }) => spread === ctx.spread) + 1;
        return <Paper context={ctx} bled={{ left: true, right: true }}>
          <ctx.PhotoBox id="hero" rect={all} />
          <ctx.Text presentation="inline" parameter="eyebrow" className="eyebrow on-photo" rect={at.left(margin, 196, page - 2 * margin, 8)}
            fallback={number ? 'Chapter ' + number : ''} fallbackLabel="Chapter number" />
          <ctx.Text presentation="inline" parameter="heading" as="h2" className="on-photo opener" rect={at.left(margin, 208, page - 2 * margin, 56)} />
        </Paper>;
      },
    }),
    panorama: spread({
      label: 'Panorama',
      boxes: { hero: captioned('Panorama photo') },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <Paper context={ctx} bled={{ left: true, right: true }}>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')} />
          <Caption context={ctx} box={ctx.boxes.hero} className="caption overlay" rect={at.left(margin, 266, 2 * page - 2 * margin, 10)} />
        </Paper>;
      },
    }),
    map: spread({
      label: 'Map',
      parameters: { mapTitle: p.string({ label: 'Map title', default: '', maxLength: 80, placeholder: 'Shown on the map', markdown: 'inline' }) },
      // The map's data is credited on the last page.
      credits: ({ elements }) => mapCredits(elements.map.params.style),
      elements: { map: {
        label: 'Map',
        parameters: mapParameters,
        // Framed on the page, in the map's own place; the panel remains the fallback.
        editor: { label: 'Edit map', parameters: [...mapEditorParameters], component: MapLayoutEditor, presentation: 'inline' },
      } },
      render: (ctx) => {
        const { trackWidth, ...values } = ctx.elements.map.params;
        return <Paper context={ctx} bled={{ left: true, right: true }}>
          <MapView values={values} trackWidth={trackWidth} rect={ctx.geometry.spread('bleed')} theme={ctx.document.theme} Element={ctx.Element} />
          {ctx.params.mapTitle && <h2 className="map-title" style={ctx.geometry.css(mapTitleRect(ctx.format))}><FormattedText value={ctx.params.mapTitle} /></h2>}
        </Paper>;
      },
    }),

    // A map page pairs freely with stories, photos, notes or another map.
    mapPage: pageLayout({
      label: 'Map page',
      parameters: { mapCaption: p.string({ label: 'Map caption', default: '', maxLength: 160, placeholder: 'Where the story goes', markdown: 'inline' }) },
      elements: { map: {
        label: 'Map',
        parameters: insetMapParameters,
        editor: { label: 'Edit map', parameters: [...mapEditorParameters], component: MapEditor, presentation: 'inline' },
      } },
      credits: ({ elements }) => mapCredits(elements.map.params.style),
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const { trackWidth, ...values } = ctx.elements.map.params;
        return <PagePaper context={ctx}>
          <MapView values={values} trackWidth={trackWidth} rect={at.page(margin, margin, page - 2 * margin, page - 2 * margin - 22)}
            theme={ctx.document.theme} className="map-inset" Element={ctx.Element} />
          <ctx.Text presentation="inline" parameter="mapCaption" className="caption" rect={at.page(margin, page - margin - 12, page - 2 * margin, 10)} />
        </PagePaper>;
      },
    }),

    // Overflow picture lists are pages too; each takes the next entries in book order.
    pictures: pageLayout({
      label: 'Picture list page',
      parameters: { listHeading: p.string({ label: 'Heading', default: 'Pictures', markdown: 'inline' }) },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <PagePaper context={ctx}>
          {listsSomething(ctx) &&
            <ctx.Text presentation="inline" parameter="listHeading" as="h3" rect={at.page(margin, 36, page - 2 * margin, 14)} />}
          <PictureList context={ctx} columns={pictureColumns('pictures', at.page)} />
        </PagePaper>;
      },
    }),
  }),
  // A new book starts with a tour of the layouts, in the sample book's order, ready for photos and text. New Book can
  // also start an empty book.
  openingSpreads: [
    { layout: 'cover' },
    { pages: { left: { layout: 'photo' }, right: { layout: 'contents' } } },
    { layout: 'opener' },
    { pages: { left: { layout: 'photo' }, right: { layout: 'textPage' } } },
    { layout: 'panorama' },
    { pages: { left: { layout: 'notePage' }, right: { layout: 'gridPage' } } },
    { pages: { left: { layout: 'quotePage' }, right: { layout: 'photo' } } },
    { pages: { left: { layout: 'textPage' }, right: { layout: 'photo' } } },
    { pages: { left: { layout: 'photo' }, right: { layout: 'gridPage' } } },
    { pages: { left: { layout: 'textPage' }, right: { layout: 'textPage' } } },
    { layout: 'opener' },
    { pages: { left: { layout: 'photo' }, right: { layout: 'photo' } } },
    { pages: { left: { layout: 'notePage' }, right: { layout: 'photoShaped' } } },
    { layout: 'panorama' },
    { pages: { left: { layout: 'gridPage9' }, right: { layout: 'notePage' } } },
    { pages: { left: { layout: 'textPage' }, right: { layout: 'textPage' } } },
    { layout: 'credits' },
  ],
});
