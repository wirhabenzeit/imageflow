import { z } from 'zod';

const length = z.object({ value: z.number().min(0), unit: z.enum(['mm', 'pt', 'in']) });
const positiveLength = length.refine(({ value }) => value > 0, 'Trim must be greater than zero.');
const insets = z.object({ top: length, bottom: length, outside: length, binding: length });
const resolution = z.object({ minimum: z.number().positive(), target: z.number().positive(), maximum: z.number().positive() })
  .refine(({ minimum, target, maximum }) => minimum <= target && target <= maximum, 'Resolution must satisfy minimum ≤ target ≤ maximum.');

export const formatSchema = z.object({
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

export function resolveFormat(format: PrintFormat) {
  const trim = { width: toMillimeters(format.trim.width), height: toMillimeters(format.trim.height) };
  const bleed = resolveInsets(format.bleed);
  const safe = resolveInsets(format.safe);
  const pageWidth = trim.width + bleed.outside + bleed.binding;
  const spreadWidth = (trim.width + bleed.outside) * 2;
  const outputWidth = format.structure.delivery === 'pages' ? pageWidth : spreadWidth;
  const height = trim.height + bleed.top + bleed.bottom;
  if (outputWidth < 10 || height < 10 || outputWidth > 1000 || height > 1000) {
    throw new Error('PDF dimensions must be between 10 and 1000 mm on each edge.');
  }
  if (bleed.binding > trim.width + bleed.outside) throw new Error('Binding bleed exceeds the facing page.');
  if (safe.outside + safe.binding >= trim.width || safe.top + safe.bottom >= trim.height) {
    throw new Error('Template safe insets leave no space inside the trim.');
  }
  return { trim, bleed, safe, pageWidth, spreadWidth, outputWidth, height, resolution: format.output.resolution };
}

export function pageSequence(spans: Span[], format: PrintFormat) {
  let count = 0;
  const issues: string[] = [];
  const spreads = spans.map((span, index) => {
    if (span !== 'spread' && (format.structure.delivery === 'spreads' || format.structure.ends !== 'single-pages' ||
        (span === 'right' ? index !== 0 : index !== spans.length - 1))) {
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
