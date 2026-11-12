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
  const spans = ordered.map(({ definition }) => template.spreads[definition]?.span ?? 'spread');
  // Reordering does not change the page count. Check only sequence placement, so a book with a page-count
  // error can still be organised, while its single right/left end pages cannot be moved into the interior.
  if (!spans.every((span, index) => spanAllowedAt(span, index, spans.length, template.format))) return;
  return ordered;
}
