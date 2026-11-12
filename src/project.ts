import { z } from 'zod';
import { importModeSchema, sourceReferenceSchema } from './source-locations';
import type { SourceStatus } from './source-locations';
import type { Dimensions } from './spread';

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, digits, underscores, or hyphens.')
  .refine((id) => !Object.hasOwn(Object.prototype, id), 'This identifier is reserved.');
const label = z.string().trim().min(1);
export const values = z.record(identifier, z.union([z.string(), z.boolean(), z.number()])).default({});
const unit = z.number().min(0).max(1);
const crop = z.object({ centerX: unit, centerY: unit, zoom: z.number().min(1).max(20) });
// A box's content is shared by every layout that declares a box with its ID; layouts without that box keep it on the
// spread. Crops depend on the frame, so each layout has its own. A layout without one fills its frame around
// `focus`, the centre of the crop set last.
const box = z.object({
  photo: identifier.optional(),
  text: identifier.optional(),
  crops: z.record(identifier, crop).optional(),
  focus: z.object({ centerX: unit, centerY: unit }).optional(),
  params: values,
}).refine(({ photo, text, crops, focus }) => !(photo && text) && (!(crops || focus) || !!photo),
  'A box holds one assignment, and only photos have a crop.');


export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  title: label,
  importMode: importModeSchema.optional(),
  template: z.object({ id: identifier, version: label }),
  // The template format chosen in Book settings; templates with one format ignore it.
  format: identifier.optional(),
  params: values,
  texts: z.record(identifier, sourceReferenceSchema).default({}),
  // File parameter sources (such as GPX tracks), by ID: owned relative paths or explicit external links.
  files: z.record(identifier, sourceReferenceSchema).default({}),
  // Each spread keeps one state for all its layouts: `definition` picks which boxes and elements are shown.
  spreads: z.array(z.object({
    id: identifier,
    definition: identifier,
    params: values,
    boxes: z.record(identifier, box).default({}),
    elements: z.record(identifier, z.object({ params: values })).default({}),
  })).refine((spreads) => new Set(spreads.map((spread) => spread.id)).size === spreads.length, 'Spread IDs must be unique.'),
});

export const photoIndexSchema = z.record(identifier, z.object({
  path: z.string(),
  linked: z.boolean().optional(),
  caption: z.string().optional(),
  title: z.string().optional(),
  credit: z.string().optional(),
  altText: z.string().optional(),
}));

export type Project = z.infer<typeof projectSchema>;
export type SpreadState = Project['spreads'][number];
export type BoxState = z.infer<typeof box>;
export type Values = z.infer<typeof values>;
export type PhotoIndex = z.infer<typeof photoIndexSchema>;
export type Photo = Omit<PhotoIndex[string], 'path' | 'linked'> & Dimensions;
// A file the template reads through `file(id)`. Files are read as UTF-8 text.
export type ProjectFile = { name: string; extension: string; text?: string; problem?: string };
export type ProjectFiles = { project: Project; photoIndex: PhotoIndex };
export type RenderProject = {
  project: Project;
  photos: Record<string, Photo & { src: string }>;
  texts: Record<string, string>;
  // Registered files with their text, or why they could not be read.
  files: Record<string, ProjectFile>;
  problems: string[];
  sources?: Record<string, SourceStatus>;
  template: { script: string; css?: string; assets: Record<string, string> };
  mode: 'edit' | 'export';
  // A synthetic authoring fixture book. Its artwork carries a banner and fixture labels so it is never mistaken for the book.
  fixture?: FixtureMarking;
};
export type FixtureMarking = { banner: string; labels: Record<string, string> };

export function parseDocument<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.length ? ' → ' + issue.path.join(' → ') : '';
  throw new Error(label + path + ': ' + issue.message);
}
