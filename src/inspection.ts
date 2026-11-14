import { z } from 'zod';
import { identifier } from './project';

const id = identifier.refine((value) => value.length <= 256);
export const makeInspectionSchema = (spread: z.ZodType<string, string>) => z.strictObject({
  spread: spread.describe('Spread to measure, or a $ref of a spread inserted by the draft.'),
  box: id.optional().describe('Measure just this box.'), element: id.optional().describe('Measure just this element.'),
  offset: z.int().min(0).default(0).describe('Index of the first item to return, for paging.'),
  limit: z.int().min(1).max(100).default(30).describe('Number of items to return. Continue from nextOffset.'),
}).refine(({ box, element }) => !(box && element), 'Choose either a box or an element.');
export const inspectionSchema = makeInspectionSchema(id);
export type InspectionRequest = z.input<typeof inspectionSchema>;
export type ElementMeasurement = {
  spread: string; id: string; kind: 'photo' | 'markdown' | 'element';
  // Axis-aligned bounds relative to the full sheet's outer bleed corner; not inferred CSS source positions.
  boundsMm: { x: number; y: number; width: number; height: number }; upright: boolean;
  typography: { fontFamily: string; fontSizePt: number; lineHeightPt: number | null; fontWeight: string; color: string };
  editPaths: string[]; source?: string;
};
export type ElementInspection = {
  spread: string; coordinateSpace: 'sheet-bleed-mm';
  items: ElementMeasurement[]; total: number; nextOffset: number | null;
};
