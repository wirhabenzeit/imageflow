import { mm, printFormat, pt } from 'imageflow';
import type { CoverFormat, FacingFormat, Length } from 'imageflow';

// Print presets: an interior format and its exterior cover, returned together because the cover's panels, height and
// spine bands depend on the interior trim and page-count rule. Values come from the printers' calculators, templates
// and help pages, researched on the date in `researched` (method and raw data: spikes/cover-sizing in the ImageFlow
// repository). They are not checked against the printers' live uploaders: confirm them before ordering.
//
// This file is part of the template, so a book keeps the values it was made with. Copy it into another template to
// reuse it. A preset is plain data: spread it to change a field, for example
//   const blurb = blurbLargeSquare({ paper: 'premiumMatte', cover: 'dustJacket' });
//   formats: { blurb: { ...blurb.format, label: 'Blurb · 30 × 30 cm' } },
//   coverFormats: { blurb: { ...blurb.coverFormat, foldAvoidance: { back: pt(18), front: pt(18) } } },
// When a printer changes its specification, add the new values beside the old ones rather than editing them.

export type PrintPreset = {
  format: FacingFormat;
  coverFormat: CoverFormat;
  /** The day the values were measured, as YYYY-MM-DD. */
  researched: string;
  /** The printer's pages the values come from. */
  sources: string[];
};

const allEdges = (length: Length) => ({ top: length, right: length, bottom: length, left: length });
const pdf = { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } as const;
// WhiteWall accepts 180–300 ppi; Blurb up to 300 ppi. 250 ppi is the target ImageFlow's checks aim for.
const resolution = { minimum: 180, target: 250, maximum: 300 };

// WhiteWall Coffee Table Book, Gallery Square (29 × 29 cm), hardcover. The cover finish (glossy, silk-matt, linen)
// and endpaper colour do not change the geometry.
export type WhiteWallPaper =
  | 'fujiCrystalArchive'   // Fuji Crystal Archive photo paper, lustre, glossy or velvet; layflat; 28–112 pages
  | 'fedrigoniGloss'       // Fedrigoni Symbol Freelife Gloss, with or without high-gloss varnish; 28–200 pages
  | 'sappiSilkMatt';       // Sappi Magno Volume silk-matt; 28–200 pages

// Spine width in mm: one step every `pages` interior pages from 28 (recovered from 519 official IDML templates).
const whiteWallSpines: Record<WhiteWallPaper, { first: number; step: number; pages: 8 | 16; max: number }> = {
  fujiCrystalArchive: { first: 11, step: 1.5, pages: 8, max: 112 },
  fedrigoniGloss: { first: 8.2, step: 1.1, pages: 16, max: 200 },
  sappiSilkMatt: { first: 8.4, step: 1.5, pages: 16, max: 200 },
};

export function whiteWallGallerySquare({ paper }: { paper: WhiteWallPaper }): PrintPreset {
  const { first, step, pages, max } = whiteWallSpines[paper];
  return {
    format: printFormat({
      label: 'WhiteWall Gallery Square · 29 × 29 cm',
      trim: { width: mm(290), height: mm(290) },
      bleed: { all: mm(3), binding: mm(0) },
      safe: mm(5),
      pageCount: { min: 28, max, step: 4 },
      output: { resolution },
    }),
    coverFormat: {
      kind: 'wrap', height: mm(296), panels: { back: mm(296), front: mm(296) },
      widths: { kind: 'page-bands', bands: Array.from({ length: (max - 28) / pages + 1 }, (_, i) => {
        const from = 28 + pages * i;
        return { from, to: Math.min(from + pages - 4, max), value: { spine: mm(Number((first + step * i).toFixed(1))) } };
      }) },
      outer: { kind: 'wrap', insets: allEdges(mm(10)) },
      // Text 5 mm inside the panel edges and 2 mm inside the spine edges.
      safe: { back: allEdges(mm(5)), front: allEdges(mm(5)), spine: allEdges(mm(2)) },
      // The fold reaches 10–12 mm onto the panels; the upper end, as a content warning.
      foldAvoidance: { back: mm(12), front: mm(12) },
      output: { ...pdf, maximumFileSize: 250_000_000, resolution },
    },
    researched: '2026-11-16',
    sources: [
      'https://www.whitewall.com/us/coffee-table-book/pdf-upload',
      'https://service.whitewall.com/hc/en-us/articles/4411250911377-03-Setting-the-correct-dimensions-for-cover-and-content-pages',
      'https://service.whitewall.com/hc/en-us/articles/4411236486929-04-Notes-on-design',
      'https://service.whitewall.com/hc/en-us/articles/4411222671249-06-Uploading-the-PDF-files',
    ],
  };
}

// Blurb Large Square (846 × 846 pt trim, nominally 12 × 12 in), hardcover. Softcover is not offered at this size.
export type BlurbPaper =
  | 'standard'                   // 20–440 pages
  | 'premiumMatte'               // 20–240 pages
  | 'proPhotoPearl'              // Mohawk proPhoto Pearl, 20–240 pages
  | 'superfineEggshell'          // Mohawk Superfine Eggshell, 20–240 pages
  | 'proPhotoPearlLayflat'       // 20–110 pages, ImageWrap only
  | 'superfineEggshellLayflat';  // 20–110 pages, ImageWrap only
export type BlurbCover = 'imageWrap' | 'dustJacket';

// Spine width in pt by inclusive, even interior page counts, read from Blurb's calculator at both sides of every change.
const blurbSpines: Record<BlurbPaper, [from: number, to: number, spine: number][]> = {
  standard: [[20, 72, 33], [74, 146, 41], [148, 220, 54], [222, 294, 66], [296, 368, 79], [370, 440, 89]],
  premiumMatte: [[20, 50, 33], [52, 100, 41], [102, 160, 54], [162, 200, 66], [202, 240, 79]],
  proPhotoPearl: [[20, 40, 33], [42, 80, 41], [82, 120, 54], [122, 160, 66], [162, 200, 79], [202, 240, 89]],
  superfineEggshell: [[20, 40, 33], [42, 80, 41], [82, 120, 54], [122, 160, 66], [162, 200, 79], [202, 240, 89]],
  proPhotoPearlLayflat: [[20, 34, 40], [36, 42, 53], [44, 52, 63], [54, 62, 81], [64, 80, 104], [82, 92, 110], [94, 98, 122], [100, 110, 144]],
  superfineEggshellLayflat: [[20, 34, 40], [36, 50, 54], [52, 62, 71], [64, 68, 81], [70, 82, 94], [84, 94, 110], [96, 110, 137]],
};
const blurbPaperLabels: Record<BlurbPaper, string> = {
  standard: 'Standard', premiumMatte: 'Premium Matte', proPhotoPearl: 'proPhoto Pearl', superfineEggshell: 'Superfine Eggshell',
  proPhotoPearlLayflat: 'proPhoto Pearl Layflat', superfineEggshellLayflat: 'Superfine Eggshell Layflat',
};

export function blurbLargeSquare({ paper, cover }: { paper: BlurbPaper; cover: BlurbCover }): PrintPreset {
  const layflat = paper.endsWith('Layflat');
  if (layflat && cover === 'dustJacket') throw new Error('Blurb binds layflat papers with ImageWrap only.');
  const bands = blurbSpines[paper];
  const jacket = cover === 'dustJacket';
  const coverEdges = { back: allEdges(pt(18)), front: allEdges(pt(18)), spine: allEdges(pt(0)) };
  return {
    format: printFormat({
      label: `Blurb Large Square · ${blurbPaperLabels[paper]} ${jacket ? 'Dust Jacket' : 'ImageWrap'}`,
      trim: { width: pt(846), height: pt(846) },
      bleed: { all: pt(9), binding: pt(0) },
      // Layflat pages open flat, so they need no extra margin at the binding.
      safe: { all: pt(18), binding: pt(layflat ? 0 : 36) },
      pageCount: { min: 20, max: bands[bands.length - 1][1], step: 2 },
      output: { resolution },
    }),
    // ImageWrap: (1760 + S) × 918 pt PDF with a 22 pt wrap. Dust jacket: (1776 + S + 2F) × 882 pt PDF with 9 pt bleed,
    // where each flap F = floor((601 − S) / 2) pt, so the jacket stays almost the same width as the spine grows.
    coverFormat: {
      kind: 'wrap',
      height: pt(jacket ? 864 : 874),
      panels: { back: pt(jacket ? 879 : 858), front: pt(jacket ? 879 : 858) },
      widths: { kind: 'page-bands', bands: bands.map(([from, to, spine]) => {
        const flap = Math.floor((601 - spine) / 2);
        return { from, to, value: { spine: pt(spine), ...(jacket ? { flaps: { back: pt(flap), front: pt(flap) } } : {}) } };
      }) },
      outer: { kind: jacket ? 'bleed' : 'wrap', insets: allEdges(pt(jacket ? 9 : 22)) },
      safe: coverEdges,
      ...(jacket ? { flaps: { safe: { back: allEdges(pt(18)), front: allEdges(pt(18)) } } } : {}),
      output: { ...pdf, resolution },
    },
    researched: '2026-11-16',
    sources: [
      'https://www.blurb.com/make/pdf_to_book/booksize_calculator',
      'https://support.blurb.com/hc/en-us/articles/207792946-PDF-to-Book-specifications-and-checklist',
      'https://support.blurb.com/hc/en-us/articles/7607055286541-How-many-pages-can-my-book-have',
    ],
  };
}
