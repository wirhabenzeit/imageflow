// A design proof: the book's spreads, kept together, several to an A4 sheet with their page numbers. It is for reading
// and sharing, not for print: trim only, screen-sized photos, and none of the print format's checks.
export const proofDensities = [1, 4, 12] as const;
export type ProofDensity = (typeof proofDensities)[number];
export const isProofDensity = (value: unknown): value is ProofDensity => proofDensities.includes(value as ProofDensity);

// Millimetres. The header carries the book's name, the label under each spread its pages and problems.
export const proofSheet = { a4: { width: 297, height: 210 }, margin: 10, header: 9, label: 5, gapX: 6, gapY: 4 };
// Photos and drawn pictures as sharp as 150 dpi on the proof sheet.
export const proofDpi = 150;

export type ProofLayout = {
  page: { width: number; height: number }; columns: number; rows: number;
  /** Proof millimetres per book millimetre, the same for every spread so their sizes compare. */
  scale: number; cell: { width: number; height: number };
};

/**
 * The sheet orientation and grid that show the largest unit (a spread, or a page without facing pages) biggest, with
 * `perPage` units to a sheet. Landscape wins a tie.
 */
export function proofLayout(unit: { width: number; height: number }, perPage: number): ProofLayout {
  const { a4, margin, header, label, gapX, gapY } = proofSheet;
  let best: ProofLayout | undefined;
  for (const page of [{ width: a4.width, height: a4.height }, { width: a4.height, height: a4.width }]) {
    const width = page.width - 2 * margin, height = page.height - 2 * margin - header;
    for (let columns = 1; columns <= perPage; columns++) {
      const rows = Math.ceil(perPage / columns);
      if (columns > 1 && Math.ceil(perPage / (columns - 1)) === rows) continue;
      const cellWidth = (width - (columns - 1) * gapX) / columns;
      const cellHeight = (height - (rows - 1) * gapY) / rows - label;
      const scale = Math.min(cellWidth / unit.width, cellHeight / unit.height);
      if (scale > 0 && (!best || scale > best.scale + 1e-9)) best = { page, columns, rows, scale, cell: { width: cellWidth, height: cellHeight + label } };
    }
  }
  if (!best) throw new Error('The proof sheet has no room for a spread.');
  return best;
}

/** The width in pixels a photo `widthMm` wide in the book needs to look sharp on the proof. */
export const proofPhotoPixels = (widthMm: number, scale: number) => Math.ceil(widthMm * scale / 25.4 * proofDpi);
/**
 * The pixel ratio for drawn pictures, which lay out at 96 CSS pixels per inch of the book: the one nearest 150 dpi on
 * the sheet among those the editor draws (thumbnails at 0.5, the book view at 1 or 2), so its cached pictures serve.
 */
export function proofPixelRatio(scale: number) {
  const wanted = scale * proofDpi / 96;
  return [.5, 1, 2].reduce((best, ratio) => Math.abs(Math.log(ratio / wanted)) < Math.abs(Math.log(best / wanted)) ? ratio : best);
}
