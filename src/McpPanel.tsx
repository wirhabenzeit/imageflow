import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, McpSettings } from './desktop';

export function McpPanel({ api }: { api?: DesktopApi }) {
  const [settings, setSettings] = useState<McpSettings>({ enabled: false, clients: [] });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!api) return;
    void api.mcpSettings().then((result) => { if ('value' in result) setSettings(result.value); });
    return api.onMcpChanged(setSettings);
  }, [api]);
  async function toggle() {
    if (!api) return;
    setPending(true);
    setError('');
    try {
      const result = await api.mcpSettings(!settings.enabled);
      if ('error' in result) setError(result.error);
      else setSettings(result.value);
    } finally { setPending(false); }
  }
  return <>
    <button disabled={!api} onClick={() => dialog.current?.showModal()}>
      {settings.enabled ? `Agent connection · ${settings.clients.length}` : 'Connect an agent…'}
    </button>
    <dialog ref={dialog} className="mcp-dialog" aria-labelledby="mcp-heading">
      <h2 id="mcp-heading">Connect your agent</h2>
      <p>Enable a local MCP connection for the book open in ImageFlow. Your agent can check designs, see page images, and edit the book with Undo.</p>
      <button disabled={pending} onClick={() => void toggle()}>{settings.enabled ? 'Disconnect agents' : 'Enable local connection'}</button>
      {settings.config && <>
        <p>Add this server to your agent’s MCP settings, then close this dialog to allow book edits. The bridge requires Node.js 22.20 or newer.</p>
        <textarea aria-label="MCP connection configuration" readOnly rows={9}
          value={JSON.stringify({ mcpServers: { imageflow: settings.config } }, null, 2)} />
        <p>Give the agent access to your project folder to edit template files. Project state changes go through ImageFlow.</p>
      </>}
      <p role="status">{settings.enabled ? settings.clients.length ? 'Connected: ' + settings.clients.map(({ name }) => name).join(', ') : 'Waiting for an agent.' : 'Connection disabled.'}</p>
      {error && <p role="alert" className="error-text">{error}</p>}
      <form method="dialog"><button>Close</button></form>
    </dialog>
  </>;
}
