import { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { AppSettings, Appearance } from './settings';

const appearances: { value: Appearance; label: string }[] = [
  { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
];

export function SettingsPanel({ api }: { api?: DesktopApi }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const [settings, setSettings] = useState<AppSettings>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.getSettings().then((result) => {
      if (!active) return;
      if ('error' in result) setError(result.error);
      else setSettings(result.value);
    }).catch(() => { if (active) setError('Could not load settings. Please try again.'); });
    const stop = api.onCommand((command) => {
      if (command === 'settings' && !dialog.current?.open) dialog.current?.showModal();
    });
    return () => { active = false; stop(); };
  }, [api]);

  async function choose(appearance: Appearance) {
    if (!api || !settings) return;
    const request = ++revision.current;
    setSettings({ ...settings, appearance });
    setError('');
    try {
      const result = await api.updateSettings({ appearance });
      if ('error' in result) throw new Error(result.error);
      if (request === revision.current) setSettings(result.value);
    } catch {
      if (request !== revision.current) return;
      setError('Could not save settings. Please try again.');
      const saved = await api.getSettings().catch(() => undefined);
      if (request === revision.current && saved && 'value' in saved) setSettings(saved.value);
    }
  }

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-heading">
    <header className="settings-header"><h2 id="settings-heading">Settings</h2></header>
    <div className="settings-content">
      <section aria-labelledby="settings-general">
        <h3 id="settings-general">General</h3>
        <fieldset className="appearance-setting" disabled={!settings} aria-describedby="appearance-description">
          <legend>Appearance</legend>
          <div className="appearance-options">
            {appearances.map(({ value, label }) => <label key={value}>
              <input type="radio" name="appearance" value={value} checked={settings?.appearance === value} onChange={() => void choose(value)} />
              <span>{label}</span>
            </label>)}
          </div>
          <p id="appearance-description">System follows your macOS appearance. Changes apply immediately.</p>
        </fieldset>
      </section>
      {error && <p role="alert" className="error-text">{error}</p>}
    </div>
    <footer className="settings-footer"><form method="dialog"><button autoFocus>Done</button></form></footer>
  </dialog>;
}
