import { z } from 'zod';
import { isLightroomIdentifier } from '../../src/source-locator';

/**
 * The jobs ImageFlow hands the Lightroom plugin over the bridge (desktop/lightroom/bridge.ts) and the results it posts
 * back, as `ImageFlow.lrplugin/Bridge.lua` writes them. Everything the plugin sends is parsed here before it is used:
 * it runs in another process, so its answers are input like any other.
 *
 * - `metadata { photos: [{ uuid, known? }] }`: one `batchGetRawMetadata` and `batchGetFormattedMetadata` for the photos.
 *   `known` is the revision ImageFlow stored; the plugin hashes `getDevelopSettings()` only for a photo whose revision
 *   differs from it, or that has none (ADR 0011, §3.2). Photos the catalog does not hold are listed in `missing`.
 * - `render { uuids, size: 'preview' | 'full', folder }`: one `LrExportSession` of up to five photos into `folder`,
 *   each with its revision (and develop hash) read before the session and after its own render (§4.3).
 * - `selection {}`: the photos selected in Lightroom, for Import from Lightroom Classic….
 * - `watch { uuids }`: the photos to poll for changes; the plugin posts `/lightroom/changes` when one moves.
 */

const identifier = z.string().refine(isLightroomIdentifier, 'Not a Lightroom identifier.');
const token = z.string().min(1).max(300);
const text = z.string().max(10_000).optional();
const dimension = z.number().int().positive().max(1_000_000);

export const photoRowSchema = z.object({
  uuid: identifier,
  /** `uuid : lastEditTime : editCount : croppedWidth x croppedHeight`, made by the plugin; opaque here. */
  revision: token,
  /** The hash of `getDevelopSettings()`, present when it was read (the revision moved, or none was known). */
  developHash: token.optional(),
  /** `croppedDimensions`: the size after Lightroom's crop. */
  width: dimension,
  height: dimension,
  orientation: z.string().max(4).optional(),
  /** `dateTimeOriginalISO8601`. */
  captured: z.string().max(40).optional(),
  gps: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  cameraMake: z.string().max(200).optional(),
  cameraModel: z.string().max(200).optional(),
  title: text, caption: text, copyright: text, creator: text, altText: text,
  fileName: z.string().max(255).optional(),
});
export type PhotoRow = z.infer<typeof photoRowSchema>;
export const metadataResultSchema = z.object({ photos: z.array(photoRowSchema).max(10_000), missing: z.array(z.string()).max(10_000).optional() });
export type MetadataResult = z.infer<typeof metadataResultSchema>;

const renderState = z.object({ revision: token, developHash: token.optional() });
export type RenderState = z.infer<typeof renderState>;
export const renderResultSchema = z.object({
  renders: z.array(z.object({ uuid: identifier, file: z.string().min(1).max(4096), before: renderState, after: renderState })).max(100),
  missing: z.array(z.string()).max(100).optional(),
  failed: z.array(z.object({ uuid: z.string(), error: z.string().max(1000) })).max(100).optional(),
});
export type RenderResult = z.infer<typeof renderResultSchema>;

export const selectionResultSchema = z.object({
  catalog: identifier,
  photos: z.array(z.object({ uuid: identifier, name: z.string().max(255).optional() })).max(5000),
});
export type SelectionResult = z.infer<typeof selectionResultSchema>;

/** A result checked against its schema; a malformed one is a failure of the job, never half used. */
export function parseResult<T>(schema: z.ZodType<T>, value: unknown, job: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('The Lightroom plugin answered the ' + job + ' job with something ImageFlow cannot read.');
  return parsed.data;
}
