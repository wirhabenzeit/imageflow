import { useSyncExternalStore } from 'react';

/**
 * The icons of the apps photos come from (Lightroom Classic, Photos), as this Mac draws them, for asset badges and
 * Settings' source cards. Asked for once per window, the first time a badge needs one; until they come, or where an
 * app is not on this Mac, the badge draws a mark of its own.
 */
type Icons = { lightroom?: string; photos?: string };
let icons: Icons = {};
let asked = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!asked && typeof window !== 'undefined' && window.imageflow?.sourceIcons) {
    asked = true;
    void window.imageflow.sourceIcons().then((result) => {
      if ('error' in result) return;
      icons = result.value;
      for (const notify of listeners) notify();
    }, () => {});
  }
  return () => { listeners.delete(listener); };
}
/** The icon of an app photos come from, or undefined while there is none to show. */
export const useSourceIcon = (app: keyof Icons) => useSyncExternalStore(subscribe, () => icons[app], () => undefined);
