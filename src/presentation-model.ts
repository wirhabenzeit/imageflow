import { layoutFootprint } from './layouts';
import { hasFacingPages, pageLabel, pageNumbers, pageSequence } from './format';
import type { PrintSide } from './format';
import type { CoverState, SpreadState } from './project';
import type { TemplateInfo } from './desktop';
import { coverLayoutsFor } from './cover';

export type PresentationUnit = { spread: string; side: PrintSide; pages: number[]; label: string };
export type PresentationView = { spread: string; side: PrintSide; bounds: 'trim' | 'bleed'; overview: boolean };
// Screen-sized pictures, not camera originals: overview cells small ones, the spread on screen as wide as its box shows
// them. Six decoded originals took hundreds of megabytes, twice over while a new revision replaced the previous one,
// and Chromium dropped some again after decoding them, so they blinked at each revision. Widths step by 512 so a
// rendition made once serves the next revision and nearby window sizes; the original is never enlarged.
export function presentationPhotoSource(source: string, pixels: number, overview: boolean) {
  const width = overview ? Math.max(128, Math.min(1024, Math.ceil(pixels / 128) * 128)) : Math.max(512, Math.min(8192, Math.ceil(pixels / 512) * 512));
  return source.replace(/(\/proof-photo\/[\w-]+)(?:\/\d+)?$/, '$1/' + width);
}
// Keep reading order independent of PDF delivery: a spread stays together unless single pages were requested.
export function presentationUnits(spreads: SpreadState[], template: Pick<TemplateInfo, 'spreads' | 'format'>, single = false): PresentationUnit[] {
  const sequence = pageSequence(spreads.map((spread) => layoutFootprint(spread, template.spreads)), template.format);
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
// The exterior cover opens the presentation when the book has one in a layout of its format (its own sheet: back,
// spine and front, the way the Cover view shows it).
export function presentsCover(cover: CoverState | undefined, template: Pick<TemplateInfo, 'coverFormats' | 'coverLayouts' | 'formatId'>) {
  return !!cover && !!template.coverFormats && Object.hasOwn(template.coverFormats, template.formatId) &&
    Object.hasOwn(coverLayoutsFor(template.coverLayouts, template.formatId), cover.definition);
}
