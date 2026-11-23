import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AssetFact } from '../src/asset-facts';
import { parseDocument, photoIndexSchema, projectSchema, withBookFormat } from '../src/project';
import type { PhotoIndex, Project } from '../src/project';
import { projectManifests, stateBlobSchema } from '../src/sync-snapshot';
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
const syncedSchema = z.object({ commitId: z.uuid(), bookId: z.uuid().optional(), bookStateRevision: sha256, stateDigest: sha256, photoDigests: z.record(z.string(), sha256),
  localDigests: z.record(z.string(), sha256).optional() }).strict();
const syncStateSchema = z.object({
  version: z.literal(1),
  // The sync folder this book syncs through on this Mac (#251). Per Mac: another Mac may keep it elsewhere.
  folder: z.string().min(1).max(4096).optional(),
  lastSynced: syncedSchema.optional(),
  // A pull that started touching the book. `staleOriginals` are owned originals here that the snapshot replaced and
  // that go (by path, with their stale digest), so the photo shows its new proxy until its new original is downloaded.
  // `keepLocal` are the photos whose original here changed since the last sync, so their local fact wins;
  // `localDigests` the originals' digests after the pull. `conflictCopy` is the copy Keep Both made before it.
  // Owned originals never pass through a pull: they are downloaded after it, beside their target (`downloadOriginals`).
  pull: z.object({
    targetCommit: z.uuid(), previousCommit: z.uuid().optional(), stateDigest: sha256, bookStateRevision: sha256,
    templateChanged: z.boolean(), staleOriginals: z.record(z.string(), sha256).default({}), keepLocal: z.array(z.string()).default([]),
    localDigests: z.record(z.string(), sha256).default({}), conflictCopy: z.string().max(4096).optional(),
  }).strict().optional(),
  // A marked pull that could not be finished and was given up (`abandonPull`): what it pulled, why it failed, the
  // revision the half-pulled book had then (absent when it did not load), the copy Keep Both made before it, and
  // whether it failed when the book opened, which the editor then tells the user about once.
  abandoned: z.object({
    targetCommit: z.uuid(), error: z.string().max(2000), at: z.iso.datetime(), bookStateRevision: sha256.optional(),
    conflictCopy: z.string().max(4096).optional(), atOpen: z.literal(true).optional(),
  }).strict().optional(),
  // A pull changed template/: origins it declares that this book has not allowed are asked about even when the book is
  // trusted, since a sync remote is not authenticated (ADR 0006).
  networkReview: z.literal(true).optional(),
}).strict();
export type SyncState = z.infer<typeof syncStateSchema>;
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

export async function readSyncState(folder: string): Promise<SyncState> {
  const path = await syncFolder(folder, false);
  if (!path) return { version: 1 };
  let text: string;
  try { text = await readFile(join(path, 'sync.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }; throw error; }
  const parsed = syncStateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('This book’s sync record is invalid. Preserve ' + join(path, 'sync.json') + ' and remove it to sync again from scratch.');
  return parsed.data;
}

async function writeSyncState(folder: string, state: SyncState) {
  const path = (await syncFolder(folder, true))!;
  const bytes = JSON.stringify(syncStateSchema.parse(state)) + '\n';
  const staging = join(path, 'sync-' + randomUUID() + '.tmp');
  try {
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(staging, join(path, 'sync.json'));
  } finally { await rm(staging, { force: true }); }
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

async function place(root: string, path: string, sha: string, bytes: () => Promise<Uint8Array>) {
  const target = await bookPath(root, path);
  if (await digestOrUndefined(target) === sha) return;
  const staging = join(dirname(target), '.imageflow-write-' + randomUUID() + '.tmp');
  try {
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(await bytes()); await handle.sync(); } finally { await handle.close(); }
    await rename(staging, target);
  } finally { await rm(staging, { force: true }); }
}

/** Removes template files the snapshot does not have, and folders that end up empty. Ignored names stay. */
async function pruneTemplate(root: string, keep: Set<string>) {
  const walk = async (path: string): Promise<boolean> => {
    const absolute = join(root, path);
    const info = await lstat(absolute).catch(() => undefined);
    if (!info) return true;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      if (keep.has(path)) return false;
      await rm(absolute, { force: true });
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
}

/**
 * The per-asset rule for a pull (ADR 0010): the fact of a photo whose original changed here since the last sync wins
 * (`keepLocal`); otherwise the snapshot's, even over an original still here at an older digest. Facts of photos that
 * left the book go.
 */
export function mergePulledFacts(photos: PhotoIndex, local: Record<string, AssetFact>, remote: Record<string, AssetFact>, keepLocal: ReadonlySet<string>) {
  const merged: Record<string, AssetFact> = {};
  for (const id of Object.keys(photos)) {
    const fact = local[id] && keepLocal.has(id) ? local[id] : remote[id] ?? local[id];
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
  await updateSyncState(folder, ({ pull, lastSynced: _, ...state }) => ({ ...state,
    abandoned: { targetCommit: marker.targetCommit, error: message, at: new Date().toISOString(), ...(bookStateRevision ? { bookStateRevision } : {}),
      ...(marker.conflictCopy ? { conflictCopy: marker.conflictCopy } : {}), ...(atOpen ? { atOpen: true as const } : {}) },
    ...(pull?.templateChanged || state.networkReview ? { networkReview: true as const } : {}) }));
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
  for (const [path, sha] of Object.entries(blob.content)) await place(root, path, sha, () => stagedBlob(root, sha));
  await pruneTemplate(root, new Set(Object.keys(blob.content).filter((path) => path.startsWith('template/'))));
  for (const [path, stale] of Object.entries(marker.staleOriginals)) {
    const target = await bookPath(root, path);
    if (await digestOrUndefined(target) === stale) await rm(target, { force: true });
  }
  const before = await manifests(root);
  const { project, photos, after } = projectedManifests(blob, before);
  if (!after['project.json'].equals(before['project.json']) || !after['photos.json'].equals(before['photos.json'])) {
    await persistProjectManifests(root, before, after, { origin: 'app', label: 'Sync pull' });
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
      localDigests: Object.fromEntries(Object.entries(marker.localDigests).filter(([id]) => photos[id])) },
    ...(marker.templateChanged || state.networkReview ? { networkReview: true as const } : {}) }));
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
