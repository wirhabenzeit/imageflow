import { takeAway } from './away-originals';
import { issueText } from './desktop';
import type { Issue } from './desktop';

// The export confirmation names the first few errors; Book check lists them all.
const shownExportErrors = 8;
/**
 * The errors an export asks about. Unavailable originals are summed up by their cause, one line for all the photos of a
 * Lightroom Classic that is not running, say, instead of one line per box; the other errors are listed as they are.
 */
export function exportErrorList(errors: Issue[]) {
  const unavailable = new Map<string, Issue[]>();
  const other: Issue[] = [];
  for (const issue of errors) {
    if (issue.code !== 'source-unavailable') { other.push(issue); continue; }
    const cause = (issue.problem ?? issue.message).replace(/\.+$/, '');
    unavailable.set(cause, [...unavailable.get(cause) ?? [], issue]);
  }
  const summaries = [...unavailable].map(([cause, issues]) => {
    const photos = new Set(issues.map(({ source, spread, box }) => source ?? spread + ':' + box)).size;
    const spreads = new Set(issues.flatMap(({ spread }) => spread ?? [])).size;
    const where = [spreads && (spreads === 1 ? '1 spread' : spreads + ' spreads'), issues.some(({ cover }) => cover) && 'the cover'].filter(Boolean).join(' and ');
    return cause + ': ' + (photos === 1 ? '1 photo' : photos + ' photos') + ' on ' + where + ' will print from cached previews.';
  });
  const shown = other.slice(0, Math.max(0, shownExportErrors - summaries.length)).map(issueText);
  const more = other.length - shown.length;
  return [...summaries, ...shown].join('\n') + (more > 0 ? '\n…and ' + more + ' more ' + (more === 1 ? 'error' : 'errors') + ' in Book check.' : '');
}

/** What a saved export leaves in Book check, with its own count of what prints from previews: Book check counts those originals nowhere. */
export function foundText(result: { errors: Issue[]; warnings: Issue[] }, kind: 'proof' | 'print') {
  const { errors, warnings, notes } = takeAway(result);
  const counted = (n: number, word: string) => n ? n + ' ' + word + (n === 1 ? '' : 's') : '';
  const found = [counted(errors.length, 'error'), counted(warnings.length, 'warning')].filter(Boolean).join(', ');
  const previews = new Set(notes.flatMap(({ placed }) => placed.map(({ source }) => source))).size;
  return (found ? ' ' + found + ' in Book check' + (kind === 'proof' ? '; problem spreads are marked in the proof.' : '.') : '') +
    (previews ? ' ' + counted(previews, 'photo') + (previews === 1 ? ' prints from a preview, on a marked page.' : ' print from previews, on marked pages.') : '');
}
