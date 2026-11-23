import type { SyncCleanUpPlan, SyncStorage } from './desktop';

/** A size as Finder and iCloud show it: decimal units, one decimal from MB on. */
export function formatStorage(bytes: number) {
  if (bytes < 1000) return bytes + ' bytes';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return (unit === 0 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + units[unit];
}

/** The storage figures in a sentence. */
export function storageSummary(usage: SyncStorage, icloud: boolean) {
  const books = usage.books.filter(({ deleted }) => !deleted).length;
  if (!usage.books.length) return icloud ? 'No books are stored in iCloud yet.' : 'No books are stored yet.';
  return 'ImageFlow uses ' + formatStorage(usage.bytes) + (icloud ? ' of your iCloud storage' : '') + ' for ' + books + (books === 1 ? ' book' : ' books') +
    (usage.originals ? ', ' + formatStorage(usage.originals) + ' of it originals.' : '.');
}

/** What Clean Up would free, in words, before it deletes anything. */
export function cleanUpText(plan: SyncCleanUpPlan) {
  const skipped = plan.skipped ? ' ' + (plan.skipped === 1 ? '1 book is' : plan.skipped + ' books are') + ' left as it is: what it uses cannot be read now.' : '';
  if (!plan.objects) return 'There is nothing to clean up.' + skipped;
  const parts = [plan.books ? 'originals, previews and covers unused for a week in ' + plan.books + (plan.books === 1 ? ' book' : ' books') : '',
    plan.deletedBooks ? 'what is left of ' + plan.deletedBooks + (plan.deletedBooks === 1 ? ' deleted book' : ' deleted books') : ''].filter(Boolean);
  return 'Clean Up can free ' + formatStorage(plan.bytes) + ': ' + parts.join(', and ') + '.' + skipped;
}
