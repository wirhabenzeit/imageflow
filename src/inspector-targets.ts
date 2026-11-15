import type { BookGeometry } from './desktop';

// The Inspector lists editable content; pixel geometry belongs to the canvas. Retain
// identity and reading order here and resolve the current rectangle when opening an editor.
export type InspectorTarget = Pick<BookGeometry['targets'][number], 'spread' | 'edits' | 'occurrence' | 'owner'> & { order: number };
export function inspectorTargets(targets: BookGeometry['targets'], spread?: string): InspectorTarget[] {
  const selected = targets.filter(target => target.spread === spread);
  const marked = selected.filter(target => !target.owner)
    .filter((target, i, all) => all.findIndex(other => other.edits.join(' ') === target.edits.join(' ')) === i);
  const sorted = [...marked].sort((a, b) => Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x);
  const order = new Map(sorted.map((target, i) => [target, i]));
  return selected.map(({ spread, edits, occurrence, owner }, i) => ({ spread, edits, occurrence, owner, order: order.get(selected[i]) ?? -1 }));
}
