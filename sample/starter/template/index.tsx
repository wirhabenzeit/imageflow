import { asset, box, defineTemplate, Element, file, issue, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { ElementEditorProps, ImageFlowNode, LayoutPickerProps, Photo, Rect, RenderContext } from 'imageflow';
import './styles.css';
import { MapEditor, mapEditorParameters, mapOrigin, mapParameters, MapView } from './map';

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

const heading = p.string({ label: 'Heading', default: 'Field notes', multiline: true, maxLength: 90 });
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const textSize = p.number({ label: 'Body size', default: 11, min: 8, max: 16, step: .5, unit: 'pt' });
// For layouts that draw the photo's caption. Declare the toggle only where it has an effect: the editor shows a
// control for every declared parameter. The value is shared by every layout with this box, so it returns when the
// spread switches back to a layout that draws captions.
const captioned = (label: string) => box.photo(label, { caption: p.boolean({ label: 'Show caption', default: false }) });
const columns = p.enum({ label: 'Columns', default: '1', options: ['1', '2', '3'], labels: { 1: 'Full width', 2: '2 columns', 3: '3 columns' } });
const body = (label: string, flowOrder = 1) => box.markdown(label, { flowOrder, parameters: { columns } });

const documentParameters = {
  showPageNumbers: p.boolean({ label: 'Page numbers', default: true }),
  accent: p.color({ label: 'Text colour', default: '#243b30' }),
  paper: p.enum({ label: 'Paper tone', default: 'warm', options: ['warm', 'white', 'cool'], labels: { warm: 'Warm', white: 'White', cool: 'Cool' } }),
};
// The context shared helpers need, typed with the same document parameters the template declares.
type Context = RenderContext<{ label: string }, typeof documentParameters>;

/** Paper, folios, and spread root. Pass `bled` for pages covered by a photo, which get no page number. */
function Paper({ context, bled = {}, children }: {
  context: Pick<Context, 'document' | 'page'>; bled?: { left?: boolean; right?: boolean }; children?: ImageFlowNode;
}) {
  const { document, page } = context;
  return <Spread className={'field-book ' + document.paper} style={{ '--ink': document.accent }}>
    <div className="bleed paper" />
    {children}
    {document.showPageNumbers && page.left && !bled.left && <span className="folio left-folio">{page.left}</span>}
    {document.showPageNumbers && page.right && !bled.right && <span className="folio right-folio">{page.right}</span>}
  </Spread>;
}

function Caption({ context, box, rect, className = 'caption' }: {
  context: Pick<Context, 'geometry'>; box: { params: { caption: boolean }; photo: Photo | null }; rect: Rect; className?: string;
}) {
  return box.params.caption && box.photo?.caption ? <p className={className} style={context.geometry.css(rect)}>{box.photo.caption}</p> : null;
}

// Track points of a GPX file as [longitude, latitude]. ImageFlow only checks the extension; the content is ours.
function gpxPoints(text: string) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('is not valid GPX');
  const points = Array.from(xml.querySelectorAll('trkpt, rtept')).map((node) => [Number(node.getAttribute('lon')), Number(node.getAttribute('lat'))]);
  if (points.length < 2 || points.some((point) => point.some((value) => !Number.isFinite(value)))) throw new Error('has no track');
  return points;
}

// The track as an SVG polyline in a 100 × 100 square (5 units of margin), north up, longitude scaled by latitude.
function routeLine(text: string) {
  const points = gpxPoints(text);
  const scale = Math.cos(points.reduce((sum, [, lat]) => sum + lat, 0) / points.length * Math.PI / 180);
  const xs = points.map(([lon]) => lon * scale);
  const ys = points.map(([, lat]) => -lat);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const offset = [(size - (Math.max(...xs) - minX)) / 2, (size - (Math.max(...ys) - minY)) / 2];
  return xs.map((x, i) => ((x - minX + offset[0]) / size * 90 + 5).toFixed(2) + ',' + ((ys[i] - minY + offset[1]) / size * 90 + 5).toFixed(2)).join(' ');
}

// The part of the route square the inset shows: `zoom` 1 is the whole route, centred on (centerX, centerY) in 0–1.
// The window is kept inside the square, so the centre is clamped the same way everywhere.
type Viewport = { centerX: number; centerY: number; zoom: number };
const maxRouteZoom = 8;
function routeWindow({ centerX, centerY, zoom }: Viewport) {
  const z = Math.min(maxRouteZoom, Math.max(1, zoom));
  const size = 1 / z;
  const clamp = (value: number) => Math.min(1 - size / 2, Math.max(size / 2, value));
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return { centerX: round(clamp(centerX)), centerY: round(clamp(centerY)), zoom: round(z), size };
}
const viewBox = (viewport: Viewport) => {
  const { centerX, centerY, size } = routeWindow(viewport);
  return [(centerX - size / 2) * 100, (centerY - size / 2) * 100, size * 100, size * 100].map((value) => value.toFixed(3)).join(' ');
};

// An optional route inset: the track of the assigned GPX file, drawn without a basemap and framed by its viewport.
// Without a file it is an empty frame in the editor (so it can be clicked) and nothing in the printed book.
function RouteMap({ track, viewport, mode, rect }: { track: string; viewport: Viewport; mode: Context['mode']; rect: Rect }) {
  const source = file(track);
  let line = '';
  let problem = '';
  if (source) {
    try {
      line = routeLine(source.text);
    } catch (error) {
      problem = source.name + ' ' + (error instanceof Error ? error.message : 'could not be read') + '; the route is left out.';
    }
  }
  // The Book check reports an unreadable track on the route element and its file parameter.
  const finding = problem ? issue({ code: 'gpx-invalid', message: problem, element: 'route', parameter: 'track', file: track,
    suggestion: 'Assign a GPX file that contains a track or route, or clear the GPX track.' }) : {};
  // The printed book leaves an unavailable route out, but still reports why.
  if (!line && mode !== 'edit') return problem ? <span hidden {...finding} /> : null;
  return <Element id="route" className={line ? 'route-map' : 'route-map empty'} rect={rect}>
    {line
      ? <svg viewBox={viewBox(viewport)} aria-label="Route"><polyline points={line} /></svg>
      : <span {...finding}>{problem ? 'Route unavailable' : 'Route map: add a GPX track'}</span>}
  </Element>;
}

// The route map's own editor: choose or import the GPX track with ImageFlow's file control, then drag to move,
// scroll or use the buttons to zoom, so the inset can show part of the route. Choosing the track and framing it is
// one task, so one editor owns all four parameters and applies changes while it stays open.
const routeParameters = {
  track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
  centerX: p.number({ label: 'Horizontal', default: .5, min: 0, max: 1, step: .01 }),
  centerY: p.number({ label: 'Vertical', default: .5, min: 0, max: 1, step: .01 }),
  zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: maxRouteZoom, step: .1 }),
};
// Typed from the element's declaration: `set` and `Control` accept only these four parameters, with their value types.
type RouteEditorProps = ElementEditorProps<typeof routeParameters, 'track' | 'centerX' | 'centerY' | 'zoom'>;
let routeDrag: { x: number; y: number; start: Viewport; width: number } | undefined;
function RouteEditor({ values, set, readOnly, Control }: RouteEditorProps) {
  const viewport = routeWindow(values);
  const source = file(values.track);
  let line = '';
  let problem = source ? '' : 'Choose a GPX track to draw the route.';
  if (source) {
    try {
      line = routeLine(source.text);
    } catch (error) {
      problem = source.name + ' ' + (error instanceof Error ? error.message : 'could not be read') + '.';
    }
  }
  const move = (next: Viewport) => {
    const { centerX, centerY, zoom } = routeWindow(next);
    set({ centerX, centerY, zoom });
  };
  const zoomBy = (factor: number) => move({ ...viewport, zoom: viewport.zoom * factor });
  const pan = (dx: number, dy: number) => move({ ...viewport, centerX: viewport.centerX + dx * viewport.size, centerY: viewport.centerY + dy * viewport.size });
  const track = <Control parameter="track" />;
  const editable = !readOnly && !!line;
  return <div className="route-editor">
    {track}
    <div className="route-editor-nav">
      <button type="button" aria-label="Zoom out" disabled={!editable || viewport.zoom <= 1} onClick={() => zoomBy(1 / 1.5)}>−</button>
      <button type="button" aria-label="Zoom in" disabled={!editable || viewport.zoom >= maxRouteZoom} onClick={() => zoomBy(1.5)}>+</button>
      <button type="button" disabled={!editable || viewport.zoom === 1} onClick={() => move({ centerX: .5, centerY: .5, zoom: 1 })}>Whole route</button>
      <span>{viewport.zoom > 1 ? 'Zoom ' + viewport.zoom.toFixed(1) + '×' : ''}</span>
    </div>
    <div className="route-editor-frame" role="application" aria-label="Route viewport" tabIndex={editable ? 0 : -1}
      onPointerDown={(event: PointerEvent) => {
        const frame = event.currentTarget as HTMLElement;
        if (!editable) return;
        frame.setPointerCapture(event.pointerId);
        routeDrag = { x: event.clientX, y: event.clientY, start: viewport, width: frame.clientWidth };
      }}
      onPointerMove={(event: PointerEvent) => {
        if (!routeDrag) return;
        const size = routeWindow(routeDrag.start).size;
        move({ ...routeDrag.start, centerX: routeDrag.start.centerX - (event.clientX - routeDrag.x) / routeDrag.width * size,
          centerY: routeDrag.start.centerY - (event.clientY - routeDrag.y) / routeDrag.width * size });
      }}
      onPointerUp={() => { routeDrag = undefined; }} onPointerCancel={() => { routeDrag = undefined; }}
      onWheel={(event: WheelEvent) => { if (editable) zoomBy(Math.exp(-event.deltaY * .002)); }}
      onKeyDown={(event: KeyboardEvent) => {
        const steps: Record<string, [number, number]> = { ArrowLeft: [-.1, 0], ArrowRight: [.1, 0], ArrowUp: [0, -.1], ArrowDown: [0, .1] };
        const step = Object.hasOwn(steps, event.key) ? steps[event.key] : undefined;
        if (!editable || !step) return;
        event.preventDefault();
        pan(step[0], step[1]);
      }}>
      <svg viewBox={viewBox(viewport)} aria-hidden="true"><polyline points={line} /></svg>
    </div>
    <p className="route-editor-note" role="status">{problem}</p>
  </div>;
}

// Marked days are stored as a comma-separated list of day numbers, such as "3,14".
const markedDays = (value: string) => new Set(value.split(',').map(Number).filter((day) => day > 0));

function CalendarGrid({ date, firstWeekday, marked = '', toggle }: {
  date: string; firstWeekday: 'monday' | 'sunday'; marked?: string; toggle?: (day: number) => void;
}) {
  const month = new Date(date + 'T00:00:00Z');
  month.setUTCDate(1);
  const first = firstWeekday === 'monday' ? 1 : 0;
  const offset = (month.getUTCDay() - first + 7) % 7;
  const last = new Date(month);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const count = last.getUTCDate();
  const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  return <>
    <h3>{new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(month)}</h3>
    <div className="days">
      {weekdays.map((_, i) => <strong key={i}>{weekdays[(i + first) % 7]}</strong>)}
      {Array.from({ length: count + offset }, (_, i) => {
        const day = i + 1 - offset;
        if (i < offset) return <span key={i} />;
        const isMarked = markedDays(marked).has(day);
        return toggle
          ? <button key={i} type="button" className={isMarked ? 'marked' : undefined} aria-pressed={isMarked} onClick={() => toggle(day)}>{day}</button>
          : <span key={i} className={isMarked ? 'marked' : undefined}>{day}</span>;
      })}
    </div>
  </>;
}

// The calendar's own editor: step through months and click days to mark them, and title the page. It runs in
// ImageFlow's editor dialog and only proposes values; ImageFlow validates and saves them when the user clicks Done.
// The title is a layout parameter rather than one of the grid's, edited here because naming the month belongs to
// the same task; `scope="spread"` gives it ImageFlow's own text field.
const calendarParameters = {
  month: p.date({ label: 'Month', default: '2027-01-01', precision: 'month' }),
  firstWeekday: p.enum({ label: 'Week starts', default: 'monday', options: ['monday', 'sunday'], labels: { monday: 'Monday', sunday: 'Sunday' } }),
  marked: p.string({ label: 'Marked days', default: '', maxLength: 200 }),
};
const calendarLayoutParameters = { title: p.string({ label: 'Calendar title', default: '', maxLength: 80, placeholder: 'Shown above the calendar' }) };
type CalendarEditorProps = ElementEditorProps<typeof calendarParameters, 'month' | 'marked', {}, typeof calendarLayoutParameters, 'title'>;
function CalendarEditor({ values, set, readOnly, Control }: CalendarEditorProps) {
  const month = values.month;
  const shift = (step: number) => {
    const date = new Date(month + 'T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + step, 1);
    set({ month: date.toISOString().slice(0, 10), marked: '' });
  };
  const toggle = (day: number) => {
    const days = markedDays(values.marked);
    if (!days.delete(day)) days.add(day);
    set({ marked: [...days].sort((a, b) => a - b).join(',') });
  };
  return <div className="calendar-editor">
    <Control parameter="title" scope="spread" />
    <div className="calendar-editor-nav">
      <button type="button" aria-label="Previous month" disabled={readOnly} onClick={() => shift(-1)}>‹</button>
      <button type="button" aria-label="Next month" disabled={readOnly} onClick={() => shift(1)}>›</button>
      <span>{readOnly ? '' : 'Click days to mark them. Changing the month clears the marks.'}</span>
    </div>
    <CalendarGrid date={month} firstWeekday={values.firstWeekday} marked={values.marked}
      toggle={readOnly ? undefined : toggle} />
  </div>;
}

// The photo grid comes in two sizes, declared as two ordinary layouts of the `grid` family. Their box IDs are fixed:
// the 2×2 boxes stay in the upper left of the 3×3 grid, so switching sizes keeps those photos where they were and
// keeps the other five outside the 2×2 layout until the spread switches back.
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
const gridParameters = { heading, gutter: p.integer({ label: 'Gap', default: 6, min: 2, max: 20, unit: 'mm' }) };
type GridLayout<S extends keyof typeof gridSizes> = { label: string; parameters: typeof gridParameters; boxes: ReturnType<typeof gridBoxes<S>> };
// One render function per size, typed like the builder types each layout's own context.
const photoGrid = <const S extends keyof typeof gridSizes>(size: S) => (ctx: RenderContext<GridLayout<S>, typeof documentParameters>) => {
  const { columns, ids } = gridSizes[size];
  const at = ctx.geometry.design(canvas);
  // The gap is drawn on the design page too, so it scales with the format like the cells.
  const cells = ctx.geometry.grid(at.right(20, 20, page - 40, page - 40),
    { columns, rows: columns, columnGap: at.width(ctx.params.gutter), rowGap: at.height(ctx.params.gutter) });
  return <Paper context={ctx}>
    <ctx.Text parameter="heading" as="h2" rect={at.left(margin, 196, page - 2 * margin, 64)} />
    {ids.map((id, i) => <ctx.PhotoBox id={id} key={id} rect={cells[i]} />)}
  </Paper>;
};

// The grid family's picker: one "Grid size" choice drawn as small grids. It chooses by the variants' tags, so a new
// size needs only a new layout with its tag.
function GridSizePicker({ variants, current, choose, readOnly }: LayoutPickerProps) {
  return <div className="variant-picker" role="radiogroup" aria-label="Grid size">
    {variants.map(({ id, variant }) => {
      const size = String(variant.size);
      const columns = Object.hasOwn(gridSizes, size) ? gridSizes[size as keyof typeof gridSizes].columns : 1;
      return <button key={id} type="button" role="radio" aria-checked={id === current} disabled={readOnly} onClick={() => choose(id)}>
        <span className="variant-grid" style={{ gridTemplateColumns: 'repeat(' + columns + ', 1fr)' }} aria-hidden="true">
          {Array.from({ length: columns * columns }, (_, i) => <span key={i} />)}
        </span>
        {size.replace('x', ' × ')}
      </button>;
    })}
  </div>;
}

export default defineTemplate({
  id: 'imageflow-starter',
  version: '0.7.0',
  label: 'Photobook',
  description: 'A travel journal with photographs, stories, maps, and room for your own layouts.',
  contract: 1,
  // The Map layout loads OpenFreeMap styles and tiles once the user allows it, in its editor, the page and export.
  network: [mapOrigin],
  formats: {
    square: bookFormat('WhiteWall Gallery Square · 29 × 29 cm', 290, 290),
    landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
  },
  defaultFormat: 'square',
  parameters: documentParameters,
  // Layouts that are variants of one design. The sidebar shows the grid once, and its picker chooses the size.
  layoutFamilies: { grid: { label: 'Photo grid', picker: { label: 'Grid size', component: GridSizePicker } } },
  // `spread` types each layout's context from its own declarations and the document parameters above.
  spreads: ({ spread }) => ({
    title: spread({
      label: 'Title page', span: 'right',
      parameters: { heading, subtitle: p.string({ label: 'Subtitle', default: 'A book made in ImageFlow' }) },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <Paper context={ctx}>
          <img alt="" className="compass" src={asset('compass.svg')} style={{ ...ctx.geometry.css(at.right(margin, 60, 14, 14)), objectFit: 'contain' }} />
          <ctx.Text parameter="heading" as="h1" rect={at.right(margin, 120, page - 2 * margin, 110)} />
          <ctx.Text parameter="subtitle" className="subtitle" rect={at.right(margin, 238, page - 2 * margin, 20)} />
        </Paper>;
      },
    }),
    story: spread({
      label: 'Photo and story',
      parameters: { heading, textSize },
      boxes: { hero: captioned('Main photo'), body: body('Story') },
      // Listed by the contents layout. The heading is on the right page.
      anchors: ({ params }) => [{ id: 'chapter', title: oneLine(params.heading), side: 'right' }],
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <Paper context={ctx} bled={{ left: true }}>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />
          <ctx.Text parameter="heading" as="h2" rect={at.right(margin, 40, page - 2 * margin, 44)} />
          <ctx.MarkdownBox id="body" {...ctx.edit('textSize')} className="reading" columns={ctx.boxes.body.params.columns}
            rect={at.right(margin, 100, 150, 150)} style={{ fontSize: ctx.params.textSize + 'pt' }} />
          <Caption context={ctx} box={ctx.boxes.hero} rect={at.right(margin, 262, 150, 10)} />
        </Paper>;
      },
    }),
    panorama: spread({
      label: 'Panorama',
      boxes: { hero: captioned('Panorama photo') },
      elements: { route: {
        label: 'Route map',
        parameters: routeParameters,
        editor: { label: 'Edit route', parameters: ['track', 'centerX', 'centerY', 'zoom'], component: RouteEditor },
      } },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <Paper context={ctx} bled={{ left: true, right: true }}>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')} />
          <RouteMap track={ctx.elements.route.params.track} viewport={ctx.elements.route.params} mode={ctx.mode}
            rect={at.right(page - margin - 60, margin, 60, 60)} />
          <Caption context={ctx} box={ctx.boxes.hero} className="caption overlay" rect={at.left(margin, 268, 2 * page - 2 * margin, 10)} />
        </Paper>;
      },
    }),
    map: spread({
      label: 'Map',
      parameters: { mapTitle: p.string({ label: 'Map title', default: '', maxLength: 80, placeholder: 'Shown on the map' }) },
      elements: { map: {
        label: 'Map',
        parameters: mapParameters,
        editor: { label: 'Edit map', parameters: [...mapEditorParameters], component: MapEditor },
      } },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const { trackColor, trackWidth, ...values } = ctx.elements.map.params;
        return <Paper context={ctx} bled={{ left: true, right: true }}>
          <MapView values={values} trackColor={trackColor} trackWidth={trackWidth} rect={ctx.geometry.spread('bleed')} Element={ctx.Element} />
          {ctx.params.mapTitle && <h2 className="map-title" style={ctx.geometry.css(at.left(margin, margin, 150, 22))}>{ctx.params.mapTitle}</h2>}
        </Paper>;
      },
    }),
    // `grid` keeps its ID from before the family existed, so saved books open unchanged as the 2×2 variant.
    grid: spread({
      label: 'Photo grid 2×2', family: 'grid', variant: { size: '2x2' },
      parameters: gridParameters, boxes: gridBoxes('2x2'),
      render: photoGrid('2x2'),
    }),
    grid9: spread({
      label: 'Photo grid 3×3', family: 'grid', variant: { size: '3x3' },
      parameters: gridParameters, boxes: gridBoxes('3x3'),
      render: photoGrid('3x3'),
    }),
    pair: spread({
      label: 'Two photos',
      parameters: { framed: p.boolean({ label: 'White frame', default: false }) },
      boxes: { hero: captioned('Left photo'), second: captioned('Right photo') },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const framed = ctx.params.framed;
        return <Paper context={ctx} bled={{ left: !framed, right: !framed }}>
          <ctx.PhotoBox id="hero" rect={framed ? at.left(20, 50, 250, 167) : ctx.geometry.page('left', 'bleed')} />
          <ctx.PhotoBox id="second" rect={framed ? at.right(20, 50, 250, 167) : ctx.geometry.page('right', 'bleed')} />
          <Caption context={ctx} box={ctx.boxes.hero} className={framed ? 'caption' : 'caption overlay'}
            rect={framed ? at.left(20, 222, 250, 10) : at.left(margin, 268, 200, 10)} />
          <Caption context={ctx} box={ctx.boxes.second} className={framed ? 'caption' : 'caption overlay'}
            rect={framed ? at.right(20, 222, 250, 10) : at.right(60, 268, 200, 10)} />
        </Paper>;
      },
    }),
    text: spread({
      label: 'Text spread',
      parameters: { heading, textSize },
      boxes: { body: body('Left text', 1), continuation: body('Right text', 2) },
      anchors: ({ params }) => [{ id: 'chapter', title: oneLine(params.heading), side: 'left' }],
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const size = { fontSize: ctx.params.textSize + 'pt' };
        return <Paper context={ctx}>
          <ctx.Text parameter="heading" as="h2" rect={at.left(40, 40, 210, 44)} />
          <ctx.MarkdownBox id="body" {...ctx.edit('textSize')} className="reading" columns={ctx.boxes.body.params.columns}
            rect={at.left(70, 100, 170, 160)} style={size} />
          <ctx.MarkdownBox id="continuation" {...ctx.edit('textSize')} className="reading" columns={ctx.boxes.continuation.params.columns}
            rect={at.right(50, 40, 170, 220)} style={size} />
        </Paper>;
      },
    }),
    calendar: spread({
      label: 'Calendar spread',
      parameters: calendarLayoutParameters,
      boxes: { hero: box.photo('Calendar photo') },
      elements: { grid: {
        label: 'Calendar grid',
        parameters: calendarParameters,
        editor: { label: 'Edit calendar', parameters: ['month', 'marked'], spread: ['title'], component: CalendarEditor },
      } },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <Paper context={ctx} bled={{ left: true }}>
          <ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />
          {ctx.params.title && <h2 className="calendar-title" style={ctx.geometry.css(at.right(40, 36, 210, 24))}>{ctx.params.title}</h2>}
          <ctx.Element id="grid" className="calendar-grid" rect={at.right(40, 70, 210, 170)}>
            <CalendarGrid date={ctx.elements.grid.params.month} firstWeekday={ctx.elements.grid.params.firstWeekday}
              marked={ctx.elements.grid.params.marked} />
          </ctx.Element>
        </Paper>;
      },
    }),
    contents: spread({
      label: 'Contents',
      parameters: { contentsHeading: p.string({ label: 'Contents heading', default: 'Contents' }) },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        // Every spread declares its anchors before any spread renders, so these pages follow inserts, moves and
        // layout switches like the folios do.
        const chapters = ctx.book.anchors('chapter');
        return <Paper context={ctx}>
          <ctx.Text parameter="contentsHeading" as="h2" rect={at.left(margin, 40, page - 2 * margin, 44)} />
          <ol className="contents" style={ctx.geometry.css(at.right(margin, 40, page - 2 * margin, 220))}>
            {chapters.map((chapter) => <li key={chapter.spread + chapter.side}>
              <span>{chapter.title}</span><span className="contents-page">{chapter.page}</span>
            </li>)}
          </ol>
          {!chapters.length && ctx.mode === 'edit' &&
            <p className="caption" style={ctx.geometry.css(at.right(margin, 40, page - 2 * margin, 10))}>Story and text spreads appear here.</p>}
        </Paper>;
      },
    }),
    closing: spread({
      label: 'Closing page', span: 'left',
      // Not `heading`: an ID means the same thing in every layout, and a closing line is not a spread heading.
      parameters: { closingLine: p.string({ label: 'Closing line', default: 'Until next time' }) },
      render: (ctx) => <Paper context={ctx}>
        <ctx.Text parameter="closingLine" as="h2" rect={ctx.geometry.design(canvas).left(margin, 120, page - 2 * margin, 60)} />
      </Paper>,
    }),
  }),
  // A new book without the sample content starts with a title page, one story spread and the closing page.
  openingSpreads: [{ layout: 'title' }, { layout: 'story' }, { layout: 'closing' }],
});
