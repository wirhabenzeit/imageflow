import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, ProjectSummary, SourceAction } from './desktop';
import { sourceEntries } from './source-locations';
import { useListSelection } from './list-selection';
import { photoMime, textMime } from './source-items';
import type { SourceRef } from './source-items';
import { Icon } from './Icon';
import { fileName } from './source-items';

export function SourceManager({ api, summary, adopt, disabled = false, quickLook }: {
  api: DesktopApi; summary: ProjectSummary; adopt: (summary: ProjectSummary) => void; disabled?: boolean; quickLook?: (source: SourceRef) => void;
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [error, setError] = useState<{ message: string; code?: string }>();
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<'all' | 'photo' | 'markdown' | 'file' | 'attention'>('all');
  const entries = sourceEntries(summary);
  const unavailable = (key: string) => !!summary.sources?.[key] && summary.sources[key].state !== 'available';
  const linked = entries.filter((entry) => entry.linked).length;
  const missing = entries.filter((entry) => unavailable(entry.key)).length;
  const tabs = [['all', 'All', entries.length], ['photo', 'Photos', entries.filter((entry) => entry.kind === 'photo').length],
    ['markdown', 'Markdown', entries.filter((entry) => entry.kind === 'markdown').length],
    ['file', 'Files', entries.filter((entry) => entry.kind === 'file').length],
    ...(missing ? [['attention', 'Needs attention', missing]] : [])] as const;
  const active = filter !== 'all' && !tabs.some(([kind, , count]) => kind === filter && Number(count) > 0) ? 'all' : filter;
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
    if (busy || disabled || summary.readOnly || !keys.length) return;
    const result = await api.sourceMenu(keys);
    if ('error' in result) setError({ message: result.error });
    else if (result.value) await act({ action: result.value, keys });
  }
  const locked = busy || disabled || summary.readOnly;
  const shown = entries.filter((entry) => active === 'all' || (active === 'attention' ? unavailable(entry.key) : active === entry.kind));
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
      <div className="segmented" role="tablist" aria-label="Asset type">
        {tabs.filter(([kind, , count]) => kind === 'all' || Number(count) > 0).map(([kind, label, count]) => <button key={kind} type="button" role="tab" aria-selected={active === kind}
          onClick={() => { setFilter(kind as typeof filter); list.setSelection([]); }}>{label} <span className="count">{count}</span></button>)}
      </div>
    </header>
    {(linked > 0 || missing > 0) && <div className="asset-banner">
      <span className="muted">{[linked ? linked + ' linked' : '', missing ? missing + ' need attention' : ''].filter(Boolean).join(' · ')}</span>
      {missing > 0 && <button disabled={locked} onClick={() => void act({ action: 'locate-folder' })}>Locate Folder…</button>}
      {linked > 0 && <button disabled={locked || (chosen.length > 0 && !copyCount)} onClick={() => void act({ action: 'collect', keys: copyKeys })}>{chosen.length ? 'Copy ' + copyCount + ' into Book' : 'Copy All into Book'}</button>}
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
        return <div role="option" aria-selected={list.selected.includes(entry.key)} key={entry.key} data-source={entry.key} data-list-id={entry.key}
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
            {(entry.linked || problem) && <span className="muted">{entry.path}</span>}</span></span>
          <span className="asset-status">{badge && <span className="source-badge warning" title={status?.problem}>{badge}</span>}
            {entry.linked && <span className="asset-linked" role="img" aria-label="Linked to original file" title="Linked to original file"><Icon name="link" size={16} /></span>}
          </span>
        </div>;
      })}

      {!shown.length && <p className="asset-empty muted">{active === 'all' ? 'No assets' : 'No ' + (active === 'photo' ? 'photos' : active === 'markdown' ? 'Markdown' : 'files')}</p>}
    </div>
    {error && <p role="alert" data-error-code={error.code} className="error-text">{error.message}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
