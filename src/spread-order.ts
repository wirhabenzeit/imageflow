import { spanAllowedAt } from './format';
import type { TemplateInfo } from './desktop';
import type { SpreadState } from './project';

// Both the buttons and drag/drop use final indices (after removing the moving spread).
export function spreadOrder(spreads: SpreadState[], id: string, target: number, template: Pick<TemplateInfo, 'spreads' | 'format'>) {
  const start = spreads.findIndex((spread) => spread.id === id);
  if (start < 0 || !Number.isInteger(target) || target < 0 || target >= spreads.length || start === target) return;
  const ordered = [...spreads];
  const [item] = ordered.splice(start, 1);
  ordered.splice(target, 0, item);
  const allowed = (spread: SpreadState, index: number) =>
    spanAllowedAt(template.spreads[spread.definition]?.span ?? 'spread', index, spreads.length, template.format);
  const misplaced = new Set(spreads.filter((spread, index) => !allowed(spread, index)).map(({ id }) => id));
  // Existing problems must not freeze the book: allow partial repairs and unrelated moves. Track the affected
  // spreads, rather than just counting errors, so fixing one cannot displace a previously valid end page.
  // Page-count errors are unchanged by a move and do not affect its allowed destinations.
  if (ordered.some((spread, index) => !allowed(spread, index) && !misplaced.has(spread.id))) return;
  return ordered;
}
