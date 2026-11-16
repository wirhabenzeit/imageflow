/** Type-checked draft declarations. These helpers are not in the shipped SDK. */
import { mm, pt, printFormat } from '../../src/format';
import type { CoverFormat, CoverWidthsHelper, Edges, Length, PageCount, PrintDeclaration, PrintSpecification, WrapCover } from './cover-model';

const edges = (length: Length): Edges => ({ top: length, right: length, bottom: length, left: length });
const output = { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } as const;

// A proposed SDK helper, not a runtime resolver. The normalized declaration
// contains the complete finite table produced by this call.
declare const coverWidths: CoverWidthsHelper;

export function whitewallCover(
  size: 'square' | 'portrait' | 'landscape',
  paper: 'fedrigoni' | 'sappi' | 'fuji',
): { pageCount: PageCount; cover: CoverFormat } {
  // The current PDF-upload product has no such combination.
  if (size === 'portrait' && paper === 'fuji') throw new Error('Unsupported size and paper.');
  const pageCount: PageCount = {
    min: 28, max: paper !== 'fuji' ? 200 : size === 'landscape' ? 100 : 112, step: 4,
  };
  const panel = size === 'landscape' ? 389 : size === 'portrait' ? 276 : 296;
  return {
    pageCount,
    cover: {
      kind: 'wrap',
      height: mm(size === 'portrait' ? 362 : 296),
      panels: { back: mm(panel), front: mm(panel) },
      widths: coverWidths({
        pageCount,
        sizeAt: (n) => ({ spine: mm(paper === 'fuji'
          ? 11 + 1.5 * Math.floor((n - 28) / 8)
          : paper === 'sappi'
            ? 8.4 + 1.5 * Math.floor((n - 28) / 16)
            : 8.2 + 1.1 * Math.floor((n - 28) / 16)) }),
      }),
      outer: { kind: 'wrap', insets: {
        top: mm(10), bottom: mm(10), left: mm(size === 'landscape' ? 15 : 10), right: mm(size === 'landscape' ? 15 : 10),
      } },
      safe: { back: edges(mm(5)), front: edges(mm(5)), spine: edges(mm(2)) },
      // No exact hinge width claimed: the published guidance gives 10–12 mm.
      output: { ...output, maximumFileSize: 250_000_000 },
    },
  };
}

// Exact normalized data is equally valid; the helper is optional.
const premium: { from: number; to: number; spine: number }[] = [
  { from: 20, to: 50, spine: 33 },
  { from: 52, to: 100, spine: 41 },
  { from: 102, to: 160, spine: 54 },
  { from: 162, to: 202, spine: 66 },
  { from: 204, to: 240, spine: 79 },
];

export function blurbPremiumCover(
  size: 'square' | 'landscape', binding: 'imagewrap' | 'jacket',
): { pageCount: PageCount; cover: WrapCover } {
  const square = size === 'square', jacket = binding === 'jacket';
  // Derived from the printer's complete trim and spine/flap measurements.
  const panel = jacket ? (square ? 879 : 931) : (square ? 858 : 918);
  return {
    pageCount: { min: 20, max: 240, step: 2 },
    cover: {
      kind: 'wrap',
      height: pt(jacket ? (square ? 864 : 783) : (square ? 874 : 793)),
      panels: { back: pt(panel), front: pt(panel) },
      widths: {
        kind: 'page-bands',
        bands: premium.map(({ from, to, spine }) => {
          // Rounding is in the printer's source unit, BEFORE conversion to mm.
          const flap = (square ? Math.floor : Math.ceil)(((square ? 601 : 639) - spine) / 2);
          return { from, to, value: {
            spine: pt(spine), ...(jacket ? { flaps: { back: pt(flap), front: pt(flap) } } : {}),
          } };
        }),
      },
      outer: { kind: jacket ? 'bleed' : 'wrap', insets: edges(pt(jacket ? 9 : 22)) },
      safe: { back: edges(pt(18)), front: edges(pt(18)), spine: edges(pt(0)) },
      // Zero means this draft adds no separate spine-text inset for Blurb;
      // the research did not establish a dedicated spine-text safety rule.
      ...(jacket ? { flaps: { safe: { back: edges(pt(18)), front: edges(pt(18)) } } } : {}),
      // Declared independently; RGB/PDF acceptance still needs uploader checks.
      output,
    },
  };
}

// The five existing format IDs can remain the template's size choices. Paper
// choices are ordinary document parameters owned by this example template.
// A template with no choices can instead supply a fixed PrintSpecification.
type DocumentParameters = { paper: 'fedrigoni' | 'sappi' | 'fuji' };

export const whitewallPrint: PrintDeclaration<DocumentParameters> = ({ document, formatId }) => {
  const size = formatId === 'square' ? 'square'
    : formatId === 'landscape' ? 'landscape'
      : formatId === 'whitewallPortfolioPortrait' ? 'portrait' : undefined;
  if (!size) throw new Error('Unknown WhiteWall format.');
  const selected = whitewallCover(size, document.paper);
  return {
    interior: printFormat({
      label: `WhiteWall ${size}`,
      trim: {
        width: mm(size === 'square' ? 290 : size === 'portrait' ? 270 : 382),
        height: mm(size === 'portrait' ? 356 : 290),
      },
      bleed: { all: mm(3), binding: mm(0) },
      safe: mm(5),
      pageCount: selected.pageCount,
    }),
    cover: selected.cover,
  };
};

// This template offers one fixed product and needs no paper/binding parameters.
const selectedBlurb = blurbPremiumCover('square', 'jacket');
export const fixedBlurbPrint: PrintSpecification = {
  interior: printFormat({
    label: 'Blurb Large Square · Premium',
    trim: { width: pt(846), height: pt(846) },
    bleed: { all: pt(9), binding: pt(0) },
    safe: { all: pt(18), binding: pt(36) },
    pageCount: selectedBlurb.pageCount,
  }),
  cover: selectedBlurb.cover,
};
