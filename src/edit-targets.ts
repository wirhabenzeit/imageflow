import type { BookGeometry, Rect } from './desktop';

type EditTarget = BookGeometry['targets'][number];

// A visual edit target is named by its spread, the fields it edits and which occurrence of those fields on the sheet
// it is. Two nodes that show the same heading edit the same saved field but are different targets, so the editor
// opens at the one clicked. The name is only the app's: saved data never refers to it.
export const targetKey = (target: { spread: string; edits: string[]; occurrence?: number }) =>
  target.spread + '|' + target.edits.join(' ') + '|' + (target.occurrence ?? 0);

// Where an open editor was last anchored: its rectangle and how many nodes on the sheet edited the same fields.
export type TargetAnchor = Rect & { spread: string; edits: string; count: number };

export const targetAnchor = (target: EditTarget, targets: readonly EditTarget[]): TargetAnchor => {
  const edits = target.edits.join(' ');
  return { spread: target.spread, edits, x: target.x, y: target.y, width: target.width, height: target.height,
    count: targets.filter((other) => other.spread === target.spread && other.edits.join(' ') === edits).length };
};

// The target an open editor names. While the nodes editing the same fields stay as many as when it opened, the
// occurrence number still names the same node. When one appears or disappears (a conditional node earlier on the
// sheet), the numbers shift, so the node nearest to where the editor was anchored is taken instead.
export function resolveTarget(targets: readonly EditTarget[], key: string, anchor?: TargetAnchor): EditTarget | undefined {
  const exact = targets.find((target) => targetKey(target) === key);
  const candidates = anchor ? targets.filter((target) => target.spread === anchor.spread && target.edits.join(' ') === anchor.edits) : [];
  if (!anchor || !candidates.length || (exact && candidates.length === anchor.count && candidates.includes(exact))) return exact;
  const centre = (rect: Rect) => [rect.x + rect.width / 2, rect.y + rect.height / 2];
  const [ax, ay] = centre(anchor);
  const distance = (rect: Rect) => {
    const [x, y] = centre(rect);
    return Math.hypot(x - ax, y - ay);
  };
  return candidates.reduce((best, target) => distance(target) < distance(best) ? target : best);
}

// Numbers nodes that edit the same fields on one sheet in document order, the order `nodes` is given in.
export function numberOccurrences<T extends { edits: string[] }>(nodes: readonly T[]): (T & { occurrence: number })[] {
  const seen = new Map<string, number>();
  return nodes.map((node) => {
    const edits = node.edits.join(' ');
    const occurrence = seen.get(edits) ?? 0;
    seen.set(edits, occurrence + 1);
    return { ...node, occurrence };
  });
}
