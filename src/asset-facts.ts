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
export const assetFactSchema = z.object({
  /** SHA-256 of the original's bytes, as hex. */
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  captured: captureTime.optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  camera: z.object({ make: z.string().optional(), model: z.string().optional() }).optional(),
  /** When this replica last observed the original at this digest, as an ISO instant. */
  verified: z.iso.datetime(),
});
export const assetsMetaSchema = z.object({ version: z.literal(1), assets: z.record(z.string(), assetFactSchema) });
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
