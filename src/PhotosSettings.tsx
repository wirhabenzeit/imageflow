import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import type { DesktopApi, PhotosAccessState } from './desktop';
import { useSourceIcon } from './source-icons';

type Action = 'ask' | 'settings';

/** One status line and at most one action for the Apple Photos card (ADR 0013). */
function summary(access: PhotosAccessState): { tone: 'ok' | 'attention' | 'off'; text: string; action?: Action } {
  switch (access) {
    case 'authorized': return { tone: 'ok', text: 'Allowed to read the Photos library' };
    case 'notDetermined': return { tone: 'attention', text: 'Not asked yet', action: 'ask' };
    case 'denied': case 'limited': return { tone: 'attention', text: 'Not allowed to read the Photos library', action: 'settings' };
    case 'restricted': return { tone: 'off', text: 'Access is restricted on this Mac' };
    case 'unsupported-system': return { tone: 'off', text: 'Needs macOS 15 or later' };
    default: return { tone: 'off', text: 'Not available in this build' };
  }
}
const actionLabels: Record<Action, string> = { ask: 'Allow Access…', settings: 'Open System Settings' };

/**
 * The Apple Photos card of the Sources pane: whether ImageFlow may read the Photos library, the one action that gives it
 * access, and how photos come in. Access is given in System Settings, so the card looks again when its window is focused.
 */
export function PhotosSettings({ api }: { api?: DesktopApi }) {
  const [access, setAccess] = useState<PhotosAccessState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const icon = useSourceIcon('photos');
  useEffect(() => {
    if (!api) return;
    let active = true;
    const refresh = () => void api.photosAccess().then((result) => { if (!active) return; if ('error' in result) setError(result.error); else setAccess(result.value); });
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, [api]);
  async function run(action: Action) {
    if (!api) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.photosAccess(action);
      if ('error' in result) setError(result.error); else setAccess(result.value);
    } finally { setBusy(false); }
  }
  const status = access && summary(access);
  return <section className="source-card" aria-labelledby="photos-title">
    <div className="source-card-head">
      {icon ? <img className="source-card-icon" src={icon} alt="" /> :
        <span className="source-card-icon source-card-icon-fallback" aria-hidden="true"><Icon name="sources" size={22} /></span>}
      <div className="source-card-title">
        <h2 id="photos-title">Apple Photos</h2>
        <p className="source-card-status" role="status">
          <span className={'status-dot status-dot-' + (status?.tone ?? 'off')} aria-hidden="true" />
          <span>{status?.text ?? 'Checking…'}</span>
        </p>
      </div>
      {status?.action && <button className={status.action === 'ask' ? 'primary' : undefined} disabled={busy} onClick={() => void run(status.action!)}>{actionLabels[status.action]}</button>}
    </div>
    {error && <p role="alert" className="error-text source-card-error">{error}</p>}
    {access !== 'unsupported-build' && access !== 'unsupported-system' && <div className="source-card-foot">
      <span>Drag photos from Photos into a book: they are linked, and follow edits made in Photos.</span>
    </div>}
  </section>;
}
