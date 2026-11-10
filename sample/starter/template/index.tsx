import { asset, defineTemplate, spreadFor, p, mm, pt, Spread, PhotoBox, MarkdownBox, Element } from 'imageflow';
import type { CSSProperties, ImageFlowNode, Photo, RenderContext } from 'imageflow';
import './styles.css';

// Layouts are drawn on a 290 × 290 design page, measured from the trim edge of the left or right page. They
// scale with the chosen format: horizontal values with the trim width, vertical values with the trim height.
const page = 290;
const margin = 30;
const bleed = 3;
const inset = mm(5);
const across = (value: number) => 'calc(var(--trim-width) * ' + value / page + ')';
const down = (value: number) => 'calc(var(--trim-height) * ' + value / page + ')';

function left(x: number, y: number, width: number, height: number): CSSProperties {
  return { position: 'absolute', left: across(x), top: down(y), width: across(width), height: down(height) };
}
function right(x: number, y: number, width: number, height: number): CSSProperties {
  return { ...left(x, y, width, height), left: 'calc(var(--trim-width) + ' + across(x) + ')' };
}
// Full-bleed photos reach into the bleed on the outside, top and bottom. WhiteWall's layflat binding has no
// bleed at the gutter.
const fullHeight = { top: 'calc(-1 * var(--bleed-top))', height: 'calc(var(--trim-height) + var(--bleed-top) + var(--bleed-bottom))' };
const fullLeft: CSSProperties = { position: 'absolute', ...fullHeight,
  left: 'calc(-1 * var(--bleed-outside))', width: 'calc(var(--trim-width) + var(--bleed-outside))' };
const fullRight: CSSProperties = { ...fullLeft, left: 'var(--trim-width)' };
const fullSpread: CSSProperties = { ...fullLeft, width: 'calc(2 * var(--trim-width) + 2 * var(--bleed-outside))' };

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
const textSize = p.number({ label: 'Body size', default: 11, min: 8, max: 16, step: .5, unit: 'pt' });
const photo = (label: string) => ({
  type: 'photo' as const,
  label,
  parameters: { caption: p.boolean({ label: 'Show caption', default: false }) },
});
const columns = p.enum({ label: 'Columns', default: '1', options: ['1', '2', '3'], labels: { 1: 'Full width', 2: '2 columns', 3: '3 columns' } });
const body = (label: string, flowOrder = 1) => ({ type: 'markdown' as const, label, flowOrder, parameters: { columns } });

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

function CalendarGrid({ date, firstWeekday }: { date: string; firstWeekday: 'monday' | 'sunday' }) {
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
      {Array.from({ length: count + offset }, (_, i) => <span key={i}>{i < offset ? '' : i + 1 - offset}</span>)}
    </div>
  </>;
}

export default defineTemplate({
  id: 'imageflow-starter',
  version: '0.2.0',
  contract: 1,
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
      render: (ctx) => <Paper context={ctx}>
        <img alt="" className="compass" src={asset('compass.svg')} style={{ ...right(margin, 60, 14, 14), objectFit: 'contain' }} />
        <h1 {...ctx.edit('heading')} style={right(margin, 120, page - 2 * margin, 110)}>{ctx.params.heading}</h1>
        <p {...ctx.edit('subtitle')} className="subtitle" style={right(margin, 238, page - 2 * margin, 20)}>{ctx.params.subtitle}</p>
      </Paper>,
    }),
    story: spread({
      label: 'Photo and story',
      parameters: { heading, textSize },
      boxes: { hero: photo('Main photo'), body: body('Story') },
      render: (ctx) => <Paper context={ctx} bled={{ left: true }}>
        <PhotoBox id="hero" style={fullLeft} />
        <h2 {...ctx.edit('heading')} style={right(margin, 40, page - 2 * margin, 44)}>{ctx.params.heading}</h2>
        <MarkdownBox id="body" {...ctx.edit('textSize')} className="reading" columns={Number(ctx.boxes.body.params.columns)}
          style={{ ...right(margin, 100, 150, 150), fontSize: ctx.params.textSize + 'pt' }} />
        <Caption box={ctx.boxes.hero} style={right(margin, 262, 150, 10)} />
      </Paper>,
    }),
    panorama: spread({
      label: 'Panorama',
      boxes: { hero: photo('Panorama photo') },
      render: (ctx) => <Paper context={ctx} bled={{ left: true, right: true }}>
        <PhotoBox id="hero" style={fullSpread} />
        <Caption box={ctx.boxes.hero} className="caption overlay" style={left(margin, 268, 2 * page - 2 * margin, 10)} />
      </Paper>,
    }),
    grid: spread({
      label: 'Photo grid',
      parameters: { heading, gutter: p.integer({ label: 'Gap', default: 6, min: 2, max: 20, unit: 'mm' }) },
      boxes: { hero: photo('Upper left'), second: photo('Upper right'), third: photo('Lower left'), fourth: photo('Lower right') },
      render: (ctx) => {
        const cell = (page - 2 * 20 - ctx.params.gutter) / 2;
        return <Paper context={ctx}>
          <h2 {...ctx.edit('heading')} style={left(margin, 196, page - 2 * margin, 64)}>{ctx.params.heading}</h2>
          {(['hero', 'second', 'third', 'fourth'] as const).map((id, i) => <PhotoBox id={id} key={id}
            style={right(20 + (i % 2) * (cell + ctx.params.gutter), 20 + Math.floor(i / 2) * (cell + ctx.params.gutter), cell, cell)} />)}
        </Paper>;
      },
    }),
    pair: spread({
      label: 'Two photos',
      parameters: { framed: p.boolean({ label: 'White frame', default: false }) },
      boxes: { hero: photo('Left photo'), second: photo('Right photo') },
      render: (ctx) => {
        const framed = ctx.params.framed;
        return <Paper context={ctx} bled={{ left: !framed, right: !framed }}>
          <PhotoBox id="hero" style={framed ? left(20, 50, 250, 167) : fullLeft} />
          <PhotoBox id="second" style={framed ? right(20, 50, 250, 167) : fullRight} />
          <Caption box={ctx.boxes.hero} className={framed ? 'caption' : 'caption overlay'}
            style={framed ? left(20, 222, 250, 10) : left(margin, 268, 200, 10)} />
          <Caption box={ctx.boxes.second} className={framed ? 'caption' : 'caption overlay'}
            style={framed ? right(20, 222, 250, 10) : right(60, 268, 200, 10)} />
        </Paper>;
      },
    }),
    text: spread({
      label: 'Text spread',
      parameters: { heading, textSize },
      boxes: { body: body('Left text', 1), continuation: body('Right text', 2) },
      render: (ctx) => {
        const size = { fontSize: ctx.params.textSize + 'pt' };
        return <Paper context={ctx}>
          <h2 {...ctx.edit('heading')} style={left(40, 40, 210, 44)}>{ctx.params.heading}</h2>
          <MarkdownBox id="body" {...ctx.edit('textSize')} className="reading" columns={Number(ctx.boxes.body.params.columns)} style={{ ...left(70, 100, 170, 160), ...size }} />
          <MarkdownBox id="continuation" {...ctx.edit('textSize')} className="reading" columns={Number(ctx.boxes.continuation.params.columns)}
            style={{ ...right(50, 40, 170, 220), ...size }} />
        </Paper>;
      },
    }),
    calendar: spread({
      label: 'Calendar spread',
      boxes: { hero: photo('Calendar photo') },
      elements: { grid: { label: 'Calendar grid', parameters: {
        month: p.date({ label: 'Month', default: '2027-01-01', precision: 'month' }),
        firstWeekday: p.enum({ label: 'Week starts', default: 'monday', options: ['monday', 'sunday'], labels: { monday: 'Monday', sunday: 'Sunday' } }),
      } } },
      render: (ctx) => <Paper context={ctx} bled={{ left: true }}>
        <PhotoBox id="hero" style={fullLeft} />
        <Element id="grid" className="calendar-grid" style={right(40, 70, 210, 170)}>
          <CalendarGrid date={ctx.elements.grid.params.month} firstWeekday={ctx.elements.grid.params.firstWeekday} />
        </Element>
      </Paper>,
    }),
    closing: spread({
      label: 'Closing page', span: 'left',
      parameters: { heading: p.string({ label: 'Closing line', default: 'Until next time' }) },
      render: (ctx) => <Paper context={ctx}><h2 {...ctx.edit('heading')} style={left(margin, 120, page - 2 * margin, 60)}>{ctx.params.heading}</h2></Paper>,
    }),
  },
});
