import { awayText, takeAway } from './away-originals';
import type { AwayNote } from './away-originals';
import type { Issue } from './desktop';
import type { SourceState } from './source-locations';

/** `info` says something about the book that needs nothing done while editing: it is listed last and counted nowhere. */
export type IssueLevel = 'error' | 'warning' | 'info';
/** One problem of the book, with every place it occurs at. */
export type CheckRow = { key: string; level: IssueLevel; title: string; items: Issue[];
  /** What it means, when the title does not say it, and what to do about it. Shown once, when the row is opened. */
  detail?: string; fix?: string;
  note?: AwayNote };

// What Book check says about a problem, by its code: a short title, and, when the row is opened, what it means and what to
// do about it. The finding's own message and suggestion are written for `check_book`: they name spreads, IDs and commands.
// A code with a meaning here takes its values from the finding (`occurrenceText`), any other shows its messages.
type CheckText = { title: string; detail?: string; fix?: string };
const texts: Record<string, CheckText> = {
  // A to-do while the book grows: only export reports it as an error.
  'page-sequence': { title: 'Pages to fit the format before export', fix: 'Add, remove or move spreads, or change a layout.' },
  'book-empty': { title: 'No spreads yet', fix: 'Add a spread.' },
  'format-unavailable': { title: 'Format no longer offered', fix: 'Choose a format in the book settings.' },
  'cover-page-count': { title: 'Cover needs a page count' },
  'cover-page-sequence': { title: 'Pages don’t fit the cover' },
  'cover-layout-unavailable': { title: 'No cover layout', fix: 'Choose a cover layout in the Inspector.' },
  'cover-box-empty': { title: 'Empty photo on the cover', fix: 'Choose a photo in the Inspector.' },
  'photo-resolution-low': { title: 'Low resolution', detail: 'Too few pixels for the size it prints at.', fix: 'Zoom the crop out, use a larger photo, or choose a layout with a smaller box.' },
  'photo-missing': { title: 'Photo missing', detail: 'The photo can’t be found, and nothing stands in for it.', fix: 'Locate the original, or choose another photo.' },
  'text-source-missing': { title: 'Text missing', detail: 'The text’s file can’t be found.', fix: 'Locate it, or choose another text.' },
  'file-missing': { title: 'File missing', fix: 'Choose the file again.' },
  'file-unreadable': { title: 'File can’t be read', fix: 'Choose the file again.' },
  'file-type': { title: 'Wrong type of file', fix: 'Choose another file.' },
  'outside-bleed': { title: 'Runs off the page' },
  'text-overflow': { title: 'Text doesn’t fit', detail: 'Part of the text has no room in its boxes.', fix: 'Add a spread that continues it, or shorten it.' },
  'text-box-unused': { title: 'Text box left empty', detail: 'The text ends before this box.', fix: 'Take the text out of the box, or use a smaller layout.' },
  'text-too-small': { title: 'Text too small to print', detail: 'It is smaller than the format allows.' },
  'text-outside-safe-area': { title: 'Text too close to the edge', detail: 'It runs out of the format’s safe area and may be trimmed.' },
  'text-overlap': { title: 'Text overlaps' },
  'text-clipped': { title: 'Text cut off' },
  'text-overflows-box': { title: 'Text runs out of its box' },
  'text-stroked': { title: 'Stroked text' },
  'text-frontmatter-invalid': { title: 'Text header can’t be read' },
  'cover-text-near-fold': { title: 'Cover text near a fold' },
  'rendered-image-failed': { title: 'Picture not drawn' },
  'rendered-image-raster': { title: 'Picture prints as pixels' },
  'photo-render-failed': { title: 'Photo box failed' },
  'photo-decode-failed': { title: 'Photo can’t be shown', fix: 'Replace its file, or choose another photo.' },
  'photo-decode': { title: 'Photo can’t be shown', fix: 'Replace its file, or choose another photo.' },
  'layout-render-failed': { title: 'Layout failed' },
  'render-impure': { title: 'Layout depends on something outside the book' },
  'source-reshaped': { title: 'Photo changed its shape', detail: 'It has another aspect ratio in its source than when it was placed.', fix: 'Check how it is cropped.' },
  'source-out-of-date': { title: 'Preview out of date', detail: 'The photo is shown as it was before its latest edit in its source. Export prints it as it is now.',
    fix: 'Return to Lightroom’s Library, or choose Refresh from Lightroom Classic in the asset’s menu.' },
  'parameter-invalid': { title: 'Setting not allowed' },
  'content-undeclared': { title: 'Content without a box' },
  'element-undeclared': { title: 'Settings without an element' },
  'font-load-failed': { title: 'Font not loaded' },
  'font-load': { title: 'Font not loaded' },
  'font-coverage': { title: 'Characters missing from a font' },
  'anchor-missing': { title: 'Reference without a target' },
  'anchor-ambiguous': { title: 'Reference with several targets' },
  'credit-conflict': { title: 'Conflicting credits' },
  'credit-unprinted': { title: 'Credit not printed', fix: 'Add a spread that prints the credits.' },
  'template-dependencies': { title: 'Template packages', fix: 'Choose Rebuild Template Dependencies.' },
  'pdf-resource': { title: 'PDF problem' },
  'pdf-file-size': { title: 'PDF too large' },
};
// A source that cannot be used, by its state: print needs its original, whatever stands in for it on the page.
const states: Record<SourceState, CheckText> = {
  missing: { title: 'Original missing', fix: 'Locate the original, or reconnect the drive it is on.' },
  unapproved: { title: 'Original needs approval', detail: 'This book links a file that was not approved on this Mac.', fix: 'Locate the original to approve it.' },
  unreadable: { title: 'Original can’t be read' },
  denied: { title: 'No access to the original', fix: 'Allow ImageFlow to read it in System Settings → Privacy & Security.' },
  offline: { title: 'Original can’t be reached', fix: 'Open the photo’s app, or reconnect its server.' },
  'needs-sign-in': { title: 'Original needs a sign-in' },
  // Available, but not as an original: an export whose provider produced only a preview.
  available: { title: 'Only a preview is here', fix: 'Export on a Mac that can read the original.' },
};
const sourceCodes = new Set(['source-unavailable', 'project-input']);
/** A code in words, such as a template's own: `template:missing-caption` is "Missing caption". */
const codeTitle = (code: string) => { const words = code.replace(/^template:/, '').replace(/-/g, ' '); return words[0].toUpperCase() + words.slice(1); };

function textOf(issue: Issue): CheckText & { key: string } {
  const { code, message, state } = issue;
  if (code && sourceCodes.has(code) && state) {
    // One that no page reports (an asset no page uses) is another problem than one that print needs.
    const { title, ...rest } = states[state];
    return { key: code + ':' + state, title: code === 'project-input' ? title + ' (not placed)' : title, ...rest };
  }
  // A finding that names no problem of its own, such as a template's plain `data-issue` or a render that failed: its
  // message is all there is.
  if (!code || code === 'template-issue') return { key: 'message:' + message, title: message.replace(/\.$/, '') };
  if (Object.hasOwn(texts, code)) return { key: code, ...texts[code] };
  return { key: code, title: codeTitle(code), ...(code.startsWith('template:') && issue.suggestion ? { fix: issue.suggestion } : {}) };
}

/**
 * Book check's rows: one per problem, not per place. What needs something done comes first: errors, then those that only
 * print has a problem with (an original a preview stands in for), then warnings, then what is only good to know.
 */
export function checkRows(found: { errors: readonly Issue[]; warnings: readonly Issue[] }): CheckRow[] {
  const { errors, warnings, notes } = takeAway(found);
  const rows = new Map<string, CheckRow>();
  for (const [level, issues] of [['error', errors], ['warning', warnings]] as const) for (const issue of issues) {
    const { key, ...text } = textOf(issue);
    const id = level + ' ' + key;
    const row = rows.get(id);
    if (row) row.items.push(issue); else rows.set(id, { key: id, level, ...text, items: [issue] });
  }
  const rank = ({ level, key }: CheckRow) => level === 'warning' ? 2 : key.startsWith('error source-unavailable') ? 1 : 0;
  return [...[...rows.values()].sort((a, b) => rank(a) - rank(b)),
    ...notes.map((note): CheckRow => ({ key: 'info ' + note.away, level: 'info', title: awayText(note), items: note.placed, note }))];
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/**
 * A message with the name of its source in place of its stored path and ID. An ID that is only letters may be a word of
 * the message as well ("text", "a"), so it counts as the ID only after the kind of thing it names.
 */
export function namedMessage(message: string, { id, path, name }: { id: string; path?: string; name: string }) {
  const word = /^\p{L}+$/u.test(id) ? '(?<=\\b(?:photo|text|markdown|source|file|asset) )' : '';
  const token = word + '(?<![\\p{L}\\p{N}_./-])' + escaped(id) + '(?![\\p{L}\\p{N}_/-]|\\.[\\p{L}\\p{N}])';
  // In one pass, so a name that holds the ID is not replaced in turn.
  return message.replace(new RegExp([...(path ? [escaped(path)] : []), token].join('|'), 'giu'), (found) => found === path || found === id ? name : found);
}

/** The messages of a row that has no words of its own, each once. */
export function rowMessages({ level, title, detail, items }: CheckRow, readable: (issue: Issue) => string) {
  if (level === 'info' || detail) return [];
  const messages = [...new Set(items.map((issue) => issue.problem ? issue.problem.replace(/\.?$/, '.') : readable(issue)))];
  return messages.filter((message) => message.replace(/\.$/, '') !== title);
}

/**
 * What tells one place of a problem from the others, from the finding's values: "170 ppi, needs 180". Without any, its
 * own message, unless the row says it once for all of them.
 */
export function occurrenceText(row: CheckRow, issue: Issue, readable: (issue: Issue) => string): string | undefined {
  const { code, details } = issue;
  if (code === 'photo-resolution-low' && details?.ppi !== undefined) return details.ppi + ' ppi, needs ' + details.minimumPpi;
  if (code === 'text-overflow' && details?.overflowCharacters) return details.overflowCharacters + ' characters left over';
  if (code === 'text-too-small' && details?.sizePt !== undefined) return details.sizePt + ' pt, needs ' + details.minimumPt;
  if (code === 'text-outside-safe-area' && details?.overshootMm !== undefined) return details.overshootMm + ' mm outside';
  const messages = rowMessages(row, readable);
  if (messages.length < 2) return undefined;
  return issue.problem ?? readable(issue);
}

/**
 * A key for each finding of a check, by which the one being looked at is found again after the book changed: its code and
 * place, not its measured values, and its number among findings that share them.
 */
export function issueKeys(rows: readonly CheckRow[]) {
  const seen = new Map<string, number>();
  return new Map(rows.flatMap(({ items }) => items.map((issue) => {
    const { code, message, spread, cover, page, box, element, source } = issue;
    const key = JSON.stringify([code ?? message, spread, cover, page, box, element, source]);
    const number = seen.get(key) ?? 0;
    seen.set(key, number + 1);
    return [issue, key + number] as const;
  })));
}
