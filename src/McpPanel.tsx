import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, McpClientTarget, McpSettings } from './desktop';

export function McpPanel({ api }: { api?: DesktopApi }) {
  const [settings, setSettings] = useState<McpSettings>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<'access' | McpClientTarget>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!api) return;
    void api.mcpSettings().then((result) => { if ('value' in result) setSettings(result.value); });
    return api.onMcpChanged(setSettings);
  }, [api]);
  useEffect(() => api?.onCommand((command) => { if (command === 'agent-settings') dialog.current?.showModal(); }), [api]);
  const enabled = !!settings?.enabled;
  async function toggle() {
    if (!api) return;
    setPending('access');
    setError('');
    try {
      const result = await api.mcpSettings(!enabled);
      if ('error' in result) setError(result.error);
      else setSettings(result.value);
    } finally { setPending(undefined); }
  }
  async function install(target: McpClientTarget) {
    if (!api) return;
    setPending(target);
    setError('');
    setNotice('');
    try {
      const result = await api.installMcp(target);
      if ('error' in result) setError(result.error);
      else setNotice(result.value);
    } finally { setPending(undefined); }
  }
  const clients = settings?.clients ?? [];
  const otherConfig = settings && JSON.stringify({ mcpServers: { imageflow: settings.launch } }, null, 2);
  return <>
    {enabled && <button className="agent-status" title={clients.length ? 'Connected: ' + clients.map(({ name }) => name).join(', ') : 'Agent connection enabled · waiting for an agent'}
      onClick={() => dialog.current?.showModal()}>Agent · {clients.length}</button>}
    <dialog ref={dialog} className="mcp-dialog" aria-labelledby="mcp-heading">
      <h2 id="mcp-heading">Connect your agent</h2>
      <p>Let an AI agent check designs, see page images and edit the open book. Its edits can be undone.</p>

      <section aria-labelledby="mcp-install-heading">
        <h3 id="mcp-install-heading">1. Add ImageFlow to your agent</h3>
        <p className="muted">Do this once. You don’t need to install anything else.</p>
        <div className="mcp-targets">
          <button disabled={!!pending} onClick={() => void install('claude')}>Add to Claude Desktop</button>
          <button disabled={!!pending} onClick={() => void install('codex')}>Add to ChatGPT &amp; Codex</button>
        </div>
        {notice && <p role="status">{notice}</p>}
        <details>
          <summary>Claude Code and other agents</summary>
          <p>Run this command for Claude Code:</p>
          <textarea aria-label="Claude Code command" readOnly rows={4} value={settings?.claudeCode ?? ''} />
          <p>Other MCP clients use this stdio server configuration:</p>
          <textarea aria-label="MCP connection configuration" readOnly rows={12} value={otherConfig ?? ''} />
        </details>
      </section>

      <section aria-labelledby="mcp-access-heading">
        <h3 id="mcp-access-heading">2. Allow access while you work</h3>
        <p className="muted">Agents can reach this book only while access is on. Close this dialog so ImageFlow can accept their edits.</p>
        <button className={enabled ? undefined : 'primary'} disabled={!!pending} onClick={() => void toggle()}>
          {enabled ? 'Turn off agent access' : 'Turn on agent access'}
        </button>
        <p role="status">{enabled ? clients.length ? 'Connected: ' + clients.map(({ name }) => name).join(', ') : 'Waiting for an agent.' : 'Agent access is off.'}</p>
      </section>
      {error && <p role="alert" className="error-text">{error}</p>}
      <form method="dialog"><button>Close</button></form>
    </dialog>
  </>;
}
