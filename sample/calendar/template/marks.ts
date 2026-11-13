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
