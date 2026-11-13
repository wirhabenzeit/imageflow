import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { LibraryEntry } from './library';

/** The template library, kept current while imports and removals happen in any window. */
export function useLibrary(api?: DesktopApi, { timeoutMs }: { timeoutMs?: number } = {}) {
  const [entries, setEntries] = useState<LibraryEntry[]>();
  const [error, setError] = useState('');
  const requests = useRef(0);
  const load = useCallback(async () => {
    if (!api) return;
    const request = ++requests.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError('');
    try {
      const result = await Promise.race([
        api.library(),
        ...(timeoutMs === undefined ? [] : [new Promise<{ error: string }>(resolve => {
          timer = setTimeout(() => resolve({ error: 'Loading templates is taking longer than expected. Try again.' }), timeoutMs);
        })]),
      ]);
      if (request !== requests.current) return;
      if ('error' in result) setError(result.error);
      else { setEntries(result.value); setError(''); }
    } catch {
      if (request === requests.current) setError('Could not read the template library.');
    } finally { clearTimeout(timer); }
  }, [api, timeoutMs]);
  useEffect(() => {
    if (!api) return;
    void load();
    const stop = api.onLibraryChanged(() => void load());
    return () => { requests.current++; stop(); };
  }, [api, load]);
  return { entries, error, reload: load };
}
