import type { BookGeometry } from './desktop';

export const reorderTiming = { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' } as const;
export type ReorderOffset = { spread: string; x: number; y: number };

// Only animate a permutation of the same, equally sized thumbnails. Edits,
// insertions, format changes and sidebar resizing keep their normal presentation.
export function reorderOffsets(before?: BookGeometry, after?: BookGeometry): ReorderOffset[] {
  if (!before || !after || before.width !== after.width || before.sheets.length !== after.sheets.length ||
    before.sheets.every((sheet, i) => sheet.spread === after.sheets[i].spread)) return [];
  const previous = new Map(before.sheets.map(sheet => [sheet.spread, sheet]));
  if (after.sheets.some(sheet => {
    const old = previous.get(sheet.spread);
    return !old || Math.abs(old.width - sheet.width) > .5 || Math.abs(old.height - sheet.height) > .5;
  })) return [];
  return after.sheets.flatMap(sheet => {
    const old = previous.get(sheet.spread)!;
    const x = old.x - sheet.x, y = old.y - sheet.y;
    return Math.abs(x) > .5 || Math.abs(y) > .5 ? [{ spread: sheet.spread, x, y }] : [];
  });
}

export function animateReorder(node: HTMLElement, { x, y }: ReorderOffset) {
  const animation = node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], reorderTiming);
  animation.onfinish = () => animation.cancel();
  return animation;
}
