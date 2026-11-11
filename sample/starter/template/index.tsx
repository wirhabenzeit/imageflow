import { asset, box, defineTemplate, Element, file, geometry, issue, mm, p, pt, Spread, spreadFor } from 'imageflow';
import type { CSSProperties, ElementEditorProps, ImageFlowNode, Photo, RenderContext, ResolvedFormat } from 'imageflow';
import './styles.css';

// Layouts are drawn on a 290 × 290 design page, measured from the trim edge of the left or right page.
// `geometry.design` scales them to the chosen format: horizontal values with the trim width, vertical values with
// the trim height. Type sizes stay in points.
const page = 290;
const margin = 30;
const bleed = 3;
const inset = mm(5);

// Design-page positions as CSS for one format, and the full-bleed areas photos fill.
function draw(format: ResolvedFormat) {
  const design = geometry.design(format, { width: page, height: page });
  const place = (side: 'left' | 'right') => (x: number, y: number, width: number, height: number) =>
    geometry.css(design[side](x, y, width, height));
  return {
    design, left: place('left'), right: place('right'),
    // Full-bleed photos reach into the bleed on the outside, top and bottom. The edge at the fold stays at the fold.
    full: {
      left: geometry.css(geometry.page(format, 'left', 'bleed')), right: geometry.css(geometry.page(format, 'right', 'bleed')),
      spread: geometry.css(geometry.spread(format, 'bleed')),
    },
  };
}

// One print format per size; they share bleed, safe area, page count and output rules.
function bookFormat(label: string, width: number, height: number) {
  return {
    label,
    trim: { width: mm(width), height: mm(height) },
    bleed: { top: mm(bleed), bottom: mm(bleed), outside: mm(bleed), binding: mm(0) },
    safe: { top: inset, bottom: inset, outside: inset, binding: inset },
    structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 28, max: 112, step: 4 } },
    output: {
      container: 'pdf', colorSpace: 'sRGB', transparency: 'allow',
      resolution: { minimum: 180, target: 250, maximum: 300 }, minimumTextSize: pt(8),
      fonts: { allowType3: false, allowSystemFonts: false },
      maximumFileSize: { pages: 500_000_000 },
    },
  } as const;
}

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
const spread = spreadFor(documentParameters);
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

function Caption({ box, style, className = 'caption' }: {
  box: { params: { caption: boolean }; photo: Photo | null }; style: CSSProperties; className?: string;
}) {
  return box.params.caption && box.photo?.caption ? <p className={className} style={style}>{box.photo.caption}</p> : null;
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
function RouteMap({ track, viewport, mode, style }: { track: string; viewport: Viewport; mode: Context['mode']; style: CSSProperties }) {
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
  return <Element id="route" className={line ? 'route-map' : 'route-map empty'} style={style}>
    {line
      ? <svg viewBox={viewBox(viewport)} aria-label="Route"><polyline points={line} /></svg>
      : <span {...finding}>{problem ? 'Route unavailable' : 'Route map: add a GPX track'}</span>}
  </Element>;
}

// The route map's own editor: drag to move, scroll or use the buttons to zoom, so the inset can show part of the
// route. It edits the three viewport parameters together; the GPX track keeps its generated control.
let routeDrag: { x: number; y: number; start: Viewport; width: number } | undefined;
function RouteEditor({ values, set, readOnly }: ElementEditorProps) {
  const viewport = routeWindow({ centerX: Number(values.centerX), centerY: Number(values.centerY), zoom: Number(values.zoom) });
  const source = file(String(values.track));
  let line = '';
  let problem = source ? '' : 'Choose a GPX track for the route map first.';
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
  if (!line) return <div className="route-editor"><p className="route-editor-note">{problem}</p></div>;
  const editable = !readOnly;
  return <div className="route-editor">
    <div className="route-editor-nav">
      <button type="button" aria-label="Zoom out" disabled={!editable || viewport.zoom <= 1} onClick={() => zoomBy(1 / 1.5)}>−</button>
      <button type="button" aria-label="Zoom in" disabled={!editable || viewport.zoom >= maxRouteZoom} onClick={() => zoomBy(1.5)}>+</button>
      <button type="button" disabled={!editable || viewport.zoom === 1} onClick={() => move({ centerX: .5, centerY: .5, zoom: 1 })}>Whole route</button>
      <span>{editable ? 'Drag to move, scroll to zoom. Arrow keys move too.' : ''}</span>
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
    <p className="route-editor-note">{viewport.zoom === 1 ? 'Shows the whole route.' : 'Zoom ' + viewport.zoom.toFixed(1) + '×'}</p>
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

// The calendar's own editor: step through months and click days to mark them. It runs in ImageFlow's editor
// dialog and only proposes values; ImageFlow validates and saves them when the user clicks Done.
function CalendarEditor({ values, set, readOnly }: ElementEditorProps) {
  const month = String(values.month);
  const shift = (step: number) => {
    const date = new Date(month + 'T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + step, 1);
    set({ month: date.toISOString().slice(0, 10), marked: '' });
  };
  const toggle = (day: number) => {
    const days = markedDays(String(values.marked));
    if (!days.delete(day)) days.add(day);
    set({ marked: [...days].sort((a, b) => a - b).join(',') });
  };
  return <div className="calendar-editor">
    <div className="calendar-editor-nav">
      <button type="button" aria-label="Previous month" disabled={readOnly} onClick={() => shift(-1)}>‹</button>
      <button type="button" aria-label="Next month" disabled={readOnly} onClick={() => shift(1)}>›</button>
      <span>{readOnly ? '' : 'Click days to mark them. Changing the month clears the marks.'}</span>
    </div>
    <CalendarGrid date={month} firstWeekday={values.firstWeekday === 'sunday' ? 'sunday' : 'monday'} marked={String(values.marked)}
      toggle={readOnly ? undefined : toggle} />
  </div>;
}

export default defineTemplate({
  id: 'imageflow-starter',
  version: '0.3.0',
  contract: 1,
  requires: ['anchors', 'geometry', 'box-helpers', 'template-issues', 'typed-components'],
  formats: {
    square: bookFormat('WhiteWall Gallery Square · 29 × 29 cm', 290, 290),
    landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
  },
  defaultFormat: 'square',
  parameters: documentParameters,
  spreads: {
    title: spread({
      label: 'Title page', span: 'right',
      parameters: { heading, subtitle: p.string({ label: 'Subtitle', default: 'A book made in ImageFlow' }) },
      render: (ctx) => {
        const at = draw(ctx.format);
        return <Paper context={ctx}>
          <img alt="" className="compass" src={asset('compass.svg')} style={{ ...at.right(margin, 60, 14, 14), objectFit: 'contain' }} />
          <h1 {...ctx.edit('heading')} style={at.right(margin, 120, page - 2 * margin, 110)}>{ctx.params.heading}</h1>
          <p {...ctx.edit('subtitle')} className="subtitle" style={at.right(margin, 238, page - 2 * margin, 20)}>{ctx.params.subtitle}</p>
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
        const at = draw(ctx.format);
        return <Paper context={ctx} bled={{ left: true }}>
          <ctx.PhotoBox id="hero" style={at.full.left} />
          <h2 {...ctx.edit('heading')} style={at.right(margin, 40, page - 2 * margin, 44)}>{ctx.params.heading}</h2>
          <ctx.MarkdownBox id="body" {...ctx.edit('textSize')} className="reading" columns={ctx.boxes.body.params.columns}
            style={{ ...at.right(margin, 100, 150, 150), fontSize: ctx.params.textSize + 'pt' }} />
          <Caption box={ctx.boxes.hero} style={at.right(margin, 262, 150, 10)} />
        </Paper>;
      },
    }),
    panorama: spread({
      label: 'Panorama',
      boxes: { hero: captioned('Panorama photo') },
      elements: { route: {
        label: 'Route map',
        parameters: {
          track: p.file({ label: 'GPX track', accept: ['.gpx'] }),
          centerX: p.number({ label: 'Horizontal', default: .5, min: 0, max: 1, step: .01 }),
          centerY: p.number({ label: 'Vertical', default: .5, min: 0, max: 1, step: .01 }),
          zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: maxRouteZoom, step: .1 }),
        },
        editor: { label: 'Frame route', parameters: ['centerX', 'centerY', 'zoom'], component: RouteEditor },
      } },
      render: (ctx) => {
        const at = draw(ctx.format);
        return <Paper context={ctx} bled={{ left: true, right: true }}>
          <ctx.PhotoBox id="hero" style={at.full.spread} />
          <RouteMap track={ctx.elements.route.params.track} viewport={ctx.elements.route.params} mode={ctx.mode}
            style={at.right(page - margin - 60, margin, 60, 60)} />
          <Caption box={ctx.boxes.hero} className="caption overlay" style={at.left(margin, 268, 2 * page - 2 * margin, 10)} />
        </Paper>;
      },
    }),
    grid: spread({
      label: 'Photo grid',
      parameters: { heading, gutter: p.integer({ label: 'Gap', default: 6, min: 2, max: 20, unit: 'mm' }) },
      boxes: { hero: box.photo('Upper left'), second: box.photo('Upper right'), third: box.photo('Lower left'), fourth: box.photo('Lower right') },
      render: (ctx) => {
        const at = draw(ctx.format);
        // The gap is drawn on the design page too, so it scales with the format like the cells.
        const cells = geometry.grid(at.design.right(20, 20, page - 40, page - 40),
          { columns: 2, rows: 2, columnGap: at.design.width(ctx.params.gutter), rowGap: at.design.height(ctx.params.gutter) });
        return <Paper context={ctx}>
          <h2 {...ctx.edit('heading')} style={at.left(margin, 196, page - 2 * margin, 64)}>{ctx.params.heading}</h2>
          {(['hero', 'second', 'third', 'fourth'] as const).map((id, i) => <ctx.PhotoBox id={id} key={id} style={geometry.css(cells[i])} />)}
        </Paper>;
      },
    }),
    pair: spread({
      label: 'Two photos',
      parameters: { framed: p.boolean({ label: 'White frame', default: false }) },
      boxes: { hero: captioned('Left photo'), second: captioned('Right photo') },
      render: (ctx) => {
        const at = draw(ctx.format);
        const framed = ctx.params.framed;
        return <Paper context={ctx} bled={{ left: !framed, right: !framed }}>
          <ctx.PhotoBox id="hero" style={framed ? at.left(20, 50, 250, 167) : at.full.left} />
          <ctx.PhotoBox id="second" style={framed ? at.right(20, 50, 250, 167) : at.full.right} />
          <Caption box={ctx.boxes.hero} className={framed ? 'caption' : 'caption overlay'}
            style={framed ? at.left(20, 222, 250, 10) : at.left(margin, 268, 200, 10)} />
          <Caption box={ctx.boxes.second} className={framed ? 'caption' : 'caption overlay'}
            style={framed ? at.right(20, 222, 250, 10) : at.right(60, 268, 200, 10)} />
        </Paper>;
      },
    }),
    text: spread({
      label: 'Text spread',
      parameters: { heading, textSize },
      boxes: { body: body('Left text', 1), continuation: body('Right text', 2) },
      anchors: ({ params }) => [{ id: 'chapter', title: oneLine(params.heading), side: 'left' }],
      render: (ctx) => {
        const at = draw(ctx.format);
        const size = { fontSize: ctx.params.textSize + 'pt' };
        return <Paper context={ctx}>
          <h2 {...ctx.edit('heading')} style={at.left(40, 40, 210, 44)}>{ctx.params.heading}</h2>
          <ctx.MarkdownBox id="body" {...ctx.edit('textSize')} className="reading" columns={ctx.boxes.body.params.columns}
            style={{ ...at.left(70, 100, 170, 160), ...size }} />
          <ctx.MarkdownBox id="continuation" {...ctx.edit('textSize')} className="reading" columns={ctx.boxes.continuation.params.columns}
            style={{ ...at.right(50, 40, 170, 220), ...size }} />
        </Paper>;
      },
    }),
    calendar: spread({
      label: 'Calendar spread',
      boxes: { hero: box.photo('Calendar photo') },
      elements: { grid: {
        label: 'Calendar grid',
        parameters: {
          month: p.date({ label: 'Month', default: '2027-01-01', precision: 'month' }),
          firstWeekday: p.enum({ label: 'Week starts', default: 'monday', options: ['monday', 'sunday'], labels: { monday: 'Monday', sunday: 'Sunday' } }),
          marked: p.string({ label: 'Marked days', default: '', maxLength: 200 }),
        },
        editor: { label: 'Edit calendar', parameters: ['month', 'marked'], component: CalendarEditor },
      } },
      render: (ctx) => {
        const at = draw(ctx.format);
        return <Paper context={ctx} bled={{ left: true }}>
          <ctx.PhotoBox id="hero" style={at.full.left} />
          <ctx.Element id="grid" className="calendar-grid" style={at.right(40, 70, 210, 170)}>
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
        const at = draw(ctx.format);
        // Every spread declares its anchors before any spread renders, so these pages follow inserts, moves and
        // layout switches like the folios do.
        const chapters = ctx.book.anchors('chapter');
        return <Paper context={ctx}>
          <h2 {...ctx.edit('contentsHeading')} style={at.left(margin, 40, page - 2 * margin, 44)}>{ctx.params.contentsHeading}</h2>
          <ol className="contents" style={at.right(margin, 40, page - 2 * margin, 220)}>
            {chapters.map((chapter) => <li key={chapter.spread + chapter.side}>
              <span>{chapter.title}</span><span className="contents-page">{chapter.page}</span>
            </li>)}
          </ol>
          {!chapters.length && ctx.mode === 'edit' &&
            <p className="caption" style={at.right(margin, 40, page - 2 * margin, 10)}>Story and text spreads appear here.</p>}
        </Paper>;
      },
    }),
    closing: spread({
      label: 'Closing page', span: 'left',
      // Not `heading`: an ID means the same thing in every layout, and a closing line is not a spread heading.
      parameters: { closingLine: p.string({ label: 'Closing line', default: 'Until next time' }) },
      render: (ctx) => <Paper context={ctx}>
        <h2 {...ctx.edit('closingLine')} style={draw(ctx.format).left(margin, 120, page - 2 * margin, 60)}>{ctx.params.closingLine}</h2>
      </Paper>,
    }),
  },
});
