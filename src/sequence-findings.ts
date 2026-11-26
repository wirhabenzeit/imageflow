import type { Issue } from './desktop';
import type { SequenceIssue } from './format';

type Sequence = { count: number; issues: SequenceIssue[]; shortfall?: { add?: number; remove?: number } };

/**
 * The findings of a page sequence, by severity. A growing book often has a page count or book ends the format does not
 * take yet: while it is edited and checked, that is a to-do before export (a `page-sequence` warning), and only the
 * print export and the proof, which make the book, report it as an error (API-023). A layout of the wrong kind or side
 * for the format comes from a format switch or a wrong layout, not from growth, and is an error everywhere.
 */
export function sequenceFindings(sequence: Sequence, { exporting }: { exporting: boolean }): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [], warnings: Issue[] = [];
  for (const { text, kind } of sequence.issues) {
    if (kind === 'layout') {
      errors.push({ message: text, code: 'layout-format-mismatch',
        suggestion: 'Switch the layout to one that fits the format, with switch_layout or the layout picker, or switch back to the earlier format.' });
      continue;
    }
    (exporting ? errors : warnings).push({ message: text, code: 'page-sequence',
      ...(kind === 'count' && sequence.shortfall ? { details: { pages: sequence.count, ...sequence.shortfall } } : {}),
      suggestion: 'Insert, remove or move spreads, or switch layouts, so the page sequence fits the format before export.' });
  }
  return { errors, warnings };
}

/**
 * The cover's findings about the interior pages: the cover's spine follows the interior page count, so a cover is only
 * printed once the interior fits its format. While it is edited and checked, a growing interior is a warning; printing
 * the cover reports it as an error. A layout that does not fit the format is an error everywhere, as in the interior.
 * `provisionalPages` is the page count the cover preview uses when the interior's is not one the cover supports.
 */
export function coverSequenceFindings(sequence: Sequence, { provisionalPages, printing }: { provisionalPages?: number; printing: boolean }): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [], warnings: Issue[] = [];
  const cover = (message: string, code: string): Issue => ({ message, code, cover: true, where: 'Cover' });
  const layout = sequence.issues.find(({ kind }) => kind === 'layout');
  if (provisionalPages !== undefined) {
    (printing ? errors : warnings).push(cover('The cover needs a supported interior page count. The preview uses ' + provisionalPages + ' pages.', 'cover-page-count'));
    if (layout) errors.push(cover('Fix the interior page sequence before exporting the cover. ' + layout.text, 'cover-page-sequence'));
  } else if (sequence.issues.length) {
    const first = layout ?? sequence.issues[0];
    (printing || layout ? errors : warnings).push(cover('Fix the interior page sequence before exporting the cover. ' + first.text, 'cover-page-sequence'));
  }
  return { errors, warnings };
}
