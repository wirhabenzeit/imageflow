import type { ImportCounts } from './desktop';

/** What to do with a HEIC photo, which neither Chromium nor the app's image library decodes (UI-013 of 25 November, evening). */
export const heicAdvice = 'If they are in Photos or Lightroom Classic, add them from there instead (drag them in from Photos, or import them from Lightroom), which renders them; or export them as JPEG first, for example from Preview.';
export const isHeic = (path: string) => /\.(heic|heif)$/i.test(path);

const amount = (count: number, singular: string) => count + ' ' + singular + (count === 1 ? '' : 's');
export function importFeedback(imported: number, counts?: ImportCounts) {
  if (!counts) return imported ? 'Imported ' + amount(imported, 'file') + '.' : 'No files found to import.';
  const other = counts.skipped - (counts.heic ?? 0);
  const skipped = [counts.heic && amount(counts.heic, 'HEIC photo') + ' skipped. ' + heicAdvice, other > 0 && amount(other, 'unsupported file') + ' skipped.',
    counts.failed && amount(counts.failed, 'unreadable or invalid file') + ' skipped.'].filter(Boolean);
  if (!imported) return [counts.failed ? 'No files imported.' : counts.skipped ? counts.heic && !other ? 'ImageFlow cannot read HEIC photos.' : 'No supported files were selected.' :
    'No files found to import. Empty folders and hidden files are ignored.', ...skipped].join(' ');
  const kinds = [[counts.photos, 'photo'], [counts.texts, 'text'], [counts.files, 'file']] as const;
  const parts = kinds.filter(([count]) => count > 0).map(([count, kind]) => amount(count, kind));
  const description = parts.length < 2 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts.at(-1);
  // Files the book already holds are not added again (F-044).
  const existing = counts.existing ? (counts.existing === 1 ? '1 file is' : counts.existing + ' files are') + ' already in this book' : '';
  if (!parts.length && existing) return [existing + '; nothing new to import.', ...skipped].join(' ');
  return ['Imported ' + description + (existing ? '; ' + existing : '') + '.', ...skipped].join(' ');
}
