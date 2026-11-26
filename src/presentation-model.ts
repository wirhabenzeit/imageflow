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

// Presentation zoom (UI-021) enlarges what is drawn, no more: a scale of the whole screen and its offset, in pixels.
export type PresentationZoom = { scale: number; x: number; y: number };
export const presentationFit: PresentationZoom = { scale: 1, x: 0, y: 0 };
export const presentationMaxZoom = 8;
// The enlarged screen always covers the window, so panning stops at its edges rather than showing empty space.
function coverWindow({ scale, x, y }: PresentationZoom, size: { width: number; height: number }): PresentationZoom {
  return { scale, x: Math.min(0, Math.max(size.width * (1 - scale), x)), y: Math.min(0, Math.max(size.height * (1 - scale), y)) };
}
// Zoom around a point of the window, which stays under the pointer. Zooming out to (nearly) the whole spread snaps to
// it, so a pinch never leaves the spread a few percent enlarged, nor smaller than the window.
export function zoomPresentationAt(view: PresentationZoom, factor: number, point: { x: number; y: number }, size: { width: number; height: number }) {
  const scale = Math.min(presentationMaxZoom, view.scale * factor);
  if (!(scale >= 1.02)) return presentationFit;
  const ratio = scale / view.scale;
  return coverWindow({ scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, size);
}
// Scroll deltas move the view over the enlarged spread: the artwork moves the other way.
export function panPresentation(view: PresentationZoom, dx: number, dy: number, size: { width: number; height: number }) {
  return view.scale > 1 ? coverWindow({ ...view, x: view.x - dx, y: view.y - dy }, size) : view;
}
