import { Icon } from './Icon';
import { useEffect, useState } from 'react';
import type { DesktopApi, McpSettings } from './desktop';

/** Status-bar indicator while agent access is on; opens the Agents pane in Settings. */
export function AgentStatus({ api }: { api?: DesktopApi }) {
  const [settings, setSettings] = useState<McpSettings>();
  useEffect(() => {
    if (!api) return;
    void api.mcpSettings().then((result) => { if ('value' in result) setSettings(result.value); });
    return api.onMcpChanged(setSettings);
  }, [api]);
  if (!api || !settings?.enabled) return null;
  const { clients } = settings;
  return <button className="agent-status" title={clients.length ? 'Connected: ' + clients.map(({ name }) => name).join(', ') : 'No agent connected'}
    aria-label={clients.length ? 'Connected: ' + clients.map(({ name }) => name).join(', ') : 'No agent connected'}
    onClick={() => void api.showSettings('agents')}><Icon name="agent" />{clients.length > 0 && <span className="connection-dot" />}</button>;
}
