// The calendar's dates, kept apart from the layouts so they are plain functions: the month a page shows, and the
// marked dates. They import nothing from ImageFlow, so the app's unit tests can check them directly.

// Dates are plain calendar dates; UTC keeps them free of the computer's time zone.
export const monthAt = (first: string, offset: number) => {
  const date = new Date(first + 'T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + offset, 1);
  return date;
};
export const daysIn = (month: Date) => new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * The month a month page shows: the first month, moved on by the month pages before this one. It reads only what
 * `render` and an editor's `context` both have, so the page and its day picker always agree.
 */
export const monthFor = (context: { page: { number?: number }; book: { anchors(id: string): { page: number }[] }; document: { firstMonth: string } }) => {
  const index = Math.max(0, context.book.anchors('month').findIndex((anchor) => anchor.page === context.page.number));
  return monthAt(context.document.firstMonth, index);
};

// Marked days are dates for the whole calendar: "25.12" every year or "2027-04-16" once, separated by commas,
// semicolons or new lines. Every entry is kept, so ones that are not dates can be reported instead of dropped.
type MarkedDate = { month: number; day: number; year?: number };
export const markedEntries = (value: string) => value.split(/[\s,;]+/).filter(Boolean).map((entry): { entry: string; date?: MarkedDate } => {
  const yearly = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(entry);
  const once = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry);
  const [year, month, day] = once ? [Number(once[1]), Number(once[2]), Number(once[3])]
    : yearly ? [undefined, Number(yearly[2]), Number(yearly[1])] : [undefined, 0, 0];
  // A yearly 29.02 is valid: it shows in leap years.
  const longest = month >= 1 && month <= 12 ? new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate() : 0;
  return day >= 1 && day <= longest ? { entry, date: { month, day, year } } : { entry };
});
/** The marked days of one month. */
export const markedDays = (value: string, month: Date) => new Set(markedEntries(value).flatMap(({ date }) =>
  date && date.month === month.getUTCMonth() + 1 && (date.year === undefined || date.year === month.getUTCFullYear())
    && date.day <= daysIn(month) ? [date.day] : []));
/** How a day of a month is marked: once (in the month's year), every year, both, or not at all. */
export const markOf = (value: string, month: Date, day: number) => {
  const matches = markedEntries(value).filter(({ date }) => date && date.month === month.getUTCMonth() + 1 && date.day === day);
  return { once: matches.some(({ date }) => date!.year === month.getUTCFullYear()), yearly: matches.some(({ date }) => date!.year === undefined) };
};
const pad = (value: number) => String(value).padStart(2, '0');
const onceEntry = (month: Date, day: number) => month.getUTCFullYear() + '-' + pad(month.getUTCMonth() + 1) + '-' + pad(day);
const yearlyEntry = (month: Date, day: number) => pad(day) + '.' + pad(month.getUTCMonth() + 1);
/**
 * The marked dates with this day's yearly mark, its one-off mark in the month's year, or both set or cleared. A kind
 * the change leaves out keeps its entries as they were, so removing the yearly mark keeps a one-off mark of the same
 * day. Setting a kind writes one entry for it, however many there were. Entries that are not dates, and entries for
 * other days or years, stay unchanged; the list is rewritten comma-separated.
 */
export function changeMark(value: string, month: Date, day: number, change: { once?: boolean; yearly?: boolean }) {
  const year = month.getUTCFullYear();
  const changes = (date: MarkedDate) => date.month === month.getUTCMonth() + 1 && date.day === day &&
    (date.year === undefined ? change.yearly !== undefined : date.year === year && change.once !== undefined);
  const kept = markedEntries(value).filter(({ date }) => !date || !changes(date)).map(({ entry }) => entry);
  return [...kept, ...(change.yearly ? [yearlyEntry(month, day)] : []), ...(change.once ? [onceEntry(month, day)] : [])].join(', ');
}

// Marked days can also come from a calendar file (.ics), such as birthdays or holidays exported from a calendar app.
// Only all-day events count: their DTSTART is a plain date (`DTSTART;VALUE=DATE:20270416`). An event lasts until its
// DTEND (the day after its last day) or for its DURATION, and marks each of its days. Yearly repeats follow RFC 5545:
// INTERVAL, BYMONTH, BYMONTHDAY and BYDAY (such as the last Monday in May), ended by UNTIL or COUNT, without the dates
// in EXDATE or those that another event with the same UID and a RECURRENCE-ID moves or cancels. A repeat this file
// cannot follow, such as a monthly one or BYSETPOS, marks only its first date and is reported.
type Rule = { interval: number; months?: number[]; monthDays?: number[]; days?: { weekday: number; nth?: number }[]; until?: Date; count?: number };
// `starts` remembers each year's starts once they are worked out.
type CalendarEvent = { start: Date; days: number; rule?: Rule; except: Set<number>; starts: Map<number, Date[]> };
export type CalendarFile = { events: CalendarEvent[]; count: number; unsupported: string[] } | { problem: string };

const DAY = 86_400_000;
const utc = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
};
// A date, or the date part of a date-time.
const icsDate = (value: string) => {
  const found = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/.exec(value.trim());
  return found ? utc(Number(found[1]), Number(found[2]), Number(found[3])) : undefined;
};
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const numbers = (value: string | undefined, valid: (n: number) => boolean) => {
  if (value === undefined) return undefined;
  const list = value.split(',').map(Number);
  return list.every((n) => Number.isInteger(n) && valid(n)) ? list : null;
};

/** A yearly RRULE, or why it is not one this calendar follows. */
function parseRule(value: string): Rule | string {
  const parts = Object.fromEntries(value.split(';').filter(Boolean).map((part) => {
    const [key, ...rest] = part.split('=');
    return [key.toUpperCase(), rest.join('=').toUpperCase()];
  }));
  if (parts.FREQ !== 'YEARLY') return 'repeats ' + (parts.FREQ ? parts.FREQ.toLowerCase() : 'without FREQ');
  const other = Object.keys(parts).filter((key) => !['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'UNTIL', 'COUNT', 'WKST'].includes(key));
  if (other.length) return 'uses ' + other.join(', ');
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  const months = numbers(parts.BYMONTH, (n) => n >= 1 && n <= 12);
  const monthDays = numbers(parts.BYMONTHDAY, (n) => n !== 0 && Math.abs(n) <= 31);
  const days = parts.BYDAY?.split(',').map((day) => {
    const found = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(day);
    const weekday = found ? weekdays.indexOf(found[2]) : -1;
    return weekday < 0 ? null : { weekday, ...(found![1] ? { nth: Number(found![1]) } : {}) };
  });
  const until = parts.UNTIL === undefined ? undefined : icsDate(parts.UNTIL);
  const count = parts.COUNT === undefined ? undefined : Number(parts.COUNT);
  if (!Number.isInteger(interval) || interval < 1 || months === null || monthDays === null || days?.includes(null)
    || until === undefined && parts.UNTIL !== undefined || count !== undefined && !(Number.isInteger(count) && count >= 1)
    || days?.some((day) => day!.nth === 0 || Math.abs(day!.nth ?? 0) > 53)) return 'has an RRULE that is not valid';
  return { interval, ...(months ? { months } : {}), ...(monthDays ? { monthDays } : {}),
    ...(days ? { days: days as { weekday: number; nth?: number }[] } : {}), ...(until ? { until } : {}), ...(count ? { count } : {}) };
}

/** The starts a yearly rule gives in one year, in order, before UNTIL, COUNT and EXDATE are applied. */
function ruleStarts(rule: Rule, start: Date, year: number): Date[] {
  if ((year - start.getUTCFullYear()) % rule.interval !== 0) return [];
  const startMonth = start.getUTCMonth() + 1;
  const inMonth = (month: number): Date[] => {
    if (!rule.days && !rule.monthDays) return [utc(year, month, start.getUTCDate())].filter((date): date is Date => !!date);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const all = Array.from({ length: last }, (_, i) => utc(year, month, i + 1)!);
    let found = rule.monthDays ? rule.monthDays.map((n) => n > 0 ? all[n - 1] : all[last + n]).filter(Boolean)
      : all;
    if (rule.days) found = found.filter((date) => rule.days!.some(({ weekday, nth }) => {
      if (date.getUTCDay() !== weekday) return false;
      if (nth === undefined) return true;
      const same = all.filter((other) => other.getUTCDay() === weekday);
      return same[nth > 0 ? nth - 1 : same.length + nth]?.getTime() === date.getTime();
    }));
    return found;
  };
  // BYDAY with an ordinal and no BYMONTH counts within the year (20MO, the twentieth Monday); without one it is every
  // such weekday of the year. BYMONTHDAY or BYDAY without BYMONTH apply to every month.
  if (rule.days && !rule.months && !rule.monthDays) {
    const all = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(year, 0, 1 + i))).filter((date) => date.getUTCFullYear() === year);
    return all.filter((date) => rule.days!.some(({ weekday, nth }) => {
      if (date.getUTCDay() !== weekday) return false;
      if (nth === undefined) return true;
      const same = all.filter((other) => other.getUTCDay() === weekday);
      return same[nth > 0 ? nth - 1 : same.length + nth]?.getTime() === date.getTime();
    }));
  }
  const months = rule.months ?? (rule.monthDays ? Array.from({ length: 12 }, (_, i) => i + 1) : [startMonth]);
  return [...new Set(months)].sort((a, b) => a - b).flatMap(inMonth).sort((a, b) => a.getTime() - b.getTime());
}

/** The starts of an event in one year: DTSTART is always the first, and COUNT counts from it. */
function eventStarts(event: CalendarEvent, year: number): Date[] {
  const first = event.start.getUTCFullYear();
  const { rule } = event;
  if (!rule) return year === first ? [event.start] : [];
  if (year < first || rule.until && year > rule.until.getUTCFullYear()) return [];
  const startsIn = (y: number) => {
    let starts = event.starts.get(y);
    if (!starts) {
      starts = ruleStarts(rule, event.start, y).filter((date) => date > event.start);
      if (y === first) starts = [event.start, ...starts];
      if (rule.until) starts = starts.filter((date) => date <= rule.until!);
      event.starts.set(y, starts);
    }
    return starts;
  };
  let starts = startsIn(year);
  if (rule.count !== undefined) {
    // COUNT counts every occurrence since the first, including those EXDATE removes.
    let before = 0;
    for (let y = first; y < year && before < rule.count; y++) before += startsIn(y).length;
    starts = starts.slice(0, Math.max(0, rule.count - before));
  }
  return starts.filter((date) => !event.except.has(date.getTime()));
}

/** The all-day events of a calendar file, or why it cannot be read. */
export function parseCalendarFile(text: string): CalendarFile {
  // Long lines are folded: a line that starts with a space or tab continues the one before.
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.some((line) => /^BEGIN:VCALENDAR$/i.test(line))) return { problem: 'is not a calendar file (no BEGIN:VCALENDAR)' };
  type Property = { params: string; value: string };
  const found: Record<string, Property[]>[] = [];
  let event: Record<string, Property[]> | undefined;
  let nested = 0;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) { event = {}; nested = 0; continue; }
    if (!event) continue;
    // Alarms inside an event have properties of their own.
    if (/^BEGIN:/i.test(line)) { nested++; continue; }
    if (/^END:/i.test(line) && nested) { nested--; continue; }
    if (/^END:VEVENT$/i.test(line)) { found.push(event); event = undefined; continue; }
    if (nested) continue;
    const property = /^([A-Z0-9-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
    if (property) (event[property[1].toUpperCase()] ??= []).push({ params: property[2].toUpperCase(), value: property[3] });
  }
  if (!found.length) return { problem: 'has no events' };
  const one = (event: Record<string, Property[]>, key: string) => event[key]?.[0];
  const dateOf = (property: Property | undefined) =>
    property && (/VALUE=DATE(?!-)/.test(property.params) || /^\d{8}$/.test(property.value.trim())) ? icsDate(property.value) : undefined;
  const name = (event: Record<string, Property[]>) => one(event, 'SUMMARY')?.value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').trim() || 'an event';
  // Occurrences moved or cancelled by another event with the same UID and a RECURRENCE-ID.
  const moved = new Map<string, Set<number>>();
  for (const event of found) {
    const uid = one(event, 'UID')?.value;
    const id = one(event, 'RECURRENCE-ID');
    const date = id && icsDate(id.value);
    if (uid && date) (moved.get(uid) ?? moved.set(uid, new Set()).get(uid)!).add(date.getTime());
  }
  const events: CalendarEvent[] = [];
  const unsupported: string[] = [];
  for (const event of found) {
    if (one(event, 'STATUS')?.value.toUpperCase() === 'CANCELLED') continue;
    // A timed event has a time after its date (20270416T090000Z); it is not a marked day.
    const start = dateOf(one(event, 'DTSTART'));
    if (!start) continue;
    const end = dateOf(one(event, 'DTEND'));
    const duration = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T.*)?$/i.exec(one(event, 'DURATION')?.value.trim() ?? '');
    const span = end ? Math.round((end.getTime() - start.getTime()) / DAY)
      : duration ? Number(duration[1] ?? 0) * 7 + Number(duration[2] ?? 0) : 1;
    // At most a year of days, so a mistyped end cannot mark a whole decade.
    const days = Math.min(366, Math.max(1, span));
    const ruleText = one(event, 'RRULE')?.value;
    let rule: Rule | undefined;
    if (ruleText && !one(event, 'RECURRENCE-ID')) {
      const parsed = parseRule(ruleText);
      if (typeof parsed === 'string') unsupported.push(name(event) + ' ' + parsed);
      else rule = parsed;
    }
    const except = new Set((event.EXDATE ?? []).flatMap(({ value }) => value.split(',').map(icsDate).filter((date): date is Date => !!date).map((date) => date.getTime())));
    if (!one(event, 'RECURRENCE-ID')) for (const date of moved.get(one(event, 'UID')?.value ?? '') ?? []) except.add(date);
    events.push({ start, days, ...(rule ? { rule } : {}), except, starts: new Map() });
  }
  return { events, count: found.length, unsupported };
}

/** The days of one month marked by a calendar file's events, including events that began the month or year before. */
export function fileDays(events: readonly CalendarEvent[], month: Date) {
  const first = month.getTime();
  const last = Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), daysIn(month));
  const marked = new Set<number>();
  for (const event of events) {
    for (const year of [month.getUTCFullYear() - 1, month.getUTCFullYear()]) {
      for (const start of eventStarts(event, year)) {
        for (let i = 0; i < event.days; i++) {
          const day = start.getTime() + i * DAY;
          if (day > last) break;
          if (day >= first) marked.add(new Date(day).getUTCDate());
        }
      }
    }
  }
  return marked;
}
