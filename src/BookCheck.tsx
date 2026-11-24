import { coverInstance } from './project';
import type { PageSide } from './project';
import { Icon } from './Icon';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { issueText } from './desktop';
import type { Issue, ProjectSummary } from './desktop';
import { checkRows, issueKeys, occurrenceText, rowMessages } from './issue-groups';
import type { CheckRow } from './issue-groups';
import { awayText } from './away-originals';
import { revealIn } from './reveal';
import { fileName, sourceTitle } from './source-items';
import { sourcePath } from './source-locations';

// `pictures`: how many <RenderedImage> pictures the book view is still drawing; their failures join `errors` as they come.
export type BookCheck = { id: string; errors: Issue[]; warnings: Issue[]; pictures?: number };
const issueTarget = (issue: Issue) => issue.cover ? coverInstance : issue.spread;
const count = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');
// A row shows its first places; the others are there when it is opened.
const shownPlaces = 6;

type Source = { kind: 'photo' | 'text' | 'file'; name: string; thumb?: string };
function sourceOf(summary: ProjectSummary, { source, sourceKind }: Issue): Source | undefined {
  if (!source) return undefined;
  if ((!sourceKind || sourceKind === 'photo') && Object.hasOwn(summary.photoIndex, source)) return { kind: 'photo', name: sourceTitle(summary, 'photo', source), thumb: summary.photos[source] };
  if ((!sourceKind || sourceKind === 'markdown') && Object.hasOwn(summary.project.texts, source)) return { kind: 'text', name: sourceTitle(summary, 'text', source) };
  if (Object.hasOwn(summary.project.files, source)) return { kind: 'file', name: fileName(summary.project.files[source]) };
  return undefined;
}
/** A finding's message with the name of its source in place of its ID and stored path. */
function readableMessage(summary: ProjectSummary, issue: Issue) {
  const { source, message } = issue;
  const name = sourceOf(summary, issue)?.name;
  if (!source || !name) return message;
  const stored = summary.photoIndex[source]?.path ?? summary.project.texts[source] ?? summary.project.files[source];
  return (stored ? message.replaceAll(sourcePath(stored), name) : message).replaceAll(source, name);
}

// A labeled book-check status in the footer, with a panel above it for going through the findings: it stays open while
// they are looked at and fixed in the book, and closes with its button, the indicator or Escape.
export function BookCheckIndicator({ summary, check, checking, spread, select, request = 0, requestSpread, refresh, locateFolder, pages, editing = false }: {
  summary: ProjectSummary; requestSpread?: string; request?: number; check?: BookCheck; checking: boolean; spread: string;
  /** Goes to a finding's spread and points out its box; undefined once none is looked at any more. */
  select: (issue: Issue | undefined) => void;
  /** The page or pages a finding is on, as printed: "9", "8–9" or "Cover". */
  pages: (issue: Issue) => string | undefined;
  refresh?: () => void;
  /** Finds originals that are elsewhere in a folder the user chooses; absent while the book cannot change. */
  locateFolder?: () => void;
  /** An editor in the book is open: Escape is its own, unless the panel has the focus. */
  editing?: boolean;
}) {
  const [scope, setScope] = useState<string>();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // The finding being looked at, with its place in the list: after a fix it is gone, and Next goes on from there.
  const [current, setCurrent] = useState<{ key: string; index: number }>();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const all = useMemo(() => checkRows({ errors: check?.errors ?? [], warnings: check?.warnings ?? [] }), [check?.errors, check?.warnings]);
  const total = (level: CheckRow['level']) => all.reduce((sum, row) => sum + (row.level === level ? row.items.length : 0), 0);
  const errors = total('error'), warnings = total('warning');
  // Informational rows are in no count: a book whose originals are only elsewhere has no issues (#308).
  const label = !check ? 'Checking book…' : !errors && !warnings ? 'No issues' :
    [errors && count(errors, 'error'), warnings && count(warnings, 'warning')].filter(Boolean).join(' · ');
  const level = errors ? 'error' : warnings ? 'warning' : 'clean';
  const rows = useMemo(() => !scope ? all : all.flatMap((row) => {
    const items = row.items.filter((issue) => issueTarget(issue) === scope);
    // Of originals that are elsewhere, those of this spread only.
    const title = row.note ? awayText({ away: row.note.away, sources: [...new Set(items.flatMap(({ source }) => source ?? []))] }) : row.title;
    return items.length ? [{ ...row, title, items }] : [];
  }), [all, scope]);
  const keys = useMemo(() => issueKeys(all), [all]);
  const keyOf = (issue: Issue) => keys.get(issue)!;
  // What Previous and Next go through: every place of every problem, in the order of the rows.
  const stops = useMemo(() => rows.filter(({ level }) => level !== 'info').flatMap(({ key, items }) => items.map((issue) => ({ row: key, issue, key: keys.get(issue)! }))), [rows, keys]);
  const at = current ? stops.findIndex(({ key }) => key === current.key) : -1;
  const nextIndex = at >= 0 ? at + 1 : current ? Math.min(current.index, stops.length) : 0;
  const previousIndex = at >= 0 ? at - 1 : current ? Math.min(current.index, stops.length) - 1 : stops.length - 1;

  function close() {
    const inside = panel.current?.contains(document.activeElement);
    setOpen(false);
    setCurrent(undefined);
    select(undefined);
    if (inside) root.current?.querySelector('button')?.focus();
  }
  function visit(issue: Issue) {
    const key = keyOf(issue);
    setCurrent({ key, index: Math.max(0, stops.findIndex((stop) => stop.key === key)) });
    select(issue);
  }
  const toggleRow = (key: string) => setOpened((previous) => {
    const next = new Set(previous);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  async function menu(issues: Issue[]) {
    const [first] = issues;
    if (!first) return;
    const result = await window.imageflow?.showContextMenu([...(issueTarget(first) ? ['issue-jump' as const] : []), { command: 'issue-copy', value: issues.map(issueText).join('\n') }]);
    if (result?.command === 'issue-jump') visit(first);
  }
  const contextMenu = (issues: Issue[]) => ({
    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); void menu(issues); },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); void menu(issues); }
    },
  });

  // Escape closes the panel, but not while it ends something else, such as a crop.
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && (!editing || root.current?.contains(document.activeElement))) close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  useEffect(() => {
    if (request) { setScope(requestSpread); setOpen(true); setCurrent(undefined); select(undefined); }
  }, [request]);
  // Asked for by the command, the panel takes the focus, so its findings are the next stop for the keyboard.
  useEffect(() => { if (request && open) panel.current?.focus(); }, [request, open]);
  // The finding Previous and Next go to comes into view.
  useEffect(() => {
    const item = list.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (item && list.current) revealIn(list.current, item);
  }, [current]);

  if (!check) return null;
  const drawing = !checking && !!check.pictures;
  const title = 'Book check · ' + (checking ? 'Checking…' : drawing ? 'Rendering…' : label);
  const found = errors + warnings;

  // A place of a problem: its photo (or what stands for its text or file) with its page, and, in an opened row, its name
  // and what tells it from the others.
  function place(row: CheckRow, issue: Issue, full: boolean, index: number) {
    const source = sourceOf(summary, issue);
    const page = pages(issue);
    const text = full ? occurrenceText(row, issue, (item) => readableMessage(summary, item)) : undefined;
    const name = source?.name ?? (page ? undefined : 'Whole book');
    const target = issueTarget(issue);
    const isCurrent = !!current && current.key === keyOf(issue) && row.level !== 'info';
    const pageText = page && (/^\d/.test(page) ? (page.includes('–') ? 'Pages ' : 'Page ') + page : page);
    const description = [name, pageText, text].filter(Boolean).join(', ');
    const className = (full ? 'bc-place' : 'bc-thumb') + (target === spread ? ' issue-current' : '');
    const picture = source?.thumb ? <img src={source.thumb} alt="" loading="lazy" draggable={false} />
      : <span className="bc-glyph" aria-hidden="true">{source?.kind === 'text' ? 'Aa' : <Icon name={source?.kind === 'photo' ? 'sources' : source ? 'document' : 'pageLayout'} size={13} />}</span>;
    const content = <>{(full || source) && picture}
      {full ? <span className="bc-place-text"><span className="bc-place-name">{name ?? pageText}</span>{text && <span className="muted">{text}</span>}</span> : null}
      {page && (!full || name) && <span className="bc-page">{full ? pageText : page}</span>}</>;
    return <li key={index} {...contextMenu([issue])}>{target
      ? <button type="button" className={className} aria-label={description || row.title} title={full ? undefined : description} aria-current={isCurrent || undefined}
          onClick={() => visit(issue)}>{content}</button>
      : <span className={className} tabIndex={full ? 0 : undefined} aria-current={isCurrent || undefined}>{content}</span>}</li>;
  }
  // The places a closed row shows: the first few, or those around the one being looked at.
  function places(row: CheckRow) {
    const located = row.items.filter((issue) => issueTarget(issue));
    const seen = current ? located.findIndex((issue) => keyOf(issue) === current.key) : -1;
    const start = Math.max(0, Math.min(seen - shownPlaces + 2, located.length - shownPlaces));
    const shown = located.slice(start, start + shownPlaces);
    const rest = row.items.length - shown.length;
    if (!shown.length) return null;
    return <ul className="bc-thumbs" aria-label={row.title + ', places'}>{shown.map((issue, i) => place(row, issue, false, start + i))}
      {rest > 0 && <li><button type="button" className="bc-more" aria-label={'Show all ' + row.items.length} onClick={() => toggleRow(row.key)}>+{rest}</button></li>}</ul>;
  }
  function renderRow(row: CheckRow, index: number) {
    const shown = opened.has(row.key);
    const body = id + index;
    const info = row.level === 'info';
    const messages = shown ? rowMessages(row, (issue) => readableMessage(summary, issue)) : [];
    const sentence = [row.detail, row.fix].filter(Boolean).join(' ');
    const reason = messages.length === 1 ? messages[0] : undefined;
    // A problem without places or words of its own has nothing to open.
    const single = row.items.length === 1 ? row.items[0] : undefined;
    const opens = row.items.some((issue) => issueTarget(issue)) || !!sentence || rowMessages(row, (issue) => readableMessage(summary, issue)).length > 0;
    const head = <><span className="bc-icon"><Icon name={info ? 'info' : row.level === 'error' ? 'error' : 'warning'} size={14} /></span>
      <span className="bc-title">{row.title}</span>
      {!info && row.items.length > 1 && <span className="bc-count">{row.items.length}</span>}
      {opens && <span className="bc-chevron" data-open={shown || undefined}><Icon name="chevron" size={12} /></span>}</>;
    const spoken = info ? row.title : (row.level === 'error' ? 'Error: ' : 'Warning: ') + row.title + (row.items.length > 1 ? ', ' + row.items.length : '');
    const currentRow = !!current && !info && stops.some((stop) => stop.row === row.key && stop.key === current.key);
    return <li key={row.key} className={'bc-row issue-' + row.level + (row.items.some((issue) => issueTarget(issue) === spread) ? ' has-current' : '')} {...contextMenu(row.items)}
      aria-current={currentRow && !row.items.some((issue) => issueTarget(issue)) ? 'true' : undefined}>
      {opens ? <button type="button" className="bc-head" aria-expanded={shown} aria-controls={shown ? body : undefined} aria-label={spoken} onClick={() => toggleRow(row.key)}>{head}</button>
        : <div className="bc-head" tabIndex={0}><span className="visually-hidden">{spoken}</span><span className="bc-head-text" aria-hidden="true">{head}</span></div>}
      {row.note?.away === 'other-mac' && locateFolder && <button type="button" className="bc-action" onClick={locateFolder}>Locate Folder…</button>}
      {!shown && !info && places(row)}
      {shown && <div className="bc-body" id={body}>
        {(reason || sentence) && <p>{[reason, sentence].filter(Boolean).join(' ')}</p>}
        {(!single || issueTarget(single) || messages.length > 1) && <ul className="bc-places" aria-label={row.title + ', places'}>{row.items.map((issue, i) => place(row, issue, true, i))}</ul>}
      </div>}
    </li>;
  }
  return <div ref={root} className={'book-check-list book-check-' + level + (checking ? ' book-check-stale' : '')}>
    <button type="button" className="book-check-toggle" aria-expanded={open} title={title} aria-label={title}
      onClick={() => {
        if (open) { close(); return; }
        setScope(spread === coverInstance ? coverInstance : undefined); setOpen(true); refresh?.();
      }}>
      {checking || drawing ? <span className="status-spinner" aria-hidden="true" /> : <Icon name={found ? 'warning' : 'check'} />}
      {found > 0 && <span className="issue-count">{found}</span>}
    </button>
    {open && <div ref={panel} className="book-check-panel" role="dialog" aria-label="Book check" tabIndex={-1}>
      <div className="bc-header">
        <h2 className="book-check-heading">Book check <span className="muted">· {scope === coverInstance ? 'This cover' : scope ? 'This spread' : label}</span></h2>
        {scope && <button type="button" className="link" onClick={() => setScope(undefined)}>Show all</button>}
        {stops.length > 0 && <span className="bc-nav">
          <button type="button" aria-label="Previous finding" title="Previous" disabled={previousIndex < 0} onClick={() => visit(stops[previousIndex].issue)}><Icon name="previous" size={12} /></button>
          <span role="status" aria-label={at >= 0 ? 'Finding ' + (at + 1) + ' of ' + stops.length : undefined}>{at >= 0 ? (at + 1) + ' of ' + stops.length : ''}</span>
          <button type="button" aria-label="Next finding" title="Next" disabled={nextIndex >= stops.length} onClick={() => visit(stops[nextIndex].issue)}><Icon name="next" size={12} /></button>
        </span>}
        <button type="button" className="ep-close bc-close" aria-label="Close" title="Close (Esc)" onClick={close}><Icon name="close" size={12} /></button>
      </div>
      {!rows.some(({ level }) => level !== 'info') && <p className="bc-empty">{checking ? 'Checking book…' : drawing ? 'Rendering…' : 'No issues found.'}</p>}
      {rows.length > 0 && <ul ref={list} className="bc-rows">{rows.map(renderRow)}</ul>}
    </div>}
  </div>;
}
