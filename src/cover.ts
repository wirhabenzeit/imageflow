import { z } from 'zod';
import { formatSchema, isAllowedPageCount, lengthSchema, pdfSizeProblem, printOutputSchema, resolveSides, toMillimeters } from './format';
import type { PrintFormat } from './format';
import { inset } from './geometry';
import type { Rect } from './geometry';

const positive = lengthSchema.refine(({ value }) => value > 0, 'Use a length greater than zero.');
const edges = z.strictObject({ top: lengthSchema, right: lengthSchema, bottom: lengthSchema, left: lengthSchema });
const widths = z.strictObject({
  spine: positive,
  flaps: z.strictObject({ back: positive, front: positive }).optional(),
});
const band = z.strictObject({ from: z.int().positive(), to: z.int().positive(), value: widths })
  .refine(({ from, to }) => from <= to, 'The end of a page-count band must be at least its start.');
export const coverFormatSchema = z.strictObject({
  kind: z.literal('wrap'),
  height: positive,
  panels: z.strictObject({ back: positive, front: positive }),
  widths: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('fixed'), value: widths }),
    z.strictObject({ kind: z.literal('page-bands'), bands: z.array(band).min(1) }),
  ]),
  outer: z.strictObject({ kind: z.enum(['bleed', 'wrap']), insets: edges }),
  safe: z.strictObject({ back: edges, spine: edges, front: edges }),
  flaps: z.strictObject({ safe: z.strictObject({ back: edges, front: edges }) }).optional(),
  foldAvoidance: z.strictObject({ back: lengthSchema, front: lengthSchema }).optional(),
  output: printOutputSchema.omit({ maximumFileSize: true, fonts: true })
    .extend({ maximumFileSize: z.int().positive().optional() }).strict(),
});

export type CoverFormat = z.infer<typeof coverFormatSchema>;
type CoverWidths = z.infer<typeof widths>;
type CoverRegion = 'backFlap' | 'back' | 'spine' | 'front' | 'frontFlap';
type PageCount = PrintFormat['structure']['pageCount'];
export type ResolvedCover = {
  outerKind: CoverFormat['outer']['kind'];
  // All rectangles are in millimetres from the upper-left corner of the trim.
  sheet: Rect;
  trim: Rect;
  regions: Record<'back' | 'spine' | 'front', Rect> & Partial<Record<'backFlap' | 'frontFlap', Rect>>;
  // null means the region exists, but its safe insets leave no usable area.
  safe: Partial<Record<CoverRegion, Rect | null>>;
  folds: number[];
  avoid: Rect[];
  output: CoverFormat['output'];
};

function geometry(format: CoverFormat, widths: CoverWidths): ResolvedCover {
  const height = toMillimeters(format.height);
  const outer = resolveSides(format.outer.insets);
  let x = 0;
  const folds: number[] = [];
  const safe: ResolvedCover['safe'] = {};
  function panel(region: CoverRegion, width: CoverWidths['spine'], margins: z.infer<typeof edges>) {
    if (x > 0) folds.push(x);
    const rect = { x, y: 0, width: toMillimeters(width), height };
    x += rect.width;
    const inner = inset(rect, resolveSides(margins));
    safe[region] = inner.width > 1e-9 && inner.height > 1e-9 ? inner : null;
    return rect;
  }
  const regions = {
    ...(format.flaps && widths.flaps ? { backFlap: panel('backFlap', widths.flaps.back, format.flaps.safe.back) } : {}),
    back: panel('back', format.panels.back, format.safe.back),
    spine: panel('spine', widths.spine, format.safe.spine),
    front: panel('front', format.panels.front, format.safe.front),
    ...(format.flaps && widths.flaps ? { frontFlap: panel('frontFlap', widths.flaps.front, format.flaps.safe.front) } : {}),
  };
  const trim = { x: 0, y: 0, width: x, height };
  const sheet = {
    x: -outer.left, y: -outer.top,
    width: trim.width + outer.left + outer.right,
    height: trim.height + outer.top + outer.bottom,
  };
  const avoid: Rect[] = [];
  if (format.foldAvoidance) {
    const back = toMillimeters(format.foldAvoidance.back);
    const front = toMillimeters(format.foldAvoidance.front);
    if (back > 0) avoid.push({ x: regions.spine.x - back, y: 0, width: back, height });
    if (front > 0) avoid.push({ x: regions.front.x, y: 0, width: front, height });
  }
  return { outerKind: format.outer.kind, sheet, trim, regions, safe, folds, avoid, output: format.output };
}

function bandProblem(bands: z.infer<typeof band>[], { min, max, step }: PageCount) {
  // Compare indices of allowed counts so a gap such as 50 to 52 is valid for step 2. This also
  // avoids enumerating the entire supported page range when loading a declaration.
  let next = 0;
  let previousEnd = 0;
  for (const { from, to } of [...bands].sort((a, b) => a.from - b.from)) {
    if (from <= previousEnd) return 'Cover page-count bands overlap.';
    const first = Math.ceil((from - min) / step);
    const last = Math.floor((to - min) / step);
    if (from < min || to > max || first > last) {
      return 'Each cover band must be within the interior range and contain a permitted page count.';
    }
    if (first !== next) return 'Cover bands must account for every permitted interior page count.';
    next = last + 1;
    previousEnd = to;
  }
  if (next !== Math.floor((max - min) / step) + 1) {
    return 'Cover bands must account for every permitted interior page count.';
  }
}

// Validate the paired declaration before it can be used for preview, checks or PDF output.
export const printSpecificationSchema = z.strictObject({
  interior: formatSchema,
  cover: coverFormatSchema.optional(),
}).superRefine(({ interior, cover }, context) => {
  if (!cover) return;
  const report = (message: string, ...path: (string | number)[]) => {
    context.addIssue({ code: 'custom', path: ['cover', ...path], message });
  };
  if (cover.foldAvoidance) {
    for (const side of ['back', 'front'] as const) {
      if (toMillimeters(cover.foldAvoidance[side]) > toMillimeters(cover.panels[side])) {
        report('Fold avoidance extends beyond its cover panel.', 'foldAvoidance', side);
      }
    }
  }
  const schedule = cover.widths;
  const checkSheet = (widths: CoverWidths, path: (string | number)[]) => {
    if (!!cover.flaps !== !!widths.flaps) {
      report('Each cover width must specify both flap widths when the cover declares flaps.', ...path, 'flaps');
      return;
    }
    const { sheet } = geometry(cover, widths);
    const problem = pdfSizeProblem(sheet.width, sheet.height);
    if (problem) report(problem, ...path);
  };
  if (schedule.kind === 'fixed') checkSheet(schedule.value, ['widths', 'value']);
  else {
    const problem = bandProblem(schedule.bands, interior.structure.pageCount);
    if (problem) report(problem, 'widths', 'bands');
    schedule.bands.forEach(({ value }, index) => checkSheet(value, ['widths', 'bands', index, 'value']));
  }
});

export type PrintSpecification = z.infer<typeof printSpecificationSchema>;
export function coverLayoutsFor<T extends { formats?: readonly string[] }>(layouts: Record<string, T> | undefined, format: string) {
  return Object.fromEntries(Object.entries(layouts ?? {}).filter(([, layout]) => !layout.formats || layout.formats.includes(format)));
}

type ReadyCover = { status: 'ready'; interiorPages: number; geometry: ResolvedCover };
export type CoverResolution = { status: 'unavailable' } | ReadyCover |
  { status: 'provisional'; interiorPages: number; previewPages: number; geometry: ResolvedCover };

export function resolveCover({ interior, cover }: PrintSpecification, interiorPages: number): CoverResolution {
  if (!cover) return { status: 'unavailable' };
  const pageCount = interior.structure.pageCount;
  const ready = isAllowedPageCount(interiorPages, pageCount);
  const previewPages = ready ? interiorPages : pageCount.min;
  const schedule = cover.widths;
  const widths = schedule.kind === 'fixed' ? schedule.value
    : schedule.bands.find(({ from, to }) => from <= previewPages && previewPages <= to)?.value;
  if (!widths) throw new Error('Invalid cover specification: no cover size for ' + previewPages + ' interior pages.');
  const resolved = geometry(cover, widths);
  return ready ? { status: 'ready', interiorPages, geometry: resolved }
    : { status: 'provisional', interiorPages, previewPages, geometry: resolved };
}

// PDF trim box in millimetres from the bottom-left corner of the full sheet.
export function coverTrimBox({ geometry: { sheet, trim } }: ReadyCover): Rect {
  return { x: trim.x - sheet.x, y: sheet.y + sheet.height - trim.y - trim.height, width: trim.width, height: trim.height };
}
