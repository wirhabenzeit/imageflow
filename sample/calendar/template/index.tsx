import { box, defineTemplate, inch, issue, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { DocumentEditorProps, ImageFlowNode, Rect, RenderContext } from 'imageflow';
import { changeMark, daysIn, markedDays, markedEntries, markOf, monthFor } from './marks';
import './styles.css';

// A wall calendar without facing pages: a cover, then one page per month. Each page is a full-bleed photo with a
// narrow strip on the right: the photo's place written down the strip, a thin rule, the month, and its days.
//
// Layouts are drawn on a 420 × 297 design page (A-series landscape), measured from the trim edge.
// `ctx.geometry.design` scales positions to the chosen format; type sizes use the design canvas’s explicit x-axis scaling so every format keeps
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
    maximumFileSize: { pages: 1_000_000_000 },
  },
});

const languages = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', nl: 'Nederlands' } as const;
type Language = keyof typeof languages;

const documentParameters = {
  firstMonth: p.date({ label: 'First month', default: '2027-01-01', precision: 'month' }),
  language: p.enum({ label: 'Month and day names', default: 'en', options: languages }),
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

/** The page: the photo fills everything left of the strip, both reaching into the bleed. */
function Page({ context, className, children }: { context: Pick<Context, 'document' | 'geometry' | 'format'>; className: string; children?: ImageFlowNode }) {
  const { document, geometry } = context;
  const at = geometry.design(canvas);
  const bleed = geometry.page('bleed');
  const left = at.page(strip.x, 0, 0, 0).x;
  return <Spread className={'wall-calendar ' + className} style={{ '--strip': document.strip, '--highlight': document.highlight,
    '--place-size': at.length(19, 'pt', 'x'), '--caption-size': at.length(17, 'pt', 'x'), '--day-size': at.length(10.5, 'pt', 'x'), '--weekday-size': at.length(6.5, 'pt', 'x'), '--year-size': at.length(38, 'pt', 'x'),
    '--day-row': at.length(6.25, 'mm', 'x'), '--day-gap': at.length(1.4, 'mm', 'x') }}>
    <div className="strip" style={geometry.css({ ...bleed, x: left, width: bleed.x + bleed.width - left })} />
    {children}
  </Spread>;
}

/** The photo box, from the left bleed to the strip. */
const photoRect = (context: Pick<Context, 'geometry'>) => {
  const bleed = context.geometry.page('bleed');
  return { ...bleed, width: context.geometry.design(canvas).page(strip.x, 0, 0, 0).x - bleed.x };
};

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
      {/* A regular click changes only this year; Option-click changes the yearly mark. */}
      {days.map(({ day, once, yearly }) => <button key={day} type="button" className={yearly ? 'yearly' : once ? 'once' : undefined}
        aria-pressed={once || yearly} disabled={readOnly}
        title={(yearly ? 'Every year' : once ? 'Once in ' + year : 'Unmarked') + ' · Click: once · ⌥-click: every year'}
        onClick={(event: MouseEvent) => change(day, event.altKey ? { yearly: !yearly } : { once: !once })}
        onKeyDown={(event: KeyboardEvent) => { if (event.altKey && event.key === 'Enter') { event.preventDefault(); change(day, { yearly: !yearly }); } }}>{day}</button>)}
    </div>
    <p className="marked-days-note" title={"Click a day to mark it in " + year}>● Once · ◯ Every year</p>
    <details className="marked-days-all">
      <summary>All marked days</summary>
      {rejected.length > 0 && <p className="marked-days-note">Not dates: {rejected.join(', ')}</p>}
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
          <ctx.Text parameter="title" placeholder="Title" className="place title" rect={at.page(strip.x, 8, strip.width, rule - 14)} />
          <Rule context={ctx} />
          <ctx.Text parameter="year" className="year" rect={at.page(strip.x, rule + 6, strip.width, 297 - rule - 14)} />
        </Page>;
      },
    }),
    month: spread({
      label: 'Month',
      parameters: { place: p.string({ label: 'Place', default: '', maxLength: 40, placeholder: "The photo's caption" }),
        showPlace: p.boolean({ label: 'Show place', default: true }) },
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
          <ctx.Text parameter="place" fallback={ctx.boxes.hero.photo?.caption?.trim() || ctx.boxes.hero.photo?.title?.trim()}
            fallbackLabel="photo caption or title" hidden={!ctx.params.showPlace} placeholder="Place" className="place"
            rect={at.page(strip.x, 8, strip.width, rule - 14)} />
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
