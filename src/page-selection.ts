import type { Rect } from './desktop';
import type { UnitPages } from './format';
import type { PageSide } from './project';

export type PageSelection = { spread: string; side?: PageSide };
export function pageSelectionSide(pages: UnitPages, side?: PageSide): PageSide | undefined {
  return pages.number === undefined && side && pages[side] !== undefined ? side : undefined;
}
export function pageSideAt(sheet: Rect, pages: UnitPages, x: number, y: number): PageSide | undefined {
  if (y < sheet.y || pages.number !== undefined) return undefined;
  if (pages.left === undefined) return pages.right === undefined ? undefined : 'right';
  if (pages.right === undefined) return 'left';
  return x < sheet.x + sheet.width / 2 ? 'left' : 'right';
}
export function pageSelectionRect<T extends Rect>(sheet: T, side?: PageSide): T {
  return side ? { ...sheet, x: sheet.x + (side === 'right' ? sheet.width / 2 : 0), width: sheet.width / 2 } : sheet;
}
/** Left/right follow printed page order, including single opening and closing pages. */
export function stepPageSelection(sheets: { id: string; page: UnitPages }[], selected: PageSelection, direction: -1 | 1): PageSelection | undefined {
  const pages = sheets.flatMap(({ id: spread, page }): PageSelection[] => page.number !== undefined ? [{ spread }]
    : [...(page.left !== undefined ? [{ spread, side: 'left' as const }] : []), ...(page.right !== undefined ? [{ spread, side: 'right' as const }] : [])]);
  const selectedPages = sheets.find(item => item.id === selected.spread)?.page ?? {};
  const side = pageSelectionSide(selectedPages, selected.side);
  const at = pages.findIndex(item => item.spread === selected.spread && (!side || item.side === side));
  // With a whole sheet selected, start at its near edge before moving to the next sheet.
  if (at < 0) return undefined;
  if (!side && direction === 1 && pages[at + 1]?.spread === selected.spread) return pages[at + 1];
  return pages[at + direction];
}
