import { z } from 'zod';

const length = z.object({ value: z.number().min(0), unit: z.enum(['mm', 'pt', 'in']) });
const positiveLength = length.refine(({ value }) => value > 0, 'Trim must be greater than zero.');
const insets = z.object({ top: length, bottom: length, outside: length, binding: length });
const resolution = z.object({ minimum: z.number().positive(), target: z.number().positive(), maximum: z.number().positive() })
  .refine(({ minimum, target, maximum }) => minimum <= target && target <= maximum, 'Resolution must satisfy minimum ≤ target ≤ maximum.');

const declaredFormat = z.object({
  label: z.string().trim().min(1),
  trim: z.object({ width: positiveLength, height: positiveLength }),
  bleed: insets,
  safe: insets,
  structure: z.object({
    delivery: z.enum(['pages', 'spreads']),
    ends: z.enum(['single-pages', 'inside-covers']),
    pageCount: z.object({ min: z.int().positive(), max: z.int().positive(), step: z.union([z.literal(2), z.literal(4)]) })
      .refine(({ min, max }) => max >= min, 'Maximum page count must be at least the minimum.'),
  }),
  output: z.object({
    container: z.literal('pdf', 'This draft supports PDF delivery.'),
    colorSpace: z.literal('sRGB'),
    transparency: z.enum(['allow', 'forbid'], 'This draft supports allowing or forbidding transparency.'),
    resolution: resolution.optional(),
    minimumTextSize: positiveLength.optional(),
    maximumFileSize: z.object({ pages: z.number().positive(), cover: z.number().positive().optional() }).optional(),
    fonts: z.object({ allowType3: z.literal(false), allowSystemFonts: z.literal(false) }).optional(),
  }),
});

type Length = z.infer<typeof length>;
export type PrintFormat = z.infer<typeof formatSchema>;
export const mm = (value: number): Length => ({ value, unit: 'mm' });
export const pt = (value: number): Length => ({ value, unit: 'pt' });
export const inch = (value: number): Length => ({ value, unit: 'in' });
type Insets = PrintFormat['bleed'];
export type InsetsShorthand = Length | (Partial<Insets> & { all: Length }) | Insets;
const isLength = (value: InsetsShorthand): value is Length => 'value' in value && 'unit' in value;
function expandInsets(insets: InsetsShorthand): Insets {
  if (isLength(insets)) return { top: insets, bottom: insets, outside: insets, binding: insets };
  const { all, ...sides } = insets as Partial<Insets> & { all?: Length };
  if (!all) return insets as Insets;
  return { top: sides.top ?? all, bottom: sides.bottom ?? all, outside: sides.outside ?? all, binding: sides.binding ?? all };
}

// A complete PrintFormat from shorter options. Only the delivery shape and the PDF container basics have defaults;
// page counts and every printer limit stay explicit, so a format never claims to be a printer's product by default.
export function printFormat(options: {
  label: string; trim: { width: Length; height: Length }; bleed: InsetsShorthand; safe: InsetsShorthand;
  pageCount: PrintFormat['structure']['pageCount']; delivery?: PrintFormat['structure']['delivery'];
  ends?: PrintFormat['structure']['ends']; output?: Partial<PrintFormat['output']>;
}): PrintFormat {
  return {
    label: options.label, trim: options.trim, bleed: expandInsets(options.bleed), safe: expandInsets(options.safe),
    structure: { delivery: options.delivery ?? 'pages', ends: options.ends ?? 'single-pages', pageCount: options.pageCount },
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow', ...options.output },
  };
}
export type Span = 'spread' | 'left' | 'right';
export type PrintSide = Span;

export function toMillimeters({ value, unit }: Length) {
  if (unit === 'in') return value * 25.4;
  if (unit === 'pt') return value * 25.4 / 72;
  return value;
}

function resolveInsets(inset: PrintFormat['bleed']) {
  return {
    top: toMillimeters(inset.top), bottom: toMillimeters(inset.bottom),
    outside: toMillimeters(inset.outside), binding: toMillimeters(inset.binding),
  };
}

// Page geometry the template can declare but print and the editor cannot use. Checked when the template loads,
// so a broken format is reported as a template problem rather than when a book first switches to it.
function geometry(format: z.infer<typeof declaredFormat>) {
  const trim = { width: toMillimeters(format.trim.width), height: toMillimeters(format.trim.height) };
  const bleed = resolveInsets(format.bleed);
  const safe = resolveInsets(format.safe);
  const pageWidth = trim.width + bleed.outside + bleed.binding;
  const spreadWidth = (trim.width + bleed.outside) * 2;
  const outputWidth = format.structure.delivery === 'pages' ? pageWidth : spreadWidth;
  const height = trim.height + bleed.top + bleed.bottom;
  const problem = outputWidth < 10 || height < 10 || outputWidth > 1000 || height > 1000
    ? 'PDF dimensions must be between 10 and 1000 mm on each edge.'
    : bleed.binding > trim.width + bleed.outside ? 'Binding bleed exceeds the facing page.'
    : safe.outside + safe.binding >= trim.width || safe.top + safe.bottom >= trim.height ? 'Template safe insets leave no space inside the trim.'
    : undefined;
  return { problem, resolved: { trim, bleed, safe, pageWidth, spreadWidth, outputWidth, height, resolution: format.output.resolution } };
}

export const formatSchema = declaredFormat.superRefine((format, context) => {
  const { problem } = geometry(format);
  if (problem) context.addIssue({ code: 'custom', message: problem });
});

export function resolveFormat(format: PrintFormat) {
  const { problem, resolved } = geometry(format);
  if (problem) throw new Error(problem);
  return resolved;
}

export function spanAllowedAt(span: Span, index: number, count: number, format: PrintFormat) {
  return span === 'spread' || (format.structure.delivery === 'pages' && format.structure.ends === 'single-pages' &&
    (span === 'right' ? index === 0 : index === count - 1));
}

export function pageSequence(spans: Span[], format: PrintFormat) {
  let count = 0;
  const issues: string[] = [];
  const spreads = spans.map((span, index) => {
    if (!spanAllowedAt(span, index, spans.length, format)) {
      issues.push('Spread ' + (index + 1) + ' uses a single ' + span + ' page outside the allowed book end.');
    }
    const left = span === 'right' ? undefined : ++count;
    const right = span === 'left' ? undefined : ++count;
    const sides: PrintSide[] = format.structure.delivery === 'spreads' ? ['spread'] :
      span === 'spread' ? ['left', 'right'] : [span];
    return { span, page: { left, right }, sides };
  });
  const { min, max, step } = format.structure.pageCount;
  if (count < min || count > max || (count - min) % step) {
    issues.push('Page count is ' + count + '. ' + format.label + ' requires ' + min + '–' + max + ' pages in steps of ' + step + '.');
  }
  return { spreads, count, issues };
}

export type ResolvedFormat = ReturnType<typeof resolveFormat>;
export const cssMM = (value: number) => value + 'mm';
export const pdfPoints = (value: number) => value * 72 / 25.4;
