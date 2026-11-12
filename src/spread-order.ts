import { hasSingleEnds, spanAllowedAt } from './format';
import type { PrintFormat, Span } from './format';
import type { TemplateInfo } from './desktop';
import type { SpreadState } from './project';

type Book = { spreads: TemplateInfo['spreads']; format: Pick<PrintFormat, 'structure'> };

// Why a new spread of this span cannot go at `position` (0 = before the first), or undefined when it can. Where the
// format requires a single opening and closing page, nothing goes before the opening page or after the closing page,
// an opening page only goes first and a closing page only last; a book still missing one may get it. Other formats
// take any fitting span anywhere (layoutChoices and spanFits decide what fits).
export function insertionProblem(spreads: SpreadState[], position: number, span: Span, template: Book) {
  if (!hasSingleEnds(template.format)) return undefined;
  const spanOf = (spread?: SpreadState) => spread && (template.spreads[spread.definition]?.span ?? 'spread');
  const first = spanOf(spreads[0]), last = spanOf(spreads.at(-1));
  if (span === 'right') return position === 0 && first !== 'right' ? undefined : 'A single right page can only open the book, before its first spread.';
  if (span === 'left') return position === spreads.length && last !== 'left' ? undefined : 'A single left page can only close the book, after its last spread.';
  if (position === 0) return 'The book must open on a single right page, so nothing can go before ' + (first === 'right' ? 'it.' : 'its first spread.');
  if (position === spreads.length && last === 'left') return 'The book must close on a single left page, so nothing can go after it.';
  return undefined;
}

// Both the buttons and drag/drop use final indices (after removing the moving spread).
export function spreadOrder(spreads: SpreadState[], id: string, target: number, template: Book) {
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
