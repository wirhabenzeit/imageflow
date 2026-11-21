import { z } from 'zod';
import { assetsMetaSchema } from './asset-facts';
import { canonicalJson } from './canonical-json';
import { computeBookStateRevision } from './book-revision';
import type { PhotoIndex, Project } from './project';

/**
 * Immutable sync snapshots (ADR 0010, Milestone 1). A sync remote keeps two kinds of immutable record per book:
 *
 * - a **commit header** (`books/<bookId>/snapshots/<commitId>.json`): a few hundred bytes naming its parents, the
 *   portable book-state revision and the digest of its state blob, so deriving the tips never parses whole books;
 * - a **state blob** (`blobs/content/<stateDigest>`): the full small book state, with machine-local linked paths
 *   reduced to their file names, the derived `assets-meta.json`, and digest maps of the content, owned originals and
 *   screen proxies it refers to, which are blobs of their own.
 *
 * Pure and host-agnostic: no Node, Electron or filesystem APIs, so a web companion reads the same records.
 */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
// `.jpg`, `.png`, `.webp`…: lower case, with the dot, as `extname` gives it.
const extension = z.string().regex(/^\.[a-z0-9]{1,10}$/);

export const commitHeaderSchema = z.object({
  version: z.literal(1),
  commitId: uuid,
  bookId: uuid,
  // `[]` for the first commit, `[previous]` for an ordinary push, every superseded tip when a fork is closed.
  parents: z.array(uuid).max(16),
  bookStateRevision: sha256,
  createdAt: z.iso.datetime(),
  title: z.string().max(400),
  stateDigest: sha256,
}).strict();
export type CommitHeader = z.infer<typeof commitHeaderSchema>;

/**
 * Sync records a newer ImageFlow wrote: a higher `version`, or fields this version does not know. They are never
 * skipped, which would hide commits and make an older app push a fork; sync stops and asks for an update instead.
 */
export class NewerSyncFormatError extends Error {
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
  // Every field this version needs, and more: written by a newer version.
  return version === 1 && schema.loose().safeParse(value).success;
};
/** A commit header as a remote stored it: the header, or undefined for one that is incomplete or not a header. */
export function readCommitHeader(value: unknown): CommitHeader | undefined {
  const parsed = commitHeaderSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (newer(value, commitHeaderSchema)) throw new NewerSyncFormatError();
  return undefined;
}

// Paths of the content map: the book's own texts and files that project.json references, and every template file.
const contentPath = z.string().max(1024).refine((path) => /^(?:texts|files|template)\/./.test(path) &&
  path.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\')), 'A content path must stay inside texts/, files/ or template/.');

export const stateBlobSchema = z.object({
  version: z.literal(1),
  // project.json and photos.json with every linked path reduced to its file name (`portableManifests`).
  project: z.record(z.string(), z.unknown()),
  photos: z.record(z.string(), z.unknown()),
  assetsMeta: assetsMetaSchema,
  // SHA-256 of each owned referenced text and file and of every template file, by its path in the book.
  content: z.record(contentPath, sha256),
  // Owned originals (photos/ entries that are not linked), by source ID: `blobs/originals/<digest><ext>`.
  originals: z.record(z.string(), z.object({ digest: sha256, ext: extension }).strict()),
  // Screen proxies by the original's digest: `blobs/proxies/<originalDigest>-preview-v1<ext>`, with the proxy's own SHA-256.
  proxies: z.record(sha256, z.object({ sha256, ext: z.enum(['.jpg', '.png']) }).strict()),
}).strict();
export type StateBlob = z.infer<typeof stateBlobSchema>;
/** Whether a complete state blob that this version cannot read was written by a newer version. */
export const newerStateBlob = (value: unknown) => newer(value, stateBlobSchema);

/** Keys of the immutable blobs a remote stores. */
export const contentBlobKey = (digest: string) => 'blobs/content/' + sha256.parse(digest);
export const originalBlobKey = (digest: string, ext: string) => 'blobs/originals/' + sha256.parse(digest) + extension.parse(ext);
export const proxyBlobKey = (originalDigest: string, ext: string) => 'blobs/proxies/' + sha256.parse(originalDigest) + '-preview-v1' + z.enum(['.jpg', '.png']).parse(ext);
export const blobKeyPattern = /^blobs\/(?:content\/[a-f0-9]{64}|originals\/[a-f0-9]{64}\.[a-z0-9]{1,10}|proxies\/[a-f0-9]{64}-preview-v1\.(?:jpg|png))$/;

/** The bytes of a state blob as stored and hashed. */
export const encodeStateBlob = (blob: StateBlob) => new TextEncoder().encode(canonicalJson(stateBlobSchema.parse(blob)));

/** The file name of a path, with either separator. */
export const fileNameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';

// Linked references keep their file name only, so one Mac's folder layout never reaches another.
const linkedReference = (reference: unknown): reference is { path: string; linked: true } =>
  !!reference && typeof reference === 'object' && (reference as { linked?: unknown }).linked === true && typeof (reference as { path?: unknown }).path === 'string';
const withPath = <T extends object>(reference: T, path: string) => ({ ...reference, path });
const mapReferences = (references: Record<string, unknown>, map: (id: string, reference: { path: string; linked: true }) => unknown) =>
  Object.fromEntries(Object.entries(references).map(([id, reference]) => [id, linkedReference(reference) ? map(id, reference) : reference]));

/** project.json and photos.json as a state blob carries them: linked paths become their file names, nothing else changes. */
export function portableManifests(project: Project, photos: PhotoIndex) {
  return {
    project: { ...project, texts: mapReferences(project.texts, (_id, reference) => withPath(reference, fileNameOf(reference.path))),
      files: mapReferences(project.files, (_id, reference) => withPath(reference, fileNameOf(reference.path))) } as Record<string, unknown>,
    photos: mapReferences(photos, (_id, photo) => withPath(photo, fileNameOf(photo.path))) as Record<string, unknown>,
  };
}

/**
 * Where a linked source that arrived from another Mac points until it is located here: an absolute path that does not
 * exist and is never approved, keeping the original's file name so Assets shows it and Locate Folder… can match it.
 */
export const unlocatedRoot = '/imageflow-unlocated/';
export const unlocatedPath = (name: string) => unlocatedRoot + (fileNameOf(name).replace(/[\x00-\x1f]/g, '-') || 'original');
export const isUnlocatedPath = (path: string) => path.startsWith(unlocatedRoot);

/**
 * The manifests a pull writes: the snapshot's, except that every source still linked here keeps this Mac's own path
 * (ADR 0010: machine-local paths are never overwritten across Macs), and one newly linked elsewhere gets an unlocated
 * placeholder path. Returned as plain data; the caller validates it with the manifest schemas.
 */
export function projectManifests(snapshot: Pick<StateBlob, 'project' | 'photos'>, local: { project?: Project; photos?: PhotoIndex }) {
  const localPath = (references: Record<string, unknown> | undefined, id: string) => {
    const reference = references?.[id];
    return linkedReference(reference) ? reference.path : undefined;
  };
  const project = snapshot.project as Record<string, unknown> & { texts?: Record<string, unknown>; files?: Record<string, unknown> };
  return {
    project: { ...project,
      texts: mapReferences(project.texts ?? {}, (id, reference) => withPath(reference, localPath(local.project?.texts, id) ?? unlocatedPath(reference.path))),
      files: mapReferences(project.files ?? {}, (id, reference) => withPath(reference, localPath(local.project?.files, id) ?? unlocatedPath(reference.path))) },
    photos: mapReferences(snapshot.photos, (id, photo) => withPath(photo, localPath(local.photos, id) ?? unlocatedPath(photo.path))),
  };
}

/** Whether a state blob holds exactly the book state its header names. */
export async function stateMatchesHeader(blob: StateBlob, header: Pick<CommitHeader, 'bookStateRevision'>, schemas: {
  project: z.ZodType<Project>; photos: z.ZodType<PhotoIndex>;
}) {
  const project = schemas.project.safeParse(blob.project);
  const photos = schemas.photos.safeParse(blob.photos);
  if (!project.success || !photos.success) return false;
  return await computeBookStateRevision({ project: project.data, photos: photos.data, contentDigests: blob.content }) === header.bookStateRevision;
}

/** The tips of a book's commits: those no other commit names as a parent. Sorted oldest first, then by ID. */
export function deriveTips(headers: readonly CommitHeader[]) {
  const parents = new Set(headers.flatMap((header) => header.parents));
  const unique = new Map(headers.map((header) => [header.commitId, header]));
  return [...unique.values()].filter((header) => !parents.has(header.commitId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commitId.localeCompare(b.commitId));
}

/**
 * What this Mac last synced of a book: the commit, its revision and the photo digests of its assets-meta.json, and
 * `localDigests`, the digests of the originals this Mac held then. An original whose bytes have not changed since is
 * no evidence against the snapshot, however old it is.
 */
export type SyncedCommit = { commitId: string; bookStateRevision: string; stateDigest: string; photoDigests: Record<string, string>;
  localDigests?: Record<string, string> };

export type SyncDecision =
  | { action: 'resume' }
  | { action: 'remote-behind' }
  | { action: 'initial-push' }
  | { action: 'adopt'; tip: CommitHeader }
  | { action: 'push'; tip: CommitHeader }
  | { action: 'in-sync'; tip: CommitHeader }
  | { action: 'fast-forward'; tip: CommitHeader; thenPush: boolean }
  | { action: 'diverged'; tips: CommitHeader[] };

/**
 * The photos whose original here changed since the last sync (ADR 0010, per-asset rule): their local fact is a newer
 * verified observation and wins over the snapshot's. An original still at the digest it had when this Mac last synced
 * is merely stale (another Mac re-exported or replaced the photo) and loses. `here` holds the digests of the originals
 * readable on this Mac; without a sync record every one of them counts as changed.
 */
export function changedOriginals(here: Record<string, string>, synced?: Pick<SyncedCommit, 'photoDigests' | 'localDigests'>) {
  return new Set(Object.entries(here).filter(([id, digest]) => {
    const baseline = synced?.localDigests?.[id] ?? synced?.photoDigests[id];
    return baseline === undefined || digest !== baseline;
  }).map(([id]) => id));
}

/** Whether this Mac knows a photo fact the last synced snapshot lacks, which a push has to carry: an in-place re-export. */
export function factsAhead(here: Record<string, string>, synced: Pick<SyncedCommit, 'photoDigests' | 'localDigests'>) {
  return [...changedOriginals(here, synced)].some((id) => here[id] !== synced.photoDigests[id]);
}

/**
 * The Milestone 1 decision table (ADR 0010): fast-forward or keep both. `factsChanged` says whether this Mac verified a photo fact
 * the last synced snapshot lacks (`factsAhead`); facts never make a book diverge.
 */
export function decideSync({ pullInProgress, tips, commits = tips, lastSynced, localRevision, factsChanged }: {
  pullInProgress: boolean; tips: readonly CommitHeader[]; lastSynced?: Pick<SyncedCommit, 'commitId' | 'bookStateRevision'>;
  /** Every commit the remote lists; the tips by default. */
  commits?: readonly Pick<CommitHeader, 'commitId'>[];
  localRevision: string; factsChanged: boolean;
}): SyncDecision {
  if (pullInProgress) return { action: 'resume' };
  // The commit this Mac last synced is not there (yet): a folder still downloading, or the wrong one. Pushing now would
  // start a second history that shows as diverged once the real commits arrive.
  if (lastSynced && !commits.some(({ commitId }) => commitId === lastSynced.commitId)) return { action: 'remote-behind' };
  if (!tips.length) return { action: 'initial-push' };
  if (tips.length > 1) return { action: 'diverged', tips: [...tips] };
  const [tip] = tips;
  if (!lastSynced) return localRevision === tip.bookStateRevision ? { action: 'adopt', tip } : { action: 'diverged', tips: [tip] };
  const edited = localRevision !== lastSynced.bookStateRevision;
  if (tip.commitId === lastSynced.commitId) return edited || factsChanged ? { action: 'push', tip } : { action: 'in-sync', tip };
  // The remote moved on. Nothing was edited here: take it, and push back facts this Mac knows better.
  if (!edited) return { action: 'fast-forward', tip, thenPush: factsChanged };
  // Edited here too, unless this Mac's edit is exactly what the remote now holds.
  return localRevision === tip.bookStateRevision ? { action: 'adopt', tip } : { action: 'diverged', tips: [tip] };
}
