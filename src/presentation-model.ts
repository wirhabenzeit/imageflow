import { hasFacingPages, pageLabel, pageNumbers, pageSequence } from './format';
import type { PrintSide } from './format';
import type { SpreadState } from './project';
import type { TemplateInfo } from './desktop';

export type PresentationUnit = { spread: string; side: PrintSide; pages: number[]; label: string };
export type PresentationView = { spread: string; side: PrintSide; bounds: 'trim' | 'bleed'; overview: boolean };
// Keep reading order independent of PDF delivery: a spread stays together unless single pages were requested.
export function presentationUnits(spreads: SpreadState[], template: Pick<TemplateInfo, 'spreads' | 'format'>, single = false): PresentationUnit[] {
  const sequence = pageSequence(spreads.map(({ definition }) => template.spreads[definition]?.span ?? 'spread'), template.format);
  return sequence.spreads.flatMap(({ page, span }, i) => {
    const sides: PrintSide[] = !hasFacingPages(template.format) ? ['page'] : single
      ? [page.left && 'left', page.right && 'right'].filter((side): side is 'left' | 'right' => !!side)
      : [span === 'left' || span === 'right' ? span : 'spread'];
    return sides.map((side) => {
      const pages = side === 'spread' || side === 'page' ? page : { [side]: page[side] };
      return { spread: spreads[i].id, side, pages: pageNumbers(pages), label: pageLabel(pages) };
    });
  });
}
export function presentationPage(units: PresentationUnit[], page: number) {
  return units.findIndex((unit) => unit.pages.includes(page));
}
