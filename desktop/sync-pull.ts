import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import type { AssetFact } from '../src/asset-facts';
import { parseDocument, photoIndexSchema, projectSchema, withBookFormat } from '../src/project';
import type { PhotoIndex, Project } from '../src/project';
import { pullChanges, pullLabel } from '../src/pull-summary';
import { entryReach, packagePath } from '../src/source-locator';
import { originalBlobKey, projectManifests, stateBlobSchema, withCaptureOf } from '../src/sync-snapshot';
import type { StateBlob } from '../src/sync-snapshot';
import { AssetFacts, readAssetFacts } from './asset-facts';
import { bookStateFolder, persistProjectManifests } from './persistence';
import { captureBookStateRevision, ignoredName } from './revisions';

/**
 * The local half of a sync pull (ADR 0010, Milestone 1): this Mac's sync record of a book, and projecting a snapshot
 * whose blobs were already downloaded and verified into the book's working tree.
 *
 * A pull first stages every blob it needs in App Support (`<state>/sync/staged/<sha256>`), then records a
 * `pull` marker and only then touches the book. A crash after that point leaves the marker and the staged blobs, so
 * the next open finishes the pull from them (`resumeSyncPull`, like interrupted-save recovery) without the remote,
 * before the editor can edit a half-pulled book.
 */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
// `localProps` (ADR 0014) is never written into sync.json: see `marksFile`.
const syncedSchema = z.object({ commitId: z.uuid(), bookId: z.uuid().optional(), bookStateRevision: sha256, stateDigest: sha256, photoDigests: z.record(z.string(), sha256),
  localDigests: z.record(z.string(), sha256).optional(), localKeys: z.record(z.string(), sha256).optional(), localProps: z.record(z.string(), sha256).optional() }).strict();
const syncStateSchema = z.object({
  version: z.literal(1),
  // Where a book syncs is no longer its own (ADR 0012): the Mac has one backend (`AppSettings.sync`). A record keeps
  // only the identity of the remote it last synced with, which `lastSynced` belongs to, and whether it syncs on this
  // Mac: `enabled: false` after Stop Syncing or declining to start again on another remote.
  remoteId: z.uuid().optional(),
  enabled: z.boolean().optional(),
  lastSynced: syncedSchema.optional(),
  // The set-up of sync (`AppSettings.syncSetup`) this book was made under: it starts syncing by itself while that set-up
  // lasts (#307). Its first sync replaces it with `remoteId`; another set-up does not know it, and starts nothing.
  startWith: z.uuid().optional(),
  // The book this one is a copy of (Duplicate, Save a Copy; #285), on the remote `remoteId`, with the originals that
  // book's last synced snapshot named, by photo: the copy's first push names them for photos without a file here, and
  // its background upload copies each inside the store from the source book instead of uploading it
  // (`recordCopySource`, `pendingUploads`). Used only while the copy syncs with that same remote.
  copiedFrom: z.object({ bookId: z.uuid(), remoteId: z.uuid(),
    originals: z.record(z.string(), z.object({ digest: sha256, ext: z.string().regex(/^\.[a-z0-9]{1,10}$/) }).strict()) }).strict().optional(),
  // A pull that started touching the book. `staleOriginals` are owned originals here that the snapshot replaced and
  // that go (by path, with their stale digest), so the photo shows its new proxy until its new original is downloaded.
  // `keepLocal` are the photos whose original here changed since the last sync, so their local fact wins;
  // `localDigests` the originals' digests after the pull, `localKeys` what this Mac's providers showed of photos
  // without a file (`SyncedCommit.localKeys`), and `localProps` of their marks (`SyncedCommit.localProps`, kept in
  // `marksFile`). `conflictCopy` is the copy Keep Both made before it.
  // Owned originals never pass through a pull: they are downloaded after it, beside their target (`downloadOriginals`).
  pull: z.object({
    targetCommit: z.uuid(), previousCommit: z.uuid().optional(), stateDigest: sha256, bookStateRevision: sha256,
    templateChanged: z.boolean(), staleOriginals: z.record(z.string(), sha256).default({}), keepLocal: z.array(z.string()).default([]),
    localDigests: z.record(z.string(), sha256).default({}), localKeys: z.record(z.string(), sha256).default({}), localProps: z.record(z.string(), sha256).default({}),
    conflictCopy: z.string().max(4096).optional(),
  }).strict().optional(),
  // A marked pull that could not be finished and was given up (`abandonPull`): what it pulled, why it failed, the
  // revision the half-pulled book had then (absent when it did not load), the copy Keep Both made before it, and
  // whether it failed when the book opened, which the editor then tells the user about once.
  abandoned: z.object({
    targetCommit: z.uuid(), error: z.string().max(2000), at: z.iso.datetime(), bookStateRevision: sha256.optional(),
    conflictCopy: z.string().max(4096).optional(), atOpen: z.literal(true).optional(),
  }).strict().optional(),
}).strict();
export type SyncState = z.infer<typeof syncStateSchema>;
/**
 * A record as written before ADR 0012 named the folder a book synced through (#251). It is read without it: the book
 * then does not sync until it starts again on the configured remote, and a `lastSynced` it kept counts as synced
 * somewhere else (`bookSync`). A record from before only trusted books synced (#282) may hold `networkReview`, which
 * asked about sites a pulled template added even in a trusted book; it is read without it, and such a book now takes
 * the path of every trusted book: the sites are allowed and named in a notice.
 */
const storedSyncStateSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (!('folder' in value) && !('networkReview' in value))) return value;
  const { folder: _, networkReview: __, ...rest } = value as Record<string, unknown>;
  return rest;
}, syncStateSchema);

/**
 * How a book stands with the remote this Mac syncs through (ADR 0012): it syncs there (`syncing`); it was stopped on
 * this Mac (`stopped`); it last synced with another remote, or with a sync folder before ADR 0012, and asks before it
 * starts a new history here (`elsewhere`); or it never synced here (`off`).
 */
export type BookSync = 'syncing' | 'stopped' | 'elsewhere' | 'off';
export function bookSync(state: SyncState, remoteId: string): BookSync {
  if (state.enabled === false) return 'stopped';
  if (state.remoteId === remoteId) return 'syncing';
  return syncedElsewhere(state, remoteId) ? 'elsewhere' : 'off';
}
/**
 * Whether the record holds a sync with another remote than `remoteId`, so starting there is a new history: what it
 * last synced, or a pull it gave up there (which forgot `lastSynced`, and may have left the book half-done).
 */
export const syncedElsewhere = (state: SyncState, remoteId: string) => (!!state.lastSynced || !!state.pull || !!state.abandoned) && state.remoteId !== remoteId;
/**
 * Whether the record says the book starts by itself under the set-up of sync `setup`: it was made under it, and never
 * synced here or anywhere else. Only a trusted book does (`SyncService.startsOnOpen`).
 */
export const startsWithSetup = (state: SyncState, setup: string | undefined) =>
  !!state.startWith && state.startWith === setup && state.enabled !== false && !state.lastSynced && !state.pull && !state.abandoned;
export type PullMarker = NonNullable<SyncState['pull']>;

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function syncFolder(folder: string, create: boolean) {
  const state = await bookStateFolder(folder, create);
  if (!state) return undefined;
  const path = join(state, 'sync');
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path).catch(() => undefined);
  if (!info) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(path + ' must be a real directory.');
  return path;
}

/** The folder a pull stages its verified blobs in, emptied first when `fresh`. */
export async function stagingFolder(folder: string, fresh = false) {
  const path = join((await syncFolder(folder, true))!, 'staged');
  if (fresh) await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * Where the marks' digests (`localProps` of `lastSynced` and of the pull marker, ADR 0014) are kept: a file beside
 * sync.json, not in it. A build from before them reads sync.json strictly, and fails on any key it does not know with
 * "This book's sync record is invalid" (`readSyncState`), which `resumeSyncPull` raises from `loadProject`: that build
 * could neither sync the book nor even open it. It never reads this file. The file names the exact sync.json it belongs
 * to by its SHA-256 (`record`), so after any write of sync.json without it (by such a build, or a crash between the two
 * writes) it is ignored, and the record reads as one from before marks were synced: a photo with marks then pushes them
 * once (`changedProperties`), and nothing else changes.
 */
const marksFile = 'sync-marks.json';
const marksSchema = z.object({ version: z.literal(1), record: sha256,
  lastSynced: z.record(z.string(), sha256).optional(), pull: z.record(z.string(), sha256).optional() }).strict();

/** The marks' digests of the record whose sync.json is `text`, or undefined where none belong to it. */
async function readMarks(path: string, text: string) {
  try {
    const parsed = marksSchema.safeParse(JSON.parse(await readFile(join(path, marksFile), 'utf8')));
    return parsed.success && parsed.data.record === digest(Buffer.from(text, 'utf8')) ? parsed.data : undefined;
  } catch { return undefined; }
}

/**
 * Why a sync record does not read. A later `version`, or fields this build does not know, mean a newer ImageFlow wrote
 * it: on 27 Nov an old build that macOS opened instead of the current one told the user to remove a sound record.
 * Updating opens the book again; removing the record is only for one that is damaged.
 */
export function unreadableSyncRecord(path: string, issues: readonly { code: string }[], value?: unknown) {
  const version = value && typeof value === 'object' ? (value as { version?: unknown }).version : undefined;
  const newer = typeof version === 'number' && version > 1;
  if (newer || (issues.length && issues.every(({ code }) => code === 'unrecognized_keys'))) {
    return new Error('This book was synced by a newer version of ImageFlow than this one. Update ImageFlow to open it. If an older copy of ImageFlow opened instead of the current one, quit it and open the current one.');
  }
  return new Error('This book’s sync record is damaged. Keep a copy of ' + path + ', then remove it to sync the book again from scratch.');
}

export async function readSyncState(folder: string): Promise<SyncState> {
  const path = await syncFolder(folder, false);
  if (!path) return { version: 1 };
  let text: string;
  try { text = await readFile(join(path, 'sync.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }; throw error; }
  const value: unknown = JSON.parse(text);
  const parsed = storedSyncStateSchema.safeParse(value);
  if (!parsed.success) throw unreadableSyncRecord(join(path, 'sync.json'), parsed.error.issues, value);
  const state = parsed.data;
  const marks = (state.lastSynced || state.pull) && await readMarks(path, text);
  if (!marks) return state;
  return { ...state, ...(state.lastSynced && marks.lastSynced ? { lastSynced: { ...state.lastSynced, localProps: marks.lastSynced } } : {}),
    ...(state.pull && marks.pull ? { pull: { ...state.pull, localProps: marks.pull } } : {}) };
}

/** Writes a file of the sync folder in one piece, through a staging file beside it. */
async function writeAtomically(path: string, name: string, bytes: string) {
  const staging = join(path, 'sync-' + randomUUID() + '.tmp');
  try {
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(staging, join(path, name));
  } finally { await rm(staging, { force: true }); }
}

async function writeSyncState(folder: string, state: SyncState) {
  const path = (await syncFolder(folder, true))!;
  const parsed = syncStateSchema.parse(state);
  // sync.json stays as a build before the marks wrote it; their digests go to `marksFile`, after it.
  const { localProps: synced, ...lastSynced } = parsed.lastSynced ?? {} as Partial<NonNullable<SyncState['lastSynced']>>;
  const { localProps: pulling, ...pull } = parsed.pull ?? {} as Partial<PullMarker>;
  const bytes = JSON.stringify({ ...parsed, ...(parsed.lastSynced ? { lastSynced } : {}), ...(parsed.pull ? { pull } : {}) }) + '\n';
  await writeAtomically(path, 'sync.json', bytes);
  const marks = { ...(parsed.lastSynced && synced && Object.keys(synced).length ? { lastSynced: synced } : {}), ...(parsed.pull && pulling && Object.keys(pulling).length ? { pull: pulling } : {}) };
  if (Object.keys(marks).length) await writeAtomically(path, marksFile, JSON.stringify(marksSchema.parse({ version: 1, record: digest(Buffer.from(bytes, 'utf8')), ...marks })) + '\n');
  else await rm(join(path, marksFile), { force: true });
}

// Every change to a book's sync record is a read-modify-write; one at a time per book, so a status refresh, a link or
// a notice taken while a sync runs never writes back a record older than the engine's (and drops its pull marker).
const syncStateWrites = new Map<string, Promise<unknown>>();

/** Changes a book's sync record, serialized with every other change of it. A change that returns `state` writes nothing. */
export async function updateSyncState(folder: string, change: (state: SyncState) => SyncState) {
  const key = await realpath(folder).catch(() => folder);
  const previous = syncStateWrites.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const state = await readSyncState(folder);
    const next = change(state);
    if (next !== state) await writeSyncState(folder, next);
  });
  syncStateWrites.set(key, task);
  try { await task; } finally { if (syncStateWrites.get(key) === task) syncStateWrites.delete(key); }
}

let currentSetup: () => string | undefined = () => undefined;
/** The set-up of sync on this Mac now (`AppSettings.syncSetup`), undefined with sync off: what a new book starts with. */
export function configureSyncSetup(setup: () => string | undefined) { currentSetup = setup; }
/** Notes that a book was made here under the set-up of sync there is now, so it starts syncing by itself (New Book). */
export async function startNewBook(folder: string) {
  const setup = currentSetup();
  if (setup) await updateSyncState(folder, (state) => ({ ...state, startWith: setup }));
}
/**
 * Whether a copy of a book syncs is what the book it was made from does (#307): a copy of one that syncs here starts
 * with the same remote, one of a book that does not is left for the user to turn on. A book moved to another volume
 * (`moved`) is the same book, and keeps its answer either way.
 */
export async function carrySyncChoice(source: string, copy: string, { moved = false }: { moved?: boolean } = {}) {
  try {
    const { remoteId, enabled, startWith } = await readSyncState(source);
    if (!moved && (!currentSetup() || enabled === false)) return;
    if (!remoteId && !startWith && enabled === undefined) return;
    await updateSyncState(copy, (state) => ({ ...state, ...(remoteId ? { remoteId } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(startWith ? { startWith } : {}) }));
  } catch (error) { console.warn('ImageFlow could not note whether a copied book syncs', error); }
}

/** Where a copy's originals are on the remote it syncs with: the hint `recordCopySource` left, while the copy syncs there. */
export const copySource = (state: SyncState) => (state.copiedFrom && state.copiedFrom.remoteId === state.remoteId ? state.copiedFrom : undefined);

/**
 * Duplicate and Save a Copy make a new `bookId`, so the copy's originals have keys of their own on the remote (ADR 0012,
 * section 4). When the book copied is synced, the copy's sync record notes it (`copiedFrom`): the book, its remote, and
 * the owned originals its last synced snapshot named, as this Mac knows them without asking the remote (the digests the
 * sync record holds for photos whose original syncs, with the extension of their file). That holds also when the copy is
 * made offline or on a Mac that keeps only previews. Best effort: a copy without the hint uploads its originals.
 */
export async function recordCopySource(source: string, copy: string) {
  try {
    const state = await readSyncState(source);
    const synced = state.lastSynced;
    if (!synced || !state.remoteId || state.enabled === false) return;
    const project = JSON.parse(await readFile(join(source, 'project.json'), 'utf8')) as { bookId?: unknown };
    const bookId = synced.bookId ?? (typeof project.bookId === 'string' ? project.bookId : undefined);
    if (!bookId) return;
    const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(source, 'photos.json'), 'utf8')));
    const originals: NonNullable<SyncState['copiedFrom']>['originals'] = {};
    for (const [id, photo] of Object.entries(photos)) {
      const path = entryReach(photo) === 'book' ? packagePath(photo) : undefined;
      const digest = synced.photoDigests[id];
      if (!path?.startsWith('photos/') || !digest) continue;
      const ext = extname(path).toLowerCase();
      // Only what makes a key of the layout.
      try { originalBlobKey(bookId, digest, ext); } catch { continue; }
      originals[id] = { digest, ext };
    }
    if (!Object.keys(originals).length) return;
    const remoteId = state.remoteId;
    await updateSyncState(copy, (current) => ({ ...current, copiedFrom: { bookId, remoteId, originals } }));
  } catch (error) { console.warn('ImageFlow could not note which book a copy was made from', error); }
}

/** A book that last synced with another remote starts on this one only as a new history, which the user is asked about. */
export class SyncElsewhereError extends Error {
  readonly code = 'SYNC_ELSEWHERE';
  constructor() {
    super('This book last synced somewhere else. Start syncing it here as a new history first.');
    this.name = 'SyncElsewhereError';
  }
}

/**
 * The last sync of a book could not be finished, so it may be only partly updated. On the remote it last synced with,
 * the next sync pulls again and keeps this Mac's version as a copy if it was edited since (`keepBoth`); a new history
 * on another remote would start from it, so it does not start until that sync was finished.
 */
export class SyncHalfPulledError extends Error {
  readonly code = 'SYNC_HALF_PULLED';
  constructor(detail: string) {
    super('The last sync of this book could not be finished (' + detail.replace(/\.$/, '') + '), so it may be only partly updated. ' +
      'Switch back to the sync it last used and sync it there first, or duplicate the book (File → Duplicate…) and sync the duplicate.');
    this.name = 'SyncHalfPulledError';
  }
}

/** Sync was turned off (Stop Syncing, a withdrawn trust, Delete from Sync) before a sync held the book; no failure. */
export class SyncStoppedError extends Error {
  constructor() { super('Syncing this book was stopped.'); this.name = 'SyncStoppedError'; }
}

/**
 * Makes a book sync on this Mac with the remote `remoteId`, again after Stop Syncing with the history it had. A book
 * that last synced with another remote (or a sync folder before ADR 0012) starts there only with `newHistory`, and
 * throws `SyncElsewhereError` otherwise. A new history forgets everything the record knows of the other remote:
 * `lastSynced`, and the trace of a pull given up there (`abandoned`), which says nothing about this remote. It never
 * starts from a book a pull may have left half-done: an interrupted pull is finished first, and one that cannot be
 * finished (it is given up, `finishPull`, as at every other place) or that was given up before throws
 * `SyncHalfPulledError` and starts nothing. Finishing a pull needs the writer lock.
 */
export async function startSyncing(folder: string, remoteId: string, { newHistory = false, unless }: { newHistory?: boolean;
  /** Asked with the record as it is written, so nothing that turned sync off meanwhile is undone: `SyncStoppedError`. */
  unless?: (state: SyncState) => boolean } = {}) {
  const before = await readSyncState(folder);
  if (syncedElsewhere(before, remoteId)) {
    if (!newHistory) throw new SyncElsewhereError();
    if (before.pull) {
      try { await finishPull(folder, before.pull); }
      catch (error) { throw new SyncHalfPulledError(error instanceof Error ? error.message : String(error)); }
    }
    const { abandoned } = await readSyncState(folder);
    if (abandoned) throw new SyncHalfPulledError(abandoned.error);
  }
  await updateSyncState(folder, (state) => {
    if (unless?.(state)) throw new SyncStoppedError();
    if (state.remoteId === remoteId && state.enabled === true && !state.startWith) return state;
    if (!syncedElsewhere(state, remoteId)) { const { startWith: _, ...started } = state; return { ...started, remoteId, enabled: true }; }
    if (!newHistory) throw new SyncElsewhereError();
    if (state.pull || state.abandoned) throw new SyncHalfPulledError(state.abandoned?.error ?? 'a sync started meanwhile');
    const { lastSynced: _, startWith: __, ...rest } = state;
    return { ...rest, remoteId, enabled: true };
  });
}

/**
 * Stops syncing a book on this Mac: no traffic with the remote for it until Start Syncing, neither syncs nor
 * downloads of originals. What it last synced stays, so starting again continues its history.
 */
export async function stopSyncing(folder: string) {
  await updateSyncState(folder, (state) => (state.enabled === false ? state : { ...state, enabled: false }));
}

/** Reads a staged blob and checks it still has its digest. */
export async function stagedBlob(folder: string, sha: string) {
  const bytes = await readFile(join(await stagingFolder(folder), sha256.parse(sha)));
  if (digest(bytes) !== sha) throw new Error('A staged sync blob is damaged. Sync again.');
  return bytes;
}

async function fileDigest(path: string) {
  const hash = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}
const digestOrUndefined = (path: string) => fileDigest(path).catch(() => undefined);

/**
 * A path inside one of the book's folders, refusing anything that leaves it through `..` or a link, and template
 * folders a book never carries (`node_modules`, `.git` and other ignored names, which a push never sends). Missing
 * folders on the way are created as real directories, unless only `checking`.
 */
export async function bookPath(root: string, path: string, { checking = false } = {}) {
  const parts = path.split('/');
  if (!['texts', 'files', 'template', 'photos'].includes(parts[0]) || parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')) ||
      (parts[0] === 'template' && parts.slice(1).some(ignoredName))) {
    throw new Error('A synced path must stay inside the book: ' + path);
  }
  let current = root;
  let missing = false;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = missing ? undefined : await lstat(current).catch(() => undefined);
    if (!info) { missing = true; if (!checking) await mkdir(current); }
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A synced file would go through a file or link here: ' + path);
  }
  const target = join(current, parts.at(-1)!);
  const info = await lstat(target).catch(() => undefined);
  if (info && !info.isFile()) throw new Error('A synced file would replace a folder or link: ' + path);
  return target;
}

/** Writes a file of the snapshot; whether it was not there as it is in the snapshot. */
async function place(root: string, path: string, sha: string, bytes: () => Promise<Uint8Array>) {
  const target = await bookPath(root, path);
  if (await digestOrUndefined(target) === sha) return false;
  const staging = join(dirname(target), '.imageflow-write-' + randomUUID() + '.tmp');
  try {
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(await bytes()); await handle.sync(); } finally { await handle.close(); }
    await rename(staging, target);
  } finally { await rm(staging, { force: true }); }
  return true;
}

/** Removes template files the snapshot does not have, and folders that end up empty. Ignored names stay. */
async function pruneTemplate(root: string, keep: Set<string>) {
  const removed: string[] = [];
  const walk = async (path: string): Promise<boolean> => {
    const absolute = join(root, path);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info) return true;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      if (keep.has(path)) return false;
      await rm(absolute, { force: true });
      removed.push(path);
      return true;
    }
    let empty = true;
    for (const name of await readdir(absolute)) {
      if (ignoredName(name)) { empty = false; continue; }
      if (!await walk(path + '/' + name)) empty = false;
    }
    if (empty && path !== 'template') { await rmdir(absolute).catch(() => {}); return true; }
    return false;
  };
  await walk('template');
  return removed;
}

/**
 * The per-asset rule for a pull (ADR 0010): the fact of a photo whose original changed here since the last sync wins
 * (`keepLocal`); otherwise the snapshot's, even over an original still here at an older digest, but with this Mac's
 * capture time where it knows the time zone better (`capturedAhead`). Facts of photos that left the book go.
 */
export function mergePulledFacts(photos: PhotoIndex, local: Record<string, AssetFact>, remote: Record<string, AssetFact>, keepLocal: ReadonlySet<string>) {
  const merged: Record<string, AssetFact> = {};
  for (const id of Object.keys(photos)) {
    const fact = local[id] && keepLocal.has(id) ? local[id] : remote[id] ? withCaptureOf(remote[id], local[id]) : local[id];
    if (fact) merged[id] = fact;
  }
  return merged;
}

const manifestJson = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

const manifests = async (root: string) => ({ 'project.json': await readFile(join(root, 'project.json')), 'photos.json': await readFile(join(root, 'photos.json')) });

/** The manifests a pull writes: the snapshot's, with this Mac's linked paths. Throws for ones that would not load. */
function projectedManifests(blob: StateBlob, before: Awaited<ReturnType<typeof manifests>>) {
  const parse = <T>(bytes: Buffer, schema: z.ZodType<T>) => { try { return schema.safeParse(JSON.parse(bytes.toString('utf8'))).data; } catch { return undefined; } };
  const local = { project: parse<Project>(before['project.json'], projectSchema), photos: parse<PhotoIndex>(before['photos.json'], photoIndexSchema) };
  const projected = projectManifests(blob, local);
  const photos = parseDocument(photoIndexSchema, projected.photos, 'photos.json');
  const project = withBookFormat(parseDocument(projectSchema, projected.project, 'project.json'), photos);
  return { project, photos, after: { 'project.json': Buffer.from(manifestJson(project)), 'photos.json': Buffer.from(manifestJson(photos)) } };
}

const readStaged = async (root: string, marker: PullMarker): Promise<StateBlob> =>
  stateBlobSchema.parse(JSON.parse(Buffer.from(await stagedBlob(root, marker.stateDigest)).toString('utf8')));

/**
 * Checks, before a pull is marked, everything that could make projecting it fail: the staged blobs are there and
 * whole, every file it writes or removes can be written there, and the manifests it writes are valid, like the ones
 * on disk the save journal starts from. A pull that passes changes the book only through ordinary writes.
 */
export async function preflightPull(folder: string, marker: PullMarker) {
  const root = await realpath(folder);
  const blob = await readStaged(root, marker);
  for (const [path, sha] of Object.entries(blob.content)) {
    await bookPath(root, path, { checking: true });
    await stagedBlob(root, sha);
  }
  for (const path of Object.keys(marker.staleOriginals)) await bookPath(root, path, { checking: true });
  const before = await manifests(root);
  parseDocument(projectSchema, JSON.parse(before['project.json'].toString('utf8')), 'project.json');
  parseDocument(photoIndexSchema, JSON.parse(before['photos.json'].toString('utf8')), 'photos.json');
  projectedManifests(blob, before);
}

/**
 * Gives up a pull that could not be projected, so the book stays openable: it keeps what was written so far, and
 * this Mac forgets what it last synced. The next sync then treats the book as this Mac's own version and keeps both
 * (a conflict copy beside the book, then a fresh pull), so nothing half-pulled is ever pushed and nothing is lost.
 *
 * It leaves a trace (`abandoned`) for the sync status and for Keep Both: while the book still has the revision it had
 * when the pull was given up, it holds nothing the remote or an earlier conflict copy lacks, so the next Keep Both
 * pulls again without another copy.
 */
export async function abandonPull(folder: string, marker: PullMarker, error: unknown, { atOpen = false } = {}) {
  const bookStateRevision = await captureBookStateRevision(folder).catch(() => undefined);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000) || 'The pull could not be finished.';
  await updateSyncState(folder, ({ pull: _, lastSynced: __, ...state }) => ({ ...state,
    abandoned: { targetCommit: marker.targetCommit, error: message, at: new Date().toISOString(), ...(bookStateRevision ? { bookStateRevision } : {}),
      ...(marker.conflictCopy ? { conflictCopy: marker.conflictCopy } : {}), ...(atOpen ? { atOpen: true as const } : {}) } }));
  await rm(await stagingFolder(folder), { recursive: true, force: true }).catch(() => {});
}

/** Projects a marked pull, giving it up when that fails. */
export async function finishPull(folder: string, marker: PullMarker, options: { atOpen?: boolean } = {}) {
  try { return await applyStagedPull(folder, marker); }
  catch (error) { await abandonPull(folder, marker, error, options).catch(() => {}); throw error; }
}

/**
 * Projects a staged snapshot into the book, under its writer lock: content, the template (removing what the snapshot
 * no longer has), stale owned originals removed, the manifests through the save journal, and the merged facts.
 * Checks the result against the snapshot's revision before it records the commit as synced and drops the marker.
 */
export async function applyStagedPull(folder: string, marker: PullMarker) {
  const root = await realpath(folder);
  const blob = await readStaged(root, marker);
  // For the history's entry. A pull finished after an interruption names only what it still wrote.
  const files: string[] = [];
  for (const [path, sha] of Object.entries(blob.content)) if (await place(root, path, sha, () => stagedBlob(root, sha))) files.push(path);
  files.push(...await pruneTemplate(root, new Set(Object.keys(blob.content).filter((path) => path.startsWith('template/')))));
  for (const [path, stale] of Object.entries(marker.staleOriginals)) {
    const target = await bookPath(root, path);
    if (await digestOrUndefined(target) === stale) await rm(target, { force: true });
  }
  const before = await manifests(root);
  const { project, photos, after } = projectedManifests(blob, before);
  // A pull that only replaced files is recorded too: the history then says that the template changed (API-015).
  if (files.length || !after['project.json'].equals(before['project.json']) || !after['photos.json'].equals(before['photos.json'])) {
    const pull = pullChanges(parseDocument(projectSchema, JSON.parse(before['project.json'].toString('utf8')), 'project.json'), project, files);
    await persistProjectManifests(root, before, after, { origin: 'app', label: pullLabel(pull), pull });
  }
  const facts = mergePulledFacts(photos, await readAssetFacts(root), blob.assetsMeta.assets, new Set(marker.keepLocal));
  await AssetFacts.adoptSynced(root, facts);
  const revision = await captureBookStateRevision(root);
  if (revision !== marker.bookStateRevision) {
    throw new Error('The pulled book does not match its snapshot. It is kept as pulled so far; the next sync keeps it as a separate copy and pulls again.');
  }
  const photoDigests = Object.fromEntries(Object.entries(blob.assetsMeta.assets).filter(([id]) => photos[id]).map(([id, fact]) => [id, fact.digest]));
  await updateSyncState(root, ({ abandoned: _, ...state }) => ({ ...state, pull: undefined,
    lastSynced: { commitId: marker.targetCommit, ...(project.bookId ? { bookId: project.bookId } : {}), bookStateRevision: marker.bookStateRevision, stateDigest: marker.stateDigest, photoDigests,
      localDigests: Object.fromEntries(Object.entries(marker.localDigests).filter(([id]) => photos[id])),
      localKeys: Object.fromEntries(Object.entries(marker.localKeys).filter(([id]) => photos[id])),
      localProps: Object.fromEntries(Object.entries(marker.localProps).filter(([id]) => photos[id])) } }));
  await rm(await stagingFolder(root), { recursive: true, force: true });
  return { blob, project, photos };
}

/**
 * Finishes a pull that was interrupted after it started changing the book, from the blobs it staged. Called when a
 * book opens, after interrupted-save recovery and before anything reads the manifests.
 */
export async function resumeSyncPull(folder: string, { readOnly = false }: { readOnly?: boolean } = {}) {
  const state = await readSyncState(folder);
  if (!state.pull) return false;
  if (readOnly) throw new Error('This book has an interrupted sync. Open it as a writable book to finish it before checking or previewing it.');
  // A pull that cannot be finished is given up rather than retried at every open (`abandonPull`); its trace tells the
  // user, through the sync status and a notice when the editor opens.
  try { await finishPull(folder, state.pull, { atOpen: true }); }
  catch (error) { console.warn('ImageFlow could not finish an interrupted sync; the next sync keeps both versions', error); return false; }
  return true;
}

/** What an older original a pull kept says about its photo (#283): it is drawn from its new preview until the new file arrives. */
export const keptOriginalProblem = 'Original still uploading from another Mac';

/**
 * The older originals a pull kept because the remote did not have their new versions yet (#295), by photo: the digest
 * of the file kept here and the digest the synced snapshot has. The book state, crop and size are the new version's,
 * so the book draws such a photo from its new preview, not from the kept file, until the new file replaces it.
 */
export async function keptOriginals(folder: string): Promise<Map<string, { kept: string; current: string }>> {
  const synced = (await readSyncState(folder).catch(() => undefined))?.lastSynced;
  const kept = new Map<string, { kept: string; current: string }>();
  for (const [id, digest] of Object.entries(synced?.localDigests ?? {})) {
    const current = synced!.photoDigests[id];
    if (current !== undefined && current !== digest) kept.set(id, { kept: digest, current });
  }
  return kept;
}

/** The trace of a pull given up when the book opened, once: the editor tells the user, then it stays for the status. */
export async function takeAbandonedAtOpen(folder: string) {
  // Nothing to take is the common case: it reads without writing, and without creating a sync record.
  if (!(await readSyncState(folder)).abandoned?.atOpen) return undefined;
  let taken: NonNullable<SyncState['abandoned']> | undefined;
  await updateSyncState(folder, (state) => {
    if (!state.abandoned?.atOpen) return state;
    taken = state.abandoned;
    const { atOpen: _, ...abandoned } = state.abandoned;
    return { ...state, abandoned };
  });
  return taken;
}
