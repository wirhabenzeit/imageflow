import { coverInstance } from './project';
import type { PageSide } from './project';
import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import { issueText } from './desktop';
import type { Issue } from './desktop';
import { awayText, takeAway } from './away-originals';
import { groupExtent, groupIssues } from './issue-groups';
import type { IssueLevel, LeveledIssue } from './issue-groups';

// `pictures`: how many <RenderedImage> pictures the book view is still drawing; their failures join `errors` as they come.
export type BookCheck = { id: string; errors: Issue[]; warnings: Issue[]; pictures?: number };
const issueTarget = (issue: Issue) => issue.cover ? coverInstance : issue.spread;

// A labeled book-check status in the footer, with a popover for findings.
export function BookCheckIndicator({ check, checking, spread, select, request = 0, requestSpread, refresh, locateFolder }: {
  requestSpread?: string; request?: number; check?: BookCheck; checking: boolean; spread: string; select: (spread: string, page?: PageSide) => void;
  refresh?: () => void;
  /** Finds originals that are elsewhere in a folder the user chooses; absent while the book cannot change. */
  locateFolder?: () => void;
}) {
  const [scope, setScope] = useState<string>();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Originals that are elsewhere are no errors or warnings: each reason is one line, which the counts leave out (#308).
  const { errors, warnings, notes } = takeAway({ errors: check?.errors ?? [], warnings: check?.warnings ?? [] });
  const items: LeveledIssue[] = [
    ...errors.map((issue) => ({ issue, level: 'error' as IssueLevel })),
    ...warnings.map((issue) => ({ issue, level: 'warning' as IssueLevel })),
  ];
  async function menu(issue: Issue) {
    const target = issueTarget(issue);
    const result = await window.imageflow?.showContextMenu([...(target ? ['issue-jump' as const] : []), { command: 'issue-copy', value: issueText(issue) }]);
    if (result?.command === 'issue-jump' && target) { select(target, issue.page); setOpen(false); }
  }
  const count = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');
  const label = !check ? 'Checking book…' : !items.length ? 'No issues' :
    [errors.length && count(errors.length, 'error'), warnings.length && count(warnings.length, 'warning')]
      .filter(Boolean).join(' · ');
  const level = errors.length ? 'error' : warnings.length ? 'warning' : 'clean';

  // A click elsewhere or Escape closes the list.
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  useEffect(() => {
    if (request) { setScope(requestSpread); setOpen(true); root.current?.querySelector('button')?.focus(); }
  }, [request]);

  const issueItem = ({ issue, level }: LeveledIssue, key: number) => <li key={key} tabIndex={0} onContextMenu={(event) => { event.preventDefault(); void menu(issue); }}
    onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void menu(issue); } }}
    className={'issue-' + level + (issueTarget(issue) === spread ? ' issue-current' : '')}>
    {(issue.spread || issue.cover) && issue.where ? <button type="button" className="link" onClick={() => {
      select(issueTarget(issue)!, issue.page);
      setOpen(false);
    }}>{issue.where}{issue.page ? ' · ' + issue.page + ' page' : ''}</button> : null}
    {(issue.spread || issue.cover) && issue.where ? ' · ' : ''}{issue.message}
  </li>;
  if (!check) return null;
  const drawing = !checking && !!check.pictures;
  const title = 'Book check · ' + (checking ? 'Checking…' : drawing ? 'Rendering…' : label);
  const scopedItems = scope ? items.filter(({ issue }) => issueTarget(issue) === scope) : items;
  return <div ref={root} className={'book-check-list book-check-' + level + (checking ? ' book-check-stale' : '')}>
    <button type="button" className="book-check-toggle" aria-expanded={open} title={title} aria-label={title}
      onClick={() => { setScope(spread === coverInstance ? coverInstance : undefined); setOpen(!open); if (!open) refresh?.(); }}>
      {checking || drawing ? <span className="status-spinner" aria-hidden="true" /> : <Icon name={items.length ? 'warning' : 'check'} />}
      {items.length > 0 && <span className="issue-count">{items.length}</span>}
    </button>
    {open && <div className="book-check-panel" role="dialog" aria-label="Book check">
      <p className="book-check-heading">Book check · {scope === coverInstance ? 'This cover' : scope ? 'This spread' : label}{scope && <button className="link" onClick={() => setScope(undefined)}>Show all</button>}</p>
      {!scopedItems.length && <p>{checking ? 'Checking book…' : drawing ? 'Rendering…' : 'No issues found.'}</p>}
      <ul>{groupIssues(scopedItems).map((row, i) => 'item' in row ? issueItem(row.item, i) :
        <li key={i} className={'issue-group issue-' + row.group.level}>
          <details><summary><strong>{row.group.cause}</strong> · {groupExtent(row.group)}</summary>
            <ul>{row.group.items.map((item, j) => issueItem(item, j))}</ul>
          </details>
        </li>)}</ul>
      {!scope && notes.map((note) => <p key={note.away} className="book-check-note">{awayText(note)}{note.away === 'other-mac' && locateFolder &&
        <> <button type="button" className="link" onClick={locateFolder}>Locate Folder…</button></>}</p>)}
    </div>}
  </div>;
}
