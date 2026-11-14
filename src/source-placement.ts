import type { SpreadState } from './project';
import type { SourceRef } from './source-items';

// A drop may explicitly replace its target. Additional assets only fill empty compatible boxes.
export function sourcePlacements(boxes: Record<string, { type: string }>, saved: SpreadState['boxes'], sources: SourceRef[], firstBox?: string) {
  const available = Object.entries(boxes).filter(([id]) => id === firstBox || (!saved[id]?.photo && !saved[id]?.text));
  if (firstBox) available.sort(([a], [b]) => a === firstBox ? -1 : b === firstBox ? 1 : 0);
  return sources.flatMap((source) => {
    const at = available.findIndex(([, box]) => box.type === (source.kind === 'photo' ? 'photo' : 'markdown'));
    return at < 0 ? [] : [{ box: available.splice(at, 1)[0][0], source }];
  });
}
