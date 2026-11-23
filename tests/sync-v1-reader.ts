import { z } from 'zod';

/**
 * The commit header reader of sync format version 1, frozen as it shipped up to 1.0.0-beta.21 (src/sync-snapshot.ts
 * before #278): its schema, its rule for what a newer version wrote, and its error. Kept only to prove that those
 * builds refuse the version 2 headers of the per-book layout (ADR 0012) with a request to update. Never change it.
 */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();

const commitHeaderSchema = z.object({
  version: z.literal(1),
  commitId: uuid,
  bookId: uuid,
  parents: z.array(uuid).max(16),
  bookStateRevision: sha256,
  createdAt: z.iso.datetime(),
  title: z.string().max(400),
  stateDigest: sha256,
}).strict();

class NewerSyncFormatError extends Error {
  readonly code = 'SYNC_FORMAT_NEWER';
  constructor() {
    super('This book was synced by a newer version of ImageFlow. Update ImageFlow to sync it. The book was not changed.');
    this.name = 'NewerSyncFormatError';
  }
}
const newer = (value: unknown, schema: z.ZodObject) => {
  if (!value || typeof value !== 'object') return false;
  const version = (value as { version?: unknown }).version;
  if (typeof version === 'number' && version > 1) return true;
  return version === 1 && schema.loose().safeParse(value).success;
};
export function readCommitHeaderV1(value: unknown) {
  const parsed = commitHeaderSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (newer(value, commitHeaderSchema)) throw new NewerSyncFormatError();
  return undefined;
}
