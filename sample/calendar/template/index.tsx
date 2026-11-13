import { box, defineTemplate, inch, issue, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { DocumentEditorProps, ImageFlowNode, Photo, Rect, RenderContext } from 'imageflow';
import { changeMark, daysIn, markedDays, markedEntries, markOf, monthFor } from './marks';
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
  // Dates, not days of a page: birthdays and holidays stay on their date when pages move.
  // Edited on the month pages: clicking a page's days opens the day picker (see MarkedDaysEditor).
  markedDates: p.string({ label: 'Marked days', default: '', maxLength: 600, multiline: true,
    placeholder: '25.12 every year, 2027-04-16 once' }),
  highlight: p.color({ label: 'Marked day colour', default: '#f2a93b' }),
};
type Context = RenderContext<{ label: string }, typeof documentParameters>;

const clean = (name: string) => name.replace(/\./g, '').trim();
// "NOV", "MÄR": the short month name, capitalised like the printed strip.
const monthName = (month: Date, language: Language) =>
  clean(new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'short' }).format(month)).slice(0, 3).toLocaleUpperCase(language);
// "Su", "Mo", "Di": two letters of the short weekday name.
const weekdayName = (date: Date, language: Language) => {
  const name = clean(new Intl.DateTimeFormat(language, { timeZone: 'UTC', weekday: 'short' }).format(date)).slice(0, 2);
  return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
};

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

function Days({ month, language, marked, edit, rect, geometry, finding }: {
  month: Date; language: Language; marked: string; edit: object; rect: Rect; geometry: Context['geometry']; finding: object;
}) {
  const highlighted = markedDays(marked, month);
  return <ol className="days" {...edit} {...finding} style={geometry.css(rect)}>
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

// The day picker, opened by clicking the days of a month page. It edits the document's marked dates for the month
// that page shows, which it reads from its context: moving the page to another month updates the open picker.
// A click marks that date once; a day marked every year shows as marked, and the picker offers to remove the
// yearly entry, since one click should not change every year's calendar.
function MarkedDaysEditor({ values, set, context, readOnly, Control }: DocumentEditorProps<typeof documentParameters, 'markedDates'>) {
  const month = monthFor(context);
  // `values` holds only the marked dates; every other setting is read from the context, which follows the book.
  const language = context.document.language;
  const marked = values.markedDates;
  const year = month.getUTCFullYear();
  const monthLabel = new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(month);
  const dayLabel = (day: number, withYear: boolean) => new Intl.DateTimeFormat(language, { timeZone: 'UTC', day: 'numeric', month: 'long',
    ...(withYear ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(year, month.getUTCMonth(), day)));
  // Weeks start on Monday; 1 January 2024 was a Monday.
  const offset = (month.getUTCDay() + 6) % 7;
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayName(new Date(Date.UTC(2024, 0, 1 + i)), language));
  const days = Array.from({ length: daysIn(month) }, (_, i) => ({ day: i + 1, ...markOf(marked, month, i + 1) }));
  const change = (day: number, next: { once?: boolean; yearly?: boolean }) => set({ markedDates: changeMark(marked, month, day, next) });
  const rejected = markedEntries(marked).filter(({ date }) => !date).map(({ entry }) => entry);
  return <div className="marked-days-editor">
    <h3>{monthLabel}</h3>
    <div className="marked-days-grid" role="group" aria-label={'Marked days in ' + monthLabel}>
      {weekdays.map((name) => <strong key={name}>{name}</strong>)}
      {Array.from({ length: offset }, (_, i) => <span key={'blank' + i} />)}
      {/* A day marked every year is not toggled by a click, so one click never changes every year's calendar. */}
      {days.map(({ day, once, yearly }) => <button key={day} type="button" className={yearly ? 'yearly' : once ? 'once' : undefined}
        aria-pressed={once || yearly} disabled={readOnly || yearly}
        title={yearly ? 'Marked every year: remove it below' : once ? 'Marked in ' + year + '. Click to unmark.' : 'Click to mark in ' + year + '.'}
        onClick={() => change(day, { once: !once })}>{day}</button>)}
    </div>
    <p className="marked-days-note">Click a day to mark it in {year}. Days with a ring are marked every year.</p>
    <ul className="marked-days-list">
      {days.filter(({ once, yearly }) => once || yearly).map(({ day, once, yearly }) => <li key={day}>
        <span>{yearly ? dayLabel(day, false) + ', every year' + (once ? ', and once in ' + year : '') : dayLabel(day, true)}</span>
        {/* Removing the yearly mark keeps a one-off mark of the same day, which then shows on its own. */}
        {yearly
          ? <button type="button" disabled={readOnly} onClick={() => change(day, { yearly: false })}>Unmark every year</button>
          : <button type="button" disabled={readOnly} onClick={() => change(day, { yearly: true, once: false })}>Mark every year</button>}
      </li>)}
    </ul>
    {rejected.length > 0 && <p className="marked-days-note">Not shown, because they are not dates: {rejected.join(', ')}</p>}
    <details className="marked-days-all">
      <summary>All marked days</summary>
      <Control parameter="markedDates" label="Marked days (25.12 every year, 2027-04-16 once)" />
    </details>
  </div>;
}

export default defineTemplate({
  id: 'imageflow-calendar',
  version: '1.0.0',
  label: 'Wall calendar',
  description: 'A landscape wall calendar: one full-bleed photo a month, with the place and the days on a dark strip.',
  contract: 1,
  requires: ['anchors', 'box-helpers', 'template-issues', 'typed-components', 'spread-builder', 'bound-geometry', 'text-component',
    'format-helper', 'opening-spreads', 'single-pages', 'editor-context', 'document-editors'],
  formats: {
    a3: calendarFormat('45 × 30 cm (A3 landscape) · 6835 × 4866 px', 6835, 4866),
    a2: calendarFormat('60 × 45 cm (A2 landscape) · 9417 × 6677 px', 9417, 6677),
  },
  defaultFormat: 'a3',
  parameters: documentParameters,
  editors: {
    markedDays: { label: 'Marked days', parameters: ['markedDates'], component: MarkedDaysEditor },
  },
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
      // Every month page declares an anchor, so a page knows how many months come before it. Adding, removing or
      // moving pages renumbers the months.
      anchors: () => [{ id: 'month' }],
      render: (ctx) => {
        const at = ctx.geometry.design(canvas);
        const index = Math.max(0, ctx.book.anchors('month').findIndex((anchor) => anchor.page === ctx.page.number));
        const month = monthFor(ctx);
        const language = ctx.document.language;
        const marked = ctx.document.markedDates;
        // Entries that are not dates are reported once, on the first month page.
        const rejected = index === 0 ? markedEntries(marked).filter(({ date }) => !date).map(({ entry }) => entry) : [];
        const finding = rejected.length ? issue({ code: 'marked-day-invalid', severity: 'warning',
          message: 'Marked days: ' + rejected.join(', ') + (rejected.length === 1 ? ' is not a date' : ' are not dates') + ' and ' +
            (rejected.length === 1 ? 'is' : 'are') + ' not shown.',
          suggestion: 'Write 25.12 for every year or 2027-04-16 for one date, separated by commas.' }) : {};
        return <Page context={ctx} className="month">
          <ctx.PhotoBox id="hero" rect={photoRect(ctx)} />
          <StripCaption context={ctx} text={place(ctx.params.place, ctx.boxes.hero.photo)} placeholder="Place" edit={ctx.edit('place')} />
          <Rule context={ctx} />
          <p className="month-name" style={ctx.geometry.css(at.page(strip.x, rule + 5, strip.width, 8))}>{monthName(month, language)}</p>
          <Days month={month} language={language} marked={marked} edit={ctx.edit('document.markedDates')} finding={finding}
            rect={at.page(strip.x, rule + 20, strip.width, 297 - rule - 26)} geometry={ctx.geometry} />
        </Page>;
      },
    }),
  }),
  // A new calendar starts with its cover and twelve months.
  openingSpreads: [{ layout: 'cover' }, ...Array.from({ length: 12 }, () => ({ layout: 'month' as const }))],
});
