import { z } from 'zod';
import { maxPreviewEdge } from './preview';

// Photo sheets show photos of the book that may not be placed yet (API-015), so an agent can choose among them. They are
// an option of inspect_book's sources view: the sheet shows the photos the reply lists.
export const maxSheetPhotos = 48;

export const photoSheetSchema = z.strictObject({
  columns: z.int().min(1).max(8).default(6).describe('Photos per row.'),
  maxEdge: z.int().min(400).max(maxPreviewEdge).default(maxPreviewEdge).describe('Longest image edge in pixels.'),
  format: z.enum(['png', 'jpeg']).default('jpeg').describe('Image encoding.'),
});
export type PhotoSheetRequest = z.output<typeof photoSheetSchema>;

export type PhotoSheetMetadata = {
  kind: 'photo-sheet'; width: number; height: number; columns: number;
  // Pixel rectangles of the photos, uncropped. `missing`: why a cell is empty.
  cells: { photo: string; x: number; y: number; width: number; height: number; missing?: string }[];
};

const day = z.string().regex(/^\d{4}(-\d\d(-\d\d(T\d\d(:\d\d(:\d\d)?)?)?)?)?$/, 'Use a date or time such as 2026-07-12T13:30.');
export const capturedSchema = z.strictObject({
  from: day.optional().describe('Earliest, such as 2026-07-12 or 2026-07-12T13:30.'),
  to: day.optional().describe('Latest, inclusive: a date covers its whole day.'),
}).refine(({ from, to }) => from !== undefined || to !== undefined, 'Give from, to or both.');
/** Which photos an inspection asks for. */
export type PhotoChoice = { photos?: string[]; unplaced?: true; captured?: z.output<typeof capturedSchema> };

/** Whether a photo was taken in a range, in the camera's local time. One without a capture time never was. */
export function capturedWithin(dateTime: string | undefined, { from, to }: z.output<typeof capturedSchema>) {
  return dateTime !== undefined && (from === undefined || dateTime >= from) && (to === undefined || dateTime.slice(0, to.length) <= to);
}
