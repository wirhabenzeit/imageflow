import { z } from 'zod';
import { identifier } from './project';
import type { PageSide } from './project';
import type { PhotoPrint } from './photo-resolution';

const id = identifier.refine((value) => value.length <= 256);
export const makeInspectionSchema = (spread: z.ZodType<string, string>) => z.strictObject({
  spread: spread.optional().describe('Spread to measure, or a $ref of a spread inserted by the draft.'),
  cover: z.literal(true).optional().describe('Measure the cover. Omit spread and page.'),
  page: z.enum(['left', 'right']).optional().describe('Restrict measurements to one facing page of a split sheet.'),
  box: id.optional().describe('Measure just this box.'), element: id.optional().describe('Measure just this element.'),
  offset: z.int().min(0).default(0).describe('Index of the first item to return, for paging.'),
  limit: z.int().min(1).max(100).default(30).describe('Number of items to return. Continue from nextOffset.'),
}).refine(({ box, element }) => !(box && element), 'Choose either a box or an element.')
  .refine(({ cover, spread, page }) => cover ? spread === undefined && page === undefined : spread !== undefined,
    'Choose a spread or the cover.');
export const inspectionSchema = makeInspectionSchema(id);
export type InspectionRequest = z.input<typeof inspectionSchema>;
export type ElementMeasurement = {
  spread?: string; cover?: true; id: string; kind: 'photo' | 'markdown' | 'element';
  // The page the box or element is on, when the spread is shown as page layouts (ADR 0009).
  page?: PageSide;
  // Axis-aligned bounds relative to the full sheet's outer bleed corner; not inferred CSS source positions.
  boundsMm: { x: number; y: number; width: number; height: number }; upright: boolean;
  typography: { fontFamily: string; fontSizePt: number; lineHeightPt: number | null; fontWeight: string; color: string };
  editPaths: string[]; source?: string;
  // A photo box with a photo: the original's pixels and the ppi it prints at (API-021, 26 Nov).
  print?: PhotoPrint;
};
export type ElementInspection = {
  spread?: string; cover?: true; coordinateSpace: 'sheet-bleed-mm';
  items: ElementMeasurement[]; total: number; nextOffset: number | null;
};
