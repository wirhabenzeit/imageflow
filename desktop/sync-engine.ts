import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { AssetFact } from '../src/asset-facts';
import { parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import type { PhotoIndex } from '../src/project';
import { sourceEntries } from '../src/source-locations';
import { changedFacts, commitHeaderSchema, contentBlobKey, decideSync, encodeStateBlob, originalBlobKey, portableManifests,
  projectManifests, proxyBlobKey, stateBlobSchema, stateMatchesHeader } from '../src/sync-snapshot';
import type { CommitHeader, StateBlob, SyncedCommit } from '../src/sync-snapshot';
import { AssetFacts, readAssetFacts } from './asset-facts';
import { holdsProjectLock, persistProjectManifests } from './persistence';
import { photoDetails, photoFile } from './photos';
import { loadProject } from './project';
import type { OpenProject } from './project';
import { proxyStore } from './proxy-store';
import { captureBookState } from './revisions';
import { saveDocumentCopy } from './source-actions';
import { SourceStore } from './source-store';
import { applyStagedPull, bookPath, originalHere, readSyncState, stagingFolder, updateSyncState } from './sync-pull';
import type { PullMarker } from './sync-pull';
import { remoteTips, writeAtomically } from './sync-remote';
import type { SyncRemote } from './sync-remote';

/**
 * The Milestone 1 sync engine (ADR 0010): fast-forward or keep both, over any `SyncRemote`.
 *
 * `syncBook` runs with the book's writer lock held and nothing else editing it (DocumentSession.sync runs it inside
 * `run`, with the folder watcher paused). It brings this Mac's derived facts up to date, decides from the derived
 * tips and this Mac's sync record what to do, and pushes, pulls, or keeps both versions. A pull downloads and verifies
 * every blob before it touches the book (`RemoteSyncingError` otherwise) and is finished at the next open if it is
 * interrupted (desktop/sync-pull.ts). Facts in assets-meta.json resolve per asset and never make a book diverge.
 */
export class RemoteSyncingError extends Error {
  readonly code = 'REMOTE_SYNCING';
  constructor(detail: string) {
    super('Remote still syncing: ' + detail + ' The book was not changed. Sync again once the remote has caught up.');
    this.name = 'RemoteSyncingError';
  }
}

export type SyncOptions = {
  remote: SyncRemote;
  /** The open, writable book. */
  book: OpenProject;
  /** Download owned originals with every pull (a per-Mac preference); otherwise only on demand (`downloadOriginals`). */
  keepOriginals?: boolean;
  /** Asks which tip to continue from when the remote holds several; undefined leaves the book as it is. */
  chooseTip?: (tips: CommitHeader[]) => Promise<string | undefined>;
  now?: () => Date;
};
export type SyncOutcome = {
  action: 'initial-push' | 'push' | 'in-sync' | 'adopt' | 'fast-forward' | 'diverged';
  /** Commits written to the remote, oldest first: pushes and the commit that closed a fork. */
  pushed: string[];
  /** The commit pulled into the book, if any. */
  pulled?: string;
  /** The sibling package holding this Mac's version when both were kept. */
  conflictCopy?: string;
  /** The tips when the remote has several and none was chosen. */
  tips?: CommitHeader[];
  /** Whether the book's files changed, so the host reloads it. */
  changed: boolean;
};

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(path: string) {
  const hash = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}
const schemas = { project: projectSchema, photos: photoIndexSchema };

type Context = { root: string; remote: SyncRemote; book: OpenProject; stale: boolean; options: SyncOptions;
  /** Photos whose original is readable here, with its file and verified digest. */
  here: Record<string, { path: string; digest: string }> };

/**
 * Brings assets-meta.json up to date with every original readable here, waiting for digests not yet known, and writes
 * it: a push right after an import then carries the new photo's facts and proxy.
 */
async function refreshFacts(context: Context) {
  const { root, book } = context;
  const facts = await AssetFacts.forBook(root);
  const store = await SourceStore.forBook(root, book.cache);
  const index = JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')) as unknown;
  const photos = photoIndexSchema.parse(index);
  context.here = {};
  for (const source of sourceEntries({ project: book.project, photoIndex: photos }).filter((entry) => entry.kind === 'photo')) {
    let resolved = await store.resolve(root, source);
    if (resolved.status.state !== 'available' || !resolved.stored) continue;
    if (!resolved.status.digest) { await store.digested(); resolved = await store.resolve(root, source); }
    const digest = resolved.status.digest;
    if (resolved.status.state !== 'available' || !resolved.stored || !digest) continue;
    facts.note(source.id, resolved.stored.observation, await photoDetails(resolved.stored.snapshot, null), digest);
    context.here[source.id] = { path: resolved.stored.snapshot, digest };
  }
  await store.settled();
  await facts.flush();
  return { ...facts.all() };
}

const photoFacts = (facts: Record<string, AssetFact>, photos: PhotoIndex) => Object.fromEntries(Object.entries(facts).filter(([id]) => photos[id]));
const digestsOf = (facts: Record<string, AssetFact>) => Object.fromEntries(Object.entries(facts).map(([id, fact]) => [id, fact.digest]));

/** A state blob from the remote, checked against its digest, its schema and, with a header, its revision. */
async function fetchState(remote: SyncRemote, stateDigest: string, header?: CommitHeader): Promise<StateBlob> {
  const bytes = await remote.getBlob(contentBlobKey(stateDigest));
  if (!bytes) throw new RemoteSyncingError('a snapshot of this book has not arrived yet.');
  if (sha(bytes) !== stateDigest) throw new RemoteSyncingError('a snapshot of this book is incomplete.');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new RemoteSyncingError('a snapshot of this book is incomplete.'); }
  const parsed = stateBlobSchema.safeParse(value);
  if (!parsed.success) throw new RemoteSyncingError('a snapshot of this book cannot be read.');
  if (header && !await stateMatchesHeader(parsed.data, header, schemas)) throw new RemoteSyncingError('a snapshot of this book does not match its commit.');
  return parsed.data;
}

/** The proxies a snapshot has for photos whose original is not readable here and that the proxy store lacks. */
async function missingProxies(root: string, blob: StateBlob, photos: PhotoIndex) {
  const store = await proxyStore();
  if (!store) return [];
  const missing = new Map<string, StateBlob['proxies'][string]>();
  for (const [id, photo] of Object.entries(photos)) {
    const digest = blob.assetsMeta.assets[id]?.digest;
    const entry = digest && blob.proxies[digest];
    if (!digest || !entry || missing.has(digest) || await originalHere(root, id, photo)) continue;
    if (!await store.path(digest)) missing.set(digest, entry);
  }
  return [...missing];
}

/** Downloads proxies and checks each against its own SHA-256 before any is stored. */
async function fetchProxies(remote: SyncRemote, wanted: Awaited<ReturnType<typeof missingProxies>>) {
  const fetched: { digest: string; bytes: Uint8Array }[] = [];
  for (const [digest, entry] of wanted) {
    const bytes = await remote.getBlob(proxyBlobKey(digest, entry.ext));
    if (!bytes || sha(bytes) !== entry.sha256) throw new RemoteSyncingError('a photo preview has not fully arrived yet.');
    fetched.push({ digest, bytes });
  }
  return fetched;
}
async function storeProxies(fetched: { digest: string; bytes: Uint8Array }[]) {
  const store = await proxyStore();
  for (const { digest, bytes } of fetched) {
    try { await store?.put(digest, bytes); }
    catch { throw new RemoteSyncingError('a photo preview cannot be read.'); }
  }
}

/** Fetches the proxies that were evicted from the proxy store, or never arrived, for photos without an original here. */
async function refetchProxies(context: Context, blob: StateBlob) {
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(context.root, 'photos.json'), 'utf8')));
  await storeProxies(await fetchProxies(context.remote, await missingProxies(context.root, blob, photos)));
}

/** The open book as on disk now, for renditions of originals: reloaded after a pull or an import changed it. */
async function currentBook(context: Context) {
  const stale = context.stale || Object.entries(context.here).some(([id, { path }]) => context.book.photos.get(id)?.original !== path ||
    context.book.sources?.['photo:' + id]?.state !== 'available' || context.book.sources?.['photo:' + id]?.cached);
  if (stale) { context.book = await loadProject(context.root, context.book.cache, true); context.stale = false; }
  return context.book;
}

/** A proxy's bytes on the remote: ours when it has none, theirs (with their digest) when another Mac stored one first. */
async function uploadProxy(remote: SyncRemote, digest: string, bytes: Uint8Array, ext: '.jpg' | '.png') {
  const key = proxyBlobKey(digest, ext);
  if (await remote.hasBlob(key)) {
    const existing = await remote.getBlob(key);
    if (existing) return { sha256: sha(existing), ext };
  }
  await remote.putBlob(key, bytes);
  return { sha256: sha(bytes), ext };
}

/**
 * Pushes the book as it is now: its content, owned originals and proxies the remote lacks, then the state blob, then
 * the commit header. Entries for photos whose original is not on this Mac (not located, not downloaded) are carried
 * forward from `base`, the last synced snapshot, or taken from the local proxy store.
 */
async function push(context: Context, parents: string[], base: StateBlob | undefined, facts: Record<string, AssetFact>) {
  const { root, remote } = context;
  const state = await captureBookState(root);
  const bookId = state.project.bookId;
  if (!bookId) throw new Error('This book has no lineage ID yet. Make an edit, then sync.');
  for (const [path, digest] of Object.entries(state.contentDigests)) {
    const key = contentBlobKey(digest);
    if (await remote.hasBlob(key)) continue;
    const bytes = await readFile(state.files[path]);
    if (sha(bytes) !== digest) throw new Error('The book changed during sync. Sync again.');
    await remote.putBlob(key, bytes);
  }
  const assets = { ...photoFacts(base?.assetsMeta.assets ?? {}, state.photos), ...photoFacts(facts, state.photos) };
  const originals: StateBlob['originals'] = {};
  for (const [id, photo] of Object.entries(state.photos)) {
    if (photo.linked) continue;
    const here = context.here[id];
    if (here && here.digest === assets[id]?.digest) {
      const entry = { digest: here.digest, ext: extname(photo.path).toLowerCase() };
      const key = originalBlobKey(entry.digest, entry.ext);
      if (!await remote.hasBlob(key)) {
        if (await fileDigest(here.path) !== here.digest) throw new Error('A photo changed during sync. Sync again.');
        await remote.putBlob(key, { file: here.path });
      }
      originals[id] = entry;
    } else if (base?.originals[id]) originals[id] = base.originals[id];
  }
  const proxies: StateBlob['proxies'] = {};
  const local = await proxyStore();
  for (const [id, fact] of Object.entries(assets)) {
    const digest = fact.digest;
    if (proxies[digest]) continue;
    const here = context.here[id];
    if (here && here.digest === digest) {
      const book = await currentBook(context);
      const photo = book.photos.get(id);
      if (photo && photo.original === here.path) {
        const path = await photoFile(photo, 'preview');
        const bytes = await readFile(path);
        const ext = extname(path).toLowerCase() === '.png' ? '.png' : '.jpg';
        await local?.put(digest, bytes).catch((error) => console.warn('ImageFlow could not keep a sync proxy', error));
        proxies[digest] = await uploadProxy(remote, digest, bytes, ext);
        continue;
      }
    }
    if (base?.proxies[digest]) { proxies[digest] = base.proxies[digest]; continue; }
    const stored = await local?.path(digest);
    if (stored) proxies[digest] = await uploadProxy(remote, digest, await readFile(stored), extname(stored) === '.png' ? '.png' : '.jpg');
  }
  const portable = portableManifests(state.project, state.photos);
  const blob: StateBlob = { version: 1, project: portable.project, photos: portable.photos, assetsMeta: { version: 1, assets },
    content: state.contentDigests, originals, proxies };
  const bytes = encodeStateBlob(blob);
  const stateDigest = sha(bytes);
  if (!await remote.hasBlob(contentBlobKey(stateDigest))) await remote.putBlob(contentBlobKey(stateDigest), bytes);
  const header = commitHeaderSchema.parse({ version: 1, commitId: randomUUID(), bookId, parents, bookStateRevision: state.revision,
    createdAt: (context.options.now?.() ?? new Date()).toISOString(), title: state.project.title.slice(0, 400), stateDigest });
  await remote.putCommit(header);
  await recordSynced(root, { commitId: header.commitId, bookStateRevision: header.bookStateRevision, stateDigest, photoDigests: digestsOf(assets) });
  return { header, blob };
}

async function recordSynced(root: string, synced: SyncedCommit) {
  await updateSyncState(root, (state) => ({ ...state, lastSynced: synced }));
}

/**
 * Pulls a commit into the book: verifies the snapshot and stages every blob it needs (content, missing proxies, and
 * owned originals when they are kept here) before anything changes, then marks the pull and projects it.
 */
async function pull(context: Context, tip: CommitHeader) {
  const { blob, marker } = await stagePull(context, tip);
  await applyStagedPull(context.root, marker);
  context.stale = true;
  return blob;
}

/** The first half of a pull: everything is downloaded, verified and staged, and the pull is marked. The book is untouched. */
export async function stageSyncPull(remote: SyncRemote, book: OpenProject, tip: CommitHeader, options: Pick<SyncOptions, 'keepOriginals'> = {}) {
  const root = await realpath(book.folder);
  return (await stagePull({ root, remote, book, stale: false, options: { remote, book, ...options }, here: {} }, tip)).marker;
}

async function stagePull(context: Context, tip: CommitHeader) {
  const { root, remote } = context;
  const blob = await fetchState(remote, tip.stateDigest, tip);
  const staging = await stagingFolder(root, true);
  await writeFile(join(staging, tip.stateDigest), encodeStateBlob(blob));
  for (const digest of new Set(Object.values(blob.content))) {
    const path = join(staging, digest);
    if (!await remote.downloadBlob(contentBlobKey(digest), path) || await fileDigest(path) !== digest) {
      throw new RemoteSyncingError('a file of this book has not fully arrived yet.');
    }
  }
  const localPhotos = photoIndexSchema.safeParse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8'))).data;
  const projected = photoIndexSchema.parse(projectManifests(blob, { project: context.book.project, photos: localPhotos }).photos);
  const proxies = await fetchProxies(remote, await missingProxies(root, blob, projected));
  const originals: PullMarker['originals'] = {};
  if (context.options.keepOriginals) for (const [id, original] of Object.entries(blob.originals)) {
    const photo = projected[id];
    if (!photo || photo.linked || !photo.path.startsWith('photos/')) continue;
    if (await fileDigest(join(root, photo.path)).catch(() => undefined) === original.digest) continue;
    const path = join(staging, original.digest);
    if (!await remote.downloadBlob(originalBlobKey(original.digest, original.ext), path) || await fileDigest(path) !== original.digest) {
      throw new RemoteSyncingError('an original photo has not fully arrived yet.');
    }
    originals[photo.path] = original.digest;
  }
  await storeProxies(proxies);
  const local = await captureBookState(root).catch(() => undefined);
  const templates = (content: Record<string, string>) => JSON.stringify(Object.entries(content).filter(([path]) => path.startsWith('template/')).sort());
  const synced = (await readSyncState(root)).lastSynced;
  const marker: PullMarker = { targetCommit: tip.commitId, ...(synced ? { previousCommit: synced.commitId } : {}), stateDigest: tip.stateDigest,
    bookStateRevision: tip.bookStateRevision, templateChanged: !local || templates(local.contentDigests) !== templates(blob.content), originals };
  await updateSyncState(root, (state) => ({ ...state, pull: marker }));
  return { blob, marker };
}

/** `<Book> (Conflict 2026-11-21 14.33.05).imageflow` beside the book, numbered when that name is taken. */
async function conflictDestination(root: string, now: Date) {
  const name = basename(root).replace(/\.imageflow$/i, '');
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '.');
  for (let index = 1; ; index++) {
    const candidate = join(dirname(root), name + ' (Conflict ' + stamp + (index > 1 ? ' ' + index : '') + ').imageflow');
    if (!await lstat(candidate).catch(() => undefined)) return candidate;
  }
}

/**
 * Keep both (ADR 0010, Milestone 1): this Mac's version goes to a sibling package with a new lineage and no sync
 * record, then the book is fast-forwarded to the remote tip, or to the tip the user picks when there are several. Only
 * that choice writes the commit that closes the fork, naming every tip as a parent.
 */
async function keepBoth(context: Context, tips: CommitHeader[], localRevision: string, lastSynced: SyncedCommit | undefined): Promise<SyncOutcome> {
  let target = tips.length === 1 ? tips[0] : undefined;
  if (!target) {
    const chosen = await context.options.chooseTip?.(tips);
    target = tips.find((tip) => tip.commitId === chosen);
    if (!target) return { action: 'diverged', pushed: [], tips, changed: false };
  }
  // Only a version the remote does not hold needs keeping.
  const unsynced = localRevision !== lastSynced?.bookStateRevision && !tips.some((tip) => tip.bookStateRevision === localRevision);
  const conflictCopy = unsynced ? await saveDocumentCopy(context.book, await conflictDestination(context.root, context.options.now?.() ?? new Date()), false) : undefined;
  await pull(context, target);
  const pushed: string[] = [];
  if (tips.length > 1) {
    const synced = (await readSyncState(context.root)).lastSynced!;
    const header = commitHeaderSchema.parse({ ...target, commitId: randomUUID(), parents: tips.map((tip) => tip.commitId),
      createdAt: (context.options.now?.() ?? new Date()).toISOString() });
    await context.remote.putCommit(header);
    await recordSynced(context.root, { ...synced, commitId: header.commitId });
    pushed.push(header.commitId);
  }
  return { action: 'diverged', pushed, pulled: target.commitId, ...(conflictCopy ? { conflictCopy } : {}), ...(tips.length > 1 ? { tips } : {}), changed: true };
}

/** Gives a book from before lineage IDs its `bookId` (ADR 0010), the key of its commits on a remote. */
async function ensureBookId(root: string) {
  const before = { 'project.json': await readFile(join(root, 'project.json')), 'photos.json': await readFile(join(root, 'photos.json')) };
  const project = parseDocument(projectSchema, JSON.parse(before['project.json'].toString('utf8')), 'project.json');
  if (project.bookId) return false;
  const after = { ...before, 'project.json': Buffer.from(JSON.stringify(parseDocument(projectSchema, { ...project, bookId: randomUUID() }, 'project.json'), null, 2) + '\n') };
  await persistProjectManifests(root, before, after, { origin: 'app', label: 'Prepare sync' });
  return true;
}

export async function syncBook(options: SyncOptions): Promise<SyncOutcome> {
  const root = await realpath(options.book.folder);
  if (options.book.readOnly || !await holdsProjectLock(root)) throw new Error('Open the book for editing to sync it.');
  const registered = AssetFacts.registered(root);
  const context: Context = { root, remote: options.remote, book: options.book, stale: false, options, here: {} };
  try {
    let resumed = await ensureBookId(root);
    if (resumed) context.stale = true;
    for (;;) {
      const state = await readSyncState(root);
      if (state.pull) {
        if (resumed) throw new Error('The interrupted sync could not be finished.');
        await applyStagedPull(root, state.pull);
        resumed = context.stale = true;
        continue;
      }
      const facts = await refreshFacts(context);
      const local = await captureBookState(root);
      const bookId = local.project.bookId;
      if (!bookId) throw new Error('This book has no lineage ID yet. Make an edit, then sync.');
      const tips = await remoteTips(options.remote, bookId);
      const synced = state.lastSynced;
      const factsChanged = !!synced && changedFacts(facts, synced.photoDigests, Object.keys(local.photos)).length > 0;
      const decision = decideSync({ pullInProgress: false, tips, lastSynced: synced, localRevision: local.revision, factsChanged });
      const changed = resumed;
      switch (decision.action) {
        case 'resume': continue;
        case 'initial-push': {
          const { header } = await push(context, [], undefined, facts);
          return { action: 'initial-push', pushed: [header.commitId], changed };
        }
        case 'push': {
          const base = await fetchState(options.remote, synced!.stateDigest);
          const { header } = await push(context, [decision.tip.commitId], base, facts);
          return { action: 'push', pushed: [header.commitId], changed };
        }
        case 'in-sync': {
          const blob = await fetchState(options.remote, decision.tip.stateDigest).catch(() => undefined);
          if (blob) await refetchProxies(context, blob);
          return { action: 'in-sync', pushed: [], changed };
        }
        case 'adopt': {
          const blob = await fetchState(options.remote, decision.tip.stateDigest, decision.tip);
          const photoDigests = digestsOf(photoFacts(blob.assetsMeta.assets, local.photos));
          await recordSynced(root, { commitId: decision.tip.commitId, bookStateRevision: decision.tip.bookStateRevision, stateDigest: decision.tip.stateDigest, photoDigests });
          await refetchProxies(context, blob);
          // Facts this Mac knows better than the snapshot go back with a commit of the same book state.
          if (changedFacts(facts, photoDigests, Object.keys(local.photos)).length) {
            const { header } = await push(context, [decision.tip.commitId], blob, facts);
            return { action: 'adopt', pushed: [header.commitId], changed };
          }
          return { action: 'adopt', pushed: [], changed };
        }
        case 'fast-forward': {
          const blob = await pull(context, decision.tip);
          const now = (await readSyncState(root)).lastSynced!;
          // The merge kept facts this Mac verified against its own originals; those that differ from the snapshot go back.
          const current = await readAssetFacts(root);
          const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
          if (changedFacts(current, now.photoDigests, Object.keys(photos)).length) {
            const { header } = await push(context, [decision.tip.commitId], blob, current);
            return { action: 'fast-forward', pushed: [header.commitId], pulled: decision.tip.commitId, changed: true };
          }
          return { action: 'fast-forward', pushed: [], pulled: decision.tip.commitId, changed: true };
        }
        case 'diverged': {
          const outcome = await keepBoth(context, decision.tips, local.revision, synced);
          return { ...outcome, changed: outcome.changed || changed };
        }
      }
    }
  } finally {
    // Facts this sync loaded for a book no session holds are written and dropped again.
    if (!registered) await AssetFacts.release(root).catch(() => {});
  }
}

/**
 * Downloads owned originals that are only proxies on this Mac (all of them, or those of `ids`) from the last synced
 * snapshot, checking each digest, into photos/: before printing, or when asked. Returns the IDs downloaded.
 */
export async function downloadOriginals({ remote, book, ids }: { remote: SyncRemote; book: OpenProject; ids?: readonly string[] }) {
  const root = await realpath(book.folder);
  if (book.readOnly || !await holdsProjectLock(root)) throw new Error('Open the book for editing to download its originals.');
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return [];
  const blob = await fetchState(remote, synced.stateDigest);
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const downloaded: string[] = [];
  for (const [id, original] of Object.entries(blob.originals)) {
    const photo = photos[id];
    if ((ids && !ids.includes(id)) || !photo || photo.linked || !photo.path.startsWith('photos/')) continue;
    const target = await bookPath(root, photo.path);
    if (await fileDigest(target).catch(() => undefined) === original.digest) continue;
    const staging = join(await stagingFolder(root), 'original-' + randomUUID());
    if (!await remote.downloadBlob(originalBlobKey(original.digest, original.ext), staging) || await fileDigest(staging) !== original.digest) {
      throw new RemoteSyncingError('an original photo has not fully arrived yet.');
    }
    try { await writeAtomically(target, { file: staging }); }
    finally { await rm(staging, { force: true }); }
    downloaded.push(id);
  }
  return downloaded;
}
