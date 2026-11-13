import { useEffect, useState } from 'react';
import type { DesktopApi } from './desktop';
import { TemplatePreview } from './TemplatePreview';
import { useLibrary } from './useLibrary';

export function StarterPicker({ api }: { api?: DesktopApi }) {
  const { entries, error } = useLibrary(api);
  const [selected, setSelected] = useState<string>();
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const usable = entries?.filter(({ unavailable }) => !unavailable) ?? [];
  useEffect(() => {
    if (entries && !usable.some(({ id }) => id === selected)) setSelected(usable[0]?.id);
  }, [entries]);
  const entry = usable.find(({ id }) => id === selected);
  const create = async (id = selected) => {
    const chosen = usable.find((template) => template.id === id);
    if (!api || !chosen || busy) return;
    setBusy(true); setFailure('');
    try {
      const result = await api.chooseStarter({ id: chosen.id, sample: !!chosen.sample && sample });
      if ('error' in result) setFailure(result.error);
    } catch { setFailure('Could not create the book. Please try again.'); }
    finally { setBusy(false); }
  };
  const imported = entries?.some(({ source }) => source === 'imported');
  return <main className="studio starter-picker" onKeyDown={(event) => {
    if (event.key === 'Enter' && !(event.target as Element).closest('button,input')) { event.preventDefault(); void create(); }
    if (event.key === 'Escape' && !busy) void api?.chooseStarter();
  }}>
    <header><h1>New Book</h1></header>
    <div className="starter-choices" role="listbox" aria-label="Template" aria-busy={busy}>
      {!entries && !error && <p className="muted">Loading templates…</p>}
      {error && <p className="error-text">{error}</p>}
      {(imported ? ['built-in', 'imported'] as const : ['built-in'] as const).map((source) => <section className="starter-group" key={source}>
        {imported && <h2>{source === 'built-in' ? 'ImageFlow' : 'Imported'}</h2>}
        <div className="starter-grid">
          {entries?.filter((item) => item.source === source || !imported).map((template) => <button type="button" role="option"
            key={template.id} aria-label={template.label} aria-selected={selected === template.id} disabled={busy || !!template.unavailable}
            tabIndex={selected === template.id ? 0 : -1} className="starter-choice" title={template.unavailable ?? template.description}
            onClick={() => setSelected(template.id)} onDoubleClick={() => { setSelected(template.id); void create(template.id); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void create(); return; }
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const at = usable.findIndex(({ id }) => id === template.id);
              const next = usable[event.key === 'Home' ? 0 : event.key === 'End' ? usable.length - 1 : Math.max(0, Math.min(usable.length - 1, at + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)))];
              if (next) { setSelected(next.id); document.querySelector<HTMLButtonElement>('[data-template="' + CSS.escape(next.id) + '"]')?.focus(); }
            }} data-template={template.id}>
            <TemplatePreview api={api} entry={template} natural />
            <strong>{template.label}</strong>
            <small title={template.formats[0]}>{template.formats[0]}</small>
          </button>)}
        </div>
      </section>)}
    </div>
    <div className="starter-options">
      {entry?.sample && <label className="pc-switch"><input type="checkbox" checked={sample} disabled={busy}
        onChange={(event) => setSample(event.target.checked)} />Include sample content</label>}
    </div>
    <div className="starter-notice" role="status">{failure || error}
      {(error || (entries && (!usable.length || entries.some(({ unavailable }) => unavailable)))) && <button className="link" onClick={() => void api?.showTemplates()}>Manage Templates…</button>}
    </div>
    <footer><button disabled={busy} onClick={() => void api?.chooseStarter()}>Cancel</button>
      <button className="primary" disabled={!api || !entry || busy} onClick={() => void create()}>Create</button></footer>
  </main>;
}
