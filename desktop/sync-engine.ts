import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import type { AssetFact } from '../src/asset-facts';
import { parseDocument, photoIndexSchema, projectSchema, withBookFormat } from '../src/project';
import type { PhotoIndex } from '../src/project';
import { sourceEntries } from '../src/source-locations';
import { entryReach, isFileLocator, packagePath } from '../src/source-locator';
import type { LocatorFields } from '../src/source-locator';
import { changedOriginals, commitHeaderSchema, commitHeaderVersion, contentBlobKey, decideSync, deriveTips, encodeStateBlob, factsAhead, newerStateBlob, NewerSyncFormatError, originalBlobKey, portableManifests,
  projectManifests, proxyBlobKey, stateBlobSchema, stateMatchesHeader } from '../src/sync-snapshot';
import type { CommitHeader, StateBlob, SyncDecision, SyncedCommit } from '../src/sync-snapshot';
import type { SyncStatus } from '../src/desktop';
import { AssetFacts, readAssetFacts } from './asset-facts';
import { documentPath } from './documents';
import { holdsProjectLock, persistProjectManifests } from './persistence';
import { photoDetails, photoFile } from './photos';
import { loadProject, observePhotos } from './project';
import type { OpenProject } from './project';
import { contentKey } from './provided-photos';
import { proxyStore } from './proxy-store';
import { captureBookState, captureBookStateRevision } from './revisions';
import { saveDocumentCopy } from './source-actions';
import { SourceStore } from './source-store';
import { bookPath, finishPull, preflightPull, readSyncState, stagingFolder, updateSyncState } from './sync-pull';
import type { PullMarker } from './sync-pull';
import { remoteCommits } from './sync-remote';
import type { SyncRemote } from './sync-remote';
import { StoreAccessError, StoreFullError } from './sync-store';
import type { StoreAccessReason } from './sync-store';

/**
 * The Milestone 1 sync engine (ADR 0010): fast-forward or keep both, over any `SyncRemote`.
 *
 * `syncBook` runs with the book's writer lock held and nothing else editing it (DocumentSession.sync runs it inside
 * `run`, with the folder watcher paused). It brings this Mac's derived facts up to date, decides from the derived
 * tips and this Mac's sync record what to do, and pushes, pulls, or keeps both versions. A pull downloads and verifies
 * every blob before it touches the book (`RemoteSyncingError` otherwise) and is finished at the next open if it is
 * interrupted (desktop/sync-pull.ts). Facts in assets-meta.json resolve per asset and never make a book diverge.
 *
 * Owned originals are not part of a sync (ADR 0012, section 2): a push sends the state blob, the previews and the
 * commit, which names every owned original here, and the originals follow in the background (`uploadOriginals`, run by
 * the app's sync service). What is still to upload is derived from the last synced snapshot and the remote's listing,
 * never recorded, so it survives a restart and a pull or push in between, and repairs an original the remote lost.
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
  /**
   * The per-Mac "keep originals" preference: after a successful sync, owned originals this Mac lacks are downloaded
   * (`downloadOriginals`), beside their targets and outside the pull. Otherwise only on demand.
   */
  fetchOriginals?: boolean;
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
  /**
   * With `fetchOriginals`: the originals downloaded after the sync, how many the snapshot names that another Mac has
   * not uploaded yet (`notUploaded`), and why the rest are still pending. A failed download never fails the sync, which
   * had succeeded by then; the next sync or an explicit download retries.
   */
  originals?: { downloaded: string[]; notUploaded?: number; pending?: string };
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
  /**
   * Photos this Mac can read now, with the verified digest of what it read: an original's file (`path`) and its
   * digest, or, for a photo without a file (ADR 0011), the digest of the preview stored for the fact its provider
   * reported and `key`, a key of the content the provider shows now. A photo has one of `path` and `key`.
   */
  here: Record<string, { path?: string; key?: string; digest: string }> };

/**
 * The path in the book of a photo whose original syncs (reach `book`, ADR 0012); undefined for any other photo, whose
 * original stays on its Mac or at its origin.
 */
const syncedOriginalPath = (photo: LocatorFields) => entryReach(photo) === 'book' ? packagePath(photo) : undefined;

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
  const proxies = await proxyStore();
  context.here = {};
  const sources = sourceEntries({ project: book.project, photoIndex: photos }).filter((entry) => entry.kind === 'photo');
  // Photos that are not files are asked about once per provider, all at once (ADR 0011): a sync holds the book, and a
  // provider such as Lightroom Classic answers over a bridge.
  const provided = await observePhotos(root, sources.filter((source) => !isFileLocator(source.locator)), store, facts);
  for (const source of sources) {
    const reported = provided.get(source.id)?.observed;
    // A file its provider reports where it reported none before is read like any file, below.
    if (reported && !(reported.state === 'available' && reported.file !== undefined)) {
      // A photo without a file, which its provider answers for now. What the provider reported was recorded with its
      // revisions and the digest of its preview when the book loaded or the provider reported a change
      // (desktop/provided-photos.ts). The fact is this Mac's observation of the photo only while it is of the content
      // the provider shows now (a pull may have put another Mac's fact in its place) and its preview is here. Whether
      // the photo changed here is then told by that content, not by the fact (`SyncedCommit.localKeys`).
      const fact = facts.get(source.id);
      if (reported.state !== 'available' || !fact?.revisions || contentKey(reported.revisions) !== contentKey(fact.revisions)) continue;
      if (await proxies?.path(fact.digest)) context.here[source.id] = { digest: fact.digest, key: sha(Buffer.from(contentKey(reported.revisions))) };
      continue;
    }
    let resolved = await store.resolve(root, source, reported ? { observed: reported } : {});
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

const hereDigests = (context: Context) => Object.fromEntries(Object.entries(context.here).map(([id, { digest }]) => [id, digest]));
const hereKeys = (context: Context) => Object.fromEntries(Object.entries(context.here).flatMap(([id, { key }]) => key === undefined ? [] : [[id, key]]));
/**
 * What this Mac's providers show of the photos without a file, for the sync record: as now for those it can read, and
 * as at the sync before for the others, so a photo that cannot be read for a while is still compared with what it was.
 */
const syncedKeys = (context: Context, synced: SyncedCommit | undefined, photos: Record<string, unknown>, except: ReadonlySet<string> = new Set()) =>
  Object.fromEntries(Object.entries({ ...synced?.localKeys, ...Object.fromEntries(Object.entries(hereKeys(context)).filter(([id]) => !except.has(id))) }).filter(([id]) => photos[id]));
const photoFacts = (facts: Record<string, AssetFact>, photos: PhotoIndex) => Object.fromEntries(Object.entries(facts).filter(([id]) => photos[id]));
const digestsOf = (facts: Record<string, AssetFact>) => Object.fromEntries(Object.entries(facts).map(([id, fact]) => [id, fact.digest]));

/** A state blob from the remote, checked against its digest, its schema and, with a header, its revision. */
async function fetchState(remote: SyncRemote, bookId: string, stateDigest: string, header?: CommitHeader): Promise<StateBlob> {
  return (await fetchStateBytes(remote, bookId, stateDigest, header)).blob;
}
/** The same, with the bytes as stored, which a pull stages: re-encoding would drop fields a newer version added. */
async function fetchStateBytes(remote: SyncRemote, bookId: string, stateDigest: string, header?: CommitHeader) {
  const bytes = await remote.getBlob(contentBlobKey(bookId, stateDigest));
  if (!bytes) throw new RemoteSyncingError('a snapshot of this book has not arrived yet.');
  if (sha(bytes) !== stateDigest) throw new RemoteSyncingError('a snapshot of this book is incomplete.');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new RemoteSyncingError('a snapshot of this book is incomplete.'); }
  const parsed = stateBlobSchema.safeParse(value);
  // Whole (its digest matched) but unreadable here: written by a newer version, or not by ImageFlow at all.
  if (!parsed.success) throw newerStateBlob(value) ? new NewerSyncFormatError() : new Error('A snapshot of this book on the remote cannot be read. The book was not changed.');
  if (header && !await stateMatchesHeader(parsed.data, header, schemas)) throw new Error('A snapshot of this book on the remote does not match its commit. The book was not changed.');
  return { blob: parsed.data, bytes };
}

/**
 * The proxies a snapshot has that the proxy store lacks, for photos without an original here at the snapshot's digest:
 * one not here at all, or here at an older digest because another Mac re-exported or replaced it. `skip` names photos
 * that need none (their local fact wins).
 */
async function missingProxies(blob: StateBlob, photos: PhotoIndex, here: Record<string, string>, skip: ReadonlySet<string> = new Set()) {
  const store = await proxyStore();
  if (!store) return [];
  const missing = new Map<string, StateBlob['proxies'][string]>();
  for (const id of Object.keys(photos)) {
    const digest = blob.assetsMeta.assets[id]?.digest;
    const entry = digest && blob.proxies[digest];
    if (!digest || !entry || missing.has(digest) || skip.has(id) || here[id] === digest) continue;
    if (!await store.path(digest)) missing.set(digest, entry);
  }
  return [...missing];
}

/** Downloads proxies and checks each against its own SHA-256 before any is stored. */
async function fetchProxies(remote: SyncRemote, bookId: string, wanted: Awaited<ReturnType<typeof missingProxies>>) {
  const fetched: { digest: string; bytes: Uint8Array }[] = [];
  for (const [digest, entry] of wanted) {
    const bytes = await remote.getBlob(proxyBlobKey(bookId, digest, entry.ext));
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
async function refetchProxies(context: Context, bookId: string, blob: StateBlob) {
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(context.root, 'photos.json'), 'utf8')));
  await storeProxies(await fetchProxies(context.remote, bookId, await missingProxies(blob, photos, hereDigests(context))));
}

/** The open book as on disk now, for renditions of originals: reloaded after a pull or an import changed it. */
async function currentBook(context: Context) {
  // Only originals are rendered from the open book; a photo without a file is pushed from its stored preview.
  const stale = context.stale || Object.entries(context.here).some(([id, { path }]) => path !== undefined && (context.book.photos.get(id)?.original !== path ||
    context.book.sources?.['photo:' + id]?.state !== 'available' || context.book.sources?.['photo:' + id]?.cached));
  if (stale) { context.book = await loadProject(context.root, context.book.cache, true); context.stale = false; }
  return context.book;
}

/** Whether bytes are a whole still image of the proxy's type, pixels included. */
async function decodes(bytes: Uint8Array, ext: '.jpg' | '.png') {
  try {
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== (ext === '.png' ? 'png' : 'jpeg') || (metadata.pages ?? 1) > 1) return false;
    await sharp(bytes, { failOn: 'warning' }).resize({ width: 1, height: 1 }).toBuffer();
    return true;
  } catch { return false; }
}

/** A proxy's bytes on the remote: ours when it has none, theirs (with their digest) when another Mac stored one first. */
async function uploadProxy(remote: SyncRemote, bookId: string, digest: string, bytes: Uint8Array, ext: '.jpg' | '.png') {
  const key = proxyBlobKey(bookId, digest, ext);
  if (await remote.hasBlob(key)) {
    const existing = await remote.getBlob(key);
    // A proxy another Mac is still writing (a synced folder delivers files piecemeal) must not enter a snapshot.
    if (!existing || !await decodes(existing, ext)) throw new RemoteSyncingError('a photo preview has not fully arrived yet.');
    return { sha256: sha(existing), ext };
  }
  await remote.putBlob(key, bytes);
  return { sha256: sha(bytes), ext };
}

/**
 * Pushes the book as it is now: its content and proxies the remote lacks, then the state blob, then the commit header.
 * The snapshot names every owned original here; the originals themselves go up after the commit, in the background
 * (`uploadOriginals`), so another Mac can open the book from its state and previews before they have arrived. Entries
 * for photos whose original is not on this Mac (not located, not downloaded) are carried forward from `base`, the last
 * synced snapshot, or taken from the local proxy store.
 */
async function push(context: Context, parents: string[], base: StateBlob | undefined, facts: Record<string, AssetFact>, synced: SyncedCommit | undefined) {
  const { root, remote } = context;
  const state = await captureBookState(root);
  const bookId = state.project.bookId;
  if (!bookId) throw new Error('This book has no lineage ID yet. Make an edit, then sync.');
  for (const [path, digest] of Object.entries(state.contentDigests)) {
    const key = contentBlobKey(bookId, digest);
    if (await remote.hasBlob(key)) continue;
    const bytes = await readFile(state.files[path]);
    if (sha(bytes) !== digest) throw new Error('The book changed during sync. Sync again.');
    await remote.putBlob(key, bytes, { sha256: digest });
  }
  // A photo's fact from here goes up only when its original changed here since the last sync (or the snapshot lacks
  // one); an original merely left at an older digest never pushes that digest back over another Mac's re-export.
  const changed = changedOriginals(hereDigests(context), synced, hereKeys(context));
  const remoteFacts = photoFacts(base?.assetsMeta.assets ?? {}, state.photos);
  const assets = Object.fromEntries(Object.keys(state.photos).flatMap((id) => {
    const fact = (changed.has(id) ? facts[id] : remoteFacts[id]) ?? facts[id] ?? remoteFacts[id];
    return fact ? [[id, fact]] : [];
  }));
  const originals: StateBlob['originals'] = {};
  for (const [id, photo] of Object.entries(state.photos)) {
    // Only photos whose source reaches the book sync as originals (ADR 0012, Sync by reach).
    const owned = syncedOriginalPath(photo);
    if (owned === undefined) continue;
    const here = context.here[id];
    // Named, not uploaded: the original follows the commit (`uploadOriginals`), and until it has arrived another Mac
    // shows the photo's preview and says that it is still uploading.
    if (here?.path !== undefined && here.digest === assets[id]?.digest) originals[id] = { digest: here.digest, ext: extname(owned).toLowerCase() };
    else if (base?.originals[id]) originals[id] = base.originals[id];
  }
  const proxies: StateBlob['proxies'] = {};
  const local = await proxyStore();
  for (const [id, fact] of Object.entries(assets)) {
    const digest = fact.digest;
    if (proxies[digest]) continue;
    // Unchanged photos keep the proxy the last snapshot recorded: nothing is read, decoded or downloaded again.
    if (base?.proxies[digest]) { proxies[digest] = base.proxies[digest]; continue; }
    const here = context.here[id];
    if (here?.path !== undefined && here.digest === digest) {
      const book = await currentBook(context);
      const photo = book.photos.get(id);
      if (photo && photo.original === here.path) {
        const path = await photoFile(photo, 'preview');
        const bytes = await readFile(path);
        const ext = extname(path).toLowerCase() === '.png' ? '.png' : '.jpg';
        await local?.put(digest, bytes).catch((error) => console.warn('ImageFlow could not keep a sync proxy', error));
        proxies[digest] = await uploadProxy(remote, bookId, digest, bytes, ext);
        continue;
      }
    }
    const stored = await local?.path(digest);
    if (stored) proxies[digest] = await uploadProxy(remote, bookId, digest, await readFile(stored), extname(stored) === '.png' ? '.png' : '.jpg');
  }
  const portable = portableManifests(state.project, state.photos);
  const blob: StateBlob = { version: 1, project: portable.project, photos: portable.photos, assetsMeta: { version: 1, assets },
    content: state.contentDigests, originals, proxies };
  const bytes = encodeStateBlob(blob);
  const stateDigest = sha(bytes);
  if (!await remote.hasBlob(contentBlobKey(bookId, stateDigest))) await remote.putBlob(contentBlobKey(bookId, stateDigest), bytes, { sha256: stateDigest });
  const header = commitHeaderSchema.parse({ version: commitHeaderVersion, commitId: randomUUID(), bookId, parents, bookStateRevision: state.revision,
    createdAt: (context.options.now?.() ?? new Date()).toISOString(), title: state.project.title.slice(0, 400), stateDigest });
  await remote.putCommit(header);
  await recordSynced(root, { commitId: header.commitId, bookId, bookStateRevision: header.bookStateRevision, stateDigest, photoDigests: digestsOf(assets),
    localDigests: Object.fromEntries(Object.entries(context.here).filter(([id, { path, digest }]) => path !== undefined && assets[id]?.digest === digest).map(([id, { digest }]) => [id, digest])),
    localKeys: syncedKeys(context, synced, state.photos) });
  return { header, blob };
}

/**
 * Whether a snapshot leaves out an owned original that is here at the digest the snapshot has for its photo. A push
 * from before originals went up after the commit left out what did not fit into a full iCloud; such a snapshot is
 * still read, and the next push names those originals, so a sync with nothing else to push makes one.
 */
async function unnamedOriginals(context: Context, blob: StateBlob) {
  const photos = (await captureBookState(context.root)).photos;
  return Object.entries(photos).some(([id, photo]) => {
    const here = context.here[id];
    return syncedOriginalPath(photo) !== undefined && here?.path !== undefined && !blob.originals[id] && blob.assetsMeta.assets[id]?.digest === here.digest;
  });
}

async function recordSynced(root: string, synced: SyncedCommit) {
  await updateSyncState(root, ({ abandoned: _, ...state }) => ({ ...state, lastSynced: synced }));
}

/**
 * Pulls a commit into the book: verifies the snapshot and stages every blob it needs (content and missing proxies)
 * before anything changes, then marks the pull and projects it. Owned originals are not part of it.
 */
async function pull(context: Context, tip: CommitHeader) {
  const { blob, marker } = await stagePull(context, tip);
  await applyPull(context, marker);
  return blob;
}

/** Marks and projects a staged pull, then looks at the originals here again: stale ones went, downloaded ones came. */
async function applyPull(context: Context, marker: PullMarker) {
  await markPull(context.root, marker);
  context.stale = true;
  await finishPull(context.root, marker);
  await refreshFacts(context);
}

/** The first half of a pull: everything is downloaded, verified and staged, and the pull is marked. The book is untouched. */
export async function stageSyncPull(remote: SyncRemote, book: OpenProject, tip: CommitHeader) {
  const root = await realpath(book.folder);
  const { marker } = await stagePull({ root, remote, book, stale: false, options: { remote, book }, here: {} }, tip);
  await markPull(root, marker);
  return marker;
}

/** From here on a crash leaves a pull that the next open finishes. */
const markPull = (root: string, marker: PullMarker) => updateSyncState(root, (state) => ({ ...state, pull: marker }));

/**
 * Copies a local original to a photos/ path of the book through a file beside it (a clone on APFS), checking its
 * digest; false when the bytes changed meanwhile. A file already there with those bytes counts as copied.
 */
async function copyBeside(root: string, path: string, source: string, digest: string) {
  const target = await bookPath(root, path);
  if (await fileDigest(target).catch(() => undefined) === digest) return true;
  const staging = join(dirname(target), '.imageflow-write-' + randomUUID() + '.tmp');
  try {
    await copyFile(source, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    if (await fileDigest(staging) !== digest) return false;
    await rename(staging, target);
    return true;
  } finally { await rm(staging, { force: true }); }
}

/**
 * Downloads, verifies and stages everything a pull of `tip` needs, and says what it will do. Changes nothing the book
 * refers to: the only writes into the book are copies of local bytes to photos/ paths that no manifest references yet
 * (a photo renamed, or copied into the book on another Mac), which change nothing and are harmless to repeat.
 */
async function stagePull(context: Context, tip: CommitHeader) {
  const { root, remote } = context;
  const { blob, bytes } = await fetchStateBytes(remote, tip.bookId, tip.stateDigest, tip);
  const staging = await stagingFolder(root, true);
  await writeFile(join(staging, tip.stateDigest), bytes);
  for (const digest of new Set(Object.values(blob.content))) {
    const path = join(staging, digest);
    if (!await remote.downloadBlob(contentBlobKey(tip.bookId, digest), path) || await fileDigest(path) !== digest) {
      throw new RemoteSyncingError('a file of this book has not fully arrived yet.');
    }
  }
  const localPhotos = photoIndexSchema.safeParse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8'))).data;
  const localProject = projectSchema.safeParse(JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))).data;
  const projected = photoIndexSchema.parse(projectManifests(blob, { project: localProject, photos: localPhotos }).photos);
  // Paths in photos/ the book refers to now: never written before the pull is marked.
  const referenced = new Set(Object.values(localPhotos ?? {}).flatMap((photo) => { const path = packagePath(photo); return path === undefined ? [] : [join(root, path)]; }));
  const synced = (await readSyncState(root)).lastSynced;
  const here = hereDigests(context);
  // Photos whose original changed here since the last sync keep their local fact; every other original here that
  // differs from the snapshot is stale.
  const keepLocal = new Set([...changedOriginals(here, synced, hereKeys(context))].filter((id) => projected[id]));
  const proxies = await fetchProxies(remote, tip.bookId, await missingProxies(blob, projected, here, keepLocal));
  const staleOriginals: PullMarker['staleOriginals'] = {};
  const localDigests: PullMarker['localDigests'] = {};
  for (const [id, photo] of Object.entries(projected)) {
    const path = syncedOriginalPath(photo);
    const owned = !!path?.startsWith('photos/');
    const original = owned ? blob.originals[id] : undefined;
    const wanted = owned ? original?.digest ?? blob.assetsMeta.assets[id]?.digest : undefined;
    const local = context.here[id];
    // Only an owned photo has a path in the book; any other one is never written to it.
    const target = path === undefined ? undefined : join(root, path);
    if (path !== undefined && target && wanted && !keepLocal.has(id) && !(local?.path === target && local.digest === wanted)) {
      // The bytes are here under another path (the photo was renamed, or copied into the book on another Mac): copied
      // to the new path, so nothing is downloaded and the photo stays available.
      const reuse = Object.values(context.here).find((entry) => entry.digest === wanted && entry.path !== undefined && entry.path !== target)?.path;
      if (reuse && !referenced.has(target) && await copyBeside(root, path, reuse, wanted)) {
        localDigests[id] = wanted;
        continue;
      }
    }
    // A kept local fact stays unrecorded, so it counts as ahead until a push carries it.
    if (!local || keepLocal.has(id)) continue;
    // An owned original the snapshot replaced goes, so the photo shows the new proxy until its new original is downloaded.
    if (path !== undefined && original && original.digest !== local.digest && local.path === target) { staleOriginals[path] = local.digest; continue; }
    // A photo without a file leaves no original behind: what this Mac saw of it is recorded as `localKeys`.
    if (local.path !== undefined) localDigests[id] = local.digest;
  }
  await storeProxies(proxies);
  const current = await captureBookState(root).catch(() => undefined);
  const templates = (content: Record<string, string>) => JSON.stringify(Object.entries(content).filter(([path]) => path.startsWith('template/')).sort());
  const marker: PullMarker = { targetCommit: tip.commitId, ...(synced ? { previousCommit: synced.commitId } : {}), stateDigest: tip.stateDigest,
    bookStateRevision: tip.bookStateRevision, templateChanged: !current || templates(current.contentDigests) !== templates(blob.content),
    staleOriginals, keepLocal: [...keepLocal], localDigests,
    // What a kept local fact was compared with stays as it is, so the fact counts as changed until a push carries it.
    localKeys: syncedKeys(context, synced, projected, keepLocal) };
  await preflightPull(root, marker);
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
  // Only a version the remote does not hold needs keeping. A book left half-pulled by a pull that was given up holds
  // nothing unique while it is unchanged since: before an abandoned fast-forward this Mac's version was on the remote,
  // and an abandoned Keep Both made its copy before it started. It is pulled again without another copy.
  const { abandoned } = await readSyncState(context.root);
  const halfPulled = !!abandoned?.bookStateRevision && abandoned.bookStateRevision === localRevision;
  const unsynced = !halfPulled && localRevision !== lastSynced?.bookStateRevision && !tips.some((tip) => tip.bookStateRevision === localRevision);
  // Everything is downloaded and verified first: a remote still syncing leaves neither a changed book nor a stray copy.
  const { marker } = await stagePull(context, target);
  const conflictCopy = unsynced ? await saveDocumentCopy(context.book, await conflictDestination(context.root, context.options.now?.() ?? new Date()), false) : undefined;
  await applyPull(context, conflictCopy ? { ...marker, conflictCopy } : marker);
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
  const photos = parseDocument(photoIndexSchema, JSON.parse(before['photos.json'].toString('utf8')), 'photos.json');
  const after = { ...before, 'project.json': Buffer.from(JSON.stringify(withBookFormat(parseDocument(projectSchema, { ...project, bookId: randomUUID() }, 'project.json'), photos), null, 2) + '\n') };
  await persistProjectManifests(root, before, after, { origin: 'app', label: 'Prepare sync' });
  return true;
}

export async function syncBook(options: SyncOptions): Promise<SyncOutcome> {
  const root = await realpath(options.book.folder);
  if (options.book.readOnly || !await holdsProjectLock(root)) throw new Error('Open the book for editing to sync it.');
  const registered = AssetFacts.registered(root);
  const context: Context = { root, remote: options.remote, book: options.book, stale: false, options, here: {} };
  try {
    const outcome = await decideAndSync(context);
    // The sync has succeeded; originals kept on this Mac come after it and never fail it.
    if (!options.fetchOriginals || (outcome.action === 'diverged' && !outcome.pulled)) return outcome;
    try {
      const { downloaded, notUploaded } = await fetchOriginals(root, options.remote);
      return { ...outcome, changed: outcome.changed || downloaded.length > 0, originals: { downloaded, ...(notUploaded ? { notUploaded } : {}) } };
    } catch (error) {
      return { ...outcome, originals: { downloaded: [], pending: error instanceof Error ? error.message : String(error) } };
    }
  } finally {
    // Facts this sync loaded for a book no session holds are written and dropped again.
    if (!registered) await AssetFacts.release(root).catch(() => {});
  }
}

async function decideAndSync(context: Context): Promise<SyncOutcome> {
  const { root, options } = context;
  // An interrupted pull is finished first; it was decided on before anything else changed.
  const interrupted = (await readSyncState(root)).pull;
  // One that cannot be finished is given up (`abandonPull`), and the decision below keeps both versions.
  if (interrupted) await finishPull(root, interrupted).catch((error) => console.warn('ImageFlow gave up an interrupted sync', error));
  const assigned = await ensureBookId(root);
  const changed = !!interrupted || assigned;
  context.stale = changed;
  const state = await readSyncState(root);
  if (state.pull) throw new Error('The interrupted sync could not be finished.');
  const facts = await refreshFacts(context);
  const local = await captureBookState(root);
  const bookId = local.project.bookId;
  if (!bookId) throw new Error('This book has no lineage ID yet. Make an edit, then sync.');
  // The push below asks about no content file or preview that the remote already has with a request of its own: over
  // a bucket, one listing of the book answers all of them.
  await options.remote.prepareSync?.(bookId);
  const commits = await remoteCommits(options.remote, bookId);
  const tips = deriveTips(commits);
  const synced = state.lastSynced;
  const factsChanged = !!synced && factsAhead(hereDigests(context), synced, hereKeys(context));
  const decision = decideSync({ pullInProgress: false, tips, commits, lastSynced: synced, localRevision: local.revision, factsChanged });
  switch (decision.action) {
    case 'resume': throw new Error('The interrupted sync could not be finished.');
    case 'remote-behind': throw new RemoteSyncingError('the version this Mac last synced is not on the remote yet.');
    case 'initial-push': {
      const { header } = await push(context, [], undefined, facts, undefined);
      return { action: 'initial-push', pushed: [header.commitId], changed };
    }
    case 'push': {
      const base = await fetchState(options.remote, bookId, synced!.stateDigest);
      const { header } = await push(context, [decision.tip.commitId], base, facts, synced);
      return { action: 'push', pushed: [header.commitId], changed };
    }
    case 'in-sync': {
      const blob = await fetchState(options.remote, bookId, decision.tip.stateDigest).catch(() => undefined);
      if (blob) await refetchProxies(context, bookId, blob);
      // Originals here that an older push left out (it found iCloud full) are named now; they upload after the commit.
      if (blob && await unnamedOriginals(context, blob)) {
        const { header } = await push(context, [decision.tip.commitId], blob, facts, synced);
        return { action: 'push', pushed: [header.commitId], changed };
      }
      // A photo without a file is compared from here on with what this Mac sees of it now, where it reads the photo
      // for the first time or sees it as the snapshot has it.
      const agreed = Object.entries(context.here).filter(([id, { key, digest }]) => key !== undefined && key !== synced!.localKeys?.[id] &&
        (synced!.localKeys?.[id] === undefined || synced!.photoDigests[id] === digest));
      if (agreed.length) await recordSynced(root, { ...synced!, localKeys: { ...synced!.localKeys, ...Object.fromEntries(agreed.map(([id, { key }]) => [id, key!])) } });
      return { action: 'in-sync', pushed: [], changed };
    }
    case 'adopt': {
      const blob = await fetchState(options.remote, bookId, decision.tip.stateDigest, decision.tip);
      const photoDigests = digestsOf(photoFacts(blob.assetsMeta.assets, local.photos));
      // Without a record of its own, every original here that differs from the snapshot counts as newer.
      const adopted = { commitId: decision.tip.commitId, bookId, bookStateRevision: decision.tip.bookStateRevision, stateDigest: decision.tip.stateDigest, photoDigests };
      const same = Object.entries(context.here).filter(([id, { digest }]) => photoDigests[id] === digest);
      await recordSynced(root, { ...adopted, localDigests: Object.fromEntries(same.filter(([, { path }]) => path !== undefined).map(([id, { digest }]) => [id, digest])),
        localKeys: Object.fromEntries(Object.entries(hereKeys(context)).filter(([id]) => photoDigests[id])) });
      await refetchProxies(context, bookId, blob);
      // Facts this Mac knows better than the snapshot go back with a commit of the same book state, and so do
      // originals here that it does not name.
      if (factsAhead(hereDigests(context), adopted, hereKeys(context)) || await unnamedOriginals(context, blob)) {
        const { header } = await push(context, [decision.tip.commitId], blob, facts, adopted);
        return { action: 'adopt', pushed: [header.commitId], changed };
      }
      return { action: 'adopt', pushed: [], changed };
    }
    case 'fast-forward': {
      const blob = await pull(context, decision.tip);
      const now = (await readSyncState(root)).lastSynced!;
      // The merge kept the facts of originals that changed here; they go back, never stale ones.
      if (factsAhead(hereDigests(context), now, hereKeys(context)) || await unnamedOriginals(context, blob)) {
        const { header } = await push(context, [decision.tip.commitId], blob, await readAssetFacts(root), now);
        return { action: 'fast-forward', pushed: [header.commitId], pulled: decision.tip.commitId, changed: true };
      }
      return { action: 'fast-forward', pushed: [], pulled: decision.tip.commitId, changed: true };
    }
    case 'diverged': {
      const outcome = await keepBoth(context, decision.tips, local.revision, synced);
      return { ...outcome, changed: outcome.changed || changed };
    }
  }
  throw new Error('Unknown sync decision.');
}

/**
 * Downloads owned originals that are only proxies on this Mac (all of them, or those of `ids`) from the last synced
 * snapshot, checking each digest, into photos/: before printing, or when asked. Returns the IDs downloaded.
 */
export async function downloadOriginals({ remote, book, ids }: { remote: SyncRemote; book: OpenProject; ids?: readonly string[] }) {
  const root = await realpath(book.folder);
  if (book.readOnly || !await holdsProjectLock(root)) throw new Error('Open the book for editing to download its originals.');
  return (await fetchOriginals(root, remote, ids)).downloaded;
}

/**
 * The owned originals of the last synced snapshot that photos/ lacks, each with whether the remote has it (`uploaded`):
 * a commit names its originals before they upload (`uploadOriginals`), so one the remote lacks is still uploading
 * from another Mac, which is no error. A file at the path is never replaced: it is this Mac's own original (one
 * replaced by the snapshot was removed by the pull), and its fact wins until it syncs.
 */
async function missingOriginals(root: string, remote: SyncRemote, bookId: string, blob: StateBlob, ids?: readonly string[]) {
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const missing: { id: string; path: string; original: StateBlob['originals'][string]; uploaded: boolean }[] = [];
  for (const [id, original] of Object.entries(blob.originals)) {
    const photo = photos[id];
    const path = photo && syncedOriginalPath(photo);
    if ((ids && !ids.includes(id)) || !path?.startsWith('photos/')) continue;
    if (await lstat(await bookPath(root, path, { checking: true })).catch(() => undefined)) continue;
    missing.push({ id, path, original, uploaded: false });
  }
  if (!missing.length) return missing;
  const there = new Set((await remote.listBook(bookId, 'originals')).map(({ key }) => key));
  return missing.map((entry) => ({ ...entry, uploaded: there.has(originalBlobKey(bookId, entry.original.digest, entry.original.ext)) }));
}

/**
 * The book a synced commit's blobs are stored under: the one its sync record names, whatever project.json says by now
 * (a book that syncs again as a new history gets a new ID there). Records from before the ID was kept fall back to it.
 */
async function syncedBookId(root: string, synced: SyncedCommit) {
  if (synced.bookId) return synced.bookId;
  const { bookId } = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as { bookId?: unknown };
  if (typeof bookId !== 'string') throw new Error('This book has no lineage ID yet. Make an edit, then sync.');
  return bookId;
}

/** An original downloaded into the book's root and checked, waiting to go to its place in photos/. */
export type StagedOriginal = { id: string; path: string; staging: string };

/**
 * The first half of a download that leaves the book usable: the owned originals photos/ lacks are downloaded one by one
 * into `.imageflow-write-*.tmp` files in the book's root (which revision tracking ignores) and checked against their
 * digests, without holding the book. Originals another Mac has not uploaded yet are left for later, and `notUploaded`
 * is told how many. `signal` stops between files; what was downloaded by then is returned, whole. `placeOriginals`
 * then moves them into place while the session holds the book.
 */
export async function stageOriginals({ remote, folder, signal, progress, notUploaded }: { remote: SyncRemote; folder: string; signal?: AbortSignal;
  progress?: (done: number, total: number) => void; notUploaded?: (count: number) => void }): Promise<StagedOriginal[]> {
  const root = await realpath(folder);
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return [];
  const bookId = await syncedBookId(root, synced);
  const all = await missingOriginals(root, remote, bookId, await fetchState(remote, bookId, synced.stateDigest));
  const missing = all.filter(({ uploaded }) => uploaded);
  let away = all.length - missing.length;
  const staged: StagedOriginal[] = [];
  progress?.(0, missing.length);
  try {
    for (const { id, path, original } of missing) {
      if (signal?.aborted) break;
      const staging = join(root, '.imageflow-write-' + randomUUID() + '.tmp');
      const downloaded = await remote.downloadBlob(originalBlobKey(bookId, original.digest, original.ext), staging);
      // Gone since it was listed: the remote lost it, and the Mac that has it uploads it again.
      if (!downloaded) { away++; continue; }
      if (await fileDigest(staging) !== original.digest) {
        await rm(staging, { force: true });
        throw new RemoteSyncingError('an original photo has not fully arrived yet.');
      }
      staged.push({ id, path, staging });
      progress?.(staged.length, missing.length);
    }
    notUploaded?.(away);
    return staged;
  } catch (error) {
    await Promise.all(staged.map(({ staging }) => rm(staging, { force: true })));
    throw error;
  }
}

/**
 * The second half: each staged original goes to its path, unless the book has a file there by now (this Mac's own,
 * which wins) or no longer names it. Staged files that are not placed are removed. Returns the photos placed.
 */
export async function placeOriginals(folder: string, staged: readonly StagedOriginal[]) {
  const root = await realpath(folder);
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const placed: string[] = [];
  for (const { id, path, staging } of staged) {
    try {
      const photo = photos[id];
      if (!photo || packagePath(photo) !== path || await lstat(await bookPath(root, path, { checking: true })).catch(() => undefined)) continue;
      await rename(staging, await bookPath(root, path));
      placed.push(id);
    } finally { await rm(staging, { force: true }); }
  }
  return placed;
}

/**
 * The owned originals of the last synced snapshot that are not on this Mac, without hashing anything, and those of
 * them that another Mac has not uploaded yet (`notUploaded`).
 */
export async function originalsNotHere(folder: string, remote: SyncRemote): Promise<{ ids: string[]; notUploaded: string[] }> {
  const root = await realpath(folder);
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return { ids: [], notUploaded: [] };
  const bookId = await syncedBookId(root, synced).catch(() => undefined);
  const blob = bookId && await fetchState(remote, bookId, synced.stateDigest).catch(() => undefined);
  if (!bookId || !blob) return { ids: [], notUploaded: [] };
  const missing = await missingOriginals(root, remote, bookId, blob);
  return { ids: missing.map(({ id }) => id), notUploaded: missing.filter(({ uploaded }) => !uploaded).map(({ id }) => id) };
}

/** The owned originals of the last synced snapshot that are not on this Mac, without hashing anything. */
export async function pendingOriginals(folder: string, remote: SyncRemote) {
  return (await originalsNotHere(folder, remote).catch(() => ({ ids: [] as string[] }))).ids;
}

async function fetchOriginals(root: string, remote: SyncRemote, ids?: readonly string[]) {
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return { downloaded: [], notUploaded: 0 };
  const bookId = await syncedBookId(root, synced);
  const blob = await fetchState(remote, bookId, synced.stateDigest);
  const downloaded: string[] = [];
  let notUploaded = 0;
  for (const { id, path, original, uploaded } of await missingOriginals(root, remote, bookId, blob, ids)) {
    // Still uploading from another Mac: downloaded once it has arrived.
    if (!uploaded) { notUploaded++; continue; }
    const target = await bookPath(root, path);
    // Staged beside its target, so a transport on the same volume can clone it, and removed whatever happens.
    const staging = join(dirname(target), '.imageflow-write-' + randomUUID() + '.tmp');
    try {
      if (!await remote.downloadBlob(originalBlobKey(bookId, original.digest, original.ext), staging)) { notUploaded++; continue; }
      if (await fileDigest(staging) !== original.digest) throw new RemoteSyncingError('an original photo has not fully arrived yet.');
      await rename(staging, target);
    } finally { await rm(staging, { force: true }); }
    downloaded.push(id);
  }
  return { downloaded, notUploaded };
}

/**
 * What a book's owned originals take up on this Mac, in bytes: what syncing it would upload at most, for the sheet that
 * asks which books to sync when a backend is first set up. Reads only photos.json and the files' sizes.
 */
export async function ownedOriginalsSize(folder: string) {
  const root = await realpath(folder);
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  let bytes = 0;
  for (const path of new Set(Object.values(photos).flatMap((photo) => { const path = syncedOriginalPath(photo); return path?.startsWith('photos/') ? [path] : []; }))) {
    const info = await lstat(await bookPath(root, path, { checking: true })).catch(() => undefined);
    if (info?.isFile()) bytes += info.size;
  }
  return bytes;
}

/** An owned original the last synced snapshot names, that is here, and that the remote lacks: still to upload. */
export type PendingUpload = { id: string; path: string; key: string; digest: string };

/**
 * What is still to upload of a book (ADR 0012, section 2), derived rather than recorded: the owned originals that the
 * snapshot this Mac last synced names, whose file is here, and that the remote's listing of the book's originals
 * lacks. It survives a restart and a pull or push in between (a later snapshot carries the entry forward), and it
 * repairs an original the remote lost, from any Mac that holds the file. Over a store with a change feed the listing
 * comes from the key index, so this is not a full listing of the book's records.
 */
export async function pendingUploads(folder: string, remote: SyncRemote): Promise<PendingUpload[]> {
  const root = await realpath(folder);
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return [];
  const bookId = await syncedBookId(root, synced);
  const blob = await fetchState(remote, bookId, synced.stateDigest);
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const named = Object.entries(blob.originals).flatMap(([id, original]) => {
    const photo = photos[id];
    const path = photo && syncedOriginalPath(photo);
    return path?.startsWith('photos/') ? [{ id, path, key: originalBlobKey(bookId, original.digest, original.ext), digest: original.digest }] : [];
  });
  if (!named.length) return [];
  const there = new Set((await remote.listBook(bookId, 'originals')).map(({ key }) => key));
  const pending = new Map<string, PendingUpload>();
  for (const { id, path, key, digest } of named) {
    if (there.has(key) || pending.has(key)) continue;
    const file = await bookPath(root, path, { checking: true }).catch(() => undefined);
    if (file && (await lstat(file).catch(() => undefined))?.isFile()) pending.set(key, { id, path: file, key, digest });
  }
  return [...pending.values()];
}

/** An upload clone (`uploadClonePrefix`) a store made beside an original. */
const uploadClone = /^\.imageflow-upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** Removes the upload clones a crash left in photos/. Only while no upload of the book runs. Never fails. */
async function sweepUploadClones(root: string) {
  try {
    for (const entry of await readdir(join(root, 'photos'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !uploadClone.test(entry.name)) continue;
      await unlink(join(entry.parentPath, entry.name)).catch(() => {});
    }
  } catch { /* best effort */ }
}

/** The remote a book's background upload uses, with its identity, from the app's sync service at each use. */
export type UploadConnection = { remote: SyncRemote; remoteId: string };
/**
 * How a background upload ended: what went up, what is left, originals that changed here since the commit named them
 * (`changed`; the next sync names their new version), and why it stopped early: the remote is full (`full`, the queue
 * pauses), the book no longer syncs with the remote it was asked about (`elsewhere`: another Apple ID or bucket, or Stop
 * Syncing), or it was cancelled.
 */
export type UploadOutcome = { uploaded: number; left: number; changed: number; full?: StoreFullError; stopped?: 'elsewhere' | 'cancelled' };

/**
 * Uploads a book's pending originals (`pendingUploads`) in the background, after the commit that named them, without
 * the writer lock. For each photo the remote is taken anew from `connect` (the app's sync service) and its identity
 * compared with the one the book syncs with, so an Apple ID change or a changed bucket never receives another remote's
 * originals. Each file's SHA-256 is checked before the upload and the store checks it while it uploads, so an edit
 * after the commit never puts other bytes under the digest. A full remote stops the queue at the first original that
 * does not fit (`full`), instead of failing each in turn. `progress` gets the originals uploaded of those pending.
 */
export async function uploadOriginals({ folder, connect, signal, progress }: { folder: string; connect: () => Promise<UploadConnection>;
  signal?: AbortSignal; progress?: (done: number, total: number) => void }): Promise<UploadOutcome> {
  const root = await realpath(folder);
  /** The remote the book syncs with on this Mac, or undefined when it does not sync (any more) or never synced. */
  const syncsWith = async () => {
    const state = await readSyncState(root);
    return state.enabled !== false && state.lastSynced ? state.remoteId : undefined;
  };
  const expected = await syncsWith();
  const outcome: UploadOutcome = { uploaded: 0, left: 0, changed: 0 };
  if (!expected) return outcome;
  let connection = await connect();
  if (connection.remoteId !== expected) return { ...outcome, stopped: 'elsewhere' };
  await sweepUploadClones(root);
  const pending = await pendingUploads(root, connection.remote);
  progress?.(0, pending.length);
  for (const [index, { path, key, digest }] of pending.entries()) {
    const left = pending.length - index;
    if (signal?.aborted) return { ...outcome, left, stopped: 'cancelled' };
    // The remote anew for each photo: the account or the bucket may have changed since the commit, or since the last one.
    if (index > 0) connection = await connect();
    if (connection.remoteId !== expected || await syncsWith() !== expected) return { ...outcome, left, stopped: 'elsewhere' };
    if (await fileDigest(path).catch(() => undefined) !== digest) { outcome.changed++; continue; }
    try { await connection.remote.putBlob(key, { file: path }, { sha256: digest, signal }); }
    catch (error) {
      if (signal?.aborted) return { ...outcome, left, stopped: 'cancelled' };
      if (error instanceof StoreFullError) return { ...outcome, left, full: error };
      // Changed while it uploaded: the store refused bytes without the digest, and the next sync names the new version.
      if (await fileDigest(path).catch(() => undefined) !== digest) { outcome.changed++; continue; }
      throw error;
    }
    outcome.uploaded++;
    progress?.(outcome.uploaded, pending.length);
  }
  return outcome;
}

/**
 * Open Synced Book (#251): makes a new local book at `destination` from a commit on the remote, for a Mac that
 * has no copy of it yet. Content, the manifests (linked sources unlocated, as on any Mac that has not located them)
 * and the snapshot's facts are written into a staging folder and checked against the commit's revision before the
 * book appears under its name; proxies go to the proxy store, and owned originals stay on the remote until downloaded.
 * The new book records the commit as synced and, with `remoteId`, syncs on this Mac with that remote.
 *
 * It is not trusted (ADR 0006): its template comes from an unauthenticated remote, so it asks before reaching any site.
 */
export async function cloneFromRemote({ remote, tip, destination, remoteId }: { remote: SyncRemote; tip: CommitHeader; destination: string; remoteId?: string }) {
  const folder = join(await realpath(dirname(destination)), basename(documentPath(destination)));
  const { blob } = await fetchStateBytes(remote, tip.bookId, tip.stateDigest, tip);
  const staging = join(dirname(folder), '.imageflow-create-' + randomUUID());
  let reserved = false;
  let facts: Record<string, AssetFact> = {};
  try {
    await mkdir(staging);
    await mkdir(join(staging, 'photos'));
    for (const [path, digest] of Object.entries(blob.content)) {
      const target = await bookPath(staging, path);
      if (!await remote.downloadBlob(contentBlobKey(tip.bookId, digest), target) || await fileDigest(target) !== digest) {
        throw new RemoteSyncingError('a file of this book has not fully arrived yet.');
      }
    }
    const projected = projectManifests(blob, {});
    const photos = parseDocument(photoIndexSchema, projected.photos, 'photos.json');
    const project = withBookFormat(parseDocument(projectSchema, projected.project, 'project.json'), photos);
    await writeFile(join(staging, 'project.json'), JSON.stringify(project, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(staging, 'photos.json'), JSON.stringify(photos, null, 2) + '\n', { flag: 'wx' });
    facts = photoFacts(blob.assetsMeta.assets, photos);
    await AssetFacts.adoptSynced(staging, facts);
    await storeProxies(await fetchProxies(remote, tip.bookId, await missingProxies(blob, photos, {})));
    if (await captureBookState(staging).then(({ revision }) => revision) !== tip.bookStateRevision) {
      throw new Error('The book on the remote does not match its commit. Nothing was created.');
    }
    // Reserve the name exclusively: never replace a book that is already there, even an empty package.
    try { await mkdir(folder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A book named “' + basename(folder) + '” already exists there. Choose another name.', { cause: error });
      throw error;
    }
    reserved = true;
    await rename(staging, folder);
    reserved = false;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (reserved) await rmdir(folder).catch(() => {});
  }
  await updateSyncState(folder, () => ({ version: 1, ...(remoteId ? { remoteId, enabled: true } : {}),
    lastSynced: { commitId: tip.commitId, bookId: tip.bookId, bookStateRevision: tip.bookStateRevision, stateDigest: tip.stateDigest, photoDigests: digestsOf(facts), localDigests: {} } }));
  return folder;
}

/**
 * A book's sync status without changing anything (#251), for the status bar: what Sync would do now, from the remote's
 * tips, this Mac's sync record and the book's revision. Photo facts are left out (a fact this Mac knows better is
 * pushed by the next sync, but does not count as ahead here), and so is anything a sync would find still arriving.
 */
export async function describeSync(folder: string, remote: SyncRemote): Promise<SyncStatus> {
  try {
    const root = await realpath(folder);
    const state = await readSyncState(root);
    const away = await originalsNotHere(root, remote).catch(() => ({ ids: [], notUploaded: [] }));
    const base = { pendingOriginals: away.ids.length, ...(away.notUploaded.length ? { notUploaded: away.notUploaded.length } : {}) };
    // A pull given up stays the status until a sync succeeds: the book may be half-pulled.
    if (state.abandoned) return { ...base, state: 'abandoned', detail: state.abandoned.error };
    const local = await captureBookState(root);
    const bookId = local.project.bookId;
    if (!bookId) return { ...base, state: 'ahead' };
    const commits = await remoteCommits(remote, bookId);
    const tips = deriveTips(commits);
    const decision = decideSync({ pullInProgress: !!state.pull, tips, commits, lastSynced: state.lastSynced, localRevision: local.revision, factsChanged: false });
    const states: Record<SyncDecision['action'], SyncStatus['state']> = { 'resume': 'behind', 'remote-behind': 'remote-syncing', 'initial-push': 'ahead',
      'push': 'ahead', 'in-sync': 'in-sync', 'adopt': 'in-sync', 'fast-forward': 'behind', 'diverged': 'diverged' };
    const synced = state.lastSynced;
    const remoteState = !synced || state.pull || decision.action === 'remote-behind' ? undefined
      : tips.length > 1 ? 'forked' as const : tips[0]?.commitId === synced.commitId ? 'same' as const : 'moved' as const;
    return { ...base, state: states[decision.action], ...(decision.action === 'diverged' ? { tips: decision.tips.length } : {}),
      ...(remoteState ? { remote: remoteState } : {}) };
  } catch (error) {
    if (error instanceof NewerSyncFormatError) return { state: 'newer', detail: error.message, pendingOriginals: 0 };
    if (error instanceof StoreAccessError) return unavailableStatus(error.message, error.reason);
    return { state: 'unavailable', detail: error instanceof Error ? error.message : String(error), pendingOriginals: 0 };
  }
}

/**
 * The status of a remote that cannot be used. A key the bucket refuses (`sign-in`) and a bucket, region or endpoint
 * that is wrong (`settings`) are fixed in Settings → Sync, so the status bar points there; a clock that is off and a
 * remote out of reach only say why.
 */
export function unavailableStatus(detail: string, access?: StoreAccessReason): SyncStatus {
  return { state: 'unavailable', detail, pendingOriginals: 0, ...(access === 'sign-in' ? { signIn: true as const } : access === 'settings' ? { checkSettings: true as const } : {}) };
}

/**
 * The status after an edit here, without reading the remote (#251): the remote as `previous` last saw it, against
 * the book's revision now. Statuses that depend on the remote alone stay as they were.
 */
export async function describeLocalChange(folder: string, previous: SyncStatus): Promise<SyncStatus> {
  if (!previous.remote) return previous;
  const state = await readSyncState(folder);
  if (!state.lastSynced || state.abandoned || state.pull) return previous;
  const edited = await captureBookStateRevision(folder) !== state.lastSynced.bookStateRevision;
  const next: SyncStatus['state'] = previous.remote === 'forked' ? 'diverged' : previous.remote === 'moved' ? (edited ? 'diverged' : 'behind') : edited ? 'ahead' : 'in-sync';
  const { tips: _, ...rest } = previous;
  return { ...rest, state: next, ...(next === 'diverged' && previous.tips ? { tips: previous.tips } : {}) };
}
