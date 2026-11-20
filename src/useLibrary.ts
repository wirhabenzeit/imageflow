import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { LibraryEntry } from './library';

/**
 * The template library, kept current while imports and removals happen in any window. After `slowMs` without an
 * answer, `slow` says so; the library still shows when it arrives. (It said "try again" and dropped the answer
 * before, so on a slow Mac, where checking the built-in templates takes longer, the Templates window stayed empty.)
 */
export function useLibrary(api?: DesktopApi, { slowMs }: { slowMs?: number } = {}) {
  const [entries, setEntries] = useState<LibraryEntry[]>();
  const [error, setError] = useState('');
  const [slow, setSlow] = useState(false);
  const requests = useRef(0);
  const load = useCallback(async () => {
    if (!api) return;
    const request = ++requests.current;
    const timer = slowMs === undefined ? undefined : setTimeout(() => { if (request === requests.current) setSlow(true); }, slowMs);
    setError('');
    try {
      const result = await api.library();
      if (request !== requests.current) return;
      if ('error' in result) setError(result.error);
      else { setEntries(result.value); setError(''); }
    } catch {
      if (request === requests.current) setError('Could not read the template library.');
    } finally {
      clearTimeout(timer);
      if (request === requests.current) setSlow(false);
    }
  }, [api, slowMs]);
  useEffect(() => {
    if (!api) return;
    void load();
    const stop = api.onLibraryChanged(() => void load());
    return () => { requests.current++; stop(); };
  }, [api, load]);
  return { entries, error, slow, reload: load };
}
