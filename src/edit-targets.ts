import type { BookGeometry, Rect } from './desktop';

type EditTarget = BookGeometry['targets'][number];

// A visual edit target is named by its spread, the fields it edits and which occurrence of those fields on the sheet
// it is. Two nodes that show the same heading edit the same saved field but are different targets, so the editor
// opens at the one clicked. The name is only the app's: saved data never refers to it.
export const targetKey = (target: { spread: string; edits: string[]; occurrence?: number }) =>
  target.spread + '|' + target.edits.join(' ') + '|' + (target.occurrence ?? 0);

// Where an open editor is anchored: the centre of the node it was last shown at, as a fraction of its sheet's width
// and height, so that resizing or scrolling the canvas, which moves and scales sheets, does not move the anchor.
export type TargetAnchor = { spread: string; edits: string; x: number; y: number };

const centreIn = (rect: Rect, sheet: Rect) =>
  [(rect.x + rect.width / 2 - sheet.x) / (sheet.width || 1), (rect.y + rect.height / 2 - sheet.y) / (sheet.height || 1)];

export const targetAnchor = (target: EditTarget, sheet: Rect): TargetAnchor => {
  const [x, y] = centreIn(target, sheet);
  return { spread: target.spread, edits: target.edits.join(' '), x, y };
};

// The node an editor is shown at. It opens at the node its key names. Once open, occurrence numbers are no longer
// trusted: a conditional node with the same fields can appear before it and another disappear, leaving the count
// unchanged but every number after it shifted. So an open editor follows the node nearest to where it was last
// anchored on its sheet (the anchor moves with it on every render), and the key only breaks a tie.
export function resolveTarget(targets: readonly EditTarget[], key: string, anchor?: TargetAnchor, sheet?: Rect): EditTarget | undefined {
  if (!anchor || !sheet) return targets.find((target) => targetKey(target) === key);
  const distance = (rect: Rect) => {
    const [x, y] = centreIn(rect, sheet);
    return Math.hypot(x - anchor.x, y - anchor.y);
  };
  let best: EditTarget | undefined;
  for (const target of targets) {
    if (target.spread !== anchor.spread || target.edits.join(' ') !== anchor.edits) continue;
    const d = !best ? -1 : distance(target) - distance(best);
    if (!best || d < -1e-3 || (Math.abs(d) <= 1e-3 && targetKey(target) === key)) best = target;
  }
  return best;
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
