import type { ImportCounts } from './desktop';

const amount = (count: number, singular: string) => count + ' ' + singular + (count === 1 ? '' : 's');
export function importFeedback(imported: number, counts?: ImportCounts) {
  if (!counts) return imported ? 'Imported ' + amount(imported, 'file') + '.' : 'No files found to import.';
  const skipped = [counts.skipped && amount(counts.skipped, 'unsupported file') + ' skipped.',
    counts.failed && amount(counts.failed, 'unreadable or invalid file') + ' skipped.'].filter(Boolean);
  if (!imported) return [counts.failed ? 'No files imported.' : counts.skipped ? 'No supported files were selected.' :
    'No files found to import. Empty folders and hidden files are ignored.', ...skipped].join(' ');
  const kinds = [[counts.photos, 'photo'], [counts.texts, 'text'], [counts.files, 'file']] as const;
  const parts = kinds.filter(([count]) => count > 0).map(([count, kind]) => amount(count, kind));
  const description = parts.length < 2 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1);
  return ['Imported ' + description + '.', ...skipped].join(' ');
}
