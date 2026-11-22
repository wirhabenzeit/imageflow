import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import type { AssetFact } from '../src/asset-facts';
import { parseDocument, photoIndexSchema, projectSchema, withBookFormat } from '../src/project';
import type { PhotoIndex } from '../src/project';
import { sourceEntries } from '../src/source-locations';
import { packagePath } from '../src/source-locator';
import { changedOriginals, commitHeaderSchema, contentBlobKey, decideSync, deriveTips, encodeStateBlob, factsAhead, newerStateBlob, NewerSyncFormatError, originalBlobKey, portableManifests,
  projectManifests, proxyBlobKey, stateBlobSchema, stateMatchesHeader } from '../src/sync-snapshot';
import type { CommitHeader, StateBlob, SyncDecision, SyncedCommit } from '../src/sync-snapshot';
import type { SyncStatus } from '../src/desktop';
import { AssetFacts, readAssetFacts } from './asset-facts';
import { documentPath } from './documents';
import { holdsProjectLock, persistProjectManifests } from './persistence';
import { photoDetails, photoFile } from './photos';
import { loadProject } from './project';
import type { OpenProject } from './project';
import { proxyStore } from './proxy-store';
import { captureBookState, captureBookStateRevision } from './revisions';
import { saveDocumentCopy } from './source-actions';
import { SourceStore } from './source-store';
import { bookPath, finishPull, preflightPull, readSyncState, stagingFolder, updateSyncState } from './sync-pull';
import type { PullMarker } from './sync-pull';
import { remoteCommits } from './sync-remote';
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
   * With `fetchOriginals`: the originals downloaded after the sync, and why the rest are still pending. A failed
   * download never fails the sync, which had succeeded by then; the next sync or an explicit download retries.
   */
  originals?: { downloaded: string[]; pending?: string };
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

const hereDigests = (context: Context) => Object.fromEntries(Object.entries(context.here).map(([id, { digest }]) => [id, digest]));
const photoFacts = (facts: Record<string, AssetFact>, photos: PhotoIndex) => Object.fromEntries(Object.entries(facts).filter(([id]) => photos[id]));
const digestsOf = (facts: Record<string, AssetFact>) => Object.fromEntries(Object.entries(facts).map(([id, fact]) => [id, fact.digest]));

/** A state blob from the remote, checked against its digest, its schema and, with a header, its revision. */
async function fetchState(remote: SyncRemote, stateDigest: string, header?: CommitHeader): Promise<StateBlob> {
  return (await fetchStateBytes(remote, stateDigest, header)).blob;
}
/** The same, with the bytes as stored, which a pull stages: re-encoding would drop fields a newer version added. */
async function fetchStateBytes(remote: SyncRemote, stateDigest: string, header?: CommitHeader) {
  const bytes = await remote.getBlob(contentBlobKey(stateDigest));
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
  await storeProxies(await fetchProxies(context.remote, await missingProxies(blob, photos, hereDigests(context))));
}

/** The open book as on disk now, for renditions of originals: reloaded after a pull or an import changed it. */
async function currentBook(context: Context) {
  const stale = context.stale || Object.entries(context.here).some(([id, { path }]) => context.book.photos.get(id)?.original !== path ||
    context.book.sources?.['photo:' + id]?.state !== 'available' || context.book.sources?.['photo:' + id]?.cached);
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
async function uploadProxy(remote: SyncRemote, digest: string, bytes: Uint8Array, ext: '.jpg' | '.png') {
  const key = proxyBlobKey(digest, ext);
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
 * Pushes the book as it is now: its content, owned originals and proxies the remote lacks, then the state blob, then
 * the commit header. Entries for photos whose original is not on this Mac (not located, not downloaded) are carried
 * forward from `base`, the last synced snapshot, or taken from the local proxy store.
 */
async function push(context: Context, parents: string[], base: StateBlob | undefined, facts: Record<string, AssetFact>, synced: SyncedCommit | undefined) {
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
  // A photo's fact from here goes up only when its original changed here since the last sync (or the snapshot lacks
  // one); an original merely left at an older digest never pushes that digest back over another Mac's re-export.
  const changed = changedOriginals(hereDigests(context), synced);
  const remoteFacts = photoFacts(base?.assetsMeta.assets ?? {}, state.photos);
  const assets = Object.fromEntries(Object.keys(state.photos).flatMap((id) => {
    const fact = (changed.has(id) ? facts[id] : remoteFacts[id]) ?? facts[id] ?? remoteFacts[id];
    return fact ? [[id, fact]] : [];
  }));
  const originals: StateBlob['originals'] = {};
  for (const [id, photo] of Object.entries(state.photos)) {
    // Only the package's own photos sync as originals (ADR 0011, Sync between Macs).
    const owned = packagePath(photo);
    if (owned === undefined) continue;
    const here = context.here[id];
    if (here && here.digest === assets[id]?.digest) {
      const entry = { digest: here.digest, ext: extname(owned).toLowerCase() };
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
    // Unchanged photos keep the proxy the last snapshot recorded: nothing is read, decoded or downloaded again.
    if (base?.proxies[digest]) { proxies[digest] = base.proxies[digest]; continue; }
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
  await recordSynced(root, { commitId: header.commitId, bookStateRevision: header.bookStateRevision, stateDigest, photoDigests: digestsOf(assets),
    localDigests: Object.fromEntries(Object.entries(hereDigests(context)).filter(([id]) => assets[id]?.digest === context.here[id].digest)) });
  return { header, blob };
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
  const { blob, bytes } = await fetchStateBytes(remote, tip.stateDigest, tip);
  const staging = await stagingFolder(root, true);
  await writeFile(join(staging, tip.stateDigest), bytes);
  for (const digest of new Set(Object.values(blob.content))) {
    const path = join(staging, digest);
    if (!await remote.downloadBlob(contentBlobKey(digest), path) || await fileDigest(path) !== digest) {
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
  const keepLocal = new Set([...changedOriginals(here, synced)].filter((id) => projected[id]));
  const proxies = await fetchProxies(remote, await missingProxies(blob, projected, here, keepLocal));
  const staleOriginals: PullMarker['staleOriginals'] = {};
  const localDigests: PullMarker['localDigests'] = {};
  for (const [id, photo] of Object.entries(projected)) {
    const path = packagePath(photo);
    const owned = !!path?.startsWith('photos/');
    const original = owned ? blob.originals[id] : undefined;
    const wanted = owned ? original?.digest ?? blob.assetsMeta.assets[id]?.digest : undefined;
    const local = context.here[id];
    // Only an owned photo has a path in the book; any other one is never written to it.
    const target = path === undefined ? undefined : join(root, path);
    if (path !== undefined && target && wanted && !keepLocal.has(id) && !(local?.path === target && local.digest === wanted)) {
      // The bytes are here under another path (the photo was renamed, or copied into the book on another Mac): copied
      // to the new path, so nothing is downloaded and the photo stays available.
      const reuse = Object.values(context.here).find((entry) => entry.digest === wanted && entry.path !== target);
      if (reuse && !referenced.has(target) && await copyBeside(root, path, reuse.path, wanted)) {
        localDigests[id] = wanted;
        continue;
      }
    }
    // A kept local fact stays unrecorded, so it counts as ahead until a push carries it.
    if (!local || keepLocal.has(id)) continue;
    // An owned original the snapshot replaced goes, so the photo shows the new proxy until its new original is downloaded.
    if (path !== undefined && original && original.digest !== local.digest && local.path === target) { staleOriginals[path] = local.digest; continue; }
    localDigests[id] = local.digest;
  }
  await storeProxies(proxies);
  const current = await captureBookState(root).catch(() => undefined);
  const templates = (content: Record<string, string>) => JSON.stringify(Object.entries(content).filter(([path]) => path.startsWith('template/')).sort());
  const marker: PullMarker = { targetCommit: tip.commitId, ...(synced ? { previousCommit: synced.commitId } : {}), stateDigest: tip.stateDigest,
    bookStateRevision: tip.bookStateRevision, templateChanged: !current || templates(current.contentDigests) !== templates(blob.content),
    staleOriginals, keepLocal: [...keepLocal], localDigests };
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
      const downloaded = await fetchOriginals(root, options.remote);
      return { ...outcome, changed: outcome.changed || downloaded.length > 0, originals: { downloaded } };
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
  const commits = await remoteCommits(options.remote, bookId);
  const tips = deriveTips(commits);
  const synced = state.lastSynced;
  const factsChanged = !!synced && factsAhead(hereDigests(context), synced);
  const decision = decideSync({ pullInProgress: false, tips, commits, lastSynced: synced, localRevision: local.revision, factsChanged });
  switch (decision.action) {
    case 'resume': throw new Error('The interrupted sync could not be finished.');
    case 'remote-behind': throw new RemoteSyncingError('the version this Mac last synced is not on the remote yet.');
    case 'initial-push': {
      const { header } = await push(context, [], undefined, facts, undefined);
      return { action: 'initial-push', pushed: [header.commitId], changed };
    }
    case 'push': {
      const base = await fetchState(options.remote, synced!.stateDigest);
      const { header } = await push(context, [decision.tip.commitId], base, facts, synced);
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
      // Without a record of its own, every original here that differs from the snapshot counts as newer.
      const adopted = { commitId: decision.tip.commitId, bookStateRevision: decision.tip.bookStateRevision, stateDigest: decision.tip.stateDigest, photoDigests };
      await recordSynced(root, { ...adopted, localDigests: Object.fromEntries(Object.entries(hereDigests(context)).filter(([id, digest]) => photoDigests[id] === digest)) });
      await refetchProxies(context, blob);
      // Facts this Mac knows better than the snapshot go back with a commit of the same book state.
      if (factsAhead(hereDigests(context), adopted)) {
        const { header } = await push(context, [decision.tip.commitId], blob, facts, adopted);
        return { action: 'adopt', pushed: [header.commitId], changed };
      }
      return { action: 'adopt', pushed: [], changed };
    }
    case 'fast-forward': {
      const blob = await pull(context, decision.tip);
      const now = (await readSyncState(root)).lastSynced!;
      // The merge kept the facts of originals that changed here; they go back, never stale ones.
      if (factsAhead(hereDigests(context), now)) {
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
  return fetchOriginals(root, remote, ids);
}

/**
 * The owned originals of the last synced snapshot that photos/ lacks. A file at the path is never replaced: it is
 * this Mac's own original (one replaced by the snapshot was removed by the pull), and its fact wins until it syncs.
 */
async function missingOriginals(root: string, blob: StateBlob, ids?: readonly string[]) {
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const missing: { id: string; path: string; original: StateBlob['originals'][string] }[] = [];
  for (const [id, original] of Object.entries(blob.originals)) {
    const photo = photos[id];
    const path = photo && packagePath(photo);
    if ((ids && !ids.includes(id)) || !path?.startsWith('photos/')) continue;
    if (await lstat(await bookPath(root, path, { checking: true })).catch(() => undefined)) continue;
    missing.push({ id, path, original });
  }
  return missing;
}

/** The owned originals of the last synced snapshot that are not on this Mac, without hashing anything. */
export async function pendingOriginals(folder: string, remote: SyncRemote) {
  const root = await realpath(folder);
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return [];
  const blob = await fetchState(remote, synced.stateDigest).catch(() => undefined);
  return blob ? (await missingOriginals(root, blob)).map(({ id }) => id) : [];
}

async function fetchOriginals(root: string, remote: SyncRemote, ids?: readonly string[]) {
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return [];
  const blob = await fetchState(remote, synced.stateDigest);
  const downloaded: string[] = [];
  for (const { id, path, original } of await missingOriginals(root, blob, ids)) {
    const target = await bookPath(root, path);
    // Staged beside its target, so a transport on the same volume can clone it, and removed whatever happens.
    const staging = join(dirname(target), '.imageflow-write-' + randomUUID() + '.tmp');
    try {
      if (!await remote.downloadBlob(originalBlobKey(original.digest, original.ext), staging) || await fileDigest(staging) !== original.digest) {
        throw new RemoteSyncingError('an original photo has not fully arrived yet.');
      }
      await rename(staging, target);
    } finally { await rm(staging, { force: true }); }
    downloaded.push(id);
  }
  return downloaded;
}

/**
 * Open from Sync Folder (#251): makes a new local book at `destination` from a commit on the remote, for a Mac that
 * has no copy of it yet. Content, the manifests (linked sources unlocated, as on any Mac that has not located them)
 * and the snapshot's facts are written into a staging folder and checked against the commit's revision before the
 * book appears under its name; proxies go to the proxy store, and owned originals stay on the remote until downloaded.
 * The new book records the commit as synced and, with `syncFolder`, syncs through that folder.
 *
 * It is not trusted (ADR 0006): its template comes from an unauthenticated folder, so it asks before reaching any site.
 */
export async function cloneFromRemote({ remote, tip, destination, syncFolder }: { remote: SyncRemote; tip: CommitHeader; destination: string; syncFolder?: string }) {
  const folder = join(await realpath(dirname(destination)), basename(documentPath(destination)));
  const { blob } = await fetchStateBytes(remote, tip.stateDigest, tip);
  const staging = join(dirname(folder), '.imageflow-create-' + randomUUID());
  let reserved = false;
  let facts: Record<string, AssetFact> = {};
  try {
    await mkdir(staging);
    await mkdir(join(staging, 'photos'));
    for (const [path, digest] of Object.entries(blob.content)) {
      const target = await bookPath(staging, path);
      if (!await remote.downloadBlob(contentBlobKey(digest), target) || await fileDigest(target) !== digest) {
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
    await storeProxies(await fetchProxies(remote, await missingProxies(blob, photos, {})));
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
  await updateSyncState(folder, () => ({ version: 1, ...(syncFolder ? { folder: syncFolder } : {}),
    lastSynced: { commitId: tip.commitId, bookStateRevision: tip.bookStateRevision, stateDigest: tip.stateDigest, photoDigests: digestsOf(facts), localDigests: {} } }));
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
    const pendingIds = await pendingOriginals(root, remote).catch(() => []);
    const base = { pendingOriginals: pendingIds.length };
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
    return { state: 'unavailable', detail: error instanceof Error ? error.message : String(error), pendingOriginals: 0 };
  }
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
