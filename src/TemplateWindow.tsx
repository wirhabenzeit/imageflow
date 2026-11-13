import type { DesktopApi } from './desktop';
import { TemplateSettings } from './TemplateSettings';
import { useLibrary } from './useLibrary';

export function TemplateWindow({ api }: { api?: DesktopApi }) {
  const library = useLibrary(api, { timeoutMs: 5000 });
  return <main className="studio template-window" aria-label="Manage Templates"><TemplateSettings api={api} library={library} /></main>;
}
