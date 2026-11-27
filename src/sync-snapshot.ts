import { z } from 'zod';
import { assetsMetaSchema } from './asset-facts';
import { canonicalJson } from './canonical-json';
import { computeBookStateRevision } from './book-revision';
import type { PhotoIndex, Project } from './project';
import { adoptedEntry, fileNameOf, sharedEntry, unlocatedPath } from './source-locator';
import type { LocatorFields } from './source-locator';

/**
 * Immutable sync snapshots (ADR 0010, Milestone 1). A sync remote keeps two kinds of immutable record per book, all
 * under the book's own prefix (ADR 0012, section 4):
 *
 * - a **commit header** (`books/<bookId>/snapshots/<commitId>.json`): a few hundred bytes naming its parents, the
 *   portable book-state revision and the digest of its state blob, so deriving the tips never parses whole books;
 * - a **state blob** (`books/<bookId>/content/<stateDigest>`): the full small book state, with machine-local linked
 *   paths reduced to their file names, the derived `assets-meta.json`, and digest maps of the content, owned originals
 *   and screen proxies it refers to, which are blobs of their own under the same prefix.
 *
 * Beside them a remote holds its identity (`remote.json`) and, for a book deleted from sync, a tombstone
 * (`books/<bookId>/deleted.json`).
 *
 * Pure and host-agnostic: no Node, Electron or filesystem APIs, so a web companion reads the same records.
 */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const uuidSource = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const uuidPattern = new RegExp('^' + uuidSource + '$');
const requireId = (id: string, what: string) => { if (typeof id !== 'string' || !uuidPattern.test(id)) throw new Error('Not a sync ' + what + ' ID: ' + id); return id; };
// `.jpg`, `.png`, `.webp`…: lower case, with the dot, as `extname` gives it.
const extension = z.string().regex(/^\.[a-z0-9]{1,10}$/);

// Version 2 came with the per-book layout (ADR 0012): a build that reads version 1 refuses it (`NewerSyncFormatError`)
// instead of looking for the book's blobs where they no longer are.
export const commitHeaderVersion = 2;
export const commitHeaderSchema = z.object({
  version: z.literal(commitHeaderVersion),
  commitId: uuid,
  bookId: uuid,
  // `[]` for the first commit, `[previous]` for an ordinary push, every superseded tip when a fork is closed.
  parents: z.array(uuid).max(16),
  bookStateRevision: sha256,
  createdAt: z.iso.datetime(),
  title: z.string().max(400),
  stateDigest: sha256,
  // The book's 320 px JPEG cover, `books/<bookId>/covers/<coverDigest>.jpg`, so a book that is only on the remote has a
  // thumbnail in the library (#283). A push without a cover of its own carries its parent's forward.
  coverDigest: sha256.optional(),
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
const newer = (value: unknown, schema: z.ZodObject, current = 1) => {
  if (!value || typeof value !== 'object') return false;
  const version = (value as { version?: unknown }).version;
  if (typeof version === 'number' && version > current) return true;
  // Every field this version needs, and more: written by a newer version.
  return version === current && schema.loose().safeParse(value).success;
};
/** A commit header as a remote stored it: the header, or undefined for one that is incomplete or not a header. */
export function readCommitHeader(value: unknown): CommitHeader | undefined {
  const parsed = commitHeaderSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (newer(value, commitHeaderSchema, commitHeaderVersion)) throw new NewerSyncFormatError();
  return undefined;
}

/**
 * A remote's identity (`remote.json` at its root, ADR 0012): a UUID written at first use, which a book's sync record
 * names, so a book that meets another remote is asked about instead of forking silently.
 */
export const remoteIdentitySchema = z.object({ version: z.literal(1), remoteId: uuid }).strict();
export type RemoteIdentity = z.infer<typeof remoteIdentitySchema>;
/**
 * The tombstone of a book deleted from sync (`books/<bookId>/deleted.json`): the one object left under its prefix, so a
 * Mac that still has the book asks instead of pushing it back.
 */
export const bookTombstoneSchema = z.object({ version: z.literal(1), bookId: uuid, deletedAt: z.iso.datetime() }).strict();
export type BookTombstone = z.infer<typeof bookTombstoneSchema>;

const reader = <T>(schema: z.ZodObject & z.ZodType<T>) => (value: unknown): T | undefined => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (newer(value, schema)) throw new NewerSyncFormatError();
  return undefined;
};
/** `remote.json` as stored: the identity, or undefined for one that is missing or incomplete. Throws for a newer one. */
export const readRemoteIdentity = reader<RemoteIdentity>(remoteIdentitySchema);
/** `deleted.json` as stored: the tombstone, or undefined for one that is missing or incomplete. Throws for a newer one. */
export const readBookTombstone = reader<BookTombstone>(bookTombstoneSchema);

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
  // Owned originals (photos/ entries that are not linked), by source ID: `books/<bookId>/originals/<digest><ext>`.
  originals: z.record(z.string(), z.object({ digest: sha256, ext: extension }).strict()),
  // When a commit first named each owned original's version and from which Mac (#283), carried forward while the version
  // stays: a commit names its originals before they upload (ADR 0012), so one that never arrives can be reported as never
  // uploaded from that Mac. A field of its own, so a build that does not know it reads the blob as one a newer version
  // wrote (`NewerSyncFormatError`, "Update ImageFlow") rather than as damaged.
  named: z.record(z.string(), z.object({ digest: sha256, at: z.iso.datetime(), by: z.string().max(100).optional() }).strict()).optional(),
  // Screen proxies by the original's digest: `books/<bookId>/proxies/<originalDigest>-preview-v1<ext>`, with the proxy's own SHA-256.
  proxies: z.record(sha256, z.object({ sha256, ext: z.enum(['.jpg', '.png']) }).strict()),
}).strict();
export type StateBlob = z.infer<typeof stateBlobSchema>;
/** Whether a complete state blob that this version cannot read was written by a newer version. */
export const newerStateBlob = (value: unknown) => newer(value, stateBlobSchema);

/**
 * The keys of a remote (ADR 0012, section 4). Everything a book needs lives under its own prefix, so deleting a book
 * deletes one prefix, its size is one listing, and credentials or a share link can be scoped to it.
 */
export const remoteIdentityKey = 'remote.json';
export const booksPrefix = 'books/';
export const bookPrefix = (bookId: string) => booksPrefix + requireId(bookId, 'book') + '/';
export const snapshotsPrefix = (bookId: string) => bookPrefix(bookId) + 'snapshots/';
export const commitKey = (bookId: string, commitId: string) => snapshotsPrefix(bookId) + requireId(commitId, 'commit') + '.json';
export const tombstoneKey = (bookId: string) => bookPrefix(bookId) + 'deleted.json';
/**
 * Beside each tombstone, a marker at the remote's root (`deleted/<bookId>.json`, the same record), so the books deleted
 * from sync are found with one listing of `deleted/` instead of a read per book (#283): a bucket cannot list the
 * `deleted.json` keys under every book without listing every object, and the iCloud store keeps both in its `index`
 * zone. The tombstone under the book's prefix stays the record a sync reads; the marker only says where to look.
 */
export const deletedPrefix = 'deleted/';
export const deletedMarkerKey = (bookId: string) => deletedPrefix + requireId(bookId, 'book') + '.json';
/** The book a key from a listing of `deletedPrefix` marks as deleted, or undefined for anything else found there. */
export const bookIdOfDeletedMarker = (key: string) => {
  const id = key.startsWith(deletedPrefix) && key.endsWith('.json') ? key.slice(deletedPrefix.length, -'.json'.length) : '';
  return uuidPattern.test(id) ? id : undefined;
};
/** The book a prefix from a listing of `booksPrefix` belongs to, or undefined for anything else found there. */
export const bookIdOfPrefix = (prefix: string) => {
  const id = prefix.startsWith(booksPrefix) && prefix.endsWith('/') ? prefix.slice(booksPrefix.length, -1) : '';
  return uuidPattern.test(id) ? id : undefined;
};
/** Keys of the immutable blobs a book stores. */
export const contentBlobKey = (bookId: string, digest: string) => bookPrefix(bookId) + 'content/' + sha256.parse(digest);
export const originalBlobKey = (bookId: string, digest: string, ext: string) => bookPrefix(bookId) + 'originals/' + sha256.parse(digest) + extension.parse(ext);
export const proxyBlobKey = (bookId: string, originalDigest: string, ext: string) =>
  bookPrefix(bookId) + 'proxies/' + sha256.parse(originalDigest) + '-preview-v1' + z.enum(['.jpg', '.png']).parse(ext);
export const coverBlobKey = (bookId: string, digest: string) => bookPrefix(bookId) + 'covers/' + sha256.parse(digest) + '.jpg';
export const blobKeyPattern = new RegExp('^books/' + uuidSource +
  '/(?:content/[a-f0-9]{64}|originals/[a-f0-9]{64}\\.[a-z0-9]{1,10}|proxies/[a-f0-9]{64}-preview-v1\\.(?:jpg|png)|covers/[a-f0-9]{64}\\.jpg)$');

/** The bytes of a state blob as stored and hashed. */
export const encodeStateBlob = (blob: StateBlob) => new TextEncoder().encode(canonicalJson(stateBlobSchema.parse(blob)));

// The file name of a path and the unlocated placeholder live with the locators that use them.
export { fileNameOf, isUnlocatedPath, unlocatedPath, unlocatedRoot } from './source-locator';

// Linked references keep their file name only, so one Mac's folder layout never reaches another.
const linkedReference = (reference: unknown): reference is { path: string; linked: true } =>
  !!reference && typeof reference === 'object' && (reference as { linked?: unknown }).linked === true && typeof (reference as { path?: unknown }).path === 'string';
// A snapshot is not validated when it is projected: only what has an entry's shape is read as one.
const isEntry = (value: unknown): value is LocatorFields => !!value && typeof value === 'object' && !Array.isArray(value);
const withPath = <T extends object>(reference: T, path: string) => ({ ...reference, path });
const mapReferences = (references: Record<string, unknown>, map: (id: string, reference: { path: string; linked: true }) => unknown) =>
  Object.fromEntries(Object.entries(references).map(([id, reference]) => [id, linkedReference(reference) ? map(id, reference) : reference]));

/** project.json and photos.json as a state blob carries them: linked paths become their file names, nothing else changes. */
export function portableManifests(project: Project, photos: PhotoIndex) {
  return {
    project: { ...project, texts: mapReferences(project.texts, (_id, reference) => withPath(reference, fileNameOf(reference.path))),
      files: mapReferences(project.files, (_id, reference) => withPath(reference, fileNameOf(reference.path))) } as Record<string, unknown>,
    photos: Object.fromEntries(Object.entries(photos).map(([id, photo]) => [id, sharedEntry(photo)])) as Record<string, unknown>,
  };
}

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
    photos: Object.fromEntries(Object.entries(snapshot.photos).map(([id, photo]) => [id, isEntry(photo) ? adoptedEntry(photo, local.photos?.[id]) : photo])),
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
 * no evidence against the snapshot, however old it is. `bookId` is the book the commit belongs to, so its blobs are
 * found under that prefix whatever project.json says later; records from before it was kept lack it.
 */
export type SyncedCommit = { commitId: string; bookId?: string; bookStateRevision: string; stateDigest: string; photoDigests: Record<string, string>;
  localDigests?: Record<string, string>;
  /**
   * For photos without a file: a key of the content this Mac's own provider showed for the photo when this Mac last
   * synced while it could read it. A pull replaces such a photo's fact, so only this tells whether the photo changed
   * here since, or merely under this Mac.
   */
  localKeys?: Record<string, string>;
  /**
   * For photos without a file: the SHA-256 of the declared properties (`declaredProperties`, src/source-properties.ts:
   * stars, flags, colour labels, favourites; ADR 0014) this Mac's own provider showed for the photo, kept as `localKeys`
   * is. A pull replaces the photo's fact, marks included, so only this tells whether the marks changed here since, or
   * merely under this Mac. A photo without marks has the digest of the empty string (`noProperties`), so "no marks" and
   * "never recorded" stay apart.
   */
  localProps?: Record<string, string> };

/** The SHA-256 of the empty string: the `localProps` digest of a photo whose provider shows no marks for it. */
export const noProperties = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
export function changedOriginals(here: Record<string, string>, synced?: Pick<SyncedCommit, 'photoDigests' | 'localDigests' | 'localKeys'>, keys: Record<string, string> = {}) {
  return new Set(Object.entries(here).filter(([id, digest]) => {
    // A photo without a file (`keys`) changed here when its provider shows other content than at the last sync: its
    // fact differing from the snapshot's says nothing, since another Mac may see another version of it for good. One
    // this Mac reads for the first time is only new where the snapshot lacks it; what it shows then is where this Mac
    // starts counting from. Provider revisions have no order, so one case stays: a Mac whose view moved while it
    // could not sync (to a version the remote has passed by then) pushes that version, once.
    if (keys[id] !== undefined) {
      const seen = synced?.localKeys?.[id];
      return seen !== undefined ? keys[id] !== seen : synced?.photoDigests[id] === undefined;
    }
    const baseline = synced?.localDigests?.[id] ?? synced?.photoDigests[id];
    return baseline === undefined || digest !== baseline;
  }).map(([id]) => id));
}

/**
 * The photos without a file whose marks changed here since the last sync (ADR 0014): `props` holds the digest of the
 * declared properties of each photo whose provider answered in this sync run, and a photo is changed where that differs
 * from what this Mac's provider showed at the last sync (`localProps`). As for content, the snapshot's marks say
 * nothing here: another Mac may show other marks for good (an older copy of the catalog), and what it pulled is not
 * what it shows. A photo the record has no entry for (a book synced before marks were, or a photo read here for the
 * first time) counts as changed only where it has a mark here, so marks go up once and an unmarked photo stays quiet.
 */
export function changedProperties(props: Record<string, string>, synced?: Pick<SyncedCommit, 'localProps'>) {
  return new Set(Object.entries(props).filter(([id, digest]) => {
    const seen = synced?.localProps?.[id];
    return seen !== undefined ? digest !== seen : digest !== noProperties;
  }).map(([id]) => id));
}

type CaptureFact = { captured?: { dateTime: string; offset?: string | null }; verified: string; extra?: Record<string, unknown> };
const captureInstant = ({ dateTime, offset }: { dateTime: string; offset?: string | null }) => offset ? Date.parse(dateTime + offset) : NaN;
/**
 * Whether `here` knows the time zone of a photo's capture better than `there`, another copy of its fact (a snapshot's),
 * for the same moment (or the same camera time where `there` has no offset), with an offset `here` did not guess
 * (API-020): one `there` only guessed or lacks, whenever either was observed, and the same offset too, which confirms
 * the guess; and another offset `there` holds as its own where `here` was observed later. The offset of a photo is
 * corrected without any other change, and a Mac that cannot read the photo never corrects it: such a correction would
 * otherwise never go up, and a pull would put the old offset back (27 Nov).
 */
export function capturedAhead(here: CaptureFact | undefined, there: CaptureFact | undefined) {
  const [mine, theirs] = [here?.captured, there?.captured];
  if (!here || !there || !mine?.offset || !theirs || here.extra?.offsetGuessed === true) return false;
  const sameMoment = theirs.offset ? captureInstant(mine) === captureInstant(theirs) : mine.dateTime === theirs.dateTime;
  if (!sameMoment) return false;
  const guessed = there.extra?.offsetGuessed === true;
  if (mine.offset === theirs.offset) return guessed;
  return guessed || !theirs.offset || here.verified > there.verified;
}
/**
 * `there` with the capture time of `here` where that is ahead (`capturedAhead`), and otherwise as it is. It then takes
 * the time `here` was observed too, so the copy it goes to next sees it as the newer one, and loses the mark of a
 * guessed offset: a mark left on a real offset would let the next guess replace it (`ownOffsetKept`).
 */
export function withCaptureOf<F extends CaptureFact>(there: F, here: CaptureFact | undefined): F {
  if (!here?.captured || !capturedAhead(here, there)) return there;
  const { extra: kept, ...rest } = there;
  const { offsetGuessed: _guessed, ...extra } = kept ?? {};
  return { ...rest, captured: here.captured, verified: here.verified, ...(Object.keys(extra).length ? { extra } : {}) } as F;
}

/**
 * Whether this Mac knows a photo fact the last synced snapshot lacks, which a push has to carry: an in-place re-export,
 * or marks changed here (`changedProperties`), which change no content and so no digest.
 */
export function factsAhead(here: Record<string, string>, synced: Pick<SyncedCommit, 'photoDigests' | 'localDigests' | 'localKeys' | 'localProps'>, keys: Record<string, string> = {},
  props: Record<string, string> = {}) {
  return [...changedOriginals(here, synced, keys)].some((id) => here[id] !== synced.photoDigests[id]) || changedProperties(props, synced).size > 0;
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
  // start a second history that shows as diverged once the real commits arrive. A book last synced on the layout before
  // ADR 0012 stays here too (its version 1 headers are no commits to this version) until its sync record is reset.
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
