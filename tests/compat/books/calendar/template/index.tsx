import { box, defineTemplate, file, geometry as geometryHelpers, inch, issue, mm, p, printFormat, pt, Spread } from 'imageflow';
import type { DocumentEditorProps, ImageFlowNode, Rect, RenderContext, ResolvedFormat } from 'imageflow';
import { changeMark, daysIn, fileDays, markedDays, markedEntries, markOf, monthFor, parseCalendarFile } from './marks';
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
  // Birthdays or holidays exported from a calendar app. Its all-day events are marked alongside the days above, which
  // it never changes, so importing a newer file is safe.
  markedFile: p.file({ label: 'Marked days from calendar', accept: ['.ics'] }),
  highlight: p.color({ label: 'Marked day colour', default: '#f2a93b' }),
};
type Context = RenderContext<{ label: string }, typeof documentParameters>;

/**
 * The calendar file's events and name, and why it cannot be read or what it cannot follow. Nothing when no file is
 * assigned. Every month page reads it, so the last file read is kept.
 */
let lastFile: { name: string; text: string; read: ReturnType<typeof readCalendarFile> } | undefined;
function calendarFile(id: string) {
  const source = file(id);
  if (!source) return undefined;
  if (lastFile?.name !== source.name || lastFile.text !== source.text) lastFile = { ...source, read: readCalendarFile(source.text) };
  return { name: source.name, ...lastFile.read };
}
function readCalendarFile(text: string) {
  const parsed = parseCalendarFile(text);
  if ('problem' in parsed) return { events: [], problem: parsed.problem };
  if (!parsed.events.length) return { events: [],
    problem: 'has ' + parsed.count + (parsed.count === 1 ? ' event' : ' events') + ' but none lasts all day' };
  return { events: parsed.events, ...(parsed.unsupported.length ? { problem: 'marks only the first date of events whose repeat it cannot follow: ' +
    parsed.unsupported.slice(0, 5).join('; ') + (parsed.unsupported.length > 5 ? ' and ' + (parsed.unsupported.length - 5) + ' more' : '') } : {}) };
}
const fromFile = (name: string) => 'From the calendar file ' + name;

const clean = (name: string) => name.replace(/\./g, '').trim();
// "NOV", "MÄR": the short month name, capitalised like the printed strip.
const monthName = (month: Date, language: Language) =>
  clean(new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'short' }).format(month)).slice(0, 3).toLocaleUpperCase(language);
// "Su", "Mo", "Di": two letters of the short weekday name.
const weekdayName = (date: Date, language: Language) => {
  const name = clean(new Intl.DateTimeFormat(language, { timeZone: 'UTC', weekday: 'short' }).format(date)).slice(0, 2);
  return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
};

/** The page's colours and type sizes, scaled from the A3 design to the format; the day picker on the page uses them too. */
function pageStyle(document: Context['document'], format: ResolvedFormat) {
  const at = geometryHelpers.design(format, canvas);
  return { '--strip': document.strip, '--highlight': document.highlight,
    '--place-size': at.length(19, 'pt', 'x'), '--caption-size': at.length(17, 'pt', 'x'), '--day-size': at.length(10.5, 'pt', 'x'), '--weekday-size': at.length(6.5, 'pt', 'x'), '--year-size': at.length(38, 'pt', 'x'),
    '--day-row': at.length(6.25, 'mm', 'x'), '--day-gap': at.length(1.4, 'mm', 'x') };
}

/** The page: the photo fills everything left of the strip, both reaching into the bleed. */
function Page({ context, className, children }: { context: Pick<Context, 'document' | 'geometry' | 'format'>; className: string; children?: ImageFlowNode }) {
  const { document, geometry } = context;
  const at = geometry.design(canvas);
  const bleed = geometry.page('bleed');
  const left = at.page(strip.x, 0, 0, 0).x;
  return <Spread className={'wall-calendar ' + className} style={pageStyle(document, context.format)}>
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

function Days({ month, language, marked, imported, edit, rect, geometry, finding }: {
  month: Date; language: Language; marked: string; imported: ReturnType<typeof calendarFile>; edit: object; rect: Rect;
  geometry: Context['geometry']; finding: object;
}) {
  const highlighted = markedDays(marked, month);
  const fromCalendar = imported ? fileDays(imported.events, month) : new Set<number>();
  return <ol className="days" {...edit} {...finding} style={geometry.css(rect)}>
    {Array.from({ length: daysIn(month) }, (_, i) => {
      const date = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1));
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
      const className = [weekend ? 'weekend' : '', highlighted.has(i + 1) || fromCalendar.has(i + 1) ? 'marked' : ''].filter(Boolean).join(' ');
      return <li key={i} className={className || undefined} title={fromCalendar.has(i + 1) ? fromFile(imported!.name) : undefined}><span className="day">{i + 1}</span><span className="weekday">{weekdayName(date, language)}</span></li>;
    })}
  </ol>;
}

// The day picker, opened by clicking the days of a month page. It edits the document's marked dates for the month
// that page shows, which it reads from its context: moving the page to another month updates the open picker.
// On the page (`presentation: 'inline'`) it is the page's own column of days: a click marks or unmarks a date once,
// ⌥-click every year. In the panel it is a month grid. A day marked every year is not changed by a plain click, so
// one click never changes every year's calendar. Days from the calendar file show as marked but cannot be clicked:
// the file, not the picker, decides them.
function MarkedDaysEditor(props: DocumentEditorProps<typeof documentParameters, 'markedDates'>) {
  return props.presentation === 'inline' ? <DaysOnPage {...props} /> : <MarkedDaysGrid {...props} />;
}

function DaysOnPage({ values, set, context, readOnly }: DocumentEditorProps<typeof documentParameters, 'markedDates'>) {
  const month = monthFor(context);
  const language = context.document.language;
  const marked = values.markedDates;
  const year = month.getUTCFullYear();
  const imported = calendarFile(context.document.markedFile);
  const fromCalendar = imported ? fileDays(imported.events, month) : new Set<number>();
  const toggle = (day: number, yearly: boolean) => {
    if (fromCalendar.has(day)) return;
    const mark = markOf(marked, month, day);
    if (yearly) set({ markedDates: changeMark(marked, month, day, { yearly: !mark.yearly }) });
    else if (!mark.yearly) set({ markedDates: changeMark(marked, month, day, { once: !mark.once }) });
  };
  const monthLabel = new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(month);
  return <div className="wall-calendar days-on-page" style={pageStyle(context.document, context.format)}>
    <ol className="days" aria-label={'Marked days in ' + monthLabel}>
      {Array.from({ length: daysIn(month) }, (_, i) => {
        const date = new Date(Date.UTC(year, month.getUTCMonth(), i + 1));
        const { once, yearly } = markOf(marked, month, i + 1);
        const locked = fromCalendar.has(i + 1);
        const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
        const className = [weekend ? 'weekend' : '', locked || once || yearly ? 'marked' : '', yearly ? 'yearly' : '',
          locked ? 'from-file' : ''].filter(Boolean).join(' ');
        return <li key={i} className={className || undefined}>
          <button type="button" aria-pressed={locked || once || yearly} disabled={readOnly || locked}
            title={locked ? fromFile(imported!.name)
              : yearly ? 'Every year · ⌥-click to unmark' : once ? year + ' · ⌥-click for every year' : '⌥-click for every year'}
            onClick={(event: { altKey: boolean }) => toggle(i + 1, event.altKey)}
            onKeyDown={(event: { altKey: boolean; key: string; preventDefault(): void }) => {
              if (event.altKey && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(i + 1, true); }
            }}>
            <span className="day">{i + 1}</span><span className="weekday">{weekdayName(date, language)}</span>
          </button>
        </li>;
      })}
    </ol>
  </div>;
}

function MarkedDaysGrid({ values, set, context, readOnly, Control }: DocumentEditorProps<typeof documentParameters, 'markedDates'>) {
  const month = monthFor(context);
  // `values` holds only the marked dates; every other setting is read from the context, which follows the book.
  const language = context.document.language;
  const marked = values.markedDates;
  const year = month.getUTCFullYear();
  const monthLabel = new Intl.DateTimeFormat(language, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(month);
  // Weeks start on Monday; 1 January 2024 was a Monday.
  const offset = (month.getUTCDay() + 6) % 7;
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayName(new Date(Date.UTC(2024, 0, 1 + i)), language));
  const imported = calendarFile(context.document.markedFile);
  const fromCalendar = imported ? fileDays(imported.events, month) : new Set<number>();
  const days = Array.from({ length: daysIn(month) }, (_, i) => ({ day: i + 1, ...markOf(marked, month, i + 1), locked: fromCalendar.has(i + 1) }));
  const change = (day: number, next: { once?: boolean; yearly?: boolean }) => set({ markedDates: changeMark(marked, month, day, next) });
  const rejected = markedEntries(marked).filter(({ date }) => !date).map(({ entry }) => entry);
  return <div className="marked-days-editor">
    <h3>{monthLabel}</h3>
    <div className="marked-days-grid" role="group" aria-label={'Marked days in ' + monthLabel}>
      {weekdays.map((name) => <strong key={name}>{name}</strong>)}
      {Array.from({ length: offset }, (_, i) => <span key={'blank' + i} />)}
      {/* A regular click changes only this year; Option-click changes the yearly mark. */}
      {days.map(({ day, once, yearly, locked }) => <button key={day} type="button"
        className={locked ? 'from-file' : yearly ? 'yearly' : once ? 'once' : undefined}
        aria-pressed={locked || once || yearly} disabled={readOnly || locked}
        title={locked ? fromFile(imported!.name) : (yearly ? 'Every year' : once ? 'Once in ' + year : 'Unmarked') + ' · Click: once · ⌥-click: every year'}
        onClick={(event: MouseEvent) => change(day, event.altKey ? { yearly: !yearly } : { once: !once })}
        onKeyDown={(event: KeyboardEvent) => { if (event.altKey && event.key === 'Enter') { event.preventDefault(); change(day, { yearly: !yearly }); } }}>{day}</button>)}
    </div>
    <p className="marked-days-note" title={"Click a day to mark it in " + year}>● Once · ◯ Every year{imported?.events.length ? ' · ▪ From ' + imported.name : ''}</p>
    <details className="marked-days-all">
      <summary>All marked days</summary>
      {rejected.length > 0 && <p className="marked-days-note">Not dates: {rejected.join(', ')}</p>}
      <Control parameter="markedDates" label="Marked days (25.12 every year, 2027-04-16 once)" />
    </details>
  </div>;
}

export default defineTemplate({
  id: 'imageflow-calendar',
  version: '1.2.0',
  label: 'Wall calendar',
  description: 'A landscape wall calendar: one full-bleed photo a month, with the place and the days on a dark strip.',
  // New Book shows a month page instead of a render of the cover, the first opening spread.
  preview: './preview.jpg',
  contract: 1,
  formats: {
    a3: calendarFormat('45 × 30 cm (A3 landscape) · 6835 × 4866 px', 6835, 4866),
    a2: calendarFormat('60 × 45 cm (A2 landscape) · 9417 × 6677 px', 9417, 6677),
  },
  defaultFormat: 'a3',
  parameters: documentParameters,
  editors: {
    markedDays: { label: 'Marked days', parameters: ['markedDates'], component: MarkedDaysEditor, presentation: 'inline' },
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
        const imported = calendarFile(ctx.document.markedFile);
        const fileFinding = index === 0 && imported?.problem ? issue({ code: 'marked-file-invalid', severity: 'warning',
          message: 'Marked days from calendar: ' + imported.name + ' ' + imported.problem + (imported.events.length ? '.' : ', so it marks no days.'),
          parameter: 'markedFile', file: ctx.document.markedFile,
          suggestion: imported.events.length ? 'Mark the missing dates by hand, or change the repeat in the calendar app to a plain yearly one.'
            : 'Export the calendar again as .ics with its all-day events, or assign another file.' }) : undefined;
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
          {fileFinding && <span hidden {...fileFinding} />}
          <Days month={month} language={language} marked={marked} imported={imported} edit={ctx.edit('document.markedDates')} finding={finding}
            rect={at.page(strip.x, rule + 20, strip.width, 297 - rule - 26)} geometry={ctx.geometry} />
        </Page>;
      },
    }),
  }),
  // A new calendar starts with its cover and twelve months.
  openingSpreads: [{ layout: 'cover' }, ...Array.from({ length: 12 }, () => ({ layout: 'month' as const }))],
});
