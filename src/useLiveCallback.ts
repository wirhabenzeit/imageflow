import { useCallback, useLayoutEffect, useRef } from 'react';

// Stable event callbacks for memoized UI. Calls always use the latest committed render,
// including permission and revision checks; an abandoned render cannot replace the handler.
export function useLiveCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
