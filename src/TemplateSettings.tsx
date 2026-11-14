import { emptyMenuState } from './commands';
import { useState } from 'react';
import type { DesktopApi } from './desktop';
import { TemplatePreview } from './TemplatePreview';
import { describeImport, templateFormatSummary } from './library';
import { useListSelection } from './list-selection';
import type { LibraryImportResult } from './library';
import type { useLibrary } from './useLibrary';

export function TemplateSettings({ api, library }: { api?: DesktopApi; library: ReturnType<typeof useLibrary> }) {
  const { entries, error } = library;
  const [results, setResults] = useState<LibraryImportResult[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTrust, setPendingTrust] = useState<{ id: string; allow: boolean }>();
  const list = useListSelection(entries?.map(({ id }) => id) ?? [], (id) => entries?.find((entry) => entry.id === id)?.label ?? id, false);
  const selected = list.selected[0] ?? entries?.[0]?.id;
  const entry = entries?.find(({ id }) => id === selected);
  async function run(task: () => Promise<void>) {
    setBusy(true); setMessage(''); setResults([]);
    try { await task(); } catch { setMessage('Could not update the library. Please try again.'); } finally { setBusy(false); }
  }
  const importTemplates = (paths?: string[]) => run(async () => {
    const result = await api!.importTemplates(paths);
    if ('error' in result) setMessage(result.error); else setResults(result.value);
  });
  const remove = (id: string) => run(async () => {
    const result = await api!.removeTemplate(id);
    setMessage('error' in result ? result.error : '');
  });
  const exportTemplate = (id: string) => run(async () => {
    const result = await api!.exportTemplate(id);
    setMessage('error' in result ? result.error : result.value ? 'Exported.' : '');
  });
  const trustTemplate = (id: string, allow: boolean) => run(async () => {
    setPendingTrust({ id, allow });
    try {
      const result = await api!.trustTemplate(id, allow);
      setMessage('error' in result ? result.error : '');
      if ('value' in result) await library.reload();
    } finally { setPendingTrust(undefined); }
  });
  const contextMenu = async (id: string) => {
    const item = entries?.find((item) => item.id === id);
    if (!item || busy) return;
    const result = await api?.showContextMenu(['template-new', 'template-reveal', 'template-export',
      ...(item.source === 'imported' ? ['template-remove' as const] : [])], { ...emptyMenuState, busy });
    if (result?.command === 'template-export') void exportTemplate(id);
    if (result?.command === 'template-remove') void remove(id);
    if (result?.command === 'template-new' || result?.command === 'template-reveal') void run(async () => {
      const action = await api!.templateAction(id, result.command === 'template-new' ? 'new' : 'reveal');
      if ('error' in action) setMessage(action.error);
    });
  };
  return <div className="template-settings" onDragOver={(event) => { event.preventDefault(); }} onDrop={(event) => {
    event.preventDefault(); const paths = api?.pathsForFiles([...event.dataTransfer.files]); if (paths?.length && !busy) void importTemplates(paths);
  }}>
    <div className="template-browser">
      <div className="template-list" role="listbox" aria-label="Templates" onKeyDown={(event) => {
        if ((event.key === 'Delete' || event.key === 'Backspace') && entry?.source === 'imported' && !busy) { event.preventDefault(); void remove(entry.id); }
        else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && selected) { event.preventDefault(); void contextMenu(selected); }
        else list.key(event);
      }}>
        {!entries && !error && <p className="muted">Loading templates…</p>}
        {entries?.map((item) => <div key={item.id} role="option" className="template-library-row" aria-selected={selected === item.id}
          data-list-id={item.id} tabIndex={selected === item.id ? 0 : -1} title={item.unavailable ?? item.description}
          onClick={() => list.choose(item.id)} onContextMenu={(event) => {
            list.context(item.id, event);
            void contextMenu(item.id);
          }}>
          <TemplatePreview api={api} entry={item} natural image /><strong>{item.label}</strong><span className="muted">{item.version}</span>
        </div>)}
      </div>
      <section className="template-detail" aria-label="Template details">
        {entry && <>
          <TemplatePreview api={api} entry={entry} natural />
          <h2 title={entry.source === 'imported' ? entry.id : undefined}>{entry.label} <small className="muted">{entry.version}</small></h2>
          {entry.description && <p>{entry.description}</p>}
          <dl><dt>Formats</dt><dd title={entry.formats.join('\n')}>{templateFormatSummary(entry)}</dd>
            <dt>Layouts</dt><dd title={entry.layouts.join('\n')}>{entry.layouts.length} layouts</dd>
            {entry.source === 'imported' && <><dt>Imported</dt><dd>{entry.importedAt ? new Date(entry.importedAt).toLocaleDateString() : ''}</dd></>}
          </dl>
          {entry.packages?.length ? <section><h3>Packages</h3><ul>{entry.packages.map(({ name, version, license }) =>
            <li key={name}>{name} {version}{license && ' · ' + license}</li>)}</ul></section> : null}
          {entry.network?.length ? <section className="template-network"><h3>Network</h3>
            <p>{entry.network.join(', ')}</p>
            <label className="pc-switch"><input type="checkbox" checked={pendingTrust?.id === entry.id ? pendingTrust.allow : !!entry.networkTrust} disabled={busy || entry.source !== 'imported'}
              onChange={(event) => void trustTemplate(entry.id, event.target.checked)} />Allow network access</label>
          </section> : null}
          {entry.unavailable && <p className="error-text">{entry.unavailable}</p>}
          <div className="template-detail-actions"><button disabled={busy || !api} onClick={() => void exportTemplate(entry.id)}>Export…</button>
            {entry.source === 'imported' && <button disabled={busy || !api} onClick={() => void remove(entry.id)}>Move to Trash</button>}</div>
        </>}
      </section>
    </div>
    <footer className="template-actions"><button type="button" disabled={busy || !api} onClick={() => void importTemplates()}>Import…</button>
      <div className="template-results" role="status">{error || message}
        {results.map((result, i) => <p key={i} className={result.status === 'failed' ? 'error-text' : undefined}>{describeImport(result)}</p>)}
        {error && <button onClick={() => void library.reload()}>Retry</button>}
      </div>
    </footer>
  </div>;
}
