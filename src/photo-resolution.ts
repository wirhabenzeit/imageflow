import { getCrop } from './spread';
import type { Dimensions, Placement } from './spread';

/**
 * What a render found of the resolution of the photos in its boxes (API-022): how many could be measured and which one
 * prints at the fewest pixels, so a check without findings says that the photos pass, not that nobody looked. A photo
 * drawn from a preview is measured by its original's size; one without a preview yet is not measured.
 */
export type PhotoResolution = { minimumPpi: number | null; measured: number; notMeasured: number;
  lowest?: { ppi: number; spread?: string; cover?: true; page?: 'left' | 'right'; box: string; source?: string } };

export const newResolution = (minimum: number | undefined): PhotoResolution => ({ minimumPpi: minimum ?? null, measured: 0, notMeasured: 0 });

/**
 * The photo in an inspected box (API-021, 26 Nov): its original's size in pixels and the ppi it prints at in the box.
 * `measured` is true where the render measured it (the box's `data-ppi`), as `PhotoResolution.measured` counts it, by
 * its original's size; false where the render has no size for the photo, such as one whose file is unavailable, and the
 * ppi is estimated from the size its source reported, the box's size and its crop, or null without a known size.
 * `placement` and `boxMm` (the box's own size, unrotated, as the measurement uses it) are what the estimate uses; the
 * render passes them, and the reply leaves them out.
 */
export type PhotoPrint = { widthPx?: number; heightPx?: number; ppi: number | null; measured: boolean; placement?: Placement;
  boxMm?: { width: number; height: number } };

/** What the render knows of a box's photo: measured where it has a size for it, else what an estimate needs. */
export function renderedPrint(ppi: string | undefined, photo: Dimensions | undefined, placement: Placement, boxMm: { width: number; height: number }): PhotoPrint {
  const value = ppi === undefined ? NaN : Number(ppi);
  return photo && Number.isFinite(value) ? { widthPx: photo.width, heightPx: photo.height, ppi: Math.round(value), measured: true }
    : { ppi: null, measured: false, placement, boxMm };
}

/**
 * A reply's print of a box: as measured, or estimated from the photo's known size like the render measures it, the
 * smaller of the crop's pixels per inch across and down of the box's own (unrotated) size.
 */
export function estimatedPrint(print: PhotoPrint, size: Dimensions | undefined): PhotoPrint {
  const { placement, boxMm: box, ...rest } = print;
  if (rest.measured) return rest;
  if (!size?.width || !size.height || !placement || !box || !(box.width > 0 && box.height > 0)) return { ppi: null, measured: false };
  const crop = getCrop(size, placement, box.width / box.height);
  const ppi = Math.min(size.width * crop.width / (box.width / 25.4), size.height * crop.height / (box.height / 25.4));
  return { widthPx: size.width, heightPx: size.height, ppi: Math.round(ppi), measured: false };
}

/** An inspection as a reply: each photo box's print as measured, or estimated by the photo's size (`sizeOf`). */
export function inspectionPrints<T extends { items: { print?: PhotoPrint; source?: string }[] }>(
  inspection: T, sizeOf: (id: string) => Dimensions | undefined): T {
  return { ...inspection, items: inspection.items.map((item) => item.print
    ? { ...item, print: estimatedPrint(item.print, item.print.measured || !item.source ? undefined : sizeOf(item.source)) } : item) };
}

/** Counts a box that holds a photo. `ppi` is undefined where the photo is not drawn. */
export function countResolution(resolution: PhotoResolution, ppi: number | undefined, place: Omit<NonNullable<PhotoResolution['lowest']>, 'ppi'>) {
  if (ppi === undefined || !Number.isFinite(ppi)) { resolution.notMeasured++; return; }
  resolution.measured++;
  const rounded = Math.round(ppi);
  if (!resolution.lowest || rounded < resolution.lowest.ppi) resolution.lowest = { ppi: rounded, ...place };
}

/** The interior's and the cover's together. */
export function mergeResolution(a: PhotoResolution | undefined, b: PhotoResolution | undefined): PhotoResolution | undefined {
  if (!a || !b) return a ?? b;
  const lowest = [a.lowest, b.lowest].filter((found) => found !== undefined).sort((x, y) => x.ppi - y.ppi)[0];
  return { minimumPpi: a.minimumPpi ?? b.minimumPpi, measured: a.measured + b.measured, notMeasured: a.notMeasured + b.notMeasured, ...(lowest ? { lowest } : {}) };
}
