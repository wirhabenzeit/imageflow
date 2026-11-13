import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { DesktopApi, ProjectSummary } from './desktop';
import { bookName } from './book-name';
import { QuickLook } from './Sources';
import { sourceUsage } from './editing';
import type { SourceRef } from './source-items';
import { SourceManager } from './SourceManager';

export function AssetsWindow({ api }: { api?: DesktopApi }) {
  const [summary, setSummary] = useState<ProjectSummary>();
  const [quick, setQuick] = useState<SourceRef>();
  const [error, setError] = useState('');
  useEffect(() => { if (summary) document.title = 'Assets — ' + bookName(summary.folder); }, [summary?.folder]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const retry = async (book: ProjectSummary) => {
    if (!api || book.readOnly || refreshingRef.current || !Object.values(book.sources ?? {}).some(({ state }) => state !== 'available' && state !== 'unapproved')) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const result = await api.sourceAction({ action: 'retry' });
      if ('value' in result) { setSummary(result.value.summary); setError(''); }
      else if (result.code !== 'BOOK_BUSY') setError(result.error);
    } catch { setError('Could not refresh assets.'); }
    finally { refreshingRef.current = false; setRefreshing(false); }
  };
  const focus = useEffectEvent(() => { if (summary) void retry(summary); });
  useEffect(() => {
    if (!api) return;
    let active = true;
    let changed = false;
    const stop = api.onProjectChanged((change) => {
      changed = true;
      if ('value' in change) { setSummary(change.value); setError(''); }
      else if ('error' in change) setError(change.error);
    });
    void api.currentProject().then((result) => {
      if (!active || changed) return;
      if ('error' in result) setError(result.error);
      else { setSummary(result.value); void retry(result.value); }
    }).catch(() => { if (active) setError('Could not load assets.'); });
    const onFocus = () => focus();
    window.addEventListener('focus', onFocus);
    return () => { active = false; stop(); window.removeEventListener('focus', onFocus); };
  }, [api]);
  return <main className="studio assets-window">
    {summary && api ? <SourceManager api={api} summary={summary} adopt={setSummary} disabled={refreshing} quickLook={setQuick} /> : !error && <p className="muted">Loading assets…</p>}
    {summary && quick && <QuickLook summary={summary} source={quick} usage={sourceUsage(summary.project, summary.project.spreads.map((_, i) => 'Spread ' + (i + 1)))}
      close={() => setQuick(undefined)} navigate={(step) => {
        const ids = quick.kind === 'photo' ? Object.keys(summary.photoIndex) : Object.keys(summary.project.texts);
        const next = ids[ids.indexOf(quick.id) + step]; if (next) setQuick({ ...quick, id: next });
      }} />}
    {error && <p className="error-text" role="alert">{error}</p>}
  </main>;
}
