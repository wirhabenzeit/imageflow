import { useEffect, useState } from 'react';
import type { DesktopApi, LightroomState } from './desktop';

/** What Settings says about the plugin in Lightroom's Modules folder. */
function pluginText({ plugin }: LightroomState) {
  if (plugin.state === 'missing') return 'The ImageFlow plugin is not installed.';
  if (plugin.state === 'linked') return 'The ImageFlow plugin is installed as a link to another copy' + (plugin.installed ? ' (' + plugin.installed + ').' : '.');
  if (plugin.state === 'outdated') return 'The ImageFlow plugin ' + plugin.installed + ' is installed; ' + plugin.available + ' is available.';
  if (plugin.state === 'newer') return 'A newer ImageFlow plugin (' + plugin.installed + ') is installed than this version of ImageFlow has.';
  if (plugin.state === 'unknown') return 'An ImageFlow plugin is installed whose version cannot be read.';
  return 'The ImageFlow plugin ' + plugin.installed + ' is installed.';
}
/** Whether Lightroom is connected, and whether it must be restarted to load the plugin that is installed now. */
function connectionText({ plugin, connection }: LightroomState) {
  if (!connection) return 'Lightroom Classic is not connected.';
  const catalog = 'Connected to Lightroom Classic' + (connection.catalog ? ' with ' + connection.catalog : '') + '.';
  return plugin.installed && connection.plugin !== plugin.installed ? catalog + ' Quit and reopen Lightroom Classic to load plugin ' + plugin.installed + '.' : catalog;
}

/** The Lightroom row of the General pane: install or update the plugin, and see whether Lightroom is connected. */
export function LightroomSettings({ api }: { api?: DesktopApi }) {
  const [state, setState] = useState<LightroomState>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.lightroomState().then((result) => { if (!active) return; if ('error' in result) setError(result.error); else setState(result.value); });
    const stop = api.onLightroomChanged(setState);
    return () => { active = false; stop(); };
  }, [api]);
  async function install() {
    if (!api) return;
    setInstalling(true);
    setError('');
    setNotice('');
    try {
      const result = await api.installLightroomPlugin();
      if ('error' in result) setError(result.error);
      else { setState(result.value.state); setNotice(result.value.message); }
    } finally { setInstalling(false); }
  }
  const plugin = state?.plugin;
  const label = !plugin || plugin.state === 'missing' ? 'Install Plugin' : plugin.state === 'outdated' ? 'Update Plugin' : 'Reinstall Plugin';
  return <div className="settings-control" role="group" aria-labelledby="lightroom-label">
    <p className="settings-note settings-status" role="status">{state ? pluginText(state) : 'Checking the Lightroom plugin…'}</p>
    {state && plugin?.state !== 'missing' && <p className="settings-note">{connectionText(state)}</p>}
    <div className="settings-buttons">
      <button disabled={!state || installing || plugin?.state === 'linked' || !plugin?.available} onClick={() => void install()}>{label}</button>
    </div>
    {notice && <p className="settings-note" role="status">{notice}</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <p className="settings-note">Add photos with File → Import from Lightroom Classic…, or in Lightroom with File → Plug-in Extras → Send to ImageFlow.</p>
  </div>;
}
