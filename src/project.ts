import { z } from 'zod';
import type { Dimensions } from './spread';

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, digits, underscores, or hyphens.')
  .refine((id) => !Object.hasOwn(Object.prototype, id), 'This identifier is reserved.');
const label = z.string().trim().min(1);
export const values = z.record(identifier, z.union([z.string(), z.boolean(), z.number()])).default({});
const crop = z.object({
  centerX: z.number().min(0).max(1),
  centerY: z.number().min(0).max(1),
  zoom: z.number().min(1).max(20),
});
const box = z.object({
  photo: identifier.optional(),
  text: identifier.optional(),
  crop: crop.optional(),
  params: values,
}).refine(({ photo, text, crop }) => !(photo && text) && (!crop || !!photo), 'A box holds one assignment, and only photos have a crop.');

const spreadContent = z.object({
  params: values,
  boxes: z.record(identifier, box).default({}),
  elements: z.record(identifier, z.object({ params: values })).default({}),
});

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  title: label,
  template: z.object({ id: identifier, version: label }),
  // The template format chosen in Book settings; templates with one format ignore it.
  format: identifier.optional(),
  params: values,
  texts: z.record(identifier, z.string()).default({}),
  spreads: z.array(spreadContent.extend({
    id: identifier,
    definition: identifier,
    archive: z.record(identifier, spreadContent).default({}),
  })).min(1).refine((spreads) => new Set(spreads.map((spread) => spread.id)).size === spreads.length, 'Spread IDs must be unique.'),
});

export const photoIndexSchema = z.record(identifier, z.object({
  path: z.string(),
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
export type Photo = Omit<PhotoIndex[string], 'path'> & Dimensions;
export type ProjectFiles = { project: Project; photoIndex: PhotoIndex };
export type RenderProject = {
  project: Project;
  photos: Record<string, Photo & { src: string }>;
  texts: Record<string, string>;
  problems: string[];
  template: { script: string; css?: string; assets: Record<string, string> };
  mode: 'edit' | 'export';
};

export function parseDocument<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.length ? ' → ' + issue.path.join(' → ') : '';
  throw new Error(label + path + ': ' + issue.message);
}
