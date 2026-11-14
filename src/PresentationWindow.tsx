import { useEffect, useState } from 'react';
import type { DesktopApi, ProjectSummary } from './desktop';
import { Presentation } from './Presentation';

export function PresentationWindow({ api }: { api?: DesktopApi }) {
  const [state, setState] = useState<{ summary: ProjectSummary; start: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let changed: ProjectSummary | undefined;
    const stop = api.onProjectChanged((result) => {
      if ('value' in result) {
        changed = result.value;
        setState((current) => current && { ...current, summary: result.value });
        setError('');
      } else if ('error' in result) setError(result.error);
    });
    void api.presentationState().then((result) => {
      if (!mounted) return;
      if ('value' in result) setState({ ...result.value, summary: changed ?? result.value.summary });
      else setError(result.error);
    }).catch(() => { if (mounted) setError('Could not open presentation.'); });
    return () => { mounted = false; stop(); };
  }, [api]);
  useEffect(() => {
    if (state && !error) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') void api?.closePresentation(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [!!state, error, api]);
  if (error) return <main className="presentation"><p className="presentation-message" role="alert">{error}</p>
    <div className="presentation-help"><button onClick={() => void api?.closePresentation()}>End Presentation</button></div></main>;
  return state ? <Presentation summary={state.summary} start={state.start} close={(spread) => void api?.closePresentation(spread)} />
    : <main className="presentation"><p className="presentation-message" role="status">Preparing presentation…</p></main>;
}
