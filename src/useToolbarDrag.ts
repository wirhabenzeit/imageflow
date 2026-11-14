import { useLayoutEffect } from 'react';

// Report the actual blank toolbar area and its controls, rather than estimating
// button positions in native code. Coordinates remain CSS pixels across zoom.
export function useToolbarDrag() {
  useLayoutEffect(() => {
    const api = window.imageflow;
    if (!navigator.platform.includes('Mac') || !api?.setToolbarDragRegions) return;
    const toolbar = document.querySelector<HTMLElement>('header.toolbar');
    if (!toolbar) {
      void api.setToolbarDragRegions([]);
      return;
    }
    let previous = '';
    const publish = () => {
      const controls = toolbar.querySelectorAll('button, summary, input, select, textarea, a, [role="button"], .export-progress');
      const bounds = toolbar.getBoundingClientRect();
      const regions = [toolbar, ...controls].flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const x = Math.max(bounds.x, rect.x), y = Math.max(bounds.y, rect.y);
        const width = Math.min(bounds.right, rect.right) - x, height = Math.min(bounds.bottom, rect.bottom) - y;
        return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
      });
      const key = JSON.stringify(regions);
      if (key !== previous) { previous = key; void api.setToolbarDragRegions(regions); }
    };
    const resize = new ResizeObserver(publish);
    resize.observe(toolbar);
    toolbar.querySelectorAll('.toolbar-actions').forEach((element) => resize.observe(element));
    const changes = new MutationObserver(publish);
    changes.observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    publish();
    return () => { resize.disconnect(); changes.disconnect(); void api.setToolbarDragRegions([]); };
  }, []);
}
