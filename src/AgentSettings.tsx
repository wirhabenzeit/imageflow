import { useEffect, useState } from 'react';
import type { DesktopApi, McpClientTarget, McpSettings } from './desktop';

/** The Agents pane in Settings: access for open books, and one-time setup per agent app. */
export function AgentSettings({ api }: { api?: DesktopApi }) {
  const [settings, setSettings] = useState<McpSettings>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<'access' | McpClientTarget>();
  // Shows the requested access state while ImageFlow opens or closes the connection.
  const [requested, setRequested] = useState<boolean>();
  useEffect(() => {
    if (!api) return;
    void api.mcpSettings().then((result) => {
      if ('error' in result) setError(result.error);
      else setSettings(result.value);
    });
    return api.onMcpChanged(setSettings);
  }, [api]);
  const enabled = !!settings?.enabled;
  const clients = settings?.clients ?? [];
  async function setAccess(next: boolean) {
    if (!api) return;
    setPending('access');
    setRequested(next);
    setError('');
    try {
      const result = await api.mcpSettings(next);
      if ('error' in result) setError(result.error);
      else setSettings(result.value);
    } finally { setPending(undefined); setRequested(undefined); }
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
  const status = enabled ? clients.length ? 'Connected: ' + clients.map(({ name }) => name).join(', ') : 'Waiting for an agent to connect.'
    : 'Agents select an open book to check, preview and edit with Undo.';
  const otherConfig = settings ? JSON.stringify({ mcpServers: { imageflow: settings.launch } }, null, 2) : '';
  return <div className="settings-form agent-settings">
    <span className="settings-label" id="agent-access-label">Access:</span>
    <div className="settings-control" role="group" aria-labelledby="agent-access-label">
      <label className="pc-switch">
        <input type="checkbox" checked={requested ?? enabled} disabled={!settings || !!pending} onChange={(event) => void setAccess(event.target.checked)} />
        Allow agents to use open books
      </label>
      {/* One line in every state, so checking the box never resizes the window. */}
      <p className="settings-note settings-status" role="status" title={status}>{status}</p>
    </div>

    <span className="settings-label" id="agent-apps-label">Agent apps:</span>
    <div className="settings-control" role="group" aria-labelledby="agent-apps-label">
      <div className="settings-buttons">
        <button disabled={!settings || !!pending} onClick={() => void install('claude')}>Add to Claude Desktop</button>
        <button disabled={!settings || !!pending} onClick={() => void install('codex')}>Add to ChatGPT &amp; Codex</button>
      </div>
      {notice && <p className="settings-note" role="status">{notice}</p>}
      <details className="settings-disclosure">
        <summary>Claude Code and other agents</summary>
        <p className="settings-note">Command for Claude Code:</p>
        <textarea className="settings-code" aria-label="Claude Code command" readOnly rows={5} value={settings?.claudeCode ?? ''} />
        <p className="settings-note">Stdio configuration for other MCP clients:</p>
        <textarea className="settings-code" aria-label="MCP connection configuration" readOnly rows={11} wrap="off" value={otherConfig} />
      </details>
    </div>
    {error && <p role="alert" className="error-text settings-control">{error}</p>}
  </div>;
}
