import { asset, defineTemplate, spreadFor, p, mm, pt, Spread, PhotoBox, MarkdownBox, Element } from 'imageflow';
import type { CSSProperties, ElementEditorProps, ImageFlowNode, Photo, RenderContext } from 'imageflow';
import './styles.css';

// Page geometry in millimetres from the trim edge of the left or right page. Negative values and sizes past
// the trim reach into the 3 mm bleed; WhiteWall's layflat binding has no bleed at the gutter.
const bleed = 3;
const page = 290;
const margin = 30;
const inset = mm(5);

function left(x: number, y: number, width: number, height: number): CSSProperties {
  return { position: 'absolute', left: x + 'mm', top: y + 'mm', width: width + 'mm', height: height + 'mm' };
}
function right(x: number, y: number, width: number, height: number): CSSProperties {
  return { ...left(x, y, width, height), left: 'calc(var(--trim-width) + ' + x + 'mm)' };
}
const fullLeft = left(-bleed, -bleed, page + bleed, page + 2 * bleed);
const fullRight = right(0, -bleed, page + bleed, page + 2 * bleed);

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
  version: '0.2.0',
  contract: 1,
  format: {
    label: 'WhiteWall Gallery Square · 29 × 29 cm',
    trim: { width: mm(page), height: mm(page) },
    bleed: { top: mm(bleed), bottom: mm(bleed), outside: mm(bleed), binding: mm(0) },
    safe: { top: inset, bottom: inset, outside: inset, binding: inset },
    structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 28, max: 112, step: 4 } },
    output: {
      container: 'pdf', colorSpace: 'sRGB', transparency: 'allow',
      resolution: { minimum: 180, target: 250, maximum: 300 }, minimumTextSize: pt(8),
      fonts: { allowType3: false, allowSystemFonts: false },
      maximumFileSize: { pages: 500_000_000 },
    },
  },
  parameters: documentParameters,
  spreads: {
    title: spread({
      label: 'Title page', span: 'right',
      parameters: { heading, subtitle: p.string({ label: 'Subtitle', default: 'A book made in ImageFlow' }) },
      render: (ctx) => <Paper context={ctx}>
        <img alt="" className="compass" src={asset('compass.svg')} style={right(margin, 60, 14, 14)} />
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
        <PhotoBox id="hero" style={left(-bleed, -bleed, 2 * page + 2 * bleed, page + 2 * bleed)} />
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
      elements: { grid: {
        label: 'Calendar grid',
        parameters: {
          month: p.date({ label: 'Month', default: '2027-01-01', precision: 'month' }),
          firstWeekday: p.enum({ label: 'Week starts', default: 'monday', options: ['monday', 'sunday'], labels: { monday: 'Monday', sunday: 'Sunday' } }),
          marked: p.string({ label: 'Marked days', default: '', maxLength: 200 }),
        },
        editor: { label: 'Edit calendar', parameters: ['month', 'marked'], component: CalendarEditor },
      } },
      render: (ctx) => <Paper context={ctx} bled={{ left: true }}>
        <PhotoBox id="hero" style={fullLeft} />
        <Element id="grid" className="calendar-grid" style={right(40, 70, 210, 170)}>
          <CalendarGrid date={ctx.elements.grid.params.month} firstWeekday={ctx.elements.grid.params.firstWeekday}
            marked={ctx.elements.grid.params.marked} />
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
