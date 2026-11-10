// Scrolls `container` vertically just enough to show `element`. Unlike scrollIntoView, it never scrolls the
// containers around it, so a list can follow the selection without moving the rest of the window.
export function revealIn(container: HTMLElement, element: HTMLElement, smooth = false) {
  const outer = container.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  const margin = 8;
  let delta = 0;
  if (inner.top < outer.top + margin) delta = inner.top - outer.top - margin;
  else if (inner.bottom > outer.bottom - margin) delta = Math.min(inner.bottom - outer.bottom + margin, inner.top - outer.top - margin);
  if (delta) container.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
}
