import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AgentSettings } from './AgentSettings';
import { Icon } from './Icon';
import type { UpdateChannel } from './update-feed';
import type { UpdateState } from './updates';
import type { DesktopApi } from './desktop';
import type { AppSettings, Appearance, SettingsPane } from './settings';

const panes = [{ value: 'general', label: 'General', icon: 'settings' },
  { value: 'agents', label: 'Agents', icon: 'agent' }] as const satisfies readonly { value: SettingsPane; label: string; icon: string }[];

const appearances: { value: Appearance; label: string }[] = [
  { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
];

export function SettingsPanel({ api }: { api?: DesktopApi }) {
  const [update, setUpdate] = useState<UpdateState>();
  useEffect(() => {
    if (!api) return;
    let active = true, changed = false;
    const stop = api.onUpdateChanged((state) => { changed = true; setUpdate(state); });
    void api.updateState().then((state) => { if (active && !changed) setUpdate(state); });
    return () => { active = false; stop(); };
  }, [api]);
  const revision = useRef(0);
  const pending = useRef(0);
  const [settings, setSettings] = useState<AppSettings>();
  const [error, setError] = useState('');
  const [pane, setPane] = useState<SettingsPane>();
  const [requestedPane, setRequestedPane] = useState<SettingsPane>();
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!api) { setRequestedPane('general'); return; }
    let active = true;
    void api.settingsPane().then((initial) => { if (active) setRequestedPane((current) => current ?? initial); }, () => { if (active) setRequestedPane('general'); });
    const stop = api.onSettingsPane(setRequestedPane);
    return () => { active = false; stop(); };
  }, [api]);
  useLayoutEffect(() => { if (requestedPane) setPane(requestedPane); }, [requestedPane]);
  // The native window follows the selected pane's height, like macOS Settings.
  useLayoutEffect(() => {
    const node = content.current;
    if (!api || !node || !pane || (!settings && !error)) return;
    const fit = () => void api.fitSettings(Math.ceil(node.getBoundingClientRect().height));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [api, pane, !!settings, !!error]);
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

  async function choose(patch: Partial<AppSettings>) {
    if (!api || !settings) return;
    const request = ++revision.current;
    pending.current++;
    setSettings({ ...settings, ...patch });
    setError('');
    try {
      const result = await api.updateSettings(patch);
      if ('error' in result) throw new Error(result.error);
      if (request === revision.current) setSettings(result.value);
    } catch {
      if (request !== revision.current) return;
      setError('Could not save settings. Please try again.');
      const saved = await api.getSettings().catch(() => undefined);
      if (request === revision.current && saved && 'value' in saved) setSettings(saved.value);
    } finally { pending.current--; }
  }

  const tab = (value: SettingsPane) => 'settings-tab-' + value;
  return <main className="studio settings-window" aria-label="Settings" aria-busy={requestedPane !== pane}>
    <div ref={content}>
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {panes.map(({ value, label, icon }) => <button key={value} id={tab(value)} role="tab" aria-selected={pane === value}
          aria-controls="settings-pane" aria-busy={requestedPane === value && pane !== value}
          tabIndex={(requestedPane ?? pane) === value ? 0 : -1} onClick={() => setRequestedPane(value)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const next = panes[(panes.findIndex((item) => item.value === value) + (event.key === 'ArrowRight' ? 1 : panes.length - 1)) % panes.length].value;
            setRequestedPane(next);
            document.getElementById(tab(next))?.focus();
          }}>{requestedPane === value && pane !== value ? <span className="settings-tab-loading" aria-hidden="true" /> :
            <Icon name={icon} size={22} />}{label}</button>)}
      </div>
      {pane && <div className="settings-content" id="settings-pane" role="tabpanel" aria-labelledby={tab(pane)}>
        {pane === 'general' && <div className="settings-form">
          <span className="settings-label" id="appearance-label">Appearance:</span>
          <div className="settings-control">
            <div className="appearance-options" role="radiogroup" aria-labelledby="appearance-label" aria-describedby="appearance-description">
              {appearances.map(({ value, label }) => <label key={value}>
                <input type="radio" name="appearance" value={value} disabled={!settings} checked={settings?.appearance === value} onChange={() => void choose({ appearance: value })} />
                <span>{label}</span>
              </label>)}
            </div>
            <p className="settings-note" id="appearance-description">System follows your macOS appearance.</p>
          </div>
          <span className="settings-label">Editing:</span>
          <div className="settings-control">
            <label><input type="checkbox" checked={settings?.fasterBookUpdates !== false} disabled={!settings}
              onChange={(event) => void choose({ fasterBookUpdates: event.target.checked })} /> Faster book updates</label>
            <p className="settings-note">The book and its thumbnails update in place after each edit. Turn this off if they show something unexpected.</p>
          </div>
          <span className="settings-label">Updates:</span>
          <div className="settings-control">
            <label><input type="checkbox" checked={settings?.automaticUpdates ?? true} disabled={!settings || !update || update.status === 'unavailable' || update.status === 'initializing'}
              onChange={(event) => void choose({ automaticUpdates: event.target.checked })} /> Automatically check for updates</label>
            <label className="update-channel">Channel: <select aria-label="Update channel" value={settings?.updateChannel ?? 'stable'}
              disabled={!settings || !update || ['initializing', 'unavailable', 'checking', 'downloading', 'ready'].includes(update.status)}
              onChange={(event) => void choose({ updateChannel: event.target.value as UpdateChannel })}>
              <option value="stable">Stable</option><option value="beta">Beta</option>
            </select></label>
            <p className="settings-note">Beta includes early versions. Switching to Stable does not downgrade the app.</p>
            <div className="settings-update-actions">
              <button disabled={!api || update?.status === 'initializing' || update?.status === 'checking' || update?.status === 'downloading'} onClick={() => void api?.checkUpdates()}>Check for Updates…</button>
              {update?.status === 'ready' && <button onClick={() => void api?.restartUpdate()}>Restart to Update</button>}
            </div>
            <p className="settings-note update-status" role="status">{update?.status === 'current' ? "You’re up to date." :
              update?.status === 'initializing' ? 'Preparing update checks…' : update?.status === 'checking' ? 'Checking for updates…' : update?.status === 'downloading' ? 'Downloading update…' :
              update?.status === 'ready' ? 'An update is ready to install.' : update?.message ?? ''}</p>
          </div>
          {error && <p role="alert" className="error-text settings-control">{error}</p>}
        </div>}
        {pane === 'agents' && <AgentSettings api={api} />}
      </div>}
    </div>
  </main>;
}
