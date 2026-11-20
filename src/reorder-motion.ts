import type { BookGeometry } from './desktop';

export const reorderTiming = { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' } as const;
export type ReorderOffset = { spread: string; x: number; y: number };

// Animates sheets that kept their size but moved: after a reorder, and after sheets were added or removed, when the
// ones after them slide into place (beta finding F-036). An added sheet appears in place. Edits that change a sheet's
// size, format changes and viewport resizing keep their normal presentation.
export function reorderOffsets(before?: BookGeometry, after?: BookGeometry): ReorderOffset[] {
  if (!before || !after || before.width !== after.width ||
    (before.sheets.length === after.sheets.length && before.sheets.every((sheet, i) => sheet.spread === after.sheets[i].spread))) return [];
  const previous = new Map(before.sheets.map(sheet => [sheet.spread, sheet]));
  if (after.sheets.some(sheet => {
    const old = previous.get(sheet.spread);
    return old && (Math.abs(old.width - sheet.width) > .5 || Math.abs(old.height - sheet.height) > .5);
  })) return [];
  return after.sheets.flatMap(sheet => {
    const old = previous.get(sheet.spread);
    if (!old) return [];
    const x = old.x - sheet.x, y = old.y - sheet.y;
    return Math.abs(x) > .5 || Math.abs(y) > .5 ? [{ spread: sheet.spread, x, y }] : [];
  });
}

export function animateReorder(node: HTMLElement, { x, y }: ReorderOffset) {
  const animation = node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], reorderTiming);
  animation.onfinish = () => animation.cancel();
  return animation;
}

// The saved order of a book's spreads for a frame that shows an earlier one (`shown`, in its order), until a frame of
// the saved book replaces it. A spread the frame does not have is added: as a copy of one it does have with the same
// content (a duplicate), or otherwise looking like the spread before it.
export function provisionalOrder(spreads: readonly { id: string }[], shown: readonly string[] | undefined) {
  if (!shown) return undefined;
  const order = spreads.map(({ id }) => id);
  if (order.length === shown.length && order.every((id, i) => id === shown[i])) return undefined;
  const known = new Set(shown);
  const content = (spread: { id: string }) => JSON.stringify({ ...spread, id: '' });
  const added: Record<string, { like?: string; copy?: boolean }> = {};
  spreads.forEach((spread, i) => {
    if (known.has(spread.id)) return;
    const twin = spreads.find((other) => other.id !== spread.id && known.has(other.id) && content(other) === content(spread));
    const before = spreads.slice(0, i).reverse().find(({ id }) => known.has(id)) ?? spreads.slice(i + 1).find(({ id }) => known.has(id));
    added[spread.id] = twin ? { like: twin.id, copy: true } : before ? { like: before.id } : {};
  });
  return { order, added };
}
