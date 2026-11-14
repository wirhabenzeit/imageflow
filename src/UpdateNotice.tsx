import { useEffect, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { UpdateState } from './updates';

export function UpdateNotice({ api }: { api?: DesktopApi }) {
  const [state, setState] = useState<UpdateState>();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!api) return;
    let active = true, changed = false;
    const receive = (next: UpdateState) => {
      changed = true;
      setState(next);
      if (next.status === 'ready') setVisible(true);
    };
    const stop = api.onUpdateChanged(receive);
    void api.updateState().then((next) => { if (active && !changed) receive(next); });
    return () => { active = false; stop(); };
  }, [api]);
  if (!api || !visible || state?.status !== 'ready') return null;
  return <aside className="if-editor update-notice" aria-label="ImageFlow update">
    <p role="status">An ImageFlow update is ready.</p>
    <div><button onClick={() => void api.restartUpdate()}>Restart to Update</button>
      <button onClick={() => setVisible(false)}>Later</button></div>
  </aside>;
}
