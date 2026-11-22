import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import type { DesktopApi, LightroomState } from './desktop';

type Tone = 'ok' | 'attention' | 'off';
type Action = 'install' | 'update' | 'launch';

/**
 * One status line and at most one action for the Lightroom Classic card, from the most pressing problem down:
 * the app, the plugin, whether Lightroom runs, whether it loaded the installed plugin, and the connected catalog.
 */
function summary({ plugin, app, connection }: LightroomState): { tone: Tone; text: string; action?: Action } {
  if (!app.installed && plugin.state === 'missing') return { tone: 'off', text: 'Not installed on this Mac' };
  if (plugin.state === 'missing') return { tone: 'attention', text: 'Plugin not installed', action: 'install' };
  if (plugin.state === 'outdated') return { tone: 'attention', text: 'Plugin update available', action: 'update' };
  if (connection) {
    if (plugin.installed && connection.plugin !== plugin.installed) return { tone: 'attention', text: 'Restart Lightroom Classic to load the new plugin' };
    return { tone: 'ok', text: connection.catalog ? 'Connected · ' + connection.catalog : 'Connected' };
  }
  if (!app.running) return { tone: 'off', text: 'Not running', ...(app.installed ? { action: 'launch' as const } : {}) };
  return { tone: 'attention', text: 'Restart Lightroom Classic to load the plugin' };
}

const actionLabels: Record<Action, string> = { install: 'Install Plugin', update: 'Update Plugin', launch: 'Open Lightroom Classic' };

/** The plugin's version, or what is unusual about it. */
function pluginLabel({ plugin }: LightroomState) {
  if (plugin.state === 'missing') return 'Plugin not installed';
  if (plugin.state === 'linked') return 'Plugin linked to a development copy';
  if (plugin.state === 'unknown') return 'Plugin version unknown';
  if (plugin.state === 'newer') return 'Plugin ' + plugin.installed + ' (newer than this app)';
  if (plugin.state === 'outdated') return 'Plugin ' + plugin.installed + ' → ' + plugin.available;
  return 'Plugin ' + plugin.installed;
}

/**
 * The Lightroom Classic card of the Sources pane: the app's icon, a status dot and line, the one action that moves it
 * forward, and a footer with the plugin version and where imports start. Lightroom only reports when it connects, so
 * the card also looks again while it is shown, to notice Lightroom opening or quitting.
 */
export function LightroomSettings({ api }: { api?: DesktopApi }) {
  const [state, setState] = useState<LightroomState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const refresh = () => void api.lightroomState().then((result) => { if (!active) return; if ('error' in result) setError(result.error); else setState(result.value); });
    refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener('focus', refresh);
    const stop = api.onLightroomChanged(setState);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); stop(); };
  }, [api]);
  async function run(action: Action | 'reinstall') {
    if (!api) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'launch') {
        const result = await api.launchLightroom();
        if ('error' in result) setError(result.error);
      } else {
        const result = await api.installLightroomPlugin();
        if ('error' in result) setError(result.error);
        else setState(result.value.state);
      }
    } finally { setBusy(false); }
  }
  const status = state && summary(state);
  const canReinstall = state && (state.plugin.state === 'current' || state.plugin.state === 'newer' || state.plugin.state === 'unknown') && !!state.plugin.available;
  return <section className="source-card" aria-labelledby="lightroom-title">
    <div className="source-card-head">
      {state?.app.icon ? <img className="source-card-icon" src={state.app.icon} alt="" /> :
        <span className="source-card-icon source-card-icon-fallback" aria-hidden="true"><Icon name="sources" size={22} /></span>}
      <div className="source-card-title">
        <h2 id="lightroom-title">Lightroom Classic</h2>
        <p className="source-card-status" role="status">
          <span className={'status-dot status-dot-' + (status?.tone ?? 'off')} aria-hidden="true" />
          <span>{status?.text ?? 'Checking…'}</span>
        </p>
      </div>
      {status?.action && <button className={status.action === 'launch' ? undefined : 'primary'} disabled={busy} onClick={() => void run(status.action!)}>{actionLabels[status.action]}</button>}
    </div>
    {error && <p role="alert" className="error-text source-card-error">{error}</p>}
    {state && state.plugin.state !== 'missing' && <div className="source-card-foot">
      <span>{pluginLabel(state)}</span>
      {canReinstall && <button className="link" disabled={busy} onClick={() => void run('reinstall')}>Reinstall</button>}
      <span className="source-card-hint" title="Or in Lightroom: File → Plug-in Extras → Send to ImageFlow">
        <Icon name="import" size={12} />Assets › Import Selected</span>
    </div>}
  </section>;
}
