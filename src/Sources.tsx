import { awayBadge } from './away-originals';
import { EditMarkdown, NewMarkdown } from './MarkdownActions';
import { assetMenu, assetMenuState, assetActions } from './asset-menu';
import { PhotoViewMenu } from './PhotoViewMenu';
import { SourceBadge, sourceOrigin } from './SourceBadge';
import type { PhotoViewControl } from './PhotoViewMenu';
import { photoGroups, photoDate, captureLabel, captureFact, shownMarks } from './photo-view';
import { bookPhotoMarks, bookPhotoProviders } from './source-properties';
import type { PhotoFilter } from './source-properties';
import { filterActive, filteredSourceList, quickLookList, shownProviders, stripSources } from './photo-filter';
import type { StripFilters } from './photo-filter';
import { FilterChips, FilterPopover, chipItems } from './PhotoFilter';
import { SourceMarks, rejectedMark } from './SourceMarks';
import type { PhotoView } from './photo-view';
import { useListSelection } from './list-selection';
import { useFilmstripAnchor } from './filmstrip-anchor';
import { Icon } from './Icon';
import { useEffect, useMemo, useRef } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { renderOrigin } from './desktop';
import type { ProjectSummary, SourceAction } from './desktop';
import type { SourcePlace, SourceUsage } from './editing';
import { markdownToHtml } from './markdown';
import { excerpt, fileName, photosMime, photoMime, sourceList, textMime, words } from './source-items';
import type { SourceKind, SourceRef, SourcesTab } from './source-items';
import { SourceManager } from './SourceManager';
import { outOfDateNote, photoSourceName, sourceEntries, sourceFile } from './source-locations';
import { asideText } from './asset-usage';

// Content that a layout change set aside is not placed, but has a place to go back to (UI-016).
function pagesText(list: SourcePlace[] | undefined, aside?: SourcePlace[]) {
  if (!list?.length) return ['Not placed', asideText(aside)].filter(Boolean).join(' · ');
  const interior = list.filter(({ cover }) => !cover);
  const cover = interior.length < list.length;
  if (!interior.length) return 'Cover';
  return (interior.length === 1 && !interior[0].pages.includes('–') ? 'Page ' : 'Pages ') +
    interior.map(({ pages }) => pages).join(', ') + (cover ? ', Cover' : '');
}

type SourcesProps = {
  view: PhotoViewControl; summary: ProjectSummary; tab: SourcesTab; setTab: (tab: SourcesTab) => void;
  selected: Partial<Record<SourceKind, string>>; choose: (source: SourceRef) => void; usage: SourceUsage;
  writable: boolean; busy: boolean; importSources: (command: 'import') => void;
  importPaths: (files: File[]) => void; quickLook: (source: SourceRef) => void;
  failure: (message: string) => void; changed: (summary: ProjectSummary) => void;
  // Runs an asset action as a task of the book window, with its progress in the status bar.
  sourceAction: (request: SourceAction) => Promise<void>;
  // The extensions the template's file parameters accept, and the import that takes them as files (dropped files, or a chooser).
  fileTypes: string[]; importFileRequest: (files?: File[]) => void;
  // The strip's filter of each tab (ADR 0014, section 5), kept by the book window so its Quick Look steps through the
  // same list. It lasts as long as the book is open.
  filters: StripFilters; setFilter: (kind: SourceKind, filter: PhotoFilter) => void;
};


// The Assets tab holds the book's other assets: the files of file parameters. It is offered when the template has such
// parameters or the book already holds files, so a book without any does not carry an empty tab.
const hasAssets = (summary: ProjectSummary, fileTypes: string[]) => fileTypes.length > 0 || Object.keys(summary.project.files).length > 0;

// While a tab's filter is set, its count reads as shown of all (`Photos 14/42`).
function SourceTabs({ summary, tab, setTab, assets, filtered = {} }: { summary: ProjectSummary; tab: SourcesTab; setTab: (tab: SourcesTab) => void; assets: boolean; filtered?: Partial<Record<SourcesTab, number>> }) {
  const tabs: [SourcesTab, string, number][] = [
    ['photo', 'Photos', Object.keys(summary.photoIndex).length],
    ['text', 'Texts', Object.keys(summary.project.texts).length],
    ...(assets ? [['assets', 'Assets', Object.keys(summary.project.files).length] as [SourcesTab, string, number]] : []),
  ];
  return <div className="segmented" role="tablist" aria-label="Source type">
    {tabs.map(([kind, label, count]) => <button key={kind} role="tab" aria-selected={tab === kind}
      aria-label={filtered[kind] !== undefined ? label + ', ' + filtered[kind] + ' of ' + count + ' shown' : undefined}
      onClick={() => setTab(kind)}>{label} <span className="count">{filtered[kind] !== undefined ? filtered[kind] + '/' + count : count}</span></button>)}
  </div>;
}
// The filtered count of each tab whose filter is set.
function filteredCounts(summary: ProjectSummary, filters: StripFilters, usage: SourceUsage) {
  return Object.fromEntries((['photo', 'text'] as const).filter((kind) => filterActive(filters[kind]))
    .map((kind) => [kind, filteredSourceList(summary, kind, undefined, filters[kind], usage).length]));
}

// Photos and texts as thumbnails and excerpts, or the book's other assets, the files of file parameters, as a plain list.
export function Sources(props: SourcesProps) {
  const { summary, tab, setTab, view, changed, busy, quickLook, writable, fileTypes, importFileRequest, filters, usage } = props;
  const api = window.imageflow;
  const assets = hasAssets(summary, fileTypes);
  // The last file removed while its tab is open takes the tab with it; the strip shows photos again.
  if (tab !== 'assets' || !assets) return <SourceStrip {...props} tab={tab === 'assets' ? 'photo' : tab} assets={assets} />;
  const tabs = <SourceTabs summary={summary} tab={tab} setTab={setTab} assets filtered={filteredCounts(summary, filters, usage)} />;
  if (!api) return <section className="sources" aria-label="Sources"><div className="sources-bar">{tabs}</div></section>;
  return <SourceManager embedded view={view} api={api} summary={summary} adopt={changed} disabled={busy} quickLook={quickLook} tabs={tabs}
    fileTypes={fileTypes} importFiles={(files) => { if (writable && !busy) importFileRequest(files); }} />;
}

function SourceStrip({ view, summary, tab, setTab, selected, choose, usage, writable, busy, importSources, importPaths, quickLook, failure, sourceAction, assets, filters, setFilter }: SourcesProps & { tab: SourceKind; assets: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const filter = filters[tab];
  const items = useMemo(() => filteredSourceList(summary, tab, view.value, filter, usage), [summary, tab, filter, usage, view.value]);
  const counts = useMemo(() => filteredCounts(summary, filters, usage), [summary, filters, usage]);
  const sources = useMemo(() => stripSources(summary, tab), [summary, tab]);
  const unused = filter.placement === 'unused';
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
    const result = await api.showContextMenu(assetMenu(summary, keys, true, usage), assetMenuState(busy));
    if (!result) return;
    if (result.command === 'asset-preview') { quickLook({ kind: tab, id: ids[0] }); return; }
    const request = result.command === 'asset-jump' ? { action: 'jump' as const, spread: result.value } :
      result.command in assetActions ? { action: assetActions[result.command as keyof typeof assetActions], keys } : undefined;
    if (!request) return;
    await sourceAction(request);
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
    const sourceLabel = sourceState?.pending ? 'Loading' : sourceState?.outOfDate ? 'Out of date' : sourceState?.state !== 'available' && sourceState?.problem ? sourceState.away ? awayBadge[sourceState.away] : (sourceState.cached ? sourceState.state === 'offline' ? 'Cached · Offline' : sourceState.state === 'denied' ? 'Cached · No access' : 'Cached · Missing' : sourceState.state === 'offline' ? 'Offline' : sourceState.state === 'denied' ? 'No access' : 'Unavailable')
      : sourceState && sourceFile(sourceState)?.linked && !view.value.showSource ? 'Linked' : undefined;
    const origin = view.value.showSource ? sourceOrigin(sourceState) : undefined;
    const common = {
      'data-id': id, role: 'option', 'aria-selected': selection.selected.includes(id),
      tabIndex: visibleCurrent === id || (!visibleCurrent && id === items[0]?.id) ? 0 : -1,
      title: title + ' · ' + pagesText(placed, usage.aside?.[tab][id]) + (sourceLabel ? ' · ' + (sourceState?.outOfDate ? outOfDateNote(sourceState) : sourceState?.problem ?? sourceLabel) : ''),
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
      const time = view.value.showTime && date?.captured;
      // The marks the View menus show (ADR 0014); a rejected photo is dimmed while its flags are.
      const marks = shownMarks(view.value, bookPhotoMarks(summary, id));
      return <div key={id} className={'source-item source-photo' + (rejectedMark(marks) ? ' source-rejected' : '')} style={{ aspectRatio: summary.photoSizes[id] ? summary.photoSizes[id].width / summary.photoSizes[id].height : 1.4 }} {...common}>
        {summary.photos[id] ? <img src={summary.photos[id]} alt="" loading="lazy" draggable={false} /> : <span className="missing">{sourceState?.pending ? 'Loading…' : 'Missing'}</span>}
        {origin && <SourceBadge origin={origin} className="source-origin-tile" />}
        <span className="source-title">{title}</span>
        {/* One row along the bottom, so the status, the marks and the capture time never overlap: the status above the
            marks at the start, the time at the end, or a line up where the tile is too narrow for both. */}
        {(sourceLabel || marks.length > 0 || time) && <div className="source-photo-foot">
          {(sourceLabel || marks.length > 0) && <span className="source-photo-foot-start">
            {sourceLabel && <small className="source-storage">{sourceLabel}</small>}
            <SourceMarks marks={marks} variant="tile" />
          </span>}
          {time && <small className="photo-capture-time" title={date.capturedEstimated ? 'Estimated from file modification time' : date.captured}>{captureLabel(date.captured, date.capturedEstimated)}{date.capturedEstimated ? ' ≈' : ''}</small>}
        </div>}
        {!!placed?.length && <small className="badge" aria-label={placed.length === 1 ? 'Used once' : 'Used ' + placed.length + ' times'}>
          {placed.length === 1 ? <Icon name="check" size={12} /> : placed.length + '×'}
        </small>}
      </div>;
    }
    const source = summary.texts[id];
    const { heading, body } = source === undefined ? { heading: undefined, body: '' } : excerpt(source);
    return <div key={id} className="source-item source-text" {...common}>
      <span className="source-title">{origin && <SourceBadge origin={origin} />}{title}</span>
      <EditMarkdown id={id} name={title} disabled={!writable || busy || source === undefined} failure={failure} />
      {source === undefined ? <span className="missing">Missing file</span> : <span className="source-excerpt">
        {heading && <strong>{heading} </strong>}{body}
      </span>}
      {sourceLabel && <small className="source-storage">{sourceLabel}</small>}
      <span className="source-meta">{source !== undefined && words(source) + ' words · '}{pagesText(placed, usage.aside?.[tab][id])}</span>
    </div>;
  }
  const tiles = new Map(items.map((item) => [item.id, renderItem(item)]));
  const noun = tab === 'photo' ? 'photos' : 'texts';
  const change = (next: PhotoFilter) => setFilter(tab, next);
  const providers = useMemo(() => bookPhotoProviders(summary), [summary]);

  return <section className="sources" aria-label="Sources" onDragOver={(event) => {
    if (writable && event.dataTransfer.types.includes('Files')) event.preventDefault();
  }} onDrop={(event) => {
    event.preventDefault();
    if (writable && !busy) importPaths([...event.dataTransfer.files]);
  }}>
    <div className="sources-bar">
      <SourceTabs summary={summary} tab={tab} setTab={setTab} assets={assets} filtered={counts} />
      {/* The chips of what is filtered sit in the space between the tabs and the buttons, and scroll there if they must. */}
      <span className="spacer"><FilterChips chips={chipItems(filter, change, shownProviders(filter, tab === 'photo' ? sources : []), noun)} /></span>
      <FilterPopover filter={filter} change={change} sources={sources} providers={tab === 'photo' ? sources : []} noun={noun} />
      <PhotoViewMenu view={view.value} update={view.update} custom={view.custom} photos={tab === 'photo'} providers={providers} />
      {tab === 'text' && <NewMarkdown disabled={!writable || busy} />}
      <button className="source-import" disabled={!writable || busy} onClick={() => importSources('import')}>Import…</button>
    </div>
    <div ref={list} className={'source-items source-items-' + tab + (tab === 'photo' && view.value.group !== 'none' ? ' source-items-grouped' : '')} role="listbox"
      aria-label={tab === 'photo' ? 'Photos' : 'Texts'} onKeyDown={keys}>
      {!items.length && <p className="source-empty muted">{filterActive(filter) && (tab === 'photo' ? Object.keys(summary.photoIndex).length : Object.keys(summary.project.texts).length)
        ? <>No {noun} match the filters. <button type="button" className="link" onClick={() => change({})}>Clear Filters</button></>
        : tab === 'photo' ? 'No photos yet. Import photos or drop them here.' : 'No Markdown sources yet. Import a .md file or drop it here.'}</p>}
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

// `list`: what Previous and Next step through, the strip's filtered list in a book window (ADR 0014); the whole list
// when it is not given or does not hold the source (a photo opened from the Inspector that the filter hides).
export function QuickLook({ view, summary, source, usage, navigate, close, jump, list }: {
  view?: PhotoView; summary: ProjectSummary; source: SourceRef; usage: SourceUsage;
  navigate: (step: number) => void; close: () => void; jump?: (spread: string) => void; list?: ReturnType<typeof sourceList>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const items = quickLookList(summary, source, view, list);
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
  // Every mark of the photo, whatever the thumbnails show, as the Inspector lists them.
  const marks = photo ? bookPhotoMarks(summary, source.id) : [];
  const details = (photo
    ? [photoSourceName(summary, source.id), date && date.label + ' ' + date.value, size && size.width + ' × ' + size.height + ' px', photo.caption, photo.credit && '© ' + photo.credit]
    : [fileName(item.path), text !== undefined && words(text) + ' words']).filter(Boolean).join(' · ');

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
        <span>{details}{marks.length > 0 && <>{details && ' · '}<SourceMarks marks={marks} /></>}</span>
        <span className="ql-usage">{placed.length ? <>Placed on {placed.map(({ spread, pages }) =>
          jump && spread ? <button key={spread} className="link" onClick={() => { dialog.current?.close(); jump(spread); }}>{pages}</button>
            : <span key={spread}>{pages}</span>)}</> : pagesText(undefined, usage.aside?.[source.kind][source.id])}</span>
      </footer>
    </div>
  </dialog>;
}
