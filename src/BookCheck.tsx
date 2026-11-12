import { useEffect, useRef, useState } from 'react';
import type { Issue } from './desktop';

export type BookCheck = { id: string; errors: Issue[]; warnings: Issue[] };

// A labeled book-check status in the footer, with a popover for findings.
export function BookCheckIndicator({ check, checking, spread, select, request = 0 }: {
  request?: number; check?: BookCheck; checking: boolean; spread: string; select: (spread: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const items = [
    ...(check?.errors ?? []).map((issue) => ({ issue, level: 'error' })),
    ...(check?.warnings ?? []).map((issue) => ({ issue, level: 'warning' })),
  ];
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
    if (request) { setOpen(true); root.current?.querySelector('button')?.focus(); }
  }, [request]);

  if (!check) return null;
  const title = 'Book check · ' + label + (checking ? ' · updating…' : '');
  return <div ref={root} className={'book-check-list book-check-' + level + (checking ? ' book-check-stale' : '')}>
    <button type="button" className="book-check-toggle" aria-expanded={open} title={title}
      onClick={() => setOpen(!open)}>
      <span className="visually-hidden">{title}</span>
      <span aria-hidden="true">{checking ? 'Checking book…' : items.length ? label : 'Book check: no issues'}</span>
    </button>
    {open && <div className="book-check-panel" role="dialog" aria-label="Book check">
      <p className="book-check-heading">Book check · {label}</p>
      {!items.length && <p>{checking ? 'Checking book…' : 'No issues found.'}</p>}
      <ul>{items.map(({ issue, level }, i) => <li key={i} className={'issue-' + level + (issue.spread === spread ? ' issue-current' : '')}>
        {issue.spread && issue.where ? <button type="button" className="link" onClick={() => {
          select(issue.spread!);
          setOpen(false);
        }}>{issue.where}</button> : null}
        {issue.spread && issue.where ? ' · ' : ''}{issue.message}
      </li>)}</ul>
    </div>}
  </div>;
}
