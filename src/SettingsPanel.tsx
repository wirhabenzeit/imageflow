import { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { AppSettings, Appearance } from './settings';

const appearances: { value: Appearance; label: string }[] = [
  { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
];

export function SettingsPanel({ api }: { api?: DesktopApi }) {
  const revision = useRef(0);
  const pending = useRef(0);
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
    const stop = api.onSettingsChanged((next) => {
      if (!pending.current) setSettings(next);
    });
    return () => { active = false; stop(); };
  }, [api]);

  async function choose(appearance: Appearance) {
    if (!api || !settings) return;
    const request = ++revision.current;
    pending.current++;
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
    } finally { pending.current--; }
  }

  return <main className="studio settings-window" aria-label="Settings">
    <div className="settings-content">
      <section aria-labelledby="settings-general">
        <h1 id="settings-general">General</h1>
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
  </main>;
}
