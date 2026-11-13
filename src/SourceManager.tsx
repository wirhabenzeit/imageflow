import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, ProjectSummary, SourceAction, TemplateInfo } from './desktop';
import { sourceEntries } from './source-locations';
import { fileName } from './source-items';

export function SourceManager({ api, summary, template, adopt, close }: {
  api: DesktopApi; summary: ProjectSummary; template?: TemplateInfo; adopt: (summary: ProjectSummary) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string }>();
  const [notice, setNotice] = useState('');
  const entries = sourceEntries(summary);
  const parameters = template ? [template.parameters, ...Object.values(template.spreads).flatMap((spread) => [spread.parameters,
    ...Object.values(spread.boxes).map((box) => box.parameters), ...Object.values(spread.elements).map((element) => element.parameters)])] : [];
  const accept = [...new Set(parameters.flatMap((group) => Object.values(group).flatMap((param) => param.type === 'file' ? param.accept : [])))];
  const linked = entries.filter((entry) => entry.linked).length;
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function act(request: SourceAction) {
    setBusy(true); setError(undefined); setNotice('');
    try {
      const result = await api.sourceAction({ ...request, accept });
      if ('error' in result) setError({ message: result.error, code: result.code });
      else { adopt(result.value.summary); setNotice(result.value.message ?? 'Sources updated'); }
    } catch (error) { setError({ message: error instanceof Error ? error.message : 'Could not update sources.' }); }
    finally { setBusy(false); }
  }
  return <dialog className="source-manager" ref={dialog} aria-labelledby="source-manager-title" onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={close}>
    <h2 id="source-manager-title">Book sources</h2>
    <p className="muted">{linked ? `${linked} linked sources depend on external files.` : 'All sources belong to this book.'} Metadata and placements stay in the book.</p>
    <div className="source-manager-actions"><button disabled={busy} onClick={() => void act({ action: 'retry' })}>Retry unavailable sources</button>
      <button disabled={busy} onClick={() => void act({ action: 'locate-folder' })}>Locate Folder…</button>
      <button disabled={busy || !linked} onClick={() => void act({ action: 'collect' })}>Include All Assets</button></div>
    <div className="source-manager-list"><table><thead><tr><th>Source</th><th>Storage</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      {entries.map((entry) => {
        const status = summary.sources?.[entry.key];
        const unavailable = status && status.state !== 'available';
        return <tr key={entry.key}><td><strong>{fileName(entry.path)}</strong><small>{entry.kind === 'markdown' ? 'Markdown' : entry.kind === 'file' ? 'Parameter file' : 'Photo'}</small><span className="source-location" title={entry.path}>{entry.path.split('/').slice(-3).join('/')}</span></td>
          <td>{entry.linked ? 'Linked' : 'In book'}</td><td className={unavailable ? 'error-text' : ''} title={status?.problem}>{unavailable ? status.state === 'unapproved' ? 'Locate to approve access' : status.state === 'missing' ? 'Original missing' : status.state === 'denied' ? 'Access denied' : 'Original unavailable' : 'Available'}{status?.cached && <small>Showing cached preview</small>}</td>
          <td><button disabled={busy || !!unavailable} onClick={() => void act({ action: 'reveal', key: entry.key })}>Reveal</button>
            <button disabled={busy} onClick={() => void act({ action: entry.linked ? 'locate' : 'replace', key: entry.key })}>{entry.linked ? 'Locate…' : 'Replace Original…'}</button>
            {entry.linked && <button disabled={busy || !!unavailable} onClick={() => void act({ action: 'copy', key: entry.key })}>Copy into Book</button>}</td></tr>;
      })}
    </tbody></table></div>
    {error && <p role="alert" data-error-code={error.code} className="error-text">{error.message}</p>}{notice && <p role="status">{notice}</p>}
    <footer><button disabled={busy} onClick={() => dialog.current?.close()}>Done</button></footer>
  </dialog>;
}

export function SaveCopy({ api, close }: { api: DesktopApi; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [include, setInclude] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="save-copy-dialog" ref={dialog} aria-labelledby="save-copy-title" onClose={close} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="save-copy-title">Save a copy</h2>
    <label className="pc-switch"><input type="checkbox" checked={include} disabled={busy} onChange={(event) => setInclude(event.target.checked)} />Include all assets</label>
    <p className="muted">{include ? 'Copy photos, Markdown and parameter files into the saved book so it can move independently. Every original must be available.' : 'Preserve the current mix of copied and linked files. Links include full file paths, which can reveal your account name and folders when shared. Another Mac must locate and approve them.'}</p>
    {error && <p className="error-text" role="alert">{error}</p>}
    <footer><button disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button className="primary" disabled={busy} onClick={() => {
      setBusy(true); setError('');
      void api.saveCopy(include).then((result) => { if ('error' in result) setError(result.error); else dialog.current?.close(); })
        .catch((error) => setError(String(error))).finally(() => setBusy(false));
    }}>Choose Location…</button></footer>
  </dialog>;
}
