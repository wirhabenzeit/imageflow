import { box, defineTemplate, inch, issue, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { ImageFlowNode, Photo, RenderContext } from 'imageflow';
import './styles.css';

// A wall calendar without facing pages: a cover, then one page per month. Each page is a full-bleed photo with a
// narrow strip on the right: the photo's place written down the strip, a thin rule, the month, and its days.
//
// Layouts are drawn on a 420 × 297 design page (A-series landscape), measured from the trim edge.
// `ctx.geometry.design` scales positions to the chosen format; type sizes are scaled with `fit` so every format keeps
// the same proportions.
const canvas = { width: 420, height: 297 };
const strip = { x: 393, width: 27 };
const rule = 70;

// The printer specifies each format as a 400 dpi document in pixels, bleed included, with 31 px of bleed on every
// side. The trim is what remains: 60 × 45 is 9417 × 6677 px, so 9355 × 6615 px, or 594 × 420 mm (A2).
const dpi = 400;
const bleedPixels = 31;
const pixels = (value: number) => inch(value / dpi);
const calendarFormat = (label: string, width: number, height: number) => printFormat({
  label,
  trim: { width: pixels(width - 2 * bleedPixels), height: pixels(height - 2 * bleedPixels) },
  facingPages: false,
  bleed: pixels(bleedPixels),
  safe: mm(5),
  // Any number of pages: twelve months with or without a cover, or longer calendars.
  pageCount: { min: 1, max: 36, step: 1 },
  output: {
    resolution: { minimum: 150, target: 300, maximum: dpi }, minimumTextSize: pt(6),
    fonts: { allowType3: false, allowSystemFonts: false },
    maximumFileSize: { pages: 1_000_000_000 },
  },
});

const languages = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', nl: 'Nederlands' } as const;
type Language = keyof typeof languages;

const documentParameters = {
  firstMonth: p.date({ label: 'First month', default: '2027-01-01', precision: 'month' }),
  language: p.enum({ label: 'Month and day names', default: 'en', options: ['en', 'de', 'fr', 'es', 'it', 'nl'], labels: languages }),
  strip: p.color({ label: 'Strip colour', default: '#121212' }),
  highlight: p.color({ label: 'Marked days', default: '#f2a93b' }),
};
type Context = RenderContext<{ label: string }, typeof documentParameters>;

// Dates are plain calendar dates; UTC keeps them free of the computer's time zone.
const monthAt = (first: string, offset: number) => {
  const date = new Date(first + 'T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset, 1);
  return date;
};
const daysIn = (month: Date) => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
const clean = (name: string) => name.replace(/\./g, '').trim();
// "NOV", "MÄR": the short month name, capitalised like the printed strip.
const monthName = (month: Date, language: Language) =>
  clean(new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'short' }).format(month)).slice(0, 3).toLocaleUpperCase(language);
// "Su", "Mo", "Di": two letters of the short weekday name.
const weekdayName = (date: Date, language: Language) => {
  const name = clean(new Intl.DateTimeFormat(language, { timeZone: 'UTC', weekday: 'short' }).format(date)).slice(0, 2);
  return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
};
// Marked days are a comma-separated list of day numbers, such as "3, 14".
// Every token is kept, so entries that are not days of this month can be reported instead of silently dropped.
const markedTokens = (value: string) => value.split(/[\s,;]+/).filter(Boolean);
const markedDays = (value: string, days = 31) =>
  new Set(markedTokens(value).filter((token) => /^\d+$/.test(token)).map(Number).filter((day) => day >= 1 && day <= days));

// Type sizes are designed for A3 and scale with the trim width, like the positions do.
const scale = (context: Pick<Context, 'format'>, value: number, unit: 'pt' | 'mm') => (value * context.format.trim.width / canvas.width).toFixed(2) + unit;
const fit = (context: Pick<Context, 'format'>, points: number) => scale(context, points, 'pt');

/** The page: the photo fills everything left of the strip, both reaching into the bleed. */
function Page({ context, className, children }: { context: Pick<Context, 'document' | 'geometry' | 'format'>; className: string; children?: ImageFlowNode }) {
  const { document, geometry } = context;
  const at = geometry.design(canvas);
  const bleed = geometry.page('bleed');
  const left = at.page(strip.x, 0, 0, 0).x;
  return <Spread className={'wall-calendar ' + className} style={{ '--strip': document.strip, '--highlight': document.highlight,
    '--place-size': fit(context, 19), '--caption-size': fit(context, 17), '--day-size': fit(context, 10.5), '--weekday-size': fit(context, 6.5), '--year-size': fit(context, 38),
    '--day-row': scale(context, 6.25, 'mm'), '--day-gap': scale(context, 1.4, 'mm') }}>
    <div className="strip" style={geometry.css({ ...bleed, x: left, width: bleed.x + bleed.width - left })} />
    {children}
  </Spread>;
}

/** The photo box, from the left bleed to the strip. */
const photoRect = (context: Pick<Context, 'geometry'>) => {
  const bleed = context.geometry.page('bleed');
  return { ...bleed, width: context.geometry.design(canvas).page(strip.x, 0, 0, 0).x - bleed.x };
};

/** Text written down the strip, from its top: the place on month pages, the title on the cover. */
function StripCaption({ context, text, placeholder, edit, className = 'place' }: {
  context: Pick<Context, 'geometry' | 'mode'>; text: string; placeholder: string; edit: object; className?: string;
}) {
  const rect = context.geometry.design(canvas).page(strip.x, 8, strip.width, rule - 14);
  if (!text && context.mode !== 'edit') return null;
  return <p {...edit} className={text ? className : className + ' empty'} style={context.geometry.css(rect)}>{text || placeholder}</p>;
}

function Rule({ context }: { context: Pick<Context, 'geometry'> }) {
  const at = context.geometry.design(canvas);
  const trim = context.geometry.page();
  const rect = at.page(strip.x + 2, rule, 0, .3);
  return <div className="rule" style={context.geometry.css({ ...rect, width: trim.x + trim.width - rect.x })} />;
}

function Days({ month, language, marked }: { month: Date; language: Language; marked: string }) {
  const highlighted = markedDays(marked, daysIn(month));
  return <ol className="days">
    {Array.from({ length: daysIn(month) }, (_, i) => {
      const date = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1));
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
      const className = [weekend ? 'weekend' : '', highlighted.has(i + 1) ? 'marked' : ''].filter(Boolean).join(' ');
      return <li key={i} className={className || undefined}><span className="day">{i + 1}</span><span className="weekday">{weekdayName(date, language)}</span></li>;
    })}
  </ol>;
}

// The place shown on a month page: its own text, else the photo's caption.
const place = (text: string, photo: Photo | null) => text.trim() || photo?.caption?.trim() || photo?.title?.trim() || '';

export default defineTemplate({
  id: 'imageflow-calendar',
  version: '1.0.0',
  label: 'Wall calendar',
  description: 'A landscape wall calendar: one full-bleed photo a month, with the place and the days on a dark strip.',
  contract: 1,
  requires: ['anchors', 'box-helpers', 'template-issues', 'typed-components', 'spread-builder', 'bound-geometry', 'text-component',
    'format-helper', 'opening-spreads', 'single-pages'],
  formats: {
    a3: calendarFormat('45 × 30 cm (A3 landscape) · 6835 × 4866 px', 6835, 4866),
    a2: calendarFormat('60 × 45 cm (A2 landscape) · 9417 × 6677 px', 9417, 6677),
  },
  defaultFormat: 'a3',
  parameters: documentParameters,
  spreads: ({ spread }) => ({
    cover: spread({
      label: 'Cover',
      parameters: {
        title: p.string({ label: 'Title', default: 'A year outside', maxLength: 40, placeholder: 'Written down the strip' }),
        year: p.string({ label: 'Year', default: '2027', maxLength: 9, placeholder: 'Year' }),
      },
      boxes: { hero: box.photo('Cover photo') },
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        return <Page context={ctx} className="cover">
          <ctx.PhotoBox id="hero" rect={photoRect(ctx)} />
          <StripCaption context={ctx} text={ctx.params.title} placeholder="Title" edit={ctx.edit('title')} className="place title" />
          <Rule context={ctx} />
          <ctx.Text parameter="year" className="year" rect={at.page(strip.x, rule + 6, strip.width, 297 - rule - 14)} />
        </Page>;
      },
    }),
    month: spread({
      label: 'Month',
      parameters: { place: p.string({ label: 'Place', default: '', maxLength: 40, placeholder: "The photo's caption" }) },
      boxes: { hero: box.photo('Photo') },
      elements: { days: { label: 'Days', parameters: {
        marked: p.string({ label: 'Marked days', default: '', maxLength: 120, placeholder: 'Day numbers, such as 3, 14' }),
      } } },
      // Every month page declares an anchor, so a page knows how many months come before it. Adding, removing or
      // moving pages renumbers the months.
      anchors: () => [{ id: 'month' }],
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const index = Math.max(0, ctx.book.anchors('month').findIndex((anchor) => anchor.page === ctx.page.number));
        const month = monthAt(ctx.document.firstMonth, index);
        const language = ctx.document.language;
        const marked = ctx.elements.days.params.marked;
        const valid = markedDays(marked, daysIn(month));
        const rejected = markedTokens(marked).filter((token) => !/^\d+$/.test(token) || !valid.has(Number(token)));
        const finding = rejected.length ? issue({ code: 'marked-day-invalid', severity: 'warning', element: 'days', parameter: 'marked',
          message: (rejected.length === 1 ? 'Marked day ' : 'Marked days ') + rejected.join(', ') + (rejected.length === 1 ? ' is' : ' are') + ' not a day of ' + monthName(month, language) +
            ' (1–' + daysIn(month) + ') and ' + (rejected.length === 1 ? 'is' : 'are') + ' not shown.',
          suggestion: 'Use day numbers from 1 to ' + daysIn(month) + ', separated by commas.' }) : {};
        return <Page context={ctx} className="month">
          <ctx.PhotoBox id="hero" rect={photoRect(ctx)} />
          <StripCaption context={ctx} text={place(ctx.params.place, ctx.boxes.hero.photo)} placeholder="Place" edit={ctx.edit('place')} />
          <Rule context={ctx} />
          <p className="month-name" style={ctx.geometry.css(at.page(strip.x, rule + 5, strip.width, 8))}>{monthName(month, language)}</p>
          <ctx.Element id="days" {...finding} rect={at.page(strip.x, rule + 20, strip.width, 297 - rule - 26)}>
            <Days month={month} language={language} marked={marked} />
          </ctx.Element>
        </Page>;
      },
    }),
  }),
  // A new calendar starts with its cover and twelve months.
  openingSpreads: [{ layout: 'cover' }, ...Array.from({ length: 12 }, () => ({ layout: 'month' as const }))],
});
