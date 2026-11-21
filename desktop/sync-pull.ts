import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { AssetFact } from '../src/asset-facts';
import { parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import type { PhotoIndex, Project } from '../src/project';
import { projectManifests, stateBlobSchema } from '../src/sync-snapshot';
import type { StateBlob } from '../src/sync-snapshot';
import { AssetFacts, readAssetFacts } from './asset-facts';
import { bookStateFolder, persistProjectManifests } from './persistence';
import { captureBookStateRevision, ignoredName } from './revisions';
import { approvedSource } from './source-access';

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
const syncedSchema = z.object({ commitId: z.uuid(), bookStateRevision: sha256, stateDigest: sha256, photoDigests: z.record(z.string(), sha256) }).strict();
const syncStateSchema = z.object({
  version: z.literal(1),
  lastSynced: syncedSchema.optional(),
  // A pull that started touching the book. `originals` are owned originals staged with it, by their photos/ path.
  pull: z.object({
    targetCommit: z.uuid(), previousCommit: z.uuid().optional(), stateDigest: sha256, bookStateRevision: sha256,
    templateChanged: z.boolean(), originals: z.record(z.string(), sha256).default({}),
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

export async function writeSyncState(folder: string, state: SyncState) {
  const path = (await syncFolder(folder, true))!;
  const bytes = JSON.stringify(syncStateSchema.parse(state)) + '\n';
  const staging = join(path, 'sync-' + randomUUID() + '.tmp');
  try {
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(staging, join(path, 'sync.json'));
  } finally { await rm(staging, { force: true }); }
}

export async function updateSyncState(folder: string, change: (state: SyncState) => SyncState) {
  await writeSyncState(folder, change(await readSyncState(folder)));
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
 * A path inside one of the book's folders, refusing anything that leaves it through `..` or a link. Missing folders
 * on the way are created as real directories.
 */
export async function bookPath(root: string, path: string) {
  const parts = path.split('/');
  if (!['texts', 'files', 'template', 'photos'].includes(parts[0]) || parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error('A synced path must stay inside the book: ' + path);
  }
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) await mkdir(current);
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A synced path must stay inside the book: ' + path);
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

/** Whether a photo's original is on this Mac and readable here: in photos/, or linked, approved and present. */
export async function originalHere(root: string, id: string, photo: PhotoIndex[string]) {
  if (!photo.linked) {
    const path = join(root, photo.path);
    const rel = relative(join(root, 'photos'), path);
    if (!rel || rel.startsWith('..' + sep) || rel === '..') return false;
    return !!(await lstat(path).catch(() => undefined))?.isFile();
  }
  if (!await approvedSource(root, { key: 'photo:' + id, kind: 'photo', path: photo.path, linked: true })) return false;
  return !!(await lstat(photo.path).catch(() => undefined))?.isFile();
}

/**
 * The per-asset rule for a pull (ADR 0010): a fact this Mac verified against its own original wins; otherwise the
 * snapshot's. Facts of photos that left the book go.
 */
export async function mergePulledFacts(root: string, photos: PhotoIndex, local: Record<string, AssetFact>, remote: Record<string, AssetFact>) {
  const merged: Record<string, AssetFact> = {};
  for (const [id, photo] of Object.entries(photos)) {
    const fact = local[id] && await originalHere(root, id, photo) ? local[id] : remote[id] ?? local[id];
    if (fact) merged[id] = fact;
  }
  return merged;
}

const manifestJson = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/**
 * Projects a staged snapshot into the book, under its writer lock: content, the template (removing what the snapshot
 * no longer has), owned originals staged with it, the manifests through the save journal, and the merged facts.
 * Checks the result against the snapshot's revision before it records the commit as synced and drops the marker.
 */
export async function applyStagedPull(folder: string, marker: PullMarker) {
  const root = await realpath(folder);
  const blob: StateBlob = stateBlobSchema.parse(JSON.parse(Buffer.from(await stagedBlob(root, marker.stateDigest)).toString('utf8')));
  for (const [path, sha] of Object.entries(blob.content)) await place(root, path, sha, () => stagedBlob(root, sha));
  await pruneTemplate(root, new Set(Object.keys(blob.content).filter((path) => path.startsWith('template/'))));
  for (const [path, sha] of Object.entries(marker.originals)) await place(root, path, sha, () => stagedBlob(root, sha));
  const before = { 'project.json': await readFile(join(root, 'project.json')), 'photos.json': await readFile(join(root, 'photos.json')) };
  const parse = <T>(bytes: Buffer, schema: z.ZodType<T>) => { try { return schema.safeParse(JSON.parse(bytes.toString('utf8'))).data; } catch { return undefined; } };
  const local = { project: parse<Project>(before['project.json'], projectSchema), photos: parse<PhotoIndex>(before['photos.json'], photoIndexSchema) };
  const projected = projectManifests(blob, local);
  const project = parseDocument(projectSchema, projected.project, 'project.json');
  const photos = parseDocument(photoIndexSchema, projected.photos, 'photos.json');
  const after = { 'project.json': Buffer.from(manifestJson(project)), 'photos.json': Buffer.from(manifestJson(photos)) };
  if (!after['project.json'].equals(before['project.json']) || !after['photos.json'].equals(before['photos.json'])) {
    await persistProjectManifests(root, before, after, { origin: 'app', label: 'Sync pull' });
  }
  const facts = await mergePulledFacts(root, photos, await readAssetFacts(root), blob.assetsMeta.assets);
  await AssetFacts.adoptSynced(root, facts);
  const revision = await captureBookStateRevision(root);
  if (revision !== marker.bookStateRevision) {
    throw new Error('The pulled book does not match its snapshot. It is left as pulled so far; sync again to finish.');
  }
  const photoDigests = Object.fromEntries(Object.entries(blob.assetsMeta.assets).filter(([id]) => photos[id]).map(([id, fact]) => [id, fact.digest]));
  await updateSyncState(root, (state) => ({ ...state, pull: undefined,
    lastSynced: { commitId: marker.targetCommit, bookStateRevision: marker.bookStateRevision, stateDigest: marker.stateDigest, photoDigests },
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
  await applyStagedPull(folder, state.pull);
  return true;
}
