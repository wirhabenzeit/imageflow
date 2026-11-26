import { lt, valid } from 'semver';
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
 *   From plugin 1.3.0 a row also has the photo's marks where they are set (ADR 0014): `rating` (1 to 5), `pickStatus`
 *   (1 picked, -1 rejected), `colorNameForLabel` (Lightroom's colour name, 'red' to 'purple' or one of its own) and the
 *   formatted `label` (the label's own name). An older plugin sends none of them.
 * - `thumbnails { photos: [{ uuid, known? }], folder }` (plugin 1.1.0): the previews Lightroom keeps itself, at least
 *   1400 px where it has them, as files in `folder`, with each photo's revision before and after. `known` is the revision
 *   ImageFlow knows the develop settings of, as in `metadata`. A photo Lightroom has no preview of now, such as one being
 *   edited in Develop, is listed in `refused`; once the user is in Library the plugin posts it as changed.
 * - `render { uuids, size: 'preview' | 'full', folder }`: one `LrExportSession` of a few photos into `folder`,
 *   each with its revision (and develop hash) read before the session and after its own render (§4.3).
 * - `selection {}`: the photos selected in Lightroom, for Import from Lightroom Classic….
 * - `show { uuids }` (plugin 1.2.0): selects the photos, the first one active: in Develop when that is open, else in the Library
 *   grid. It looks in the folder or collection shown now first, and in All Photographs when they are not all there.
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
  // The marks (plugin 1.3.0) only decorate a photo and reach no render, so one ImageFlow cannot read is dropped by
  // itself instead of failing the job for every photo in it.
  rating: z.number().int().min(1).max(5).optional().catch(undefined),
  pickStatus: z.union([z.literal(1), z.literal(-1)]).optional().catch(undefined),
  colorNameForLabel: z.string().min(1).max(40).optional().catch(undefined),
  label: z.string().min(1).max(200).optional().catch(undefined),
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

export const thumbnailsResultSchema = z.object({
  thumbnails: z.array(z.object({ uuid: identifier, file: z.string().min(1).max(4096), before: renderState, after: renderState })).max(1000),
  missing: z.array(z.string()).max(1000).optional(),
  refused: z.array(z.object({ uuid: z.string(), error: z.string().max(1000) })).max(1000).optional(),
});
export type ThumbnailsResult = z.infer<typeof thumbnailsResultSchema>;
/** The first plugin version that answers the `thumbnails` job. An older one that is still installed renders instead. */
export const thumbnailsSince = '1.1.0';

export const selectionResultSchema = z.object({
  catalog: identifier,
  photos: z.array(z.object({ uuid: identifier, name: z.string().max(255).optional() })).max(5000),
});
export type SelectionResult = z.infer<typeof selectionResultSchema>;

/** How many of the photos are selected now, and the ones the catalog does not hold. */
export const showResultSchema = z.object({ shown: z.number().int().min(0).max(1000), missing: z.array(z.string()).max(1000).optional() });
/** The first plugin version that answers the `show` job. */
export const showSince = '1.2.0';
/** The first plugin version that reports a photo's marks (ADR 0014). An older one works on, and its photos show none. */
export const marksSince = '1.3.0';
/**
 * Whether a connected plugin of this version predates the marks, so View → Lightroom Classic says to update it. Not
 * for a version that cannot be read: it may be a development copy, and nothing is known about it.
 */
export function predatesMarks(version: string | undefined): boolean {
  const known = version ? valid(version) : null;
  return !!known && lt(known, marksSince);
}

/** A result checked against its schema; a malformed one is a failure of the job, never half used. */
export function parseResult<T>(schema: z.ZodType<T>, value: unknown, job: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('The Lightroom plugin answered the ' + job + ' job with something ImageFlow cannot read.');
  return parsed.data;
}
