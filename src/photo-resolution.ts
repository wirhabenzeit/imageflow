/**
 * What a render found of the resolution of the photos in its boxes (API-022): how many could be measured and which one
 * prints at the fewest pixels, so a check without findings says that the photos pass, not that nobody looked. A photo
 * drawn from a preview is measured by its original's size; one without a preview yet is not measured.
 */
export type PhotoResolution = { minimumPpi: number | null; measured: number; notMeasured: number;
  lowest?: { ppi: number; spread?: string; cover?: true; page?: 'left' | 'right'; box: string; source?: string } };

export const newResolution = (minimum: number | undefined): PhotoResolution => ({ minimumPpi: minimum ?? null, measured: 0, notMeasured: 0 });

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
