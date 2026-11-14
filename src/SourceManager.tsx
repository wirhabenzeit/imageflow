import { Fragment, useEffect, useRef, useState } from 'react';
import type { DesktopApi, ProjectSummary, SourceAction } from './desktop';
import { PhotoViewMenu } from './PhotoViewMenu';
import type { PhotoViewControl } from './PhotoViewMenu';
import { photoGroups, photoDate, captureLabel } from './photo-view';
import { sourceList } from './source-items';
import { sourceEntries } from './source-locations';
import { useListSelection } from './list-selection';
import { photoMime, textMime } from './source-items';
import type { SourceRef } from './source-items';
import { assetMenu, assetMenuState, assetActions } from './asset-menu';
import { assetUsage } from './asset-usage';
import { ActionMenu } from './ActionMenu';
import { Icon } from './Icon';
import { fileName } from './source-items';

export function SourceManager({ view, api, summary, adopt, disabled = false, quickLook }: {
  view: PhotoViewControl; api: DesktopApi; summary: ProjectSummary; adopt: (summary: ProjectSummary) => void; disabled?: boolean; quickLook?: (source: SourceRef) => void;
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [error, setError] = useState<{ message: string; code?: string }>();
  const [notice, setNotice] = useState('');
  const [kind, setKind] = useState('all');
  const [used, setUsed] = useState('all');
  const [storage, setStorage] = useState('all');
  const [attention, setAttention] = useState(false);
  const [search, setSearch] = useState('');
  const raw = sourceEntries(summary);
  const entries = [...sourceList(summary, 'photo', view.value).map(({ id }) => raw.find((entry) => entry.kind === 'photo' && entry.id === id)!), ...raw.filter((entry) => entry.kind !== 'photo')];
  const usage = assetUsage(summary, summary.project.spreads.map((_, i) => 'Spread ' + (i + 1)));
  const placements = (entry: typeof entries[number]) => usage[entry.kind === 'markdown' ? 'text' : entry.kind][entry.id] ?? [];
  const unavailable = (key: string) => !!summary.sources?.[key] && summary.sources[key].state !== 'available';
  const linked = entries.filter((entry) => entry.linked).length;
  const missing = entries.filter((entry) => unavailable(entry.key)).length;
  async function act(request: SourceAction) {
    setBusy(true); setError(undefined); setNotice('');
    try {
      let result = await api.sourceAction(request);
      // Background book checks can briefly own the document. A busy response has not started the action.
      for (let attempt = 0; 'error' in result && result.code === 'BOOK_BUSY' && attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!mounted.current) return;
        result = await api.sourceAction(request);
      }
      if ('error' in result) setError({ message: result.error, code: result.code });
      else { adopt(result.value.summary); setNotice(result.value.message ?? ''); }
    } catch (error) { setError({ message: error instanceof Error ? error.message : 'Could not update assets.' }); }
    finally { setBusy(false); }
  }
  async function menu(keys: string[]) {
    if (busy || disabled || !keys.length) return;
    const result = await api.showContextMenu(assetMenu(summary, keys, true), assetMenuState(summary, busy || disabled));
    if (!result) return;
    if (result.command === 'asset-preview') {
      const item = sourceEntries(summary).find(({ key }) => key === keys[0]);
      if (item?.kind === 'file') await act({ action: 'preview', keys });
      else if (item) quickLook?.({ kind: item.kind === 'photo' ? 'photo' : 'text', id: item.id });
    } else if (result.command === 'asset-jump') await act({ action: 'jump', spread: result.value });
    else if (result.command in assetActions) await act({ action: assetActions[result.command as keyof typeof assetActions], keys });
  }
  const locked = busy || disabled || summary.readOnly;
  const shown = entries.filter((entry) => (kind === 'all' || kind === entry.kind) &&
    (used === 'all' || (used === 'used') === !!placements(entry).length) &&
    (storage === 'all' || (storage === 'linked') === entry.linked) && (!attention || unavailable(entry.key)) &&
    fileName(entry.path).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const groups = photoGroups(summary, shown.filter((entry) => entry.kind === 'photo').map(({ id }) => id), view.value);
  const headers = new Map(groups.filter((group) => group.label).map((group) => [group.ids[0], group]));
  const list = useListSelection(shown.map(({ key }) => key), (key) => fileName(entries.find((entry) => entry.key === key)!.path));
  const chosen = entries.filter(({ key }) => list.selected.includes(key));
  const copyCount = chosen.filter(({ linked }) => linked).length;
  const copyKeys = chosen.length ? chosen.filter(({ linked }) => linked).map(({ key }) => key) : undefined;
  const preview = () => {
    const item = entries.find(({ key }) => key === list.selected[0]);
    if (item?.kind === 'file') void act({ action: 'preview', key: item.key });
    else if (item) quickLook?.({ kind: item.kind === 'photo' ? 'photo' : 'text', id: item.id });
  };
  return <section className="source-manager" aria-label="Assets" aria-busy={busy || disabled}>
    <header className="asset-toolbar">
      <input type="search" aria-label="Search assets" placeholder="Search assets" value={search} onChange={(event) => setSearch(event.target.value)} />
      <PhotoViewMenu view={view.value} update={view.update} custom={view.custom} />
      <ActionMenu className="asset-filter" label={<>Filter <Icon name="chevron" /></>}>
        {(['photo', 'markdown', 'file'] as const).map((value) => <button key={value} onClick={() => setKind(kind === value ? 'all' : value)}>{({ photo: 'Photos', markdown: 'Markdown', file: 'Files' })[value]}</button>)}
        <hr />
        <button onClick={() => setUsed(used === 'unused' ? 'all' : 'unused')}>Unused</button>
        <button onClick={() => setUsed(used === 'used' ? 'all' : 'used')}>Used</button>
        <hr />
        <button onClick={() => setStorage(storage === 'linked' ? 'all' : 'linked')}>Linked</button>
        <button onClick={() => setStorage(storage === 'book' ? 'all' : 'book')}>In Book</button>
        <button onClick={() => setAttention(!attention)}>Needs attention</button>
      </ActionMenu>
    </header>
    {(kind !== 'all' || used !== 'all' || storage !== 'all' || attention) && <div className="asset-filter-tokens" aria-label="Active filters">
      {kind !== 'all' && <button onClick={() => setKind('all')} aria-label="Remove kind filter">Kind: {kind} ×</button>}
      {used !== 'all' && <button onClick={() => setUsed('all')} aria-label="Remove usage filter">{used === 'unused' ? 'Unused' : 'Used'} ×</button>}
      {storage !== 'all' && <button onClick={() => setStorage('all')} aria-label="Remove storage filter">{storage === 'linked' ? 'Linked' : 'In Book'} ×</button>}
      {attention && <button onClick={() => setAttention(false)} aria-label="Remove attention filter">Needs attention ×</button>}
    </div>}
    <div className="source-manager-list" role="listbox" aria-label="Assets" aria-multiselectable="true" onKeyDown={(event) => {
      if (event.key === ' ') { event.preventDefault(); preview(); }
      else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); if (!locked && list.selected.length) void act({ action: 'remove', keys: list.selected }); }
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void menu(list.selected); }
      else if (event.key === 'Enter' && !locked && list.selected.length) void act({ action: 'reveal', keys: list.selected });
      else list.key(event);
    }}>
      {shown.map((entry) => {
        const status = summary.sources?.[entry.key];
        const problem = unavailable(entry.key);
        const badge = problem ? status?.state === 'unapproved' ? 'Locate to approve' : status?.state === 'missing' ? 'Missing'
          : status?.state === 'denied' ? 'Access denied' : 'Unavailable' : undefined;
        const group = entry.kind === 'photo' ? headers.get(entry.id) : undefined;
        return <Fragment key={entry.key}>
          {group && <button className="asset-group-heading" onClick={() => list.setSelection(group.ids.map((id) => 'photo:' + id))}>
            {group.label} · {group.ids.length === group.total ? group.total : group.ids.length + ' of ' + group.total}</button>}
          <div role="option" aria-selected={list.selected.includes(entry.key)} key={entry.key} data-source={entry.key} data-list-id={entry.key}
          className="asset-row" tabIndex={(list.focused ?? shown[0]?.key) === entry.key ? 0 : -1} draggable={!locked && !problem}
          onClick={(event) => list.choose(entry.key, event)}
          onContextMenu={(event) => void menu(list.context(entry.key, event))}
          onDragStart={(event) => {
            const keys = list.selected.includes(entry.key) ? list.selected : [entry.key];
            if (entry.kind === 'photo') event.dataTransfer.setData(photoMime, entry.id);
            if (entry.kind === 'markdown') event.dataTransfer.setData(textMime, entry.id);
            event.preventDefault(); void api.dragSources(keys);
          }}
          onDoubleClick={() => { if (!locked && !problem) void act({ action: 'reveal', keys: list.selected.includes(entry.key) ? list.selected : [entry.key] }); }}>
          <span className="asset-icon">{entry.kind === 'photo' && summary.photos[entry.id] ? <img src={summary.photos[entry.id]} alt="" />
            : <span aria-hidden="true">{entry.kind === 'photo' ? '▧' : entry.kind === 'markdown' ? 'Aa' : '▤'}</span>}</span>
          <span className="asset-name" title={entry.path}><span className="asset-description"><strong>{fileName(entry.path)}</strong>
            {(entry.linked || problem) && <span className="muted">{entry.path.split('/').slice(-2, -1)[0]}</span>}</span></span>
          <span className="asset-status">{entry.kind === 'photo' && view.value.showTime && <span className="muted" title={photoDate(summary, entry.id)?.capturedEstimated ? 'Estimated from file modification time' : undefined}>{captureLabel(photoDate(summary, entry.id)?.captured)}{photoDate(summary, entry.id)?.capturedEstimated ? ' ≈' : ''}</span>}<span className="muted">{placements(entry).length ? placements(entry).length + '×' : 'Not used'}</span>{badge && <span className="source-badge warning" title={status?.problem}>{badge}</span>}
            {entry.linked && <span className="asset-linked" role="img" aria-label="Linked to original file" title="Linked to original file"><Icon name="link" size={16} /></span>}
          </span>
        </div></Fragment>;
      })}

      {!shown.length && <p className="asset-empty muted">{entries.length ? 'No matching assets' : 'No assets'}</p>}
    </div>
    <footer className="asset-status-bar">
      <span className="muted">{shown.length} of {entries.length}{chosen.length ? ' · ' + chosen.length + ' selected' : ''}</span>
      {missing > 0 && <button disabled={locked} onClick={() => void act({ action: 'locate-folder' })}>Locate Folder…</button>}
      {linked > 0 && <button disabled={locked || (chosen.length > 0 && !copyCount)} onClick={() => void act({ action: 'collect', keys: copyKeys })}>
        {chosen.length ? 'Copy ' + copyCount + ' Selected into Book' : 'Copy All ' + linked + ' into Book'}</button>}
    </footer>
    {error && <p role="alert" data-error-code={error.code} className="error-text">{error.message}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
