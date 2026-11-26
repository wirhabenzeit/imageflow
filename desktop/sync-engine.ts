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
import { changedOriginals, commitHeaderSchema, commitHeaderVersion, contentBlobKey, coverBlobKey, decideSync, deriveTips, encodeStateBlob, factsAhead, newerStateBlob, NewerSyncFormatError, originalBlobKey, portableManifests,
  projectManifests, proxyBlobKey, stateBlobSchema, stateMatchesHeader } from '../src/sync-snapshot';
import type { CommitHeader, StateBlob, SyncDecision, SyncedCommit } from '../src/sync-snapshot';
import type { SyncStatus } from '../src/desktop';
import { AssetFacts, readAssetFacts } from './asset-facts';
import { documentPath } from './documents';
import { holdsProjectLock, persistProjectManifests } from './persistence';
import { trustBook } from './source-access';
import { photoDetails, photoFile } from './photos';
import { loadProject, observePhotos } from './project';
import type { OpenProject } from './project';
import { contentKey } from './provided-photos';
import { proxyStore } from './proxy-store';
import { captureBookState, captureBookStateRevision } from './revisions';
import { saveDocumentCopy } from './source-actions';
import { SourceStore } from './source-store';
import { bookPath, copySource, finishPull, keptOriginals, preflightPull, readSyncState, stagingFolder, SyncHalfPulledError, updateSyncState } from './sync-pull';
import type { PullMarker, SyncState } from './sync-pull';
import { abortableRemote, BookDeletedError, remoteCommits } from './sync-remote';
import type { SyncRemote } from './sync-remote';
import { StoreAccessError, StoreFullError, uploadClonePrefix } from './sync-store';
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
  /**
   * The book's cached 320 px JPEG cover (the app keeps it with the recent books, made in the background), for the
   * library on other Macs. It may be missing or older than the book; a push then carries its parent's cover forward.
   */
  cover?: () => Promise<Uint8Array | undefined>;
  /** The name of this Mac, recorded with the originals a push names first, for "never uploaded from …". */
  device?: string;
  now?: () => Date;
  /**
   * An automatic sync (#284): it applies a fast-forward and pushes, and nothing else. A divergence, with one remote tip
   * or several, is left as it is (`diverged` without `pulled`): no conflict copy, no overwrite of the book and no commit
   * that closes a fork, also when another Mac pushed between the listing and this Mac's commit (that commit then makes a
   * second tip, which the next sync reports). The user chooses with Sync Now.
   */
  fastForwardOnly?: boolean;
  /**
   * Never changes the book (an automatic push while an editor is open, the push when a book closes): a sync that would
   * pull, or finish an interrupted pull, or give the book its lineage ID, changes nothing (`deferred`), and no original
   * is downloaded or replaced. Implies `fastForwardOnly`.
   */
  pushOnly?: boolean;
  /**
   * Stops the sync (the bounded push when a book closes, an edit during an automatic sync): every request to the remote
   * that runs or would start rejects with the signal's reason at once, and the sync rejects at its next request or
   * local step. What a stopped push stored is harmless: blobs are content-addressed. A commit request that was sent is
   * the exception: it is waited for and recorded (`abortableRemote`), so a stopped push never leaves a commit of this
   * Mac that it does not know, which an edit after it would fork from.
   */
  signal?: AbortSignal;
  /**
   * Asked immediately before an automatic sync changes the book (#284): before a staged fast-forward is applied, before
   * an interrupted pull is finished, and before older originals a pull kept are replaced. False leaves the book as it
   * is (`deferred`): an editor opened while the sync read the remote. Everything is staged by then; nothing is lost.
   */
  beforeApply?: () => boolean | Promise<boolean>;
  /** The previews `uploadAhead` stored or checked for this remote; a push neither sends nor reads them again. */
  ahead?: UploadedPreviews;
};
/**
 * Previews known to be whole on a remote, as a snapshot records them, by book and digest of their original (`aheadKey`):
 * a book given a new lineage (Sync Again) stores them anew.
 */
export type UploadedPreviews = Map<string, { sha256: string; ext: '.jpg' | '.png' }>;
export const aheadKey = (bookId: string, digest: string) => bookId + '/' + digest;

/**
 * How many blobs go up or come down at once. Each iCloud request has over a second of fixed cost, so one at a time the
 * previews of a book of 1200 photos took more than half an hour to upload, hardly any of it spent sending (#304).
 */
const transfersAtOnce = 6;
/** Runs `task` for every item, a few at once. After a failure no further one starts; it rejects once those running ended. */
async function eachAtOnce<T>(items: readonly T[], task: (item: T) => Promise<void>) {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(transfersAtOnce, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await task(item); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}
export type SyncOutcome = {
  /** `deferred`: with `pushOnly`, the sync needed to change the book and did nothing. */
  action: 'initial-push' | 'push' | 'in-sync' | 'adopt' | 'fast-forward' | 'diverged' | 'deferred';
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
  here: Record<string, { path?: string; key?: string; digest: string }>;
  /** Ends what `SyncRemote.prepareSync` started for this sync. */
  endSync?: () => void;
  /** The book this one is a copy of, while it syncs with the same remote (`copySource`): its first push names its originals. */
  copiedFrom?: NonNullable<SyncState['copiedFrom']> };

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
  // An older original a pull kept is not this Mac's version of the photo: the fact stays the snapshot's, so the book
  // lays the photo out at the new version's size and draws it from its preview (`keptOriginals`, desktop/project.ts).
  const kept = await keptOriginals(root);
  context.here = {};
  const sources = sourceEntries({ project: book.project, photoIndex: photos }).filter((entry) => entry.kind === 'photo');
  // Photos that are not files are asked about once per provider, all at once (ADR 0011): a sync holds the book, and a
  // provider such as Lightroom Classic answers over a bridge.
  const provided = await observePhotos(root, sources.filter((source) => !isFileLocator(source.locator)), store, facts);
  for (const source of sources) {
    context.options.signal?.throwIfAborted();
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
    if (kept.get(source.id)?.kept !== digest) facts.note(source.id, resolved.stored.observation, await photoDetails(resolved.stored.snapshot, null), digest);
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
async function fetchState(remote: SyncRemote, bookId: string, stateDigest: string, header?: CommitHeader, options?: { cached?: boolean }): Promise<StateBlob> {
  return (await fetchStateBytes(remote, bookId, stateDigest, header, options)).blob;
}
/**
 * State blobs read lately, by digest: they are immutable and checked against their digest, so a status read (every
 * automatic look, #284) does not download the snapshot it read the time before (`cached`). A few, by last use. A sync
 * always reads the remote, so one that lacks a snapshot is still found out.
 */
const statesRead = new Map<string, Uint8Array>();
const statesKept = 8;
/** The same, with the bytes as stored, which a pull stages: re-encoding would drop fields a newer version added. */
async function fetchStateBytes(remote: SyncRemote, bookId: string, stateDigest: string, header?: CommitHeader, { cached = false, signal }: { cached?: boolean; signal?: AbortSignal } = {}) {
  const key = contentBlobKey(bookId, stateDigest);
  const kept = cached ? statesRead.get(key) : undefined;
  const bytes = kept ?? await remote.getBlob(key, { signal });
  if (!bytes) throw new RemoteSyncingError('a snapshot of this book has not arrived yet.');
  if (!kept && sha(bytes) !== stateDigest) throw new RemoteSyncingError('a snapshot of this book is incomplete.');
  statesRead.delete(key);
  statesRead.set(key, bytes);
  for (const oldest of statesRead.keys()) { if (statesRead.size <= statesKept) break; statesRead.delete(oldest); }
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

/**
 * Downloads proxies, a few at once, and checks each against its own SHA-256 before any is stored; `each` is told after
 * every one.
 */
async function fetchProxies(remote: SyncRemote, bookId: string, wanted: Awaited<ReturnType<typeof missingProxies>>, { signal, each }: { signal?: AbortSignal; each?: () => void } = {}) {
  const fetched: { digest: string; bytes: Uint8Array }[] = [];
  await eachAtOnce(wanted, async ([digest, entry]) => {
    signal?.throwIfAborted();
    const bytes = await remote.getBlob(proxyBlobKey(bookId, digest, entry.ext), { signal });
    if (!bytes || sha(bytes) !== entry.sha256) throw new RemoteSyncingError('a photo preview has not fully arrived yet.');
    // One that ends after a cancel is not counted: the count stops where it was cancelled.
    signal?.throwIfAborted();
    fetched.push({ digest, bytes });
    each?.();
  });
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
  if (stale) { context.book = await loadProject(context.root, context.book.cache, true, false, { previews: 'none' }); context.stale = false; }
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
  if (await remote.listsBlob(key) || (await remote.putBlob(key, bytes)).existed) {
    const existing = await remote.getBlob(key);
    // A proxy another Mac is still writing (a synced folder delivers files piecemeal) must not enter a snapshot.
    if (!existing || !await decodes(existing, ext)) throw new RemoteSyncingError('a photo preview has not fully arrived yet.');
    return { sha256: sha(existing), ext };
  }
  return { sha256: sha(bytes), ext };
}

/**
 * Pushes the book as it is now: its content and proxies the remote lacks, then the state blob, then the commit header.
 * The snapshot names every owned original here; the originals themselves go up after the commit, in the background
 * (`uploadOriginals`), so another Mac can open the book from its state and previews before they have arrived. Entries
 * for photos whose original is not on this Mac (not located, not downloaded) are carried forward from `base`, the last
 * synced snapshot, or taken from the local proxy store.
 */
async function push(context: Context, parents: string[], base: StateBlob | undefined, facts: Record<string, AssetFact>, synced: SyncedCommit | undefined,
  parentCover?: string) {
  const { root, remote } = context;
  const { signal } = context.options;
  signal?.throwIfAborted();
  const state = await captureBookState(root);
  const bookId = state.project.bookId;
  if (!bookId) throw new Error('This book has no lineage ID yet. Make an edit, then sync.');
  await eachAtOnce(contentFiles(state), async ([path, digest]) => {
    signal?.throwIfAborted();
    const key = contentBlobKey(bookId, digest);
    if (await remote.listsBlob(key)) return;
    const bytes = await readFile(state.files[path]);
    if (sha(bytes) !== digest) throw new Error('The book changed during sync. Sync again.');
    await remote.putBlob(key, bytes, { sha256: digest });
  });
  // A photo's fact from here goes up only when its original changed here since the last sync (or the snapshot lacks
  // one); an original merely left at an older digest never pushes that digest back over another Mac's re-export.
  const changed = changedOriginals(hereDigests(context), synced, hereKeys(context));
  const remoteFacts = photoFacts(base?.assetsMeta.assets ?? {}, state.photos);
  const assets = Object.fromEntries(Object.keys(state.photos).flatMap((id) => {
    const fact = (changed.has(id) ? facts[id] : remoteFacts[id]) ?? facts[id] ?? remoteFacts[id];
    return fact ? [[id, fact]] : [];
  }));
  const originals: StateBlob['originals'] = {};
  const named: NonNullable<StateBlob['named']> = {};
  for (const [id, photo] of Object.entries(state.photos)) {
    // Only photos whose source reaches the book sync as originals (ADR 0012, Sync by reach).
    const owned = syncedOriginalPath(photo);
    if (owned === undefined) continue;
    const here = context.here[id];
    // Named, not uploaded: the original follows the commit (`uploadOriginals`), and until it has arrived another Mac
    // shows the photo's preview and says that it is still uploading.
    if (here?.path !== undefined && here.digest === assets[id]?.digest) originals[id] = { digest: here.digest, ext: extname(owned).toLowerCase() };
    else if (base?.originals[id]) originals[id] = base.originals[id];
    // The first push of a copy (Duplicate, Save a Copy) names the originals of the book it was copied from that are not
    // here (a Mac that keeps only previews), as that book's snapshot named them: they are copied inside the store, not
    // uploaded (`uploadOriginals`).
    else if (!base && context.copiedFrom?.originals[id] && context.copiedFrom.originals[id].digest === assets[id]?.digest) originals[id] = context.copiedFrom.originals[id];
    // The version the last snapshot named keeps when and where it was first named. A new one is named here, now, only
    // by the Mac that has its file; one carried forward without an earlier record stays without one (it then reads as
    // still uploading, never as "never uploaded from" a Mac that never had it).
    const earlier = base?.named?.[id];
    if (originals[id] && earlier?.digest === originals[id].digest) named[id] = earlier;
    else if (originals[id] && here?.path !== undefined && here.digest === originals[id].digest) {
      named[id] = { digest: originals[id].digest, at: (context.options.now?.() ?? new Date()).toISOString(), ...(context.options.device ? { by: context.options.device.slice(0, 100) } : {}) };
    }
  }
  const proxies: StateBlob['proxies'] = {};
  const local = await proxyStore();
  // Photos of one digest share a preview: they are tried in turn, until one gives it.
  const byDigest = new Map<string, string[]>();
  for (const [id, { digest }] of Object.entries(assets)) byDigest.set(digest, [...(byDigest.get(digest) ?? []), id]);
  // Loaded at most once, whichever photo needs it first.
  let opened: Promise<OpenProject> | undefined;
  const openBook = () => opened ??= currentBook(context);
  const addPreview = async (digest: string, id: string) => {
    signal?.throwIfAborted();
    // Unchanged photos keep the proxy the last snapshot recorded: nothing is read, decoded or downloaded again. It is
    // checked against what the remote has (the sync's listing over a bucket, the key index over iCloud, so no request
    // for one that is there): one Clean Up removed is sent again, as it was where this Mac has those bytes.
    const carried = base?.proxies[digest];
    if (carried && (await remote.hasBlob(proxyBlobKey(bookId, digest, carried.ext)) || await restoreProxy(remote, bookId, digest, carried))) { proxies[digest] = carried; return; }
    // Sent before the sync held the book, and still listed: Clean Up may have removed it meanwhile.
    const ahead = context.options.ahead?.get(aheadKey(bookId, digest));
    if (ahead && await remote.listsBlob(proxyBlobKey(bookId, digest, ahead.ext))) { proxies[digest] = ahead; return; }
    const here = context.here[id];
    if (here?.path !== undefined && here.digest === digest) {
      const book = await openBook();
      const photo = book.photos.get(id);
      if (photo && photo.original === here.path) {
        const path = await photoFile(photo, 'preview');
        const bytes = await readFile(path);
        const ext = extname(path).toLowerCase() === '.png' ? '.png' : '.jpg';
        await local?.put(digest, bytes).catch((error) => console.warn('ImageFlow could not keep a sync proxy', error));
        proxies[digest] = await uploadProxy(remote, bookId, digest, bytes, ext);
        return;
      }
    }
    const stored = await local?.path(digest);
    if (stored) proxies[digest] = await uploadProxy(remote, bookId, digest, await readFile(stored), extname(stored) === '.png' ? '.png' : '.jpg');
    // Missing on the remote and nowhere here: the entry stays, and a Mac that has the preview sends it again.
    else if (carried) proxies[digest] = carried;
  };
  await eachAtOnce([...byDigest], async ([digest, ids]) => {
    for (const id of ids) { if (proxies[digest]) break; await addPreview(digest, id); }
  });
  signal?.throwIfAborted();
  const portable = portableManifests(state.project, state.photos);
  const blob: StateBlob = { version: 1, project: portable.project, photos: portable.photos, assetsMeta: { version: 1, assets },
    content: state.contentDigests, originals, ...(Object.keys(named).length ? { named } : {}), proxies };
  const bytes = encodeStateBlob(blob);
  const stateDigest = sha(bytes);
  if (!await remote.listsBlob(contentBlobKey(bookId, stateDigest))) await remote.putBlob(contentBlobKey(bookId, stateDigest), bytes, { sha256: stateDigest });
  const coverDigest = await uploadCover(context, bookId, parentCover);
  const header = commitHeaderSchema.parse({ version: commitHeaderVersion, commitId: randomUUID(), bookId, parents, bookStateRevision: state.revision,
    createdAt: (context.options.now?.() ?? new Date()).toISOString(), title: state.project.title.slice(0, 400), stateDigest, ...(coverDigest ? { coverDigest } : {}) });
  signal?.throwIfAborted();
  await remote.putCommit(header);
  await recordSynced(root, { commitId: header.commitId, bookId, bookStateRevision: header.bookStateRevision, stateDigest, photoDigests: digestsOf(assets),
    // What this Mac has: originals at the snapshot's digest, and older versions a pull kept until their new ones arrive.
    localDigests: Object.fromEntries(Object.entries(context.here).filter(([id, { path, digest }]) => path !== undefined &&
      (assets[id]?.digest === digest || synced?.localDigests?.[id] === digest)).map(([id, { digest }]) => [id, digest])),
    localKeys: syncedKeys(context, synced, state.photos) });
  return { header, blob };
}

/** The content files of a book state, each digest once. */
const contentFiles = ({ contentDigests }: Pick<Awaited<ReturnType<typeof captureBookState>>, 'contentDigests'>) =>
  [...new Map(Object.entries(contentDigests).map(([path, digest]) => [digest, [path, digest] as const])).values()];

/**
 * Sends what a push will need, its content files and previews, before the sync holds the book (`DocumentSession`): a
 * first sync of a large book takes minutes of uploads, and meanwhile the book can be edited and agents can use it. Blobs
 * are content-addressed, so one an edit made useless is harmless (Clean Up removes it). It changes nothing in the book
 * and nothing in its sync record, and does nothing unless the sync would push: what it cannot read or does not find
 * as expected is left to the push, which checks everything again under the hold.
 *
 * `ahead` collects the previews known to be whole on the remote; the caller keeps it for this remote between tries, so
 * a sync that was stopped does not read them back.
 */
export async function uploadAhead({ remote: unbounded, book, ahead, signal, progress }: { remote: SyncRemote; book: OpenProject; ahead: UploadedPreviews;
  signal?: AbortSignal; progress?: (done: number, total: number) => void }) {
  signal?.throwIfAborted();
  const root = await realpath(book.folder);
  const remote = abortableRemote(unbounded, signal);
  const record = await readSyncState(root);
  if (record.pull) return;
  // The book is not held: a save under way may be seen half-way. Read again then, and left to the push if that fails too.
  const state = await captureBookState(root).catch(() => new Promise((resolve) => setTimeout(resolve, 500)).then(() => captureBookState(root))).catch(() => undefined);
  const bookId = state?.project.bookId;
  if (!state || !bookId) return;
  const endSync = await remote.prepareSync?.(bookId);
  try {
    const commits = await remoteCommits(remote, bookId);
    // A book deleted from sync gets nothing stored again; the sync itself says so.
    if (await deletedFromSync(remote, bookId, commits.length)) return;
    const decision = decideSync({ pullInProgress: false, tips: deriveTips(commits), commits, lastSynced: record.lastSynced, localRevision: state.revision, factsChanged: false });
    if (decision.action !== 'initial-push' && decision.action !== 'push') return;
    const facts = photoFacts((await AssetFacts.forBook(root)).all(), state.photos);
    const base = record.lastSynced && decision.action === 'push' ? (await fetchState(remote, bookId, record.lastSynced.stateDigest, undefined, { cached: true })).proxies : {};
    const store = await SourceStore.forBook(root, book.cache);
    const local = await proxyStore();
    const kept = await keptOriginals(root);
    const jobs: (() => Promise<void>)[] = [];
    for (const [path, digest] of contentFiles(state)) {
      const key = contentBlobKey(bookId, digest);
      if (await remote.listsBlob(key)) continue;
      jobs.push(async () => {
        const bytes = await readFile(state.files[path]).catch(() => undefined);
        if (bytes && sha(bytes) === digest) await remote.putBlob(key, bytes, { sha256: digest });
      });
    }
    const started = new Set<string>();
    const sendPreview = async (digest: string, path: string) => {
      const bytes = await readFile(path).catch(() => undefined);
      if (!bytes) return;
      const ext = extname(path).toLowerCase() === '.png' ? '.png' : '.jpg';
      const { sha256 } = await uploadProxy(remote, bookId, digest, bytes, ext);
      ahead.set(aheadKey(bookId, digest), { sha256, ext });
    };
    for (const source of sourceEntries({ project: book.project, photoIndex: state.photos })) {
      if (source.kind !== 'photo' || kept.has(source.id)) continue;
      const known = facts[source.id]?.digest;
      if (known !== undefined && (ahead.has(aheadKey(bookId, known)) || base[known])) continue;
      jobs.push(async () => {
        let digest: string | undefined = known;
        let path = digest === undefined ? undefined : await local?.path(digest);
        if (!path && isFileLocator(source.locator)) {
          // The preview of a file is made only from the very snapshot its digest was read from.
          // A file moved or written meanwhile is left to the push, which looks at it under the hold.
          const look = () => store.resolve(root, source).catch(() => undefined);
          let resolved = await look();
          if (resolved?.status.state === 'available' && !resolved.status.digest) { await store.digested(); resolved = await look(); }
          const photo = book.photos.get(source.id);
          if (resolved?.status.state !== 'available' || !photo || resolved.stored?.snapshot !== photo.original) return;
          digest = resolved.status.digest;
          path = digest === undefined ? undefined : await photoFile(photo, 'preview').catch(() => undefined);
          // Kept for the sync that follows, as a push keeps it.
          if (digest && path) await local?.put(digest, path).catch((error) => console.warn('ImageFlow could not keep a sync proxy', error));
        }
        // Two photos of one digest share a preview.
        if (!digest || !path || started.has(digest) || ahead.has(aheadKey(bookId, digest)) || base[digest]) return;
        started.add(digest);
        await sendPreview(digest, path);
      });
    }
    let done = 0;
    if (jobs.length) progress?.(0, jobs.length);
    await eachAtOnce(jobs, async (job) => {
      signal?.throwIfAborted();
      await job();
      progress?.(++done, jobs.length);
    });
  } finally { endSync?.(); }
}

/**
 * Uploads a preview the remote lacks from this Mac's proxy store, when it holds the very bytes a snapshot records
 * (`entry.sha256`), so the snapshot stays as it is. False when it does not.
 */
async function restoreProxy(remote: SyncRemote, bookId: string, digest: string, entry: StateBlob['proxies'][string]) {
  const stored = await (await proxyStore())?.path(digest);
  if (!stored || (extname(stored) === '.png' ? '.png' : '.jpg') !== entry.ext) return false;
  const bytes = await readFile(stored).catch(() => undefined);
  if (!bytes || sha(bytes) !== entry.sha256) return false;
  await remote.putBlob(proxyBlobKey(bookId, digest, entry.ext), bytes, { sha256: entry.sha256 });
  return true;
}

/**
 * Sends the previews of a snapshot that the remote lacks (Clean Up removed one a moment before a push reused it) from
 * this Mac's proxy store, where it holds the bytes the snapshot records: otherwise every Mac that needs the preview could
 * not pull. Asked of the sync's listing over a bucket and of the key index over iCloud, so it costs no request while
 * nothing is missing. Never fails the sync.
 */
async function restoreProxies(remote: SyncRemote, bookId: string, blob: StateBlob) {
  for (const [digest, entry] of Object.entries(blob.proxies)) {
    try { if (!await remote.hasBlob(proxyBlobKey(bookId, digest, entry.ext))) await restoreProxy(remote, bookId, digest, entry); }
    catch (error) {
      if (error instanceof BookDeletedError) throw error;
      console.warn('ImageFlow could not send a photo preview again', error);
    }
  }
}

/** The largest cover a push sends: the app keeps covers of at most 300,000 characters as data URLs. */
export const maximumCoverBytes = 240_000;
/** Whether bytes look like a whole JPEG of a cover's size (start and end markers); the library decodes it again before showing it. */
export const isCoverJpeg = (bytes: Uint8Array) => bytes.length > 4 && bytes.length <= maximumCoverBytes &&
  bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;

/**
 * The cover a commit records (#283): this Mac's cached cover, uploaded under its digest unless the parent has the same
 * one, or the parent's cover when there is none here (not made yet, or not readable). A cover that cannot be uploaded
 * never fails the push; the parent's is carried forward instead.
 */
async function uploadCover(context: Context, bookId: string, parentCover: string | undefined) {
  const bytes = await context.options.cover?.().catch(() => undefined);
  if (!bytes || !isCoverJpeg(bytes)) return parentCover;
  const digest = sha(bytes);
  if (digest === parentCover) return parentCover;
  const key = coverBlobKey(bookId, digest);
  try {
    if (!await context.remote.listsBlob(key)) await context.remote.putBlob(key, bytes, { sha256: digest });
    return digest;
  } catch (error) {
    if (error instanceof BookDeletedError) throw error;
    console.warn('ImageFlow could not upload the book’s cover', error);
    return parentCover;
  }
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
  // The last moment an automatic sync may leave the book as it is: from here on the pull is applied, which is local.
  context.options.signal?.throwIfAborted();
  if (!await mayApply(context)) return undefined;
  await applyPull(context, marker);
  return blob;
}
const mayApply = async (context: Context) => !context.options.beforeApply || await context.options.beforeApply();

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
  // The originals the remote has, listed only when an original here is replaced by the snapshot.
  let uploaded: Promise<Set<string>> | undefined;
  const onRemote = async (original: StateBlob['originals'][string]) =>
    (await (uploaded ??= remote.listBook(tip.bookId, 'originals').then((entries) => new Set(entries.map(({ key }) => key))))).has(originalBlobKey(tip.bookId, original.digest, original.ext));
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
    // An owned original the snapshot replaced goes, so the photo shows the new proxy until its new original is downloaded,
    // but only once the remote has the new one: a commit names its originals before they upload, and until then this
    // file may be the only copy of the photo besides the remote's old one. Kept, it is recorded as what this Mac has
    // (`localDigests`), so it is neither pushed back as a change made here nor uploaded as this Mac's own, and the new
    // one replaces it once it has arrived (`missingOriginals`, `replaces`).
    if (path !== undefined && original && original.digest !== local.digest && local.path === target && await onRemote(original)) { staleOriginals[path] = local.digest; continue; }
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

/** `<Book> (Conflict 2026-11-21 14.33.05).imageflow` beside the book, in this Mac's time, numbered when that name is taken. */
async function conflictDestination(root: string, now: Date) {
  const name = basename(root).replace(/\.imageflow$/i, '');
  const two = (value: number) => String(value).padStart(2, '0');
  const stamp = now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate()) + ' ' + [now.getHours(), now.getMinutes(), now.getSeconds()].map(two).join('.');
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
/** Gives a book its lineage ID, with the book held; whether it had none. */
export async function ensureBookId(root: string) {
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
  options.signal?.throwIfAborted();
  const remote = abortableRemote(options.remote, options.signal);
  const context: Context = { root, remote, book: options.book, stale: false, options: { ...options, remote }, here: {} };
  try {
    const decided = await decideAndSync(context);
    // A push that must not change the book downloads and replaces nothing either.
    if (options.pushOnly || decided.action === 'deferred') return decided;
    // Older originals a pull kept until their new versions arrived are replaced once they have, whether or not this Mac
    // keeps originals: the book had the file. Never fails the sync, which has succeeded by then.
    // Looked for only when the sync record says one was kept (a digest here other than the snapshot's), so a book that
    // never kept one reads nothing more.
    const replaced = (decided.action === 'diverged' && !decided.pulled) || !await keepsOlderOriginal(root) || !await mayApply(context) ? [] : await fetchOriginals(root, options.remote, undefined, { keptOnly: true })
      .then(({ downloaded }) => downloaded, (error) => { console.warn('ImageFlow could not replace an original that changed on another Mac', error); return [] as string[]; });
    const outcome = replaced.length ? { ...decided, changed: true } : decided;
    // The sync has succeeded; originals kept on this Mac come after it and never fail it.
    if (!options.fetchOriginals || (outcome.action === 'diverged' && !outcome.pulled)) return outcome;
    try {
      const { downloaded, notUploaded } = await fetchOriginals(root, options.remote);
      return { ...outcome, changed: outcome.changed || downloaded.length > 0, originals: { downloaded, ...(notUploaded ? { notUploaded } : {}) } };
    } catch (error) {
      return { ...outcome, originals: { downloaded: [], pending: error instanceof Error ? error.message : String(error) } };
    }
  } finally {
    context.endSync?.();
    // Facts this sync loaded for a book no session holds are written and dropped again.
    if (!registered) await AssetFacts.release(root).catch(() => {});
  }
}

async function decideAndSync(context: Context): Promise<SyncOutcome> {
  const { root, options } = context;
  // An interrupted pull is finished first; it was decided on before anything else changed.
  const interrupted = (await readSyncState(root)).pull;
  const deferred: SyncOutcome = { action: 'deferred', pushed: [], changed: false };
  if (interrupted && !options.pushOnly && !await mayApply(context)) return deferred;
  if (options.pushOnly && (interrupted || !(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as { bookId?: unknown }).bookId)) return deferred;
  // One that cannot be finished is given up (`abandonPull`), and the decision below keeps both versions.
  if (interrupted) await finishPull(root, interrupted).catch((error) => console.warn('ImageFlow gave up an interrupted sync', error));
  const assigned = await ensureBookId(root);
  const changed = !!interrupted || assigned;
  context.stale = changed;
  const state = await readSyncState(root);
  if (state.pull) throw new Error('The interrupted sync could not be finished.');
  context.copiedFrom = copySource(state);
  const facts = await refreshFacts(context);
  const local = await captureBookState(root);
  const bookId = local.project.bookId;
  if (!bookId) throw new Error('This book has no lineage ID yet. Make an edit, then sync.');
  // One listing of the book answers this sync's questions over a bucket: its commits, the content files and previews a
  // push would ask about, and the originals. It ends with the sync (`syncBook`).
  context.endSync = await options.remote.prepareSync?.(bookId);
  const commits = await remoteCommits(options.remote, bookId);
  // A book deleted from sync is never pushed back, nor pulled (ADR 0012, section 4): the Mac that still has it asks.
  // Asked after the commits were listed, so that listing answers it without a request of its own.
  const tombstone = await deletedFromSync(options.remote, bookId, commits.length);
  if (tombstone) throw new BookDeletedError(tombstone);
  const tips = deriveTips(commits);
  const synced = state.lastSynced;
  const factsChanged = !!synced && factsAhead(hereDigests(context), synced, hereKeys(context));
  const decision = decideSync({ pullInProgress: false, tips, commits, lastSynced: synced, localRevision: local.revision, factsChanged });
  // Without changing the book, only a push goes ahead: a pull waits (`deferred`), and a divergence is left as it is.
  if (options.pushOnly && decision.action === 'fast-forward') return deferred;
  // An automatic sync never keeps both: neither a conflict copy nor a pull over this Mac's version (ADR 0012, section 2).
  if ((options.fastForwardOnly || options.pushOnly) && decision.action === 'diverged') return { action: 'diverged', pushed: [], tips: decision.tips, changed };
  switch (decision.action) {
    case 'resume': throw new Error('The interrupted sync could not be finished.');
    case 'remote-behind': throw new RemoteSyncingError('the version this Mac last synced is not on the remote yet.');
    case 'initial-push': {
      const { header } = await push(context, [], undefined, facts, undefined);
      return { action: 'initial-push', pushed: [header.commitId], changed };
    }
    case 'push': {
      const base = await fetchState(options.remote, bookId, synced!.stateDigest);
      const { header } = await push(context, [decision.tip.commitId], base, facts, synced, decision.tip.coverDigest);
      return { action: 'push', pushed: [header.commitId], changed };
    }
    case 'in-sync': {
      const blob = await fetchState(options.remote, bookId, decision.tip.stateDigest).catch(() => undefined);
      if (blob) await refetchProxies(context, bookId, blob);
      if (blob) await restoreProxies(context.remote, bookId, blob);
      // Originals here that an older push left out (it found iCloud full) are named now; they upload after the commit.
      if (blob && await unnamedOriginals(context, blob)) {
        const { header } = await push(context, [decision.tip.commitId], blob, facts, synced, decision.tip.coverDigest);
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
      await restoreProxies(context.remote, bookId, blob);
      // Facts this Mac knows better than the snapshot go back with a commit of the same book state, and so do
      // originals here that it does not name.
      if (factsAhead(hereDigests(context), adopted, hereKeys(context)) || await unnamedOriginals(context, blob)) {
        const { header } = await push(context, [decision.tip.commitId], blob, facts, adopted, decision.tip.coverDigest);
        return { action: 'adopt', pushed: [header.commitId], changed };
      }
      return { action: 'adopt', pushed: [], changed };
    }
    case 'fast-forward': {
      const blob = await pull(context, decision.tip);
      if (!blob) return { ...deferred, changed };
      const now = (await readSyncState(root)).lastSynced!;
      // The merge kept the facts of originals that changed here; they go back, never stale ones.
      if (factsAhead(hereDigests(context), now, hereKeys(context)) || await unnamedOriginals(context, blob)) {
        const { header } = await push(context, [decision.tip.commitId], blob, await readAssetFacts(root), now, decision.tip.coverDigest);
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
 * An original a pull kept because the snapshot replaced it while the new one was not on the remote yet: the sync
 * record names the old digest as what this Mac has (`localDigests`), and the snapshot another.
 */
const keptDigest = (synced: SyncedCommit | undefined, id: string, original: StateBlob['originals'][string]) => {
  const kept = synced?.localDigests?.[id];
  return kept !== undefined && kept !== original.digest ? kept : undefined;
};

/** Whether the sync record names, for some photo, a digest this Mac has other than the snapshot's: a kept older original. */
async function keepsOlderOriginal(root: string) {
  const synced = (await readSyncState(root)).lastSynced;
  return !!synced?.localDigests && Object.entries(synced.localDigests).some(([id, digest]) => synced.photoDigests[id] !== undefined && synced.photoDigests[id] !== digest);
}

/**
 * The owned originals of the last synced snapshot that are not on this Mac, each with whether the remote has it
 * (`uploaded`): a commit names its originals before they upload (`uploadOriginals`), so one the remote lacks is still
 * uploading from another Mac, which is no error. Those photos/ lacks, and those a pull kept at an older version
 * (`replaces`, the digest it has: the new one replaces it once it is there). Any other file at the path is never
 * replaced: it is this Mac's own original, and its fact wins until it syncs.
 */
async function missingOriginals(root: string, remote: SyncRemote, bookId: string, blob: StateBlob, ids?: readonly string[], synced?: SyncedCommit) {
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const missing: { id: string; path: string; original: StateBlob['originals'][string]; uploaded: boolean; replaces?: string }[] = [];
  for (const [id, original] of Object.entries(blob.originals)) {
    const photo = photos[id];
    const path = photo && syncedOriginalPath(photo);
    if ((ids && !ids.includes(id)) || !path?.startsWith('photos/')) continue;
    if (await lstat(await bookPath(root, path, { checking: true })).catch(() => undefined)) {
      const replaces = keptDigest(synced, id, original);
      if (replaces) missing.push({ id, path, original, uploaded: false, replaces });
      continue;
    }
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
export type StagedOriginal = { id: string; path: string; staging: string; digest?: string;
  /** The digest of the kept older version this one replaces (`missingOriginals`). */
  replaces?: string };

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
  const all = await missingOriginals(root, remote, bookId, await fetchState(remote, bookId, synced.stateDigest), undefined, synced);
  const missing = all.filter(({ uploaded }) => uploaded);
  // A kept older version whose new one is not there yet is no original away: the photo has its file.
  let away = all.filter(({ uploaded, replaces }) => !uploaded && !replaces).length;
  const staged: StagedOriginal[] = [];
  progress?.(0, missing.length);
  try {
    for (const { id, path, original, replaces } of missing) {
      if (signal?.aborted) break;
      const staging = join(root, '.imageflow-write-' + randomUUID() + '.tmp');
      const downloaded = await remote.downloadBlob(originalBlobKey(bookId, original.digest, original.ext), staging);
      // Gone since it was listed: the remote lost it, and the Mac that has it uploads it again.
      if (!downloaded) { away++; continue; }
      if (await fileDigest(staging) !== original.digest) {
        await rm(staging, { force: true });
        throw new RemoteSyncingError('an original photo has not fully arrived yet.');
      }
      staged.push({ id, path, staging, digest: original.digest, ...(replaces ? { replaces } : {}) });
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
  const replaced: Record<string, string> = {};
  for (const { id, path, staging, digest, replaces } of staged) {
    try {
      const photo = photos[id];
      if (!photo || packagePath(photo) !== path) continue;
      const target = await bookPath(root, path, { checking: true });
      if (await lstat(target).catch(() => undefined)) {
        // Only the kept older version is replaced, as it still is: a file changed here since is this Mac's own.
        if (!replaces || !digest || await fileDigest(target).catch(() => undefined) !== replaces) continue;
        replaced[id] = digest;
      }
      await rename(staging, await bookPath(root, path));
      placed.push(id);
    } finally { await rm(staging, { force: true }); }
  }
  await recordReplaced(root, replaced);
  return placed;
}

/**
 * Records that kept older originals were replaced by the versions the last synced snapshot names, so they count as what
 * this Mac has, unchanged here, from now on.
 */
async function recordReplaced(root: string, replaced: Record<string, string>) {
  if (!Object.keys(replaced).length) return;
  await updateSyncState(root, (state) => {
    const synced = state.lastSynced;
    if (!synced) return state;
    const localDigests = { ...synced.localDigests };
    for (const [id, digest] of Object.entries(replaced)) if (synced.photoDigests[id] === digest) localDigests[id] = digest;
    return { ...state, lastSynced: { ...synced, localDigests } };
  });
}

/**
 * The owned originals of the last synced snapshot that are not on this Mac, without hashing anything, and those of
 * them that another Mac has not uploaded yet (`notUploaded`).
 */
export async function originalsNotHere(folder: string, remote: SyncRemote, now = new Date()): Promise<{ ids: string[]; notUploaded: string[]; neverUploaded?: NeverUploaded[] }> {
  const root = await realpath(folder);
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return { ids: [], notUploaded: [] };
  const bookId = await syncedBookId(root, synced).catch(() => undefined);
  const blob = bookId && await fetchState(remote, bookId, synced.stateDigest, undefined, { cached: true }).catch(() => undefined);
  if (!bookId || !blob) return { ids: [], notUploaded: [] };
  const all = await missingOriginals(root, remote, bookId, blob);
  // A kept older version is here: the photo has its file, which the new one replaces once it is there.
  const missing = all.filter(({ replaces }) => !replaces);
  // Named long ago and still not on the remote: the Mac that had it never uploaded it (it is gone, or never synced
  // again). Also for a kept older version, whose photo then stays on its old file.
  const namedOf = (id: string, digest: string) => (blob.named?.[id]?.digest === digest ? blob.named[id] : undefined);
  const neverUploaded = all.flatMap(({ id, uploaded, original }) => {
    const named = namedOf(id, original.digest);
    return !uploaded && named && now.getTime() - Date.parse(named.at) > neverUploadedAfter ? [{ id, namedAt: named.at, ...(named.by ? { by: named.by } : {}) }] : [];
  });
  return { ids: missing.map(({ id }) => id), notUploaded: missing.filter(({ uploaded }) => !uploaded).map(({ id }) => id), ...(neverUploaded.length ? { neverUploaded } : {}) };
}

/** How long an original a commit named may take to arrive before it counts as never uploaded: a week. */
export const neverUploadedAfter = 7 * 24 * 60 * 60 * 1000;
/** An original a commit named a week or more ago that never arrived on the remote, with the Mac that named it. */
export type NeverUploaded = { id: string; namedAt: string; by?: string };

/** What the status and the asset say about originals that never arrived: from which Mac, when it is known. */
export function neverUploadedText(lost: readonly NeverUploaded[]) {
  const macs = [...new Set(lost.map(({ by }) => by).filter((by): by is string => !!by))];
  const from = macs.length === 1 ? ' from “' + macs[0] + '”' : macs.length ? ' from ' + macs.map((mac) => '“' + mac + '”').join(', ') : ' from the Mac that added ' + (lost.length === 1 ? 'it' : 'them');
  return (lost.length === 1 ? '1 original was' : lost.length + ' originals were') + ' never uploaded' + from + '. Open the book on that Mac to upload ' + (lost.length === 1 ? 'it' : 'them') + '.';
}

/** The owned originals of the last synced snapshot that are not on this Mac, without hashing anything. */
export async function pendingOriginals(folder: string, remote: SyncRemote) {
  return (await originalsNotHere(folder, remote).catch(() => ({ ids: [] as string[] }))).ids;
}

async function fetchOriginals(root: string, remote: SyncRemote, ids?: readonly string[], { keptOnly = false }: { keptOnly?: boolean } = {}) {
  const synced = (await readSyncState(root)).lastSynced;
  if (!synced) return { downloaded: [], notUploaded: 0 };
  const bookId = await syncedBookId(root, synced);
  const blob = await fetchState(remote, bookId, synced.stateDigest);
  const downloaded: string[] = [];
  const replaced: Record<string, string> = {};
  let notUploaded = 0;
  for (const { id, path, original, uploaded, replaces } of await missingOriginals(root, remote, bookId, blob, ids, synced)) {
    if (keptOnly && !replaces) continue;
    // Still uploading from another Mac: downloaded once it has arrived. A kept older version stays until then.
    if (!uploaded) { if (!replaces) notUploaded++; continue; }
    const target = await bookPath(root, path);
    // Staged beside its target, so a transport on the same volume can clone it, and removed whatever happens.
    const staging = join(dirname(target), '.imageflow-write-' + randomUUID() + '.tmp');
    try {
      if (!await remote.downloadBlob(originalBlobKey(bookId, original.digest, original.ext), staging)) { if (!replaces) notUploaded++; continue; }
      if (await fileDigest(staging) !== original.digest) throw new RemoteSyncingError('an original photo has not fully arrived yet.');
      // Only the kept older version is replaced, as it still is: a file changed here since is this Mac's own.
      if (replaces && await fileDigest(target).catch(() => undefined) !== replaces) continue;
      await rename(staging, target);
      if (replaces) replaced[id] = original.digest;
    } finally { await rm(staging, { force: true }); }
    downloaded.push(id);
  }
  await recordReplaced(root, replaced);
  return { downloaded, notUploaded };
}

/**
 * How many of a book's owned originals are not on this Mac, from its own files alone: owned photos whose file photos/
 * lacks, and those a pull kept at an older version (their new version is elsewhere). For the question Delete from Sync
 * asks; reads photos.json, the sync record and the files' presence, nothing else.
 */
export async function originalsAway(folder: string) {
  const root = await realpath(folder);
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const kept = await keptOriginals(root);
  let away = 0;
  for (const [id, photo] of Object.entries(photos)) {
    const path = syncedOriginalPath(photo);
    if (!path?.startsWith('photos/')) continue;
    const info = await lstat(await bookPath(root, path, { checking: true })).catch(() => undefined);
    if (!info?.isFile() || kept.has(id)) away++;
  }
  return away;
}

/**
 * An owned original the last synced snapshot names that the remote lacks: still to upload, from its file here (`path`),
 * or, for a copy of a synced book (`copySource`), copied inside the store from that book's key (`from`), with the file
 * here as the fallback where there is one.
 */
export type PendingUpload = { id: string; path?: string; key: string; digest: string; from?: string };

/**
 * What is still to upload of a book (ADR 0012, section 2), derived rather than recorded: the owned originals that the
 * snapshot this Mac last synced names, whose file is here, and that the remote's listing of the book's originals
 * lacks. It survives a restart and a pull or push in between (a later snapshot carries the entry forward), and it
 * repairs an original the remote lost, from any Mac that holds the file. Over a store with a change feed the listing
 * comes from the key index, so this is not a full listing of the book's records.
 */
export async function pendingUploads(folder: string, remote: SyncRemote): Promise<PendingUpload[]> {
  const root = await realpath(folder);
  const state = await readSyncState(root);
  const synced = state.lastSynced;
  if (!synced) return [];
  const bookId = await syncedBookId(root, synced);
  const source = copySource(state);
  // Only the originals the book it was copied from had: a photo added to the copy later is uploaded, never asked for there.
  const fromSource = new Set(source && source.bookId !== bookId ? Object.values(source.originals).map(({ digest, ext }) => digest + ext) : []);
  const copiedFrom = (original: StateBlob['originals'][string]) => (source && fromSource.has(original.digest + original.ext) ? source.bookId : undefined);
  const blob = await fetchState(remote, bookId, synced.stateDigest);
  const photos = photoIndexSchema.parse(JSON.parse(await readFile(join(root, 'photos.json'), 'utf8')));
  const named = Object.entries(blob.originals).flatMap(([id, original]) => {
    const photo = photos[id];
    const path = photo && syncedOriginalPath(photo);
    // An older version a pull kept is not the original the snapshot names: another Mac uploads that one.
    if (keptDigest(synced, id, original)) return [];
    return path?.startsWith('photos/') ? [{ id, path, key: originalBlobKey(bookId, original.digest, original.ext), digest: original.digest,
      ...(copiedFrom(original) ? { from: originalBlobKey(copiedFrom(original)!, original.digest, original.ext) } : {}) }] : [];
  });
  if (!named.length) return [];
  const there = new Set((await remote.listBook(bookId, 'originals')).map(({ key }) => key));
  const pending = new Map<string, PendingUpload>();
  for (const { id, path, key, digest, from } of named) {
    if (there.has(key) || pending.has(key)) continue;
    const file = await bookPath(root, path, { checking: true }).catch(() => undefined);
    const here = file && (await lstat(file).catch(() => undefined))?.isFile();
    if (here || from) pending.set(key, { id, ...(here ? { path: file } : {}), key, digest, ...(from ? { from } : {}) });
  }
  return [...pending.values()];
}

/**
 * Whether a book was deleted from sync, given how many commits a listing just found for it (ADR 0012, section 4): its
 * tombstone, or, for a book without commits, its deletion marker. A deletion writes the marker, removes the commits, then
 * writes the tombstone, so a deletion that stopped after its commits still reads as one on every Mac, and a copy without
 * a sync record (a Finder duplicate) never pushes the book back; a marker over a book that still has commits (a deletion
 * that stopped right after it) reads as not deleted. The marker is read only when there are no commits.
 */
export async function deletedFromSync(remote: SyncRemote, bookId: string, commits: number, options?: { fresh?: boolean; listedOnly?: boolean }) {
  if (commits === 0) return remote.deletionMarker(bookId);
  return remote.bookTombstone(bookId, options);
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
 * Syncing), it was cancelled, or the book was deleted from sync (`deleted`).
 */
export type UploadOutcome = { uploaded: number; left: number; changed: number; full?: StoreFullError; stopped?: 'elsewhere' | 'cancelled' | 'deleted' };

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
  // A book deleted from sync uploads nothing: on iCloud an upload would make its zone again.
  const synced = (await readSyncState(root)).lastSynced;
  const lineage = synced && await syncedBookId(root, synced);
  // One listing of the book (over a bucket) answers its commits, its tombstone and what is to upload.
  const end = lineage ? await connection.remote.prepareSync?.(lineage) : undefined;
  let pending: PendingUpload[];
  try {
    if (lineage && await deletedFromSync(connection.remote, lineage, (await connection.remote.listBook(lineage, 'snapshots')).length)) return { ...outcome, stopped: 'deleted' };
    await sweepUploadClones(root);
    pending = await pendingUploads(root, connection.remote);
  } finally { end?.(); }
  // Looked at again while the upload runs (at most every 30 s), so a deletion on another Mac stops it soon.
  let looked = Date.now();
  // Originals of a copy still to copy from the book it was made from, which that book does not have (yet).
  let waiting = 0;
  progress?.(0, pending.length);
  for (const [index, { path, key, digest, from }] of pending.entries()) {
    const left = pending.length - index;
    if (signal?.aborted) return { ...outcome, left, stopped: 'cancelled' };
    // The remote anew for each photo: the account or the bucket may have changed since the commit, or since the last one.
    if (index > 0) connection = await connect();
    if (connection.remoteId !== expected || await syncsWith() !== expected) return { ...outcome, left, stopped: 'elsewhere' };
    if (lineage && Date.now() - looked > 30_000) {
      looked = Date.now();
      if (await connection.remote.bookTombstone(lineage, { fresh: true }) || await connection.remote.deletionMarker(lineage).then((marker) => marker && connection.remote.listBook(lineage, 'snapshots')
        .then((commits) => !commits.length))) return { ...outcome, left, stopped: 'deleted' };
    }
    try {
      // A copy's original is copied from the book it was copied from, inside the store, without uploading it (#285).
      const copied = from !== undefined && await connection.remote.copyBlob(from, key);
      if (!copied) {
        if (path === undefined) {
          // Not here (a Mac that keeps only previews), and the store cannot copy (iCloud): downloaded from the book it was
          // copied from and uploaded again. One that book does not have yet waits for a later sync.
          if (!from || !await reupload(root, connection.remote, from, key, digest, signal)) { waiting++; continue; }
        } else {
          if (await fileDigest(path).catch(() => undefined) !== digest) { outcome.changed++; continue; }
          try { await connection.remote.putBlob(key, { file: path }, { sha256: digest, signal }); }
          catch (error) {
            // Changed while it uploaded: the store refused bytes without the digest, and the next sync names the new version.
            if (!signal?.aborted && !(error instanceof BookDeletedError) && !(error instanceof StoreFullError) && await fileDigest(path).catch(() => undefined) !== digest) { outcome.changed++; continue; }
            throw error;
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) return { ...outcome, left, stopped: 'cancelled' };
      if (error instanceof BookDeletedError) return { ...outcome, left, stopped: 'deleted' };
      if (error instanceof StoreFullError) return { ...outcome, left, full: error };
      throw error;
    }
    outcome.uploaded++;
    progress?.(outcome.uploaded, pending.length);
  }
  // A copy that has every original its first push took from the book it was made from needs the hint no more: from here
  // on its originals upload as any book's, with no copy request first.
  if (!waiting) await forgetCopySource(root);
  return outcome;
}

/** Drops a copy's hint (`copiedFrom`) once its first push named what it took, and none of those originals is left to copy. */
async function forgetCopySource(root: string) {
  await updateSyncState(root, (state) => {
    if (!state.copiedFrom || !state.lastSynced) return state;
    const { copiedFrom: _, ...rest } = state;
    return rest;
  }).catch(() => {});
}

/**
 * Downloads an original from another book's key into an upload clone in photos/ (`uploadClonePrefix`, which the writer
 * lock leaves alone and a crash leaves for `sweepUploadClones`), checks its digest and uploads it under `key`. False when
 * the other book does not have it.
 */
async function reupload(root: string, remote: SyncRemote, from: string, key: string, digest: string, signal?: AbortSignal) {
  await mkdir(join(root, 'photos'), { recursive: true });
  const staging = join(root, 'photos', uploadClonePrefix + randomUUID() + '.tmp');
  try {
    if (!await remote.downloadBlob(from, staging, { signal })) return false;
    if (await fileDigest(staging) !== digest) return false;
    await remote.putBlob(key, { file: staging }, { sha256: digest, signal });
    return true;
  } finally { await rm(staging, { force: true }); }
}

/**
 * A name for a downloaded book made from its title: what Finder allows, without a leading dot or dash, at most 100 characters,
 * and "Untitled" for one that leaves nothing.
 */
export function downloadName(title: string) {
  const name = title.normalize('NFC').replace(/[\u0000-\u001f\u007f/:\\]/g, '-').replace(/^[\s.-]+/, '').trim().slice(0, 100).trim();
  return name || 'Untitled';
}

/**
 * Download from the library (#283; Open Synced Book in #251): makes a new local book at `destination` from a commit on
 * the remote, for a Mac that has no copy of it yet. Content, the manifests (linked sources unlocated, as on any Mac that
 * has not located them) and the snapshot's facts are written into a staging folder and checked against the commit's
 * revision before the book appears under its name; proxies go to the proxy store, and owned originals stay on the
 * remote until downloaded. The new book records the commit as synced and, with `remoteId`, syncs on this Mac with that
 * remote. A name that is taken (a book, or any file) is refused: nothing that is there is ever replaced. A book deleted
 * from sync is refused (`BookDeletedError`).
 *
 * The book arrives trusted (ADR 0012, section 2): the configured backend lies inside the user's trust boundary, so the
 * book is one of their own. Returns the folder it made.
 */
export async function cloneFromRemote({ remote, tip, destination, remoteId, progress, signal }: { remote: SyncRemote; tip: CommitHeader; destination: string; remoteId?: string;
  /** Told how many of the book's files and previews are here, of how many; previews this Mac already has are not counted. */
  progress?: (done: number, total: number) => void;
  /**
   * Cancels the download: the transfer that runs stops, the staging folder goes and no book is made. Once the book is
   * put under its name it is there and stays; a cancel after that does nothing.
   */
  signal?: AbortSignal }) {
  const parent = await realpath(dirname(destination));
  const folder = join(parent, basename(documentPath(destination)));
  const taken = 'A book named “' + basename(folder) + '” already exists there. Choose another name.';
  // Refused before anything is downloaded; the name is reserved below, in case it is taken meanwhile.
  if (await lstat(folder).catch(() => undefined)) throw new Error(taken);
  signal?.throwIfAborted();
  const tombstone = await remote.bookTombstone(tip.bookId);
  if (tombstone) throw new BookDeletedError(tombstone);
  const { blob } = await fetchStateBytes(remote, tip.bookId, tip.stateDigest, tip, { signal });
  signal?.throwIfAborted();
  // Known before the first file comes down, so the count has its total from the start.
  const projected = projectManifests(blob, {});
  const photos = parseDocument(photoIndexSchema, projected.photos, 'photos.json');
  const project = withBookFormat(parseDocument(projectSchema, projected.project, 'project.json'), photos);
  const previews = await missingProxies(blob, photos, {});
  const total = Object.keys(blob.content).length + previews.length;
  let done = 0;
  const each = () => progress?.(++done, total);
  progress?.(0, total);
  const staging = join(parent, '.imageflow-create-' + randomUUID());
  let reserved = false;
  let facts: Record<string, AssetFact> = {};
  try {
    await mkdir(staging);
    await mkdir(join(staging, 'photos'));
    // Folders are made one file after the other, so two downloads never make the same one; the files then come down
    // a few at once. A failed or cancelled download lets the others end before the staging folder goes, so none of
    // them writes into it afterwards.
    signal?.throwIfAborted();
    const files: [target: string, digest: string][] = [];
    for (const [path, digest] of Object.entries(blob.content)) files.push([await bookPath(staging, path), digest]);
    await eachAtOnce(files, async ([target, digest]) => {
      signal?.throwIfAborted();
      if (!await remote.downloadBlob(contentBlobKey(tip.bookId, digest), target, { signal }) || await fileDigest(target) !== digest) {
        throw new RemoteSyncingError('a file of this book has not fully arrived yet.');
      }
      signal?.throwIfAborted();
      each();
    });
    await writeFile(join(staging, 'project.json'), JSON.stringify(project, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(staging, 'photos.json'), JSON.stringify(photos, null, 2) + '\n', { flag: 'wx' });
    facts = photoFacts(blob.assetsMeta.assets, photos);
    await AssetFacts.adoptSynced(staging, facts);
    await storeProxies(await fetchProxies(remote, tip.bookId, previews, { signal, each }));
    if (await captureBookState(staging).then(({ revision }) => revision) !== tip.bookStateRevision) {
      throw new Error('The book on the remote does not match its commit. Nothing was created.');
    }
    signal?.throwIfAborted();
    // Reserve the name exclusively: never replace a book or file that is already there, even an empty package.
    try { await mkdir(folder); reserved = true; }
    catch (error) { throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? new Error(taken, { cause: error }) : error; }
    await rename(staging, folder);
    reserved = false;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (reserved) await rmdir(folder).catch(() => {});
  }
  await updateSyncState(folder, () => ({ version: 1, ...(remoteId ? { remoteId, enabled: true } : {}),
    lastSynced: { commitId: tip.commitId, bookId: tip.bookId, bookStateRevision: tip.bookStateRevision, stateDigest: tip.stateDigest, photoDigests: digestsOf(facts), localDigests: {} } }));
  await trustBook(folder);
  return folder;
}

/**
 * Sync Again (#283), for a book that was deleted from sync on another Mac and is kept here: it becomes a new book on
 * the remote, with a new lineage in project.json (`bookId`) and a fresh history, so the tombstone of the old one stays.
 * Its sync record forgets what it last synced and syncs with `remoteId` from its next sync on. Needs the writer lock,
 * held by the open book's session or taken for a closed one. A pull that was interrupted is finished first; one that
 * could not be finished (the book may be half-pulled) starts nothing (`SyncHalfPulledError`), as for any new history.
 */
export async function newBookHistory(folder: string, remoteId: string) {
  const root = await realpath(folder);
  if (!await holdsProjectLock(root)) throw new Error('Open the book for editing to sync it again.');
  const before = await readSyncState(root);
  if (before.pull) {
    try { await finishPull(root, before.pull); }
    catch (error) { throw new SyncHalfPulledError(error instanceof Error ? error.message : String(error)); }
  }
  const { abandoned } = await readSyncState(root);
  if (abandoned) throw new SyncHalfPulledError(abandoned.error);
  // Older originals a pull kept were waiting for versions that were only in the deleted book: the files here are what
  // the new book has of those photos, so their facts become the files' (the book shows them as files again).
  const kept = await keptOriginals(root);
  // The record first: a crash after it leaves the book with its old lineage and no record of the deleted history, so
  // its next sync finds the deleted book (its marker, as it has no commits) and asks again; Sync Again then finishes.
  await updateSyncState(root, ({ lastSynced: _, pull: __, abandoned: ___, ...state }) => ({ ...state, remoteId, enabled: true }));
  if (kept.size) {
    const facts = await readAssetFacts(root);
    await AssetFacts.adoptSynced(root, Object.fromEntries(Object.entries(facts).filter(([id]) => !kept.has(id))));
  }
  const manifests = { 'project.json': await readFile(join(root, 'project.json')), 'photos.json': await readFile(join(root, 'photos.json')) };
  const project = parseDocument(projectSchema, JSON.parse(manifests['project.json'].toString('utf8')), 'project.json');
  const photos = parseDocument(photoIndexSchema, JSON.parse(manifests['photos.json'].toString('utf8')), 'photos.json');
  const bookId = randomUUID();
  const after = { ...manifests, 'project.json': Buffer.from(JSON.stringify(withBookFormat(parseDocument(projectSchema, { ...project, bookId }, 'project.json'), photos), null, 2) + '\n') };
  await persistProjectManifests(root, manifests, after, { origin: 'app', label: 'Sync again' });
  return { bookId, reverted: kept.size };
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
    const away = await originalsNotHere(root, remote).catch(() => ({ ids: [], notUploaded: [] as string[], neverUploaded: undefined }));
    const base = { pendingOriginals: away.ids.length, ...(away.notUploaded.length ? { notUploaded: away.notUploaded.length } : {}),
      ...(away.neverUploaded?.length ? { neverUploaded: neverUploadedText(away.neverUploaded) } : {}) };
    // A pull given up stays the status until a sync succeeds: the book may be half-pulled.
    if (state.abandoned) return { ...base, state: 'abandoned', detail: state.abandoned.error };
    const local = await captureBookState(root);
    const bookId = local.project.bookId;
    if (!bookId) return { ...base, state: 'ahead' };
    const commits = await remoteCommits(remote, bookId);
    // Deleted from sync on another Mac: the book asks to be kept here only or synced again, and pushes nothing. As cheap
    // as the listing of commits: the marker is read only for a book without commits, and the tombstone of one with
    // commits only where a listing answers it (see `deletedFromSync`).
    if (await deletedFromSync(remote, bookId, commits.length, { listedOnly: true })) return { state: 'removed', pendingOriginals: 0 };
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
