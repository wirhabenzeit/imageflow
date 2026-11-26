import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

// Keep the same point in the center photo while tile sizes follow the panel height.
export function useFilmstripAnchor(ref: RefObject<HTMLDivElement | null>, enabled: boolean, items: string) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    function measure() {
      const left = node!.getBoundingClientRect().left + node!.clientLeft;
      return { width: node!.clientWidth, height: node!.clientHeight, scroll: node!.scrollLeft,
        photos: [...node!.querySelectorAll<HTMLElement>('.source-photo')].map((photo) => {
          const rect = photo.getBoundingClientRect();
          return { id: photo.dataset.id, left: rect.left - left + node!.scrollLeft, width: rect.width };
        }) };
    }
    let previous = measure();
    let anchor: { id?: string; fraction: number } | undefined;
    let restoredScroll: number | undefined;
    const scroll = () => {
      // Resize can also generate a scroll event; keep the old geometry until it is restored.
      if (node.clientWidth !== previous.width || node.clientHeight !== previous.height) return;
      if (restoredScroll !== undefined && node.scrollLeft === restoredScroll) return;
      previous = measure();
      anchor = undefined;
      restoredScroll = undefined;
    };
    const observer = new ResizeObserver(() => {
      const next = measure();
      if (next.width !== previous.width || next.height !== previous.height) {
        // Keep the original point across successive resize frames. Intermediate scroll offsets can be rounded
        // or clamped at the strip's edge; choosing a fresh anchor there would gradually move the center.
        if (!anchor) {
          const center = previous.scroll + previous.width / 2;
          const distance = (photo: typeof previous.photos[number]) => Math.max(photo.left - center, center - photo.left - photo.width, 0);
          const photo = previous.photos.reduce<typeof previous.photos[number] | undefined>((best, photo) =>
            !best || distance(photo) < distance(best) ? photo : best, undefined);
          if (photo && photo.width > 0) anchor = { id: photo.id, fraction: Math.max(0, Math.min(1, (center - photo.left) / photo.width)) };
        }
        const chosen = anchor;
        const photo = chosen && next.photos.find(({ id }) => id === chosen.id);
        if (chosen && photo) {
          node.scrollLeft = photo.left + chosen.fraction * photo.width - next.width / 2;
          next.scroll = node.scrollLeft;
          restoredScroll = next.scroll;
        }
      }
      previous = next;
    });
    node.addEventListener('scroll', scroll, { passive: true });
    observer.observe(node);
    return () => { observer.disconnect(); node.removeEventListener('scroll', scroll); };
  }, [ref, enabled, items]);
}

/** The photo to keep in place when the strip's list changes: `center` if it is still listed, else the listed one nearest to it in the order before. */
export function survivingAnchor(before: readonly string[], after: readonly string[], center: string): string | undefined {
  const kept = new Set(after), at = before.indexOf(center);
  if (at < 0) return undefined;
  for (let distance = 0; distance < before.length; distance++) {
    for (const index of [at - distance, at + distance]) { const id = before[index]; if (id !== undefined && kept.has(id)) return id; }
  }
  return undefined;
}

/**
 * Keeps the strip where the user was when its list changes (a filter set or cleared, photos imported, removed or sorted
 * otherwise), instead of leaving the scroll offset to point at whatever now lies there, or at the start.
 * - When the filter changed (`filter`) and the selected photo is listed, it is scrolled into view: it is what the user
 *   was looking at, and it comes back with a filter that is cleared.
 * - Otherwise the photo that was in the middle of the strip stays where it was; where the change removed it, the
 *   nearest photo before or after it that is left takes the middle. Hiding the selected photo so moves nothing.
 * - With none of them left, the strip starts at its beginning.
 */
export function useFilmstripListAnchor(ref: RefObject<HTMLDivElement | null>, enabled: boolean, ids: readonly string[], selected: string | undefined, filter: string) {
  const seen = useRef<{ ids: readonly string[]; filter: string; center?: { id: string; fraction: number } }>({ ids, filter });
  const key = ids.join('\n');
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !enabled) { seen.current = { ids, filter }; return; }
    const tile = (id: string) => node.querySelector<HTMLElement>('.source-photo[data-id="' + CSS.escape(id) + '"]');
    const left = (photo: HTMLElement) => photo.getBoundingClientRect().left - node.getBoundingClientRect().left - node.clientLeft + node.scrollLeft;
    const before = seen.current;
    if (before.ids.join('\n') !== key) {
      const chosen = before.filter !== filter && selected !== undefined ? tile(selected) : null;
      if (chosen) chosen.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      else if (before.center) {
        const id = survivingAnchor(before.ids, ids, before.center.id);
        const photo = id === undefined ? null : tile(id);
        // The same point of the same photo, or the middle of the one that stands in for it.
        node.scrollLeft = photo ? left(photo) + (id === before.center.id ? before.center.fraction : .5) * photo.offsetWidth - node.clientWidth / 2 : 0;
      }
    }
    const remember = () => {
      const middle = node.scrollLeft + node.clientWidth / 2;
      let center: { id: string; fraction: number } | undefined, nearest = Infinity;
      for (const photo of node.querySelectorAll<HTMLElement>('.source-photo')) {
        const start = left(photo), width = photo.offsetWidth, distance = Math.max(start - middle, middle - start - width, 0);
        if (photo.dataset.id !== undefined && width > 0 && distance < nearest) { nearest = distance; center = { id: photo.dataset.id, fraction: Math.max(0, Math.min(1, (middle - start) / width)) }; }
      }
      seen.current = { ids, filter, center };
    };
    remember();
    node.addEventListener('scroll', remember, { passive: true });
    return () => node.removeEventListener('scroll', remember);
  }, [ref, enabled, key, filter]);
}
