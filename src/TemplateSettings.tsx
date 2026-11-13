import { useState } from 'react';
import type { DesktopApi } from './desktop';
import { describeImport } from './library';
import type { LibraryImportResult } from './library';
import type { useLibrary } from './useLibrary';

const date = (value?: string) => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';

/** The Templates pane: the template library a new book is created from. */
export function TemplateSettings({ api, library }: { api?: DesktopApi; library: ReturnType<typeof useLibrary> }) {
  const { entries, error } = library;
  const [results, setResults] = useState<LibraryImportResult[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try { await task(); } finally { setBusy(false); }
  };
  const importTemplates = () => run(async () => {
    setMessage('');
    const result = await api!.importTemplates();
    if ('error' in result) setMessage(result.error);
    else if (result.value.length) setResults(result.value);
  });
  const remove = (id: string) => run(async () => {
    setResults([]);
    const result = await api!.removeTemplate(id);
    setMessage('error' in result ? result.error : result.value ? 'Moved to the Trash. Books made from it are not affected.' : '');
  });
  const exportTemplate = (id: string) => run(async () => {
    setResults([]);
    const result = await api!.exportTemplate(id);
    setMessage('error' in result ? result.error : result.value ? 'Exported to ' + result.value + '.' : '');
  });
  return <div className="template-settings">
    <p className="settings-note template-intro">New books are made from these templates. Each book keeps its own copy, so removing or
      replacing a template here never changes a book.</p>
    {error && <div><p role="alert" className="error-text">{error}</p>
      <button type="button" onClick={() => void library.reload()} aria-label="Retry loading templates">Retry</button></div>}
    <ul className="template-list" aria-label="Templates">
      {!entries && !error && <li className="muted">Loading templates…</li>}
      {entries?.map((entry) => <li key={entry.id} className={entry.unavailable ? 'unavailable' : undefined}>
        <div className="template-row">
          <strong>{entry.label}</strong> <span className="muted">{entry.version}</span>
          <span className="template-source">{entry.source === 'built-in' ? 'Built-in' : 'Imported ' + date(entry.importedAt)}</span>
          <button type="button" disabled={busy || !api} aria-label={'Export ' + entry.label}
            onClick={() => void exportTemplate(entry.id)}>Export…</button>
          {entry.source === 'imported' && <button type="button" disabled={busy || !api} aria-label={'Move ' + entry.label + ' to the Trash'}
            onClick={() => void remove(entry.id)}>Move to Trash</button>}
        </div>
        {entry.description && <p className="settings-note">{entry.description}</p>}
        <p className="settings-note">{[entry.formats.join(', '), entry.layouts.length + (entry.layouts.length === 1 ? ' layout' : ' layouts'),
          entry.id].filter(Boolean).join(' · ')}{entry.replacesBuiltIn ? ' · Replaces the built-in template' : ''}</p>
        {entry.unavailable && <p className="settings-note error-text">Can't be used: {entry.unavailable}</p>}
      </li>)}
    </ul>
    <div className="template-actions">
      <button type="button" disabled={busy || !api} onClick={() => void importTemplates()}>Import…</button>
      <span className="settings-note">Choose template folders or .imageflow-template files. Templates contain code: only import templates from people you trust.</span>
    </div>
    {(results.length > 0 || message) && <div className="template-results" role="status">
      {message && <p className="settings-note">{message}</p>}
      {results.map((result, i) => <div key={i}>
        <p className={'settings-note' + (result.status === 'failed' ? ' error-text' : '')}>{describeImport(result)}</p>
        {result.details?.length ? <ul className="template-details">{result.details.map((detail, j) => <li key={j}>{detail}</li>)}</ul> : null}
      </div>)}
    </div>}
  </div>;
}
