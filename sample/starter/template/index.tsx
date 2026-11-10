import { asset, defineTemplate, p, mm, pt, Spread, PhotoBox, MarkdownBox, Element } from 'imageflow';
import './styles.css';

const inset = mm(5);
const heading = p.string({ label: 'Heading', default: 'Field notes', multiline: true, maxLength: 90 });
const photo = (label) => ({
  type: 'photo',
  label,
  parameters: { caption: p.boolean({ label: 'Show caption', default: false }) },
});
const body = (label, flowOrder = 1) => ({ type: 'markdown', label, flowOrder });
const left = (x, y, width, height) => ({ position: 'absolute', left: x + 'mm', top: y + 'mm', width: width + 'mm', height: height + 'mm' });
const right = (x, y, width, height) => ({ ...left(x, y, width, height), left: 'calc(var(--trim-width) + ' + x + 'mm)' });

function Pages({ page, document }) {
  return document.showPageNumbers ? <>
    {page.left && <span className="folio left-folio">{page.left}</span>}
    {page.right && <span className="folio right-folio">{page.right}</span>}
  </> : null;
}

function Paper({ context, children }) {
  return <Spread className={'field-book ' + context.document.paper} style={{ '--ink': context.document.accent }}>
    <div className="bleed paper" />
    {children}
    <Pages page={context.page} document={context.document} />
  </Spread>;
}

function Caption({ box, style }) {
  return box.params.caption && box.photo?.caption ? <p className="caption" style={style}>{box.photo.caption}</p> : null;
}

function CalendarGrid({ date, firstWeekday }) {
  const day = new Date(date + 'T00:00:00Z');
  const month = new Date(day);
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
  version: '0.1.0',
  contract: 1,
  format: {
    label: 'WhiteWall Gallery Square · 29 × 29 cm',
    trim: { width: mm(290), height: mm(290) },
    bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
    safe: { top: inset, bottom: inset, outside: inset, binding: inset },
    structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 28, max: 112, step: 4 } },
    output: {
      container: 'pdf', colorSpace: 'sRGB', transparency: 'allow',
      resolution: { minimum: 180, target: 250, maximum: 300 }, minimumTextSize: pt(8),
      fonts: { allowType3: false, allowSystemFonts: false },
      maximumFileSize: { pages: 500000000 },
    },
  },
  parameters: {
    showPageNumbers: p.boolean({ label: 'Page numbers', default: true }),
    accent: p.color({ label: 'Text colour', default: '#243b30' }),
    paper: p.enum({ label: 'Paper tone', default: 'warm', options: ['warm', 'white', 'cool'], labels: { warm: 'Warm', white: 'White', cool: 'Cool' } }),
  },
  spreads: {
    title: {
      label: 'Title page', span: 'right',
      parameters: { heading, subtitle: p.string({ label: 'Subtitle', default: 'A book made in ImageFlow' }) },
      render: (ctx) => <Paper context={ctx}>
        <img alt="" className="compass" src={asset('compass.svg')} style={right(40, 35, 14, 14)} />
        <h1 style={right(40, 73, 196, 118)}>{ctx.params.heading}</h1>
        <p className="subtitle" style={right(40, 194, 170, 35)}>{ctx.params.subtitle}</p>
      </Paper>,
    },
    story: {
      label: 'Photo and story',
      parameters: {
        heading,
        textSize: p.number({ label: 'Body size', default: 15, min: 9, max: 26, step: .5, unit: 'pt' }),
      },
      boxes: { hero: photo('Main photo'), body: body('Story') },
      render: (ctx) => <Paper context={ctx}>
        <PhotoBox id="hero" style={left(105, 100, 68, 65)} />
        <Caption box={ctx.boxes.hero} style={left(105, 169, 100, 15)} />
        <h2 style={right(37, 47, 199, 42)}>{ctx.params.heading}</h2>
        <MarkdownBox id="body" className="reading" style={{ ...right(37, 102, 90, 96), fontSize: ctx.params.textSize + 'pt' }} />
      </Paper>,
    },
    panorama: {
      label: 'Panorama',
      parameters: { heading },
      boxes: { hero: photo('Panorama photo') },
      render: (ctx) => <Paper context={ctx}>
        <h2 style={left(52, 71, 200, 50)}>{ctx.params.heading}</h2>
        <PhotoBox id="hero" style={right(97, 103, 95, 42)} />
        <Caption box={ctx.boxes.hero} style={right(97, 150, 112, 18)} />
      </Paper>,
    },
    grid: {
      label: 'Photo grid',
      parameters: { heading, gutter: p.integer({ label: 'Gap', default: 9, min: 5, max: 24, unit: 'mm' }) },
      boxes: { hero: photo('Upper left'), second: photo('Upper right'), third: photo('Lower left'), fourth: photo('Lower right') },
      render: (ctx) => <Paper context={ctx}>
        <h2 style={left(47, 88, 204, 70)}>{ctx.params.heading}</h2>
        {['hero', 'second', 'third', 'fourth'].map((id, i) => <PhotoBox id={id} key={id}
          style={right(70 + (i % 2) * (60 + ctx.params.gutter), 64 + Math.floor(i / 2) * (54 + ctx.params.gutter), 60, 54)} />)}
      </Paper>,
    },
    pair: {
      label: 'Two photos',
      parameters: { heading },
      boxes: { hero: photo('Left photo'), second: photo('Right photo') },
      render: (ctx) => <Paper context={ctx}>
        <h2 style={left(51, 50, 210, 52)}>{ctx.params.heading}</h2>
        <PhotoBox id="hero" style={left(109, 120, 72, 59)} />
        <Caption box={ctx.boxes.hero} style={left(109, 182, 116, 18)} />
        <PhotoBox id="second" style={right(109, 120, 72, 59)} />
        <Caption box={ctx.boxes.second} style={right(109, 182, 116, 18)} />
      </Paper>,
    },
    text: {
      label: 'Text spread',
      parameters: { heading },
      boxes: { body: body('Left text', 1), continuation: body('Right text', 2) },
      render: (ctx) => <Paper context={ctx}>
        <h2 style={left(48, 47, 194, 52)}>{ctx.params.heading}</h2>
        <MarkdownBox id="body" className="reading" style={left(48, 112, 108, 97)} />
        <MarkdownBox id="continuation" className="reading" style={right(48, 112, 108, 97)} />
      </Paper>,
    },
    calendar: {
      label: 'Calendar spread',
      parameters: { month: p.date({ label: 'Month', default: '2027-01-01' }) },
      boxes: { hero: photo('Calendar photo') },
      elements: { grid: { label: 'Calendar grid', parameters: {
        firstWeekday: p.enum({ label: 'Week starts', default: 'monday', options: ['monday', 'sunday'] }),
      } } },
      render: (ctx) => <Paper context={ctx}>
        <PhotoBox id="hero" style={left(107, 107, 76, 61)} />
        <Element id="grid" className="calendar-grid" style={right(67, 69, 153, 151)}>
          <CalendarGrid date={ctx.params.month} firstWeekday={ctx.elements.grid.params.firstWeekday} />
        </Element>
      </Paper>,
    },
    closing: {
      label: 'Closing page', span: 'left',
      parameters: { heading: p.string({ label: 'Closing line', default: 'Until next time' }) },
      render: (ctx) => <Paper context={ctx}><h2 style={left(45, 101, 195, 70)}>{ctx.params.heading}</h2></Paper>,
    },
  },
});
