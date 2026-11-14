import { useEffect, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { UpdateState } from './updates';

/** Shown only in the focused window, so a finished download never stacks a notice in every window. */
export function UpdateNotice({ api }: { api?: DesktopApi }) {
  const [state, setState] = useState<UpdateState>();
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    if (!api) return;
    let active = true, changed = false;
    const stop = api.onUpdateChanged((next) => { changed = true; setState(next); });
    void api.updateState().then((next) => { if (active && !changed) setState(next); });
    const focus = () => setFocused(true), blur = () => setFocused(false);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    return () => { active = false; stop(); window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
  }, [api]);
  if (!api || !focused || state?.status !== 'ready' || state.dismissed) return null;
  return <aside className="if-editor update-notice" aria-label="ImageFlow update">
    <p role="status">An ImageFlow update is ready.</p>
    <div><button className="primary" onClick={() => void api.restartUpdate()}>Restart to Update</button>
      <button onClick={() => void api.dismissUpdate()}>Later</button></div>
  </aside>;
}
