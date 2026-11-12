import { useCallback, useEffect, useState } from 'react';
import type { DesktopApi } from './desktop';
import type { LibraryEntry } from './library';

/** The template library, kept current while imports and removals happen in any window. */
export function useLibrary(api?: DesktopApi) {
  const [entries, setEntries] = useState<LibraryEntry[]>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!api) return;
    const result = await api.library().catch(() => ({ error: 'Could not read the template library.' }));
    if ('error' in result) setError(result.error);
    else { setEntries(result.value); setError(''); }
  }, [api]);
  useEffect(() => {
    if (!api) return;
    void load();
    return api.onLibraryChanged(() => void load());
  }, [api, load]);
  return { entries, error };
}
