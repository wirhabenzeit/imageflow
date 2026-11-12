import type { ImportMode } from './source-locations';
import { ActionMenu } from './ActionMenu';
import { Icon } from './Icon';
import { useEffect, useMemo, useRef } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { renderOrigin } from './desktop';
import type { ProjectSummary } from './desktop';
import type { SourceUsage } from './editing';
import { markdownToHtml } from './markdown';
import { excerpt, fileName, photoMime, sourceList, textMime, words } from './source-items';
import type { SourceKind, SourceRef } from './source-items';

function pagesText(list: { pages: string }[] | undefined) {
  if (!list?.length) return 'Not placed';
  return (list.length === 1 && !list[0].pages.includes('–') ? 'Page ' : 'Pages ') + list.map(({ pages }) => pages).join(', ');
}

export function Sources({ summary, tab, setTab, selected, choose, usage, writable, busy, importSources, importPaths, importWithMode, quickLook }: {
  summary: ProjectSummary; tab: SourceKind; setTab: (tab: SourceKind) => void;
  selected: Partial<Record<SourceKind, string>>; choose: (source: SourceRef) => void; usage: SourceUsage;
  writable: boolean; busy: boolean; importSources: (command: 'import-photos' | 'import-folder' | 'import-texts') => void;
  importWithMode: (kind: 'photo' | 'markdown', mode: ImportMode, folder?: boolean) => void;
  importPaths: (files: File[]) => void; quickLook: (source: SourceRef) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(() => sourceList(summary, tab), [summary, tab]);
  const current = selected[tab];

  function focus(id: string) {
    choose({ kind: tab, id });
    list.current?.querySelector<HTMLElement>('[data-id="' + CSS.escape(id) + '"]')?.focus();
  }

  function keys(event: KeyboardEvent) {
    const at = items.findIndex(({ id }) => id === current);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step && items.length) {
      event.preventDefault();
      focus(items[at < 0 ? 0 : Math.max(0, Math.min(items.length - 1, at + step))].id);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (items.length) focus(items[event.key === 'Home' ? 0 : items.length - 1].id);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (current) quickLook({ kind: tab, id: current });
    }
  }

  const tabs: [SourceKind, string, number][] = [
    ['photo', 'Photos', Object.keys(summary.photoIndex).length],
    ['text', 'Texts', Object.keys(summary.project.texts).length],
  ];
  return <section className="sources" aria-label="Sources" onDragOver={(event) => {
    if (writable && event.dataTransfer.types.includes('Files')) event.preventDefault();
  }} onDrop={(event) => {
    event.preventDefault();
    if (writable && !busy) importPaths([...event.dataTransfer.files]);
  }}>
    <div className="sources-bar">
      <div className="segmented" role="tablist" aria-label="Source type">
        {tabs.map(([kind, label, count]) => <button key={kind} role="tab" aria-selected={tab === kind}
          onClick={() => setTab(kind)}>{label} <span className="count">{count}</span></button>)}
      </div>
      <span className="spacer" />
      <ActionMenu className="source-import" disabled={!writable || busy} label={<>Import <Icon name="chevron" /></>}>
        <button onClick={() => importSources('import-photos')}>Import photos…</button>
        <button onClick={() => importSources('import-folder')}>Import folder…</button>
        <button onClick={() => importSources('import-texts')}>Import Markdown…</button>
        <hr />
        <button onClick={() => importWithMode(tab === 'photo' ? 'photo' : 'markdown', 'copy')}>Copy {tab === 'photo' ? 'photos' : 'Markdown'} into Book…</button>
        <button onClick={() => importWithMode(tab === 'photo' ? 'photo' : 'markdown', 'link')}>Link to {tab === 'photo' ? 'photos' : 'Markdown'}…</button>
        {tab === 'photo' && <button onClick={() => importWithMode('photo', 'link', true)}>Link to photo folder…</button>}
      </ActionMenu>
    </div>
    <div ref={list} className={'source-items source-items-' + tab} role="listbox"
      aria-label={tab === 'photo' ? 'Photos' : 'Texts'} onKeyDown={keys}>
      {!items.length && <p className="source-empty muted">{tab === 'photo'
        ? 'No photos yet. Import photos or drop them here.' : 'No Markdown sources yet. Import a .md file or drop it here.'}</p>}
      {items.map(({ id, title }, i) => {
        const placed = usage[tab][id];
        const sourceState = summary.sources?.[(tab === 'photo' ? 'photo:' : 'markdown:') + id];
        const sourceLabel = sourceState?.state !== 'available' && sourceState?.problem ? (sourceState.cached ? 'Cached · Missing' : 'Unavailable') : sourceState?.linked ? 'Linked' : undefined;
        const common = {
          'data-id': id, role: 'option', 'aria-selected': current === id,
          tabIndex: current === id || (!current && i === 0) ? 0 : -1,
          title: title + ' · ' + pagesText(placed) + (sourceLabel ? ' · ' + (sourceState?.problem ?? sourceLabel) : ''),
          onClick: () => focus(id),
          onDoubleClick: () => quickLook({ kind: tab, id }),
          draggable: writable && (tab === 'text' || !!summary.photos[id]),
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.setData(tab === 'photo' ? photoMime : textMime, id);
            event.dataTransfer.effectAllowed = 'copy';
          },
        };
        if (tab === 'photo') {
          return <div key={id} className="source-item source-photo" {...common}>
            {summary.photos[id] ? <img src={summary.photos[id]} alt="" loading="lazy" draggable={false} /> : <span className="missing">Missing</span>}
            <span className="source-title">{title}</span>
            {sourceLabel && <small className="source-storage">{sourceLabel}</small>}
            {!!placed?.length && <small className="badge">{placed.length}×</small>}
          </div>;
        }
        const source = summary.texts[id];
        const { heading, body } = source === undefined ? { heading: undefined, body: '' } : excerpt(source);
        return <div key={id} className="source-item source-text" {...common}>
          <span className="source-title">{title}</span>
          {source === undefined ? <span className="missing">Missing file</span> : <span className="source-excerpt">
            {heading && <strong>{heading} </strong>}{body}
          </span>}
          {sourceLabel && <small className="source-storage">{sourceLabel}</small>}
          <span className="source-meta">{source !== undefined && words(source) + ' words · '}{pagesText(placed)}</span>
        </div>;
      })}
    </div>
  </section>;
}

export function QuickLook({ summary, source, usage, navigate, close, jump }: {
  summary: ProjectSummary; source: SourceRef; usage: SourceUsage;
  navigate: (step: number) => void; close: () => void; jump: (spread: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const items = sourceList(summary, source.kind);
  const at = items.findIndex(({ id }) => id === source.id);
  const item = items[at];
  const placed = usage[source.kind][source.id] ?? [];
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    frame.current?.focus();
  }, []);
  const html = useMemo(() => {
    const text = source.kind === 'text' ? summary.texts[source.id] : undefined;
    return text === undefined ? undefined : markdownToHtml(text);
  }, [summary, source]);
  if (!item) return null;
  const photo = source.kind === 'photo' ? summary.photoIndex[source.id] : undefined;
  const size = summary.photoSizes[source.id];
  const text = summary.texts[source.id];
  const details = photo
    ? [fileName(photo.path), size && size.width + ' × ' + size.height + ' px', photo.caption, photo.credit && '© ' + photo.credit]
    : [fileName(item.path), text !== undefined && words(text) + ' words'];

  return <dialog ref={dialog} className={'quicklook quicklook-' + source.kind} aria-label={'Quick Look · ' + item.title}
    onClose={close} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
    onKeyDown={(event) => {
      if (event.key === ' ') {
        event.preventDefault();
        dialog.current?.close();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        navigate(event.key === 'ArrowLeft' ? -1 : 1);
      }
    }}>
    <div ref={frame} className="ql-frame" tabIndex={-1}>
      <header className="ql-header">
        <div className="ql-nav">
          <button aria-label="Previous" disabled={at <= 0} onClick={() => navigate(-1)}><Icon name="previous" /></button>
          <button aria-label="Next" disabled={at >= items.length - 1} onClick={() => navigate(1)}><Icon name="next" /></button>
        </div>
        <h2>{item.title}</h2>
        <span className="muted">{at + 1} of {items.length}</span>
        <button className="ql-close" aria-label="Close Quick Look" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </header>
      {source.kind === 'photo'
        ? <div className="ql-body ql-photo">{summary.photos[source.id]
          ? <img key={source.id} src={renderOrigin + '/render/' + summary.id + '/photo/' + source.id} alt={photo?.altText || item.title} />
          : <p className="missing">The photo file is missing.</p>}</div>
        : <div className="ql-body ql-text">{html === undefined
          ? <p className="missing">The Markdown file is missing.</p>
          : <article className="ql-markdown" dangerouslySetInnerHTML={{ __html: html }} />}</div>}
      <footer className="ql-footer">
        <span>{details.filter(Boolean).join(' · ')}</span>
        <span className="ql-usage">{placed.length ? <>Placed on {placed.map(({ spread, pages }) =>
          <button key={spread} className="link" onClick={() => { dialog.current?.close(); jump(spread); }}>{pages}</button>)}</> : 'Not placed'}</span>
      </footer>
    </div>
  </dialog>;
}
