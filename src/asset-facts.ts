import { z } from 'zod';
import type { CaptureMetadata } from './photo-metadata';

/**
 * Derived per-photo facts (ADR 0010): the content digest, pixel size and capture metadata of a source photo's original.
 * `assets-meta.json` in the book root keeps them by source ID so a Mac or browser without the originals can still lay
 * out spreads, and so the portable book-state revision never has to hash them. The file is derived: it is written
 * outside the save journal and ledger, regenerates from the originals, and is safe to delete. Pure module: no host APIs.
 */
export const assetsMetaFile = 'assets-meta.json';

const captureTime = z.object({ dateTime: z.string(), offset: z.string().nullable() });
// Facts and the file keep keys this version does not know, as project.json does (ADR 0010, guardrail 2): a build that
// predates a field never drops it when it writes the file again. Loose at run time, typed as stripping.
const object = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape) as unknown as z.ZodObject<S, z.core.$strip>;
/** A provider's read-only descriptive metadata (ADR 0011): an override in photos.json wins over each field. */
export const providedFieldNames = ['title', 'caption', 'credit', 'altText'] as const;
export type ProvidedField = typeof providedFieldNames[number];
const providedSchema = object(Object.fromEntries(providedFieldNames.map((field) => [field, z.string().optional()])) as Record<ProvidedField, z.ZodOptional<z.ZodString>>);
export type ProvidedMetadata = z.infer<typeof providedSchema>;
export const assetFactSchema = object({
  /**
   * SHA-256 of the original's bytes, as hex. For a photo without a file (ADR 0011), of its stored preview's bytes
   * without their metadata segments: what the proxy store keys it by.
   */
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  captured: captureTime.optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  camera: z.object({ make: z.string().optional(), model: z.string().optional() }).optional(),
  /** When this replica last observed the original at this digest, as an ISO instant. */
  verified: z.iso.datetime(),
  /**
   * For a photo without a file: the provider's two tokens (desktop/source-provider.ts) its stored facts and preview
   * were read at. The host hands them back to the provider and compares them; it never reads them.
   */
  revisions: object({ revision: z.string(), contentRevision: z.string().optional() }).optional(),
  /** For a photo without a file: its provider's title, caption, credit and alt text. */
  provided: providedSchema.optional(),
  /** For a photo without a file: what its provider keeps with the fact for its own use. */
  extra: z.record(z.string(), z.unknown()).optional(),
});
/** The `assets-meta.json` version this build reads and writes. A file with another one is never written over. */
export const assetsMetaVersion = 1;
export const assetsMetaSchema = object({ version: z.literal(assetsMetaVersion), assets: z.record(z.string(), assetFactSchema) });
export type AssetFact = z.infer<typeof assetFactSchema>;
export type AssetsMeta = z.infer<typeof assetsMetaSchema>;
export type AssetFactObservation = { digest: string; width: number; height: number } & CaptureMetadata;

/** The two replicas' entries for one asset ID, and what the local replica knows about its original. */
export type AssetFactContest = {
  local?: AssetFact; remote?: AssetFact;
  /** The local original is present and its bytes were read and verified against `local.digest`. */
  localOriginalVerified: boolean;
  /** The remote replica says it holds a verified original, when its sync record says so. */
  remoteOriginalVerified?: boolean;
};

/**
 * The per-asset auto-resolve rule for sync (ADR 0010, Milestone 1): a replica with an available verified original wins;
 * otherwise the newer `verified` observation wins; a tie keeps the local entry. Never a book-level conflict.
 */
export function resolveAssetFact({ local, remote, localOriginalVerified, remoteOriginalVerified = false }: AssetFactContest): { winner: 'local' | 'remote'; fact: AssetFact } | undefined {
  if (local && !remote) return { winner: 'local', fact: local };
  if (remote && !local) return { winner: 'remote', fact: remote };
  if (!local || !remote) return undefined;
  const localWins = localOriginalVerified !== remoteOriginalVerified ? localOriginalVerified
    : Date.parse(local.verified) >= Date.parse(remote.verified);
  return localWins ? { winner: 'local', fact: local } : { winner: 'remote', fact: remote };
}
