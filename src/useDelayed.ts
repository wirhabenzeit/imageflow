import { useEffect, useState } from 'react';

/** `value` once it has been true for `ms`; false at once. A state that is over quickly is never shown. */
export function useDelayed(value: boolean, ms: number) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value && shown;
}
