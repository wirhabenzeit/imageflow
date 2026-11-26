import { z } from 'zod';
import { walkShape } from './declaration-check';
import type { Schema } from './declaration-check';

export const lengthSchema = z.object({ value: z.number().min(0), unit: z.enum(['mm', 'pt', 'in']) });
const positiveLength = lengthSchema.refine(({ value }) => value > 0, 'Trim must be greater than zero.');
// Formats with facing pages name the horizontal insets by the fold (outside, binding); formats without facing pages
// name them by the page's own edges (left, right), like InDesign's Facing Pages setting.
const facingInsets = z.object({ top: lengthSchema, bottom: lengthSchema, outside: lengthSchema, binding: lengthSchema });
const pageInsets = z.object({ top: lengthSchema, bottom: lengthSchema, left: lengthSchema, right: lengthSchema });
const resolution = z.object({ minimum: z.number().positive(), target: z.number().positive(), maximum: z.number().positive() })
  .refine(({ minimum, target, maximum }) => minimum <= target && target <= maximum, 'Resolution must satisfy minimum ≤ target ≤ maximum.');
const pageCount = <S extends z.ZodType>(step: S) => z.object({ min: z.int().positive(), max: z.int().positive(), step })
  .refine(({ min, max }) => max >= min, 'Maximum page count must be at least the minimum.');

export const printOutputSchema = z.object({
  container: z.literal('pdf', 'This draft supports PDF delivery.'),
  colorSpace: z.literal('sRGB'),
  transparency: z.enum(['allow', 'forbid'], 'This draft supports allowing or forbidding transparency.'),
  resolution: resolution.optional(),
  minimumTextSize: positiveLength.optional(),
  maximumFileSize: z.object({ pages: z.number().positive(), cover: z.number().positive().optional() }).optional(),
  // Deprecated compatibility field. Print always rejects Type 3 and unbundled fonts, with or without it.
  fonts: z.object({ allowType3: z.literal(false), allowSystemFonts: z.literal(false) }).optional(),
});
const common = {
  label: z.string().trim().min(1),
  trim: z.object({ width: positiveLength, height: positiveLength }),
  output: printOutputSchema,
};
const facingFormat = z.object({
  ...common, bleed: facingInsets, safe: facingInsets,
  structure: z.object({
    facingPages: z.literal(true).optional(),
    delivery: z.enum(['pages', 'spreads']),
    ends: z.enum(['single-pages', 'inside-covers']),
    pageCount: pageCount(z.union([z.literal(2), z.literal(4)])),
  }).refine(({ delivery, ends }) => !(delivery === 'spreads' && ends === 'single-pages'), {
    // `ends` is what the printer requires, so a PDF of whole spreads cannot also open on a single right page.
    path: ['ends'],
    message: "delivery: 'spreads' cannot have ends: 'single-pages': a PDF of whole spreads cannot open on a single right page. " +
      "Use ends: 'inside-covers', or delivery: 'pages'.",
  }),
});
// Without facing pages every unit is one page: there is no fold, so no delivery choice and no book ends.
const singlePageFormat = z.object({
  ...common, bleed: pageInsets, safe: pageInsets,
  structure: z.strictObject({
    facingPages: z.literal(false),
    pageCount: pageCount(z.union([z.literal(1), z.literal(2), z.literal(4)])),
  }, { error: (issue) => issue.code === 'unrecognized_keys'
    ? 'Formats without facing pages have no ' + issue.keys.join(' or ') + ': every page is its own PDF page.' : undefined }),
});

type Length = z.infer<typeof lengthSchema>;
export type FacingFormat = z.infer<typeof facingFormat>;
export type SinglePageFormat = z.infer<typeof singlePageFormat>;
export type PrintFormat = FacingFormat | SinglePageFormat;
export const mm = (value: number): Length => ({ value, unit: 'mm' });
export const pt = (value: number): Length => ({ value, unit: 'pt' });
export const inch = (value: number): Length => ({ value, unit: 'in' });
export const hasFacingPages = (format: Pick<PrintFormat, 'structure'>): format is FacingFormat => format.structure.facingPages !== false;

type FacingInsets = FacingFormat['bleed'];
type PageInsets = SinglePageFormat['bleed'];
type Shorthand<I> = Length | (Partial<I> & { all: Length }) | I;
export type InsetsShorthand = Shorthand<FacingInsets>;
export type PageInsetsShorthand = Shorthand<PageInsets>;
const isLength = (value: object): value is Length => 'value' in value && 'unit' in value;
function expandInsets<K extends string>(insets: Length | Partial<Record<K | 'top' | 'bottom' | 'all', Length>>, sides: readonly K[]) {
  const names = ['top', 'bottom', ...sides] as const;
  if (isLength(insets)) return Object.fromEntries(names.map((side) => [side, insets])) as Record<'top' | 'bottom' | K, Length>;
  const { all, ...given } = insets as Partial<Record<string, Length>>;
  if (!all) return given as Record<'top' | 'bottom' | K, Length>;
  return Object.fromEntries(names.map((side) => [side, given[side] ?? all])) as Record<'top' | 'bottom' | K, Length>;
}

type FormatOptions = { label: string; trim: { width: Length; height: Length }; output?: Partial<PrintFormat['output']> };
export type PrintFormatOptions = FormatOptions & ({
  facingPages?: true; bleed: InsetsShorthand; safe: InsetsShorthand;
  pageCount: FacingFormat['structure']['pageCount']; delivery?: FacingFormat['structure']['delivery']; ends?: FacingFormat['structure']['ends'];
} | {
  facingPages: false; bleed: PageInsetsShorthand; safe: PageInsetsShorthand;
  pageCount: SinglePageFormat['structure']['pageCount']; delivery?: never; ends?: never;
});
// A complete PrintFormat from shorter options. Only the delivery shape and the PDF container basics have defaults;
// page counts and every printer limit stay explicit, so a format never claims to be a printer's product by default.
export function printFormat(options: Extract<PrintFormatOptions, { facingPages: false }>): SinglePageFormat;
export function printFormat(options: Exclude<PrintFormatOptions, { facingPages: false }>): FacingFormat;
export function printFormat(options: PrintFormatOptions): PrintFormat;
export function printFormat(options: PrintFormatOptions): PrintFormat {
  const output = { container: 'pdf' as const, colorSpace: 'sRGB' as const, transparency: 'allow' as const, ...options.output };
  if (options.facingPages === false) {
    // Spread like this so a stray delivery or ends option still reaches the schema, which explains it.
    const { delivery, ends } = options as { delivery?: unknown; ends?: unknown };
    return {
      label: options.label, trim: options.trim, bleed: expandInsets(options.bleed, ['left', 'right']), safe: expandInsets(options.safe, ['left', 'right']),
      structure: { facingPages: false, pageCount: options.pageCount, ...(delivery !== undefined ? { delivery } : {}), ...(ends !== undefined ? { ends } : {}) },
      output,
    } as SinglePageFormat;
  }
  return {
    label: options.label, trim: options.trim, bleed: expandInsets(options.bleed, ['outside', 'binding']),
    safe: expandInsets(options.safe, ['outside', 'binding']),
    // Whole spreads cannot open on a single page, so `ends` follows `delivery` unless given.
    structure: { delivery: options.delivery ?? 'pages', ends: options.ends ?? (options.delivery === 'spreads' ? 'inside-covers' : 'single-pages'),
      pageCount: options.pageCount },
    output,
  };
}
// Page layouts draw in local coordinates, on either side of facing pages or as the unit without facing pages.
export type Span = 'spread' | 'left' | 'right' | 'page';
export type PrintSide = Span;

export function toMillimeters({ value, unit }: Length) {
  if (unit === 'in') return value * 25.4;
  if (unit === 'pt') return value * 25.4 / 72;
  return value;
}

export const resolveSides = <K extends string>(inset: Record<K, Length>) =>
  Object.fromEntries(Object.entries<Length>(inset).map(([side, value]) => [side, toMillimeters(value)])) as Record<K, number>;

type Millimeters = { trim: { width: number; height: number }; pageWidth: number; spreadWidth: number; outputWidth: number; height: number;
  resolution: PrintFormat['output']['resolution'] };
export type FacingResolvedFormat = Millimeters & {
  facingPages: true; bleed: Record<keyof FacingInsets, number>; safe: Record<keyof FacingInsets, number>;
};
// Without facing pages the sheet is one page: `spreadWidth` is the page width, so code that sizes a sheet works unchanged.
export type SinglePageResolvedFormat = Millimeters & {
  facingPages: false; bleed: Record<keyof PageInsets, number>; safe: Record<keyof PageInsets, number>;
};
export type ResolvedFormat = FacingResolvedFormat | SinglePageResolvedFormat;

export function pdfSizeProblem(width: number, height: number) {
  if (![width, height].every((edge) => edge >= 10 && edge <= 1000)) {
    return 'PDF dimensions must be between 10 and 1000 mm on each edge.';
  }
}

// Page geometry the template can declare but print and the editor cannot use. Checked when the template loads,
// so a broken format is reported as a template problem rather than when a book first switches to it.
function geometry(format: PrintFormat): { problem?: string; resolved: ResolvedFormat } {
  const trim = { width: toMillimeters(format.trim.width), height: toMillimeters(format.trim.height) };
  const height = trim.height + toMillimeters(format.bleed.top) + toMillimeters(format.bleed.bottom);
  const base = { trim, height, resolution: format.output.resolution };
  if (!hasFacingPages(format)) {
    const bleed = resolveSides(format.bleed), safe = resolveSides(format.safe);
    const pageWidth = trim.width + bleed.left + bleed.right;
    const problem = pdfSizeProblem(pageWidth, height) ?? (safe.left + safe.right >= trim.width || safe.top + safe.bottom >= trim.height
      ? 'Template safe insets leave no space inside the trim.' : undefined);
    return { problem, resolved: { ...base, facingPages: false, bleed, safe, pageWidth, spreadWidth: pageWidth, outputWidth: pageWidth } };
  }
  const bleed = resolveSides(format.bleed), safe = resolveSides(format.safe);
  const pageWidth = trim.width + bleed.outside + bleed.binding;
  const spreadWidth = (trim.width + bleed.outside) * 2;
  const outputWidth = format.structure.delivery === 'pages' ? pageWidth : spreadWidth;
  const problem = pdfSizeProblem(outputWidth, height)
    ?? (bleed.binding > trim.width + bleed.outside ? 'Binding bleed exceeds the facing page.'
    : safe.outside + safe.binding >= trim.width || safe.top + safe.bottom >= trim.height ? 'Template safe insets leave no space inside the trim.'
    : undefined);
  return { problem, resolved: { ...base, facingPages: true, bleed, safe, pageWidth, spreadWidth, outputWidth } };
}

// Side names that belong to the other kind of format, with a hint, by inset path.
function sideNameProblems(input: unknown, facing: boolean) {
  const problems: { path: string[]; message: string }[] = [];
  for (const key of ['bleed', 'safe'] as const) {
    const insets = (input as Record<string, unknown> | null)?.[key];
    if (!insets || typeof insets !== 'object') continue;
    const foreign = (facing ? ['left', 'right'] : ['outside', 'binding']).filter((side) => Object.hasOwn(insets, side));
    if (foreign.length) {
      problems.push({ path: [key], message: facing
        ? 'Formats with facing pages use outside and binding instead of left and right. For one page per unit, set facingPages: false.'
        : 'Formats without facing pages use left and right instead of outside and binding.' });
    }
  }
  return problems;
}

// One schema for both kinds of format, chosen by structure.facingPages (default true), so errors name the fields of
// the kind the template declares rather than a failed union.
const facingInput = (input: unknown) => (input as { structure?: { facingPages?: unknown } } | null)?.structure?.facingPages !== false;
export const formatSchema = walkShape(z.unknown().transform((input, context): PrintFormat => {
  const facing = facingInput(input);
  const hints = sideNameProblems(input, facing);
  for (const hint of hints) context.addIssue({ code: 'custom', ...hint });
  const parsed = (facing ? facingFormat : singlePageFormat).safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (hints.some(({ path }) => issue.path[0] === path[0])) continue;
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path as (string | number)[] });
    }
    return z.NEVER;
  }
  if (hints.length) return z.NEVER;
  const { problem } = geometry(parsed.data);
  if (problem) {
    context.addIssue({ code: 'custom', message: problem });
    return z.NEVER;
  }
  return parsed.data;
}), (input) => (facingInput(input) ? facingFormat : singlePageFormat) as unknown as Schema);

export function resolveFormat(format: PrintFormat): ResolvedFormat {
  const { problem, resolved } = geometry(format);
  if (problem) throw new Error(problem);
  return resolved;
}

// The pages of one sheet in millimetres from the sheet's left bleed edge: where each page's trim starts, its safe
// insets on the left and right, and the part of the sheet its PDF page shows with bleed. A sheet is a spread with
// facing pages, else one page.
export type SheetPage = { side: 'left' | 'right' | 'page'; trimX: number; safeLeft: number; safeRight: number; bleedX: number; bleedWidth: number };
export function sheetPages(format: ResolvedFormat): SheetPage[] {
  if (!format.facingPages) {
    return [{ side: 'page', trimX: format.bleed.left, safeLeft: format.safe.left, safeRight: format.safe.right, bleedX: 0, bleedWidth: format.pageWidth }];
  }
  const { trim, bleed, safe, pageWidth } = format;
  return [
    { side: 'left', trimX: bleed.outside, safeLeft: safe.outside, safeRight: safe.binding, bleedX: 0, bleedWidth: pageWidth },
    { side: 'right', trimX: bleed.outside + trim.width, safeLeft: safe.binding, safeRight: safe.outside,
      bleedX: bleed.outside + trim.width - bleed.binding, bleedWidth: pageWidth },
  ];
}
// The bleed on the sheet's own left and right edges.
export const sheetBleed = (format: ResolvedFormat) =>
  format.facingPages ? { left: format.bleed.outside, right: format.bleed.outside } : { left: format.bleed.left, right: format.bleed.right };

// The trim box of one PDF page, in millimetres from the page's lower-left corner as PDF boxes are given: inset by the
// bleed on each edge. `side` is the part of the sheet the page shows.
export function trimBox(format: ResolvedFormat, side: PrintSide) {
  const { trim, bleed } = format;
  const pages = sheetPages(format);
  const page = pages.find((candidate) => candidate.side === side);
  const left = side === 'spread' || !page ? sheetBleed(format).left : page.trimX - page.bleedX;
  return { x: left, y: bleed.bottom, width: trim.width * (side === 'spread' ? 2 : 1), height: trim.height };
}

// Whether a book of this format has single end pages: it must open on a single right page and close on a single
// left page (`ends: 'single-pages'`, e.g. Blurb). Only page delivery can have them.
export const hasSingleEnds = (format: Pick<PrintFormat, 'structure'>) =>
  hasFacingPages(format) && format.structure.delivery === 'pages' && format.structure.ends === 'single-pages';

// Whether a layout fits the format anywhere: page layouts work with either kind; legacy left/right layouts need single ends.
export function spanFits(span: Span, format: Pick<PrintFormat, 'structure'>) {
  if (!hasFacingPages(format)) return span === 'page';
  return span === 'page' || span === 'spread' || ((span === 'left' || span === 'right') && hasSingleEnds(format));
}
// The span a position requires, or undefined when any fitting span is allowed there. With single ends, the format
// requires the first spread to be a single right page and the last a single left page, with full spreads between
// them. A book of one spread so far may hold its opening page.
export function spanRequiredAt(index: number, count: number, format: Pick<PrintFormat, 'structure'>): Span {
  if (!hasFacingPages(format)) return 'page';
  if (!hasSingleEnds(format)) return 'spread';
  return index === 0 ? 'right' : index === count - 1 ? 'left' : 'spread';
}
export function spanAllowedAt(span: Span, index: number, count: number, format: Pick<PrintFormat, 'structure'>, sides?: readonly ('left' | 'right')[]) {
  const required = spanRequiredAt(index, count, format);
  if (span === 'page' && hasFacingPages(format)) return required !== 'spread' && (!sides || sides.includes(required as 'left' | 'right'));
  return span === required;
}

// Page numbers of one unit: `left`/`right` on a spread, `number` on a page of a format without facing pages.
export type UnitPages = { left?: number; right?: number; number?: number };
export const pageNumbers = (page: UnitPages) => [page.left, page.right, page.number].filter((n): n is number => n !== undefined);
// "3–4" or "3".
export const pageLabel = (page: UnitPages) => pageNumbers(page).join('–');
// "Pages 3–4" or "Page 3".
export const pagesText = (page: UnitPages) => (pageNumbers(page).length > 1 ? 'Pages ' : 'Page ') + pageLabel(page);

// Why a facing spread is in the wrong place, with the layout to switch to.
function endIssue(span: Span, index: number, count: number, format: Pick<PrintFormat, 'label' | 'structure'>) {
  const required = spanRequiredAt(index, count, format);
  const where = 'Spread ' + (index + 1);
  const is = span === 'spread' ? 'is a full spread' : 'is a single ' + span + ' page';
  if (required === 'right') {
    return where + ' ' + is + ', but ' + format.label + " requires the book to open on a single right page. Switch it to a layout with span: 'right'.";
  }
  if (required === 'left') {
    return where + ' ' + is + ', but ' + format.label + " requires the book to close on a single left page. Switch it to a layout with span: 'left'.";
  }
  return where + ' ' + is + (hasSingleEnds(format)
    ? ', but single pages belong only at the book ends. Switch it to a full spread layout.'
    : ', but ' + format.label + ' has no single pages at the book ends. Switch it to a full spread layout.');
}

/**
 * One way a book's pages do not fit its format. `count`: the page count is one the format does not take; `end`: a
 * spread sits where the format requires a single opening or closing page, or the closing page is missing. Both happen
 * while a book grows. `layout`: a layout of the wrong kind or side for the format, after a format switch or a wrong
 * layout choice.
 */
export type SequenceIssue = { text: string; kind: 'count' | 'end' | 'layout' };

export function pageSequence(spans: (Span | { span: Span; sides?: readonly ('left' | 'right')[] })[], format: Pick<PrintFormat, 'label' | 'structure'>) {
  let count = 0;
  const issues: SequenceIssue[] = [];
  const facing = hasFacingPages(format);
  const spreads = spans.map((entry, index) => {
    const { span, sides: allowedSides } = typeof entry === 'string' ? { span: entry } : entry;
    if (!facing) {
      // A layout for facing pages in a format without them is still drawn, on one page, and reported.
      if (span !== 'page') {
        issues.push({ kind: 'layout', text: 'Page ' + (count + 1) + ' uses a ' + (span === 'spread' ? 'spread' : 'single ' + span + ' page') + ' layout, but ' +
          format.label + ' has no facing pages. Switch it to a single-page layout.' });
      }
      const page: UnitPages = { number: ++count };
      return { span, page, sides: ['page'] as PrintSide[] };
    }
    const required = spanRequiredAt(index, spans.length, format);
    const shown = span === 'page' ? required : span;
    if (!spanAllowedAt(span, index, spans.length, format, allowedSides)) {
      issues.push(span === 'page' && required !== 'spread' && allowedSides && !allowedSides.includes(required as 'left' | 'right')
        ? { kind: 'layout', text: 'Spread ' + (index + 1) + ' requires a single ' + required + ' page, but this layout allows only the ' + allowedSides.join(' and ') + ' side. Choose a page layout that allows ' + required + '.' }
        : span === 'page' && required === 'spread'
          ? { kind: 'layout', text: 'Spread ' + (index + 1) + ' uses a single-page layout without being shown as pages. Choose a spread layout or split it into page layouts.' }
          // With single ends, a spread at an end or a single page between them is where a growing book is between its
          // ends; a format without single ends has no single pages at all.
          : { kind: hasSingleEnds(format) ? 'end' : 'layout', text: endIssue(shown, index, spans.length, format) });
    }
    const left = shown === 'right' ? undefined : ++count;
    const right = shown === 'left' ? undefined : ++count;
    const sides: PrintSide[] = format.structure.delivery === 'spreads' ? ['spread'] :
      shown === 'spread' ? ['left', 'right'] : [shown];
    const page: UnitPages = { left, right };
    return { span: shown, page, sides };
  });
  // A book of one spread may open correctly, but it cannot close on a single left page too.
  if (facing && hasSingleEnds(format) && spans.length === 1 && spreads[0].span === 'right') {
    issues.push({ kind: 'end', text: 'The book has only its opening page, but ' + format.label + " requires it to close on a single left page. Add a layout with span: 'left' at the end." });
  }
  const { min, max, step } = format.structure.pageCount;
  const shortfall = pageCountShortfall(count, format.structure.pageCount);
  if (shortfall) {
    const pages = (n: number) => n + (n === 1 ? ' page' : ' pages');
    const todo = shortfall.add !== undefined
      ? pages(shortfall.add) + ' to fill before export' + (shortfall.remove !== undefined ? ', or ' + pages(shortfall.remove) + ' to remove' : '')
      : pages(shortfall.remove!) + ' to remove before export';
    issues.push({ kind: 'count', text: 'Page count is ' + count + '. ' + format.label + ' requires ' + min + '–' + max + ' pages' + (step > 1 ? ' in steps of ' + step : '') + ': ' + todo + '.' });
  }
  return { spreads, count, issues, ...(shortfall ? { shortfall } : {}) };
}

/**
 * How far a page count is from one the format allows: the pages to add to reach the next allowed count, and the pages to
 * remove to reach the one before, each only when that count exists. Undefined for an allowed count.
 */
export function pageCountShortfall(count: number, rule: PrintFormat['structure']['pageCount']): { add?: number; remove?: number } | undefined {
  if (isAllowedPageCount(count, rule)) return undefined;
  const { min, max, step } = rule;
  if (count < min) return { add: min - count };
  const last = max - (max - min) % step;
  if (count > last) return { remove: count - last };
  const over = (count - min) % step;
  return { add: step - over, remove: over };
}

export function isAllowedPageCount(count: number, { min, max, step }: PrintFormat['structure']['pageCount']) {
  return Number.isSafeInteger(count) && count >= min && count <= max && (count - min) % step === 0;
}

export const cssMM = (value: number) => value + 'mm';
export const pdfPoints = (value: number) => value * 72 / 25.4;
