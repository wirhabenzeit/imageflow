import { cachedPreviewNote } from './source-locations';
import type { Issue } from './desktop';

export type IssueLevel = 'error' | 'warning';
export type LeveledIssue = { issue: Issue; level: IssueLevel };
export type IssueGroup = { cause: string; level: IssueLevel; items: LeveledIssue[] };
export type IssueRow = { item: LeveledIssue } | { group: IssueGroup };

/**
 * What an issue is about, without what varies from one instance to the next: a missing file's path, the asset an
 * asset problem names ("photo aurora · …"), and the note that a cached preview is shown. Issues with the same cause and
 * level are one problem in many places.
 */
export function issueCause({ message }: Issue) {
  let text = message.endsWith(cachedPreviewNote) ? message.slice(0, -cachedPreviewNote.length) : message;
  text = text.replace(/^(?:photo|text|markdown|file) [^·]+ · /, '');
  const colon = text.indexOf(': ');
  return (colon > 0 ? text.slice(0, colon) : text).replace(/\.+$/, '');
}

/**
 * Book check's rows: issues that share a cause and level `min` times or more become one group, in the place of the
 * first of them; the rest stay single rows, in their order.
 */
export function groupIssues(items: readonly LeveledIssue[], min = 3): IssueRow[] {
  const groups = new Map<string, IssueGroup>();
  for (const item of items) {
    const cause = issueCause(item.issue);
    const key = item.level + '\0' + cause;
    const group = groups.get(key);
    if (group) group.items.push(item); else groups.set(key, { cause, level: item.level, items: [item] });
  }
  const rows: IssueRow[] = [];
  const placed = new Set<IssueGroup>();
  for (const item of items) {
    const group = groups.get(item.level + '\0' + issueCause(item.issue))!;
    if (group.items.length < min) rows.push({ item });
    else if (!placed.has(group)) { placed.add(group); rows.push({ group }); }
  }
  return rows;
}

/** "23 places on 12 spreads", or "40 assets" for problems that are not on a spread. */
export function groupExtent({ items }: IssueGroup) {
  const located = items.filter(({ issue }) => issue.spread || issue.cover);
  const spreads = new Set(located.map(({ issue }) => issue.cover ? 'cover' : issue.spread)).size;
  if (located.length === items.length) return items.length + ' places on ' + (spreads === 1 ? '1 spread' : spreads + ' spreads');
  return items.length + (items.every(({ issue }) => /^photo /.test(issue.message)) ? ' photos' : ' assets');
}
