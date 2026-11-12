import { useEffect, useState } from 'react';
import type { DesktopApi } from './desktop';
import { describeImport } from './library';
import { useLibrary } from './useLibrary';

/** The New Book picker: the templates in the library, shared by the start window and File → New Book. */
export function StarterPicker({ api }: { api?: DesktopApi }) {
  const { entries, error } = useLibrary(api);
  const [selected, setSelected] = useState<string>();
  const [sample, setSample] = useState(true);
  const [notice, setNotice] = useState('');
  const usable = entries?.filter(({ unavailable }) => !unavailable) ?? [];
  // Keep the choice while the library changes; otherwise preselect the first usable template.
  useEffect(() => {
    if (entries && !usable.some(({ id }) => id === selected)) setSelected(usable[0]?.id);
  }, [entries]);
  const entry = usable.find(({ id }) => id === selected);
  const importTemplates = async () => {
    const result = await api?.importTemplates();
    if (result && 'value' in result && result.value.length) setNotice(result.value.map(describeImport).join(' '));
    else if (result && 'error' in result) setNotice(result.error);
  };
  return <main className="studio starter-picker">
    <header><h1>Choose a template</h1><p className="muted">Your book keeps its own copy of the template. Make it yours.</p></header>
    <div className="starter-choices" role="radiogroup" aria-label="Template">
      {!entries && !error && <p className="muted">Loading templates…</p>}
      {error && <p className="error-text">{error}</p>}
      {entries?.map((template) => <label className={'starter-choice' + (template.unavailable ? ' unavailable' : '')} key={template.id}>
        <input type="radio" name="template" value={template.id} checked={selected === template.id} disabled={!!template.unavailable}
          onChange={() => setSelected(template.id)} />
        <span className="starter-art" aria-hidden="true"><span>{template.label}</span><span>{template.layouts.length} layouts</span></span>
        <span className="starter-description">
          <strong>{template.label} <span className="starter-version">{template.version}</span></strong>
          {template.description && <span>{template.description}</span>}
          <small>{template.formats.join(' · ')}{template.source === 'imported' ? ' · Imported' : ''}</small>
          {template.unavailable && <small className="error-text">{template.unavailable}</small>}
        </span>
      </label>)}
    </div>
    {entry?.sample && <label className="pc-switch starter-sample"><input type="checkbox" checked={sample} onChange={(event) => setSample(event.target.checked)} />
      Include sample photos, texts and spreads</label>}
    {entry && !(entry.sample && sample) && <p className="muted starter-start">{entry.openingSpreads
      ? 'The book starts with ' + (entry.openingSpreads === 1 ? 'one spread' : entry.openingSpreads + ' spreads') + ' from the template.'
      : 'The book starts empty; you choose its first spread.'}</p>}
    {notice && <p className="muted starter-notice" role="status">{notice}</p>}
    <footer>
      <button onClick={() => void importTemplates()} disabled={!api}>Import Templates…</button>
      <button onClick={() => void api?.showSettings('templates')} disabled={!api}>Manage Templates…</button>
      <span className="spacer" />
      <button onClick={() => void api?.chooseStarter()}>Cancel</button>
      <button className="primary" disabled={!api || !entry} onClick={() => entry && void api?.chooseStarter({ id: entry.id, sample: !!entry.sample && sample })}>Continue…</button>
    </footer>
  </main>;
}
