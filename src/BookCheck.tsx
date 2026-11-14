import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import { issueText } from './desktop';
import type { Issue } from './desktop';

// `pictures`: how many <RenderedImage> pictures the book view is still drawing; their failures join `errors` as they come.
export type BookCheck = { id: string; errors: Issue[]; warnings: Issue[]; pictures?: number };

// A labeled book-check status in the footer, with a popover for findings.
export function BookCheckIndicator({ check, checking, spread, select, request = 0, requestSpread }: {
  requestSpread?: string; request?: number; check?: BookCheck; checking: boolean; spread: string; select: (spread: string) => void;
}) {
  const [scope, setScope] = useState<string>();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const items = [
    ...(check?.errors ?? []).map((issue) => ({ issue, level: 'error' })),
    ...(check?.warnings ?? []).map((issue) => ({ issue, level: 'warning' })),
  ];
  async function menu(issue: Issue) {
    const result = await window.imageflow?.showContextMenu([...(issue.spread ? ['issue-jump' as const] : []), { command: 'issue-copy', value: issueText(issue) }]);
    if (result?.command === 'issue-jump' && issue.spread) { select(issue.spread); setOpen(false); }
  }
  const count = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');
  const label = !check ? 'Checking book…' : !items.length ? 'No issues' :
    [check.errors.length && count(check.errors.length, 'error'), check.warnings.length && count(check.warnings.length, 'warning')]
      .filter(Boolean).join(' · ');
  const level = check?.errors.length ? 'error' : check?.warnings.length ? 'warning' : 'clean';

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

  if (!check) return null;
  const drawing = !checking && !!check.pictures;
  const title = 'Book check · ' + (checking ? 'Checking…' : drawing ? 'Rendering…' : label);
  return <div ref={root} className={'book-check-list book-check-' + level + (checking ? ' book-check-stale' : '')}>
    <button type="button" className="book-check-toggle" aria-expanded={open} title={title} aria-label={title}
      onClick={() => { setScope(undefined); setOpen(!open); }}>
      {checking || drawing ? <span className="status-spinner" aria-hidden="true" /> : <Icon name={items.length ? 'warning' : 'check'} />}
      {items.length > 0 && <span className="issue-count">{items.length}</span>}
    </button>
    {open && <div className="book-check-panel" role="dialog" aria-label="Book check">
      <p className="book-check-heading">Book check · {scope ? 'This spread' : label}{scope && <button className="link" onClick={() => setScope(undefined)}>Show all</button>}</p>
      {!items.length && <p>{checking ? 'Checking book…' : drawing ? 'Rendering…' : 'No issues found.'}</p>}
      <ul>{items.filter(({ issue }) => !scope || issue.spread === scope).map(({ issue, level }, i) => <li key={i} tabIndex={0} onContextMenu={(event) => { event.preventDefault(); void menu(issue); }} onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void menu(issue); } }} className={'issue-' + level + (issue.spread === spread ? ' issue-current' : '')}>
        {issue.spread && issue.where ? <button type="button" className="link" onClick={() => {
          select(issue.spread!);
          setOpen(false);
        }}>{issue.where}</button> : null}
        {issue.spread && issue.where ? ' · ' : ''}{issue.message}
      </li>)}</ul>
    </div>}
  </div>;
}
