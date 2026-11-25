import type { BookStorage, SyncCleanUpPlan, UnusedStorage } from './desktop';

/** A size as Finder and iCloud show it: decimal units, one decimal from MB on. */
export function formatStorage(bytes: number) {
  if (bytes < 1000) return bytes + ' bytes';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return (unit === 0 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + units[unit];
}

/** What Clean Up would free, in words, before it deletes anything. */
export function cleanUpText(plan: SyncCleanUpPlan) {
  const skipped = plan.skipped ? ' ' + (plan.skipped === 1 ? '1 book is' : plan.skipped + ' books are') + ' left as it is: what it uses cannot be read now.' : '';
  if (!plan.objects) return 'There is nothing to clean up.' + skipped;
  const parts = [plan.books ? 'originals, previews and covers unused for a week in ' + plan.books + (plan.books === 1 ? ' book' : ' books') : '',
    plan.deletedBooks ? 'what is left of ' + plan.deletedBooks + (plan.deletedBooks === 1 ? ' deleted book' : ' deleted books') : ''].filter(Boolean);
  return 'Clean Up can free ' + formatStorage(plan.bytes) + ': ' + parts.join(', and ') + '.' + skipped;
}

/** What a book takes up, by kind (UI-009): previews, originals, covers, and its versions, which are the rest. */
export function storageParts({ bytes, originals, previews, covers }: BookStorage): { label: string; bytes: number }[] {
  return [{ label: 'Previews', bytes: previews }, { label: 'Originals', bytes: originals }, { label: 'Covers', bytes: covers },
    { label: 'Texts, files and history', bytes: bytes - originals - previews - covers }].filter((part) => part.bytes > 0);
}

const day = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
/** What of it is no longer used, and when Clean Up can free it. */
export function unusedText(unused: UnusedStorage | null) {
  if (!unused) return 'What is no longer used cannot be told now.';
  const { now, later, from, until } = unused;
  if (!now && !later) return 'All of it is in use.';
  const total = formatStorage(now + later) + ' is no longer used. Clean Up can free ';
  if (!later) return total + 'it.';
  const first = day(from!), last = day(until!);
  if (now) return total + formatStorage(now) + ' now and the rest ' + (first === last ? 'from ' + last : 'by ' + last) + '.';
  return total + (first === last ? 'it from ' + first : 'it between ' + first + ' and ' + last) + '.';
}
