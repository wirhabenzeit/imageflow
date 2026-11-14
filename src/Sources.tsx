import { assetMenu, assetMenuState, assetActions } from './asset-menu';
import { PhotoViewMenu } from './PhotoViewMenu';
import type { PhotoViewControl } from './PhotoViewMenu';
import { photoGroups, photoDate, captureLabel, captureFact } from './photo-view';
import type { PhotoView } from './photo-view';
import { useListSelection } from './list-selection';
import { useFilmstripAnchor } from './filmstrip-anchor';
import { Icon } from './Icon';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { renderOrigin } from './desktop';
import type { ProjectSummary } from './desktop';
import type { SourceUsage } from './editing';
import { markdownToHtml } from './markdown';
import { excerpt, fileName, photosMime, photoMime, sourceList, textMime, words } from './source-items';
import type { SourceKind, SourceRef } from './source-items';

function pagesText(list: { pages: string }[] | undefined) {
  if (!list?.length) return 'Not placed';
  return (list.length === 1 && !list[0].pages.includes('–') ? 'Page ' : 'Pages ') + list.map(({ pages }) => pages).join(', ');
}

export function Sources({ view, summary, tab, setTab, selected, choose, usage, writable, busy, importSources, importPaths, quickLook, changed, failure }: {
  view: PhotoViewControl; summary: ProjectSummary; tab: SourceKind; setTab: (tab: SourceKind) => void;
  selected: Partial<Record<SourceKind, string>>; choose: (source: SourceRef) => void; usage: SourceUsage;
  writable: boolean; busy: boolean; importSources: (command: 'import') => void;
  importPaths: (files: File[]) => void; quickLook: (source: SourceRef) => void;
  failure: (message: string) => void; changed: (summary: ProjectSummary) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [unused, setUnused] = useState(false);
  const items = useMemo(() => sourceList(summary, tab, view.value).filter(({ id }) => !unused || !usage[tab][id]?.length), [summary, tab, unused, usage, view.value]);
  useFilmstripAnchor(list, tab === 'photo', JSON.stringify([view.value.group, view.value.gapMinutes, items.map(({ id }) => id)]));
  const current = selected[tab];
  const visibleCurrent = items.some(({ id }) => id === current) ? current : undefined;
  const selection = useListSelection(items.map(({ id }) => id), (id) => items.find((item) => item.id === id)?.title ?? id);
  useEffect(() => {
    if (!current) selection.setSelection([]);
    else if (!selection.selected.includes(current)) selection.setSelection([current]);
  }, [current, tab]);
  const groups = tab === 'photo' ? photoGroups(summary, items.map(({ id }) => id), view.value) : [];

  useEffect(() => {
    const node = list.current?.querySelector<HTMLElement>('[data-id="' + CSS.escape(current ?? '') + '"]');
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, tab]);
  useEffect(() => {
    const node = list.current;
    if (!node || tab !== 'photo') return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || node.scrollWidth <= node.clientWidth) return;
      event.preventDefault();
      node.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? node.clientWidth : 1);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [tab]);
  function focus(id: string) {
    choose({ kind: tab, id });
    list.current?.querySelector<HTMLElement>('[data-id="' + CSS.escape(id) + '"]')?.focus();
  }

  async function context(ids: string[]) {
    const api = window.imageflow;
    if (!api || busy || !ids.length) return;
    const keys = ids.map((id) => (tab === 'photo' ? 'photo:' : 'markdown:') + id);
    const result = await api.showContextMenu(assetMenu(summary, keys, true, usage), assetMenuState(summary, busy));
    if (!result) return;
    if (result.command === 'asset-preview') { quickLook({ kind: tab, id: ids[0] }); return; }
    const request = result.command === 'asset-jump' ? { action: 'jump' as const, spread: result.value } :
      result.command in assetActions ? { action: assetActions[result.command as keyof typeof assetActions], keys } : undefined;
    if (!request) return;
    const response = await api.sourceAction(request);
    if ('error' in response) failure(response.error);
    if ('value' in response && response.value.summary.id !== summary.id) changed(response.value.summary);
  }
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void context(selection.selected.length ? selection.selected : current ? [current] : []); return; }
    const at = items.findIndex(({ id }) => id === current);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step && items.length) {
      event.preventDefault();
      const next = items[at < 0 ? 0 : Math.max(0, Math.min(items.length - 1, at + step))].id;
      if (event.shiftKey) selection.key(event); else selection.setSelection([next]);
      focus(next);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (items.length) { const id = items[event.key === 'Home' ? 0 : items.length - 1].id; selection.setSelection([id]); focus(id); }
    } else if (event.key === ' ') {
      event.preventDefault();
      if (current) quickLook({ kind: tab, id: current });
    } else selection.key(event);
  }

  function renderItem({ id, title }: typeof items[number]) {
    const placed = usage[tab][id];
    const sourceState = summary.sources?.[(tab === 'photo' ? 'photo:' : 'markdown:') + id];
    const sourceLabel = sourceState?.state !== 'available' && sourceState?.problem ? (sourceState.cached ? 'Cached · Missing' : 'Unavailable') : sourceState?.linked ? 'Linked' : undefined;
    const common = {
      'data-id': id, role: 'option', 'aria-selected': selection.selected.includes(id),
      tabIndex: visibleCurrent === id || (!visibleCurrent && id === items[0]?.id) ? 0 : -1,
      title: title + ' · ' + pagesText(placed) + (sourceLabel ? ' · ' + (sourceState?.problem ?? sourceLabel) : ''),
      onClick: (event: React.MouseEvent) => { selection.choose(id, event); choose({ kind: tab, id }); },
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => { const ids = selection.context(id, event); choose({ kind: tab, id }); void context(ids); },
      onDoubleClick: () => quickLook({ kind: tab, id }),
      draggable: writable && (tab === 'text' || !!summary.photos[id]),
      onDragStart: (event: DragEvent) => {
        const selected = selection.selected.includes(id) ? selection.selected : [id];
        event.dataTransfer.setData(tab === 'photo' ? photoMime : textMime, id);
        if (tab === 'photo' && selected.length > 1) event.dataTransfer.setData(photosMime, JSON.stringify(selected));
        event.dataTransfer.effectAllowed = 'copy';
      },
    };
    if (tab === 'photo') {
      const date = photoDate(summary, id);
      return <div key={id} className="source-item source-photo" style={{ aspectRatio: summary.photoSizes[id] ? summary.photoSizes[id].width / summary.photoSizes[id].height : 1.4 }} {...common}>
        {summary.photos[id] ? <img src={summary.photos[id]} alt="" loading="lazy" draggable={false} /> : <span className="missing">Missing</span>}
        {view.value.showTime && date?.captured && <small className="photo-capture-time" title={date.capturedEstimated ? 'Estimated from file modification time' : date.captured}>{captureLabel(date.captured, date.capturedEstimated)}{date.capturedEstimated ? ' ≈' : ''}</small>}
        <span className="source-title">{title}</span>
        {sourceLabel && <small className="source-storage">{sourceLabel}</small>}
        {!!placed?.length && <small className="badge" aria-label={placed.length === 1 ? 'Used once' : 'Used ' + placed.length + ' times'}>
          {placed.length === 1 ? <Icon name="check" size={12} /> : placed.length + '×'}
        </small>}
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
  }
  const tiles = new Map(items.map((item) => [item.id, renderItem(item)]));

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
      <PhotoViewMenu view={view.value} update={view.update} custom={view.custom} photos={tab === 'photo'}>
        <button onClick={() => setUnused(false)}>All assets{!unused ? ' ✓' : ''}</button>
        <button onClick={() => setUnused(true)}>Unused only{unused ? ' ✓' : ''}</button>
        {tab === 'photo' && <hr />}
      </PhotoViewMenu>
      <button className="source-import" disabled={!writable || busy} onClick={() => importSources('import')}>Import…</button>
    </div>
    <div ref={list} className={'source-items source-items-' + tab + (tab === 'photo' && view.value.group !== 'none' ? ' source-items-grouped' : '')} role="listbox"
      aria-label={tab === 'photo' ? 'Photos' : 'Texts'} onKeyDown={keys}>
      {!items.length && <p className="source-empty muted">{tab === 'photo'
        ? 'No photos yet. Import photos or drop them here.' : 'No Markdown sources yet. Import a .md file or drop it here.'}</p>}
      {tab === 'photo' && view.value.group !== 'none' ? groups.map((group) => {
        const count = (group.ids.length === group.total ? group.total : group.ids.length + ' of ' + group.total) +
          (unused ? ' unused' : group.ids.length === 1 && group.total === 1 ? ' photo' : ' photos');
        return <div className="photo-strip-group" key={group.id} role="group" aria-label={group.label}>
          <div className="photo-group-heading-track">
            <button className="photo-group-heading" aria-label={'Select ' + group.label} title={group.label + ' · ' + count}
              onClick={() => { selection.setSelection(group.ids); choose({ kind: 'photo', id: group.ids[0] }); }} draggable={writable}
              onDragStart={(event) => { selection.setSelection(group.ids); event.dataTransfer.setData(photoMime, group.ids[0]); event.dataTransfer.setData(photosMime, JSON.stringify(group.ids)); }}>
              <span>{group.label}</span><small> · {count}</small>
            </button>
          </div>
          <div className="photo-group-items">{group.ids.map((id) => tiles.get(id))}</div>
        </div>;
      }) : [...tiles.values()]}
    </div>
  </section>;
}

export function QuickLook({ view, summary, source, usage, navigate, close, jump }: {
  view?: PhotoView; summary: ProjectSummary; source: SourceRef; usage: SourceUsage;
  navigate: (step: number) => void; close: () => void; jump?: (spread: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const items = sourceList(summary, source.kind, view);
  const at = items.findIndex(({ id }) => id === source.id);
  const item = items[at];
  const placed = usage[source.kind][source.id] ?? [];
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.show();
    frame.current?.focus();
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!dialog.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [close]);
  const html = useMemo(() => {
    const text = source.kind === 'text' ? summary.texts[source.id] : undefined;
    return text === undefined ? undefined : markdownToHtml(text);
  }, [summary, source]);
  if (!item) return null;
  const photo = source.kind === 'photo' ? summary.photoIndex[source.id] : undefined;
  const size = summary.photoSizes[source.id];
  const text = summary.texts[source.id];
  const date = photo && captureFact(photoDate(summary, source.id));
  const details = photo
    ? [fileName(photo.path), date && date.label + ' ' + date.value, size && size.width + ' × ' + size.height + ' px', photo.caption, photo.credit && '© ' + photo.credit]
    : [fileName(item.path), text !== undefined && words(text) + ' words'];

  return <dialog ref={dialog} className={'quicklook quicklook-' + source.kind} aria-label={'Quick Look · ' + item.title}
    onClose={close} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
    onKeyDown={(event) => {
      if (event.key === ' ' || event.key === 'Escape') {
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
          jump && spread ? <button key={spread} className="link" onClick={() => { dialog.current?.close(); jump(spread); }}>{pages}</button>
            : <span key={spread}>{pages}</span>)}</> : 'Not placed'}</span>
      </footer>
    </div>
  </dialog>;
}
