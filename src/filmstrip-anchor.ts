import { useLayoutEffect } from 'react';
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
    const scroll = () => {
      // Resize can also generate a scroll event; keep the old geometry until it is restored.
      if (node.clientWidth === previous.width && node.clientHeight === previous.height) previous.scroll = node.scrollLeft;
    };
    const observer = new ResizeObserver(() => {
      const next = measure();
      if (next.width !== previous.width || next.height !== previous.height) {
        const center = previous.scroll + previous.width / 2;
        const distance = (photo: typeof previous.photos[number]) => Math.max(photo.left - center, center - photo.left - photo.width, 0);
        const anchor = previous.photos.reduce<typeof previous.photos[number] | undefined>((best, photo) =>
          !best || distance(photo) < distance(best) ? photo : best, undefined);
        const photo = anchor && next.photos.find(({ id }) => id === anchor.id);
        if (anchor && photo && anchor.width > 0) {
          const fraction = Math.max(0, Math.min(1, (center - anchor.left) / anchor.width));
          node.scrollLeft = photo.left + fraction * photo.width - next.width / 2;
          next.scroll = node.scrollLeft;
        }
      }
      previous = next;
    });
    node.addEventListener('scroll', scroll, { passive: true });
    observer.observe(node);
    return () => { observer.disconnect(); node.removeEventListener('scroll', scroll); };
  }, [ref, enabled, items]);
}
