import assert from 'node:assert/strict';
import { test as runTest } from 'node:test';
import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { configureRenditionCache } from '../desktop/rendition-cache';
import { configureProxyStore } from '../desktop/proxy-store';
import { AssetFacts, readAssetFacts } from '../desktop/asset-facts';
import { acquireProjectLock, bookStateFolder, readSaveLedger } from '../desktop/persistence';
import { importIntoProject, loadProject, updateProject } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { collectSources, relinkFolder, relocateSource, removeSources, saveDocumentCopy } from '../desktop/source-actions';
import { cleanUp, cleanUpQuestion, planCleanUp } from '../desktop/sync-sweep';
import { captureBookStateRevision } from '../desktop/revisions';
import { BookDownloads } from '../desktop/downloads';
import { cloneFromRemote, describeLocalChange, describeSync, downloadName, downloadOriginals, newBookHistory, originalsAway, originalsNotHere, pendingOriginals, pendingUploads, placeOriginals, RemoteSyncingError, stageOriginals, stageSyncPull, syncBook, ensureBookId, uploadAhead, uploadOriginals } from '../desktop/sync-engine';
import type { SyncOptions, UploadedPreviews } from '../desktop/sync-engine';
import { memoryRemote, remoteBooks, remoteTips, StoreRemote } from '../desktop/sync-remote';
import type { SyncRemote } from '../desktop/sync-remote';
import { FolderStore, folderRemote } from '../desktop/sync-store-folder';
import { MemoryStore } from '../desktop/sync-store';
import type { SyncStore } from '../desktop/sync-store';
import { storeConformance } from './sync-store-conformance';
import { s3Remote } from './s3-remote';
import { FakeS3, fakeCredentials } from './s3-fake';
import { credentialScope, MemoryCredentialStore } from '../desktop/sync-credentials';
import { unavailableStatus } from '../desktop/sync-engine';
import { S3Store } from '../desktop/sync-store-s3';
import { StoreAccessError, StoreFullError } from '../desktop/sync-store';
import { FakeCloudKit } from './cloudkit-fake';
import { CloudKitStore } from '../desktop/sync-store-cloudkit';
import { MemoryKeyIndexCache } from '../desktop/sync-key-index';
import { MemoryHeaderCache } from '../desktop/sync-header-cache';
import { readCommitHeaderV1 } from './sync-v1-reader';
import { bookTrusted, distrustBook, trustBook } from '../desktop/source-access';
import { configureSyncSetup, readSyncState, startNewBook, startSyncing, SyncElsewhereError, SyncHalfPulledError, SyncStoppedError, takeAbandonedAtOpen, updateSyncState } from '../desktop/sync-pull';
import { insideBook, pendingUploadsText, SyncService, UntrustedBookError } from '../desktop/sync-service';
import { ClosedBookSyncs } from '../desktop/sync-closed';
import { FirstSync, settleSyncSetup, syncExcludedBook } from '../desktop/sync-start';
import { AutomaticRuns, AutoSync, autoSyncTiming, SyncInterruptedError } from '../desktop/sync-auto';
import { SettingsStore } from '../desktop/settings';
import { syncPatchError, syncSetupPatch } from '../desktop/sync-settings';
import type { FolderSyncBackend, S3SyncBackend, SyncBackend } from '../src/settings';
import { blobKeyPattern, bookPrefix, commitKey, contentBlobKey, coverBlobKey, deletedMarkerKey, decideSync, readBookTombstone, readCommitHeader, readRemoteIdentity, NewerSyncFormatError, deriveTips, isUnlocatedPath, originalBlobKey, portableManifests,
  projectManifests, proxyBlobKey, stateBlobSchema, tombstoneKey } from '../src/sync-snapshot';
import type { CommitHeader, StateBlob } from '../src/sync-snapshot';
import type { ProjectFiles } from '../src/project';
import { printProblem } from '../src/source-locations';
import { copySample } from '../desktop/sample-book.mjs';
import { canonicalJson } from '../src/canonical-json';
import { computeBookStateRevision } from '../src/book-revision';
import { photoIndexSchema, projectSchema } from '../src/project';
import { persistenceRoot } from './persistence-root';
import { importProvidedPhotos } from '../desktop/project';
import { LightroomBridge } from '../desktop/lightroom/bridge';
import { lightroomProvider } from '../desktop/providers/lightroom';
import { catalogId, FakeLightroom, uuid as lightroomUuid } from './lightroom-fake';
import type { FakePhoto } from './lightroom-fake';
import { registerProvider } from '../desktop/providers';
import type { Materialized, MaterializeOptions, Observed, Revisions, SourceProvider, SourceRef, Unavailable } from '../desktop/source-provider';
import { registerLocatorKind } from '../src/source-locator';
import type { LocatorKind } from '../src/source-locator';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const image = (path: string, color: string, width = 120, height = 80) =>
  sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(path);

// Each Mac has its own book folder, source store, approvals, rendition cache and proxy store. The stores are
// configured globally, so a Mac is switched to before each step.
type Mac = { base: string; folder: string; cache: string; external: string };
async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-sync-')));
  t.after(async () => { await SourceStore.drain(); configureProxyStore(undefined); await rm(root, { recursive: true, force: true }); });
  const mac = async (name: string): Promise<Mac> => {
    const base = join(root, name);
    await mkdir(join(base, 'cache'), { recursive: true });
    await mkdir(join(base, 'external'), { recursive: true });
    return { base, folder: join(base, 'Book.imageflow'), cache: join(base, 'cache'), external: join(base, 'external') };
  };
  const a = await mac('desktop');
  const b = await mac('laptop');
  await copySample(resolve('sample/starter'), a.folder);
  return { root, a, b, remote: await newRemote(root) };
}

// The engine tests (`each`) run against every store behind the same `StoreRemote`: the memory store here, and the
// folder, S3 and iCloud (over a fake CloudKit) stores in processes of their own (tests/sync-folder-store.test.ts,
// tests/sync-s3-store.test.ts, tests/sync-cloudkit-engine.test.ts), so the runs go side by side. Every other test
// (`test`) runs once, here.
type Remote = StoreRemote;
const store = (['folder', 's3', 'cloudkit'] as const).find((name) => name === process.env.IMAGEFLOW_SYNC_TEST_STORE) ?? 'memory';
// This file takes a quarter of an hour on a CI runner, so `npm run test:unit` (every pull request) runs a core set:
// `core` and `coreEach`, one test or so per feature and the ones that guard a user's data. Everything else (`test`,
// `each`) runs with IMAGEFLOW_TEST_FULL=1, which `npm run test:unit:full` and `npm run test:desktop` (nightly) set.
// New tests are `test` or `each` unless they belong to that core.
const full = process.env.IMAGEFLOW_TEST_FULL === '1';
const none = (() => {}) as unknown as typeof runTest;
const core: typeof runTest = store === 'memory' ? runTest : none;
const test: typeof runTest = full ? core : none;
const coreEach = (name: string, run: (t: TestContext) => Promise<void>) => runTest(name + ' (' + store + ' store)', run);
const each: typeof coreEach = full ? coreEach : async () => {};
async function newRemote(root: string, name = 'Remote'): Promise<Remote> {
  if (store === 'memory') return memoryRemote();
  if (store === 's3') return s3Remote();
  if (store === 'cloudkit') return new StoreRemote(new CloudKitStore(new FakeCloudKit(), { backoff: () => 0 }));
  await mkdir(join(root, name), { recursive: true });
  return folderRemote(join(root, name));
}
// What another Mac, another version or a damaged transfer leaves on a remote, written through the store alone.
const stored = async (remote: Remote, key: string) => (await remote.store.get(key))!;
const remove = (remote: Remote, key: string) => remote.store.delete([key]);
const replace = async (remote: Remote, key: string, bytes: Uint8Array) => { await remove(remote, key); await remote.store.putIfAbsent(key, bytes); };
const headerKey = (bookId: string, name: string) => 'books/' + bookId + '/snapshots/' + name + '.json';
const putHeader = (remote: Remote, bookId: string, name: string, value: unknown) => replace(remote, headerKey(bookId, name), new TextEncoder().encode(JSON.stringify(value)));
const commitCount = async (remote: Remote) => (await remote.store.list('books/')).filter(({ key }) => key.includes('/snapshots/')).length;
/** Delivers every object one remote has and the other lacks, as a sync service does with immutable files. */
const copyObjects = async (from: Remote, to: Remote) => { for (const { key } of await from.store.list('')) await to.store.putIfAbsent(key, await stored(from, key)); };
async function use(mac: Mac) {
  await SourceStore.drain();
  configureSourceStore(join(mac.base, 'source-cache'));
  configureSourceAccess(join(mac.base, 'source-access'));
  await configureRenditionCache(mac.cache, join(mac.base, 'renditions'));
  await configureProxyStore(join(mac.base, 'proxies'));
}
/** Opens the book for editing on a Mac, runs `step` and closes it again. */
async function on<T>(mac: Mac, step: (book: OpenProject) => Promise<T>) {
  await use(mac);
  const release = await acquireProjectLock(mac.folder);
  try { return await step(await loadProject(mac.folder, mac.cache)); }
  finally { await AssetFacts.release(mac.folder); await SourceStore.drain(); await release(); }
}
/**
 * A sync as the app makes it: the engine's sync, then the background upload of the originals its commit named
 * (`uploadOriginals`, which the app's sync service runs). The book is recorded as syncing with the remote it was given,
 * as the service does before a sync. `commitOnly` stops after the commit, as a Mac that quits before the upload.
 */
const sync = async (mac: Mac, remote: SyncRemote, options: Omit<SyncOptions, 'remote' | 'book'> = {}) => {
  const outcome = await commitOnly(mac, remote, options);
  await uploadAll(mac, remote);
  return outcome;
};
const commitOnly = (mac: Mac, remote: SyncRemote, options: Omit<SyncOptions, 'remote' | 'book'> = {}) => on(mac, (book) => syncBook({ remote, book, ...options }));
async function uploadAll(mac: Mac, remote: SyncRemote, options: Partial<Parameters<typeof uploadOriginals>[0]> = {}) {
  const remoteId = await remote.remoteId();
  await updateSyncState(mac.folder, (state) => (state.remoteId || !state.lastSynced ? state : { ...state, remoteId }));
  return uploadOriginals({ folder: mac.folder, connect: async () => ({ remote, remoteId }), ...options });
}
const edit = (mac: Mac, change: (files: ProjectFiles) => void) => on(mac, async (book) => {
  const files = structuredClone({ project: book.project, photoIndex: book.photoIndex });
  change(files);
  return updateProject(book, files);
});
const caption = (id: string, text: string) => (files: ProjectFiles) => { files.photoIndex[id].caption = text; };
const manifests = async (mac: Mac) => ({ project: JSON.parse(await readFile(join(mac.folder, 'project.json'), 'utf8')), photos: JSON.parse(await readFile(join(mac.folder, 'photos.json'), 'utf8')) });
const bookId = async (mac: Mac) => (await manifests(mac)).project.bookId as string;
const tips = async (remote: SyncRemote, mac: Mac) => remoteTips(remote, await bookId(mac));
const stateOf = async (remote: Remote, header: CommitHeader): Promise<StateBlob> =>
  stateBlobSchema.parse(JSON.parse(Buffer.from(await stored(remote, contentBlobKey(header.bookId, header.stateDigest))).toString('utf8')));
const commit = async (remote: SyncRemote, mac: Mac, id: string) => readCommitHeader(await remote.getCommit(await bookId(mac), id))!;
const proxyFile = async (mac: Mac, digest: string) => {
  for (const ext of ['.jpg', '.png']) {
    const path = join(mac.base, 'proxies', digest + '-preview-v1' + ext);
    if (await lstat(path).catch(() => undefined)) return path;
  }
  return undefined;
};
/** The laptop starts as a Finder or AirDrop copy of the desktop's book, with no sync record of its own. */
const copyBook = (from: Mac, to: Mac) => cp(from.folder, to.folder, { recursive: true });

core('the decision table: fast-forward or keep both, and facts never diverge', () => {
  const header = (commitId: string, bookStateRevision: string, parents: string[] = []): CommitHeader => ({ version: 2, commitId, bookId: '00000000-0000-4000-8000-000000000000',
    parents, bookStateRevision, createdAt: '2026-11-21T10:00:00.000Z', title: 'Book', stateDigest: 'f'.repeat(64) });
  const [r1, r2, r3] = ['1', '2', '3'].map((digit) => digit.repeat(64));
  const c1 = header('00000000-0000-4000-8000-000000000001', r1);
  const c2 = header('00000000-0000-4000-8000-000000000002', r2, [c1.commitId]);
  const c3 = header('00000000-0000-4000-8000-000000000003', r3, [c1.commitId]);
  assert.deepEqual(deriveTips([c1, c2]).map(({ commitId }) => commitId), [c2.commitId]);
  assert.equal(deriveTips([c1, c2, c3]).length, 2);
  const synced = { commitId: c1.commitId, bookStateRevision: r1 };
  const decide = (input: Partial<Parameters<typeof decideSync>[0]>) => decideSync({ pullInProgress: false, tips: [c1], commits: [c1, c2, c3], lastSynced: synced, localRevision: r1, factsChanged: false, ...input }).action;
  assert.equal(decide({ pullInProgress: true }), 'resume');
  assert.equal(decide({ tips: [], lastSynced: undefined }), 'initial-push');
  assert.equal(decide({ tips: [], commits: [] }), 'remote-behind', 'an empty listing never starts a second history');
  assert.equal(decide({ tips: [c2], commits: [c2] }), 'remote-behind');
  assert.equal(decide({ tips: [c2], commits: [c1, c2] }), 'fast-forward');
  assert.equal(decide({ tips: [c2, c3] }), 'diverged');
  assert.equal(decide({ lastSynced: undefined }), 'adopt');
  assert.equal(decide({ lastSynced: undefined, localRevision: r2 }), 'diverged');
  assert.equal(decide({}), 'in-sync');
  assert.equal(decide({ localRevision: r2 }), 'push');
  assert.equal(decide({ factsChanged: true }), 'push');
  assert.equal(decide({ tips: [c2] }), 'fast-forward');
  assert.deepEqual(decideSync({ pullInProgress: false, tips: [c2], commits: [c1, c2], lastSynced: synced, localRevision: r1, factsChanged: true }), { action: 'fast-forward', tip: c2, thenPush: true });
  assert.equal(decide({ tips: [c2], localRevision: r3 }), 'diverged');
});

core('a snapshot carries linked paths as file names, and a pull keeps this Mac’s own paths', () => {
  const project = { schemaVersion: 1, title: 'B', template: { id: 't', version: '1' }, params: {}, spreads: [],
    texts: { a: { path: '/Users/alice/story.md', linked: true }, b: 'texts/b.md' }, files: {} } as never;
  const photos = { x: { path: '/Users/alice/Pictures/x.jpg', linked: true, caption: 'c' }, y: { path: 'photos/y.jpg' } };
  const portable = portableManifests(project, photos);
  assert.deepEqual(portable.photos.x, { path: 'x.jpg', linked: true, caption: 'c' });
  assert.deepEqual((portable.project.texts as Record<string, unknown>).a, { path: 'story.md', linked: true });
  const pulled = projectManifests({ ...portable, photos: { ...portable.photos, z: { path: 'z.jpg', linked: true } } },
    { photos: { x: { path: '/Volumes/Photos/x-renamed.jpg', linked: true } } });
  assert.equal((pulled.photos.x as { path: string }).path, '/Volumes/Photos/x-renamed.jpg');
  assert.equal((pulled.photos.z as { path: string }).path, '/imageflow-unlocated/z.jpg');
  assert.equal((pulled.photos.y as { path: string }).path, 'photos/y.jpg');
  assert.ok(isUnlocatedPath(((pulled.project.texts as Record<string, { path: string }>).a).path));
});

coreEach('desktop and laptop: adopt, push after import, proxies first, originals on demand, linked paths stay per Mac', async (t) => {
  const { a, b, remote } = await world(t);
  // Desktop: the first push gives the book its lineage ID and uploads everything.
  const first = await sync(a, remote);
  assert.equal(first.action, 'initial-push');
  assert.equal(first.changed, true, 'the lineage ID was saved');
  const [c1] = await tips(remote, a);
  assert.deepEqual(c1.parents, []);
  assert.equal(c1.bookStateRevision, await captureBookStateRevision(a.folder));
  const s1 = (await stateOf(remote, c1));
  assert.ok(s1.originals.shore && await remote.hasBlob(originalBlobKey(c1.bookId, s1.originals.shore.digest, s1.originals.shore.ext)));
  assert.equal(s1.originals.shore.digest, sha(await readFile(join(a.folder, 'photos/shore.jpg'))));

  // Laptop: an AirDropped copy with the same book state adopts the tip.
  await copyBook(a, b);
  const adopted = await sync(b, remote);
  assert.equal(adopted.action, 'adopt');
  assert.equal((await readSyncState(b.folder)).lastSynced?.commitId, c1.commitId);
  assert.equal((await sync(b, remote)).action, 'in-sync');

  // Desktop links a photo from its own folder and pushes.
  const linkedPhoto = join(a.external, 'harbour.jpg');
  await image(linkedPhoto, '#336699');
  const linked = await on(a, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'link' }, [linkedPhoto])).imported[0]);
  const pushed = await sync(a, remote);
  assert.equal(pushed.action, 'push');
  const c2 = await commit(remote, a, pushed.pushed[0]);
  assert.deepEqual(c2.parents, [c1.commitId]);
  const s2 = (await stateOf(remote, c2));
  assert.deepEqual(s2.photos[linked], { path: 'harbour.jpg', linked: true, title: 'harbour' }, 'the desktop’s folder layout never leaves it');
  const linkedDigest = sha(await readFile(linkedPhoto));
  assert.equal(s2.assetsMeta.assets[linked].digest, linkedDigest, 'a push right after an import waits for the digest');
  assert.equal(s2.originals[linked], undefined, 'linked originals stay where they are');
  const proxyEntry = s2.proxies[linkedDigest];
  assert.ok(proxyEntry, 'the proxy goes along');
  assert.equal(sha(await stored(remote, proxyBlobKey(c2.bookId, linkedDigest, proxyEntry.ext))), proxyEntry.sha256, 'with its own SHA-256');

  // Laptop: the linked photo arrives unlocated and is drawn from its proxy.
  const pulled = await sync(b, remote);
  assert.equal(pulled.action, 'fast-forward');
  const onLaptop = (await manifests(b)).photos[linked];
  assert.equal(onLaptop.path, '/imageflow-unlocated/harbour.jpg');
  await on(b, async (book) => {
    assert.equal(book.sources!['photo:' + linked].state, 'unapproved');
    assert.equal(book.sources!['photo:' + linked].cached, true);
    assert.equal(book.photos.get(linked)!.original, await proxyFile(b, linkedDigest));
    assert.deepEqual([book.photos.get(linked)!.width, book.photos.get(linked)!.height], [120, 80]);
  });

  // Laptop: Locate Folder… finds its own copy by the synced digest.
  const laptopCopy = join(b.external, 'Exports');
  await mkdir(laptopCopy);
  await cp(linkedPhoto, join(laptopCopy, 'harbour.jpg'));
  await on(b, async (book) => {
    const result = await relinkFolder(book, laptopCopy);
    assert.equal(result.repaired, 1);
    assert.equal(result.book.photoIndex[linked].path, join(laptopCopy, 'harbour.jpg'));
  });
  assert.equal((await sync(b, remote)).action, 'in-sync', 'locating a photo changes no portable state');

  // Laptop imports a copied photo and edits a caption; the desktop pulls both without overwriting its linked path.
  const laptopPhoto = join(b.external, 'laptop.jpg');
  await image(laptopPhoto, '#aa5500', 90, 60);
  const owned = await on(b, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'copy' }, [laptopPhoto])).imported[0]);
  await edit(b, caption('shore', 'From the laptop'));
  const fromLaptop = await sync(b, remote);
  assert.equal(fromLaptop.action, 'push');
  const s3 = (await stateOf(remote, await commit(remote, b, fromLaptop.pushed[0])));
  const ownedDigest = sha(await readFile(laptopPhoto));
  assert.deepEqual(s3.originals[owned], { digest: ownedDigest, ext: '.jpg' });
  assert.equal(s3.named?.[owned]?.digest, ownedDigest, 'with when it was first named');
  assert.equal(s3.photos[linked] && (s3.photos[linked] as { path: string }).path, 'harbour.jpg');
  assert.equal((await sync(a, remote)).action, 'fast-forward');
  const desktop = await manifests(a);
  assert.equal(desktop.photos.shore.caption, 'From the laptop');
  assert.equal(desktop.photos[linked].path, linkedPhoto, 'the desktop keeps its own path');

  // Desktop: the laptop's copied photo arrives as a proxy first, then its original on demand.
  const ownedPath = join(a.folder, desktop.photos[owned].path);
  assert.equal(await lstat(ownedPath).catch(() => undefined), undefined);
  await on(a, async (book) => {
    assert.equal(book.sources!['photo:' + owned].state, 'missing');
    assert.equal(book.photos.get(owned)!.original, await proxyFile(a, ownedDigest));
  });

  // Desktop, proxy-only for that photo, edits and pushes: the photo's original and proxy entries are carried forward.
  await edit(a, caption('segla', 'From the desktop'));
  const carried = await sync(a, remote);
  assert.equal(carried.action, 'push');
  const s4 = (await stateOf(remote, await commit(remote, a, carried.pushed[0])));
  assert.deepEqual(s4.originals[owned], s3.originals[owned]);
  assert.deepEqual(s4.proxies[ownedDigest], s3.proxies[ownedDigest]);
  assert.equal(s4.assetsMeta.assets[owned].digest, ownedDigest);

  // Laptop pulls the desktop's caption and keeps its own located path.
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await manifests(b)).photos[linked].path, join(laptopCopy, 'harbour.jpg'));
  assert.equal((await manifests(b)).photos.segla.caption, 'From the desktop');

  // Desktop downloads the original for print.
  await on(a, async (book) => assert.deepEqual(await downloadOriginals({ remote, book }), [owned]));
  assert.equal(sha(await readFile(ownedPath)), ownedDigest);
  await on(a, async (book) => assert.equal(book.sources!['photo:' + owned].state, 'available'));

  // Laptop: the located copy goes away again and the proxy store evicted the proxy; a sync with nothing else to do
  // fetches it again.
  await rm(join(laptopCopy, 'harbour.jpg'));
  await rm((await proxyFile(b, linkedDigest))!);
  assert.equal((await sync(b, remote)).action, 'in-sync');
  assert.ok(await proxyFile(b, linkedDigest), 'the proxy is back');
});

coreEach('an in-place re-export and a caption edit elsewhere fast-forward, merge facts and push, with no conflict copy', async (t) => {
  const { root, a, b, remote } = await world(t);
  const linkedPhoto = join(a.external, 'export.jpg');
  await image(linkedPhoto, '#225522');
  const linked = await on(a, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'link' }, [linkedPhoto])).imported[0]);
  await sync(a, remote);
  await copyBook(a, b);
  assert.equal((await sync(b, remote)).action, 'adopt');
  await edit(b, caption('shore', 'Laptop caption'));
  assert.equal((await sync(b, remote)).action, 'push');
  // Lightroom writes the photo again, in place, with other bytes.
  await image(linkedPhoto, '#dd2222', 160, 90);
  const digest = sha(await readFile(linkedPhoto));
  const outcome = await sync(a, remote);
  assert.equal(outcome.action, 'fast-forward');
  assert.equal(outcome.pushed.length, 1, 'the newer fact goes back');
  assert.equal(outcome.conflictCopy, undefined);
  assert.equal((await manifests(a)).photos.shore.caption, 'Laptop caption');
  const [tip] = await tips(remote, a);
  assert.equal(tip.commitId, outcome.pushed[0]);
  const state = (await stateOf(remote, tip));
  assert.equal(state.assetsMeta.assets[linked].digest, digest);
  assert.deepEqual([state.assetsMeta.assets[linked].width, state.assetsMeta.assets[linked].height], [160, 90]);
  assert.ok(state.proxies[digest]);
  assert.equal((await readAssetFacts(a.folder))[linked].digest, digest);
  assert.deepEqual((await readdir(join(root, 'desktop'))).filter((name) => name.includes('Conflict')), []);
  // The laptop takes the new facts without a conflict either.
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await readAssetFacts(b.folder))[linked].digest, digest);
});

each('a pull deletes template files the snapshot no longer has, and a pulled template change needs no review of its own', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await writeFile(join(a.folder, 'template', 'notes.txt'), 'draft');
  assert.equal((await sync(a, remote)).action, 'push');
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal(await readFile(join(b.folder, 'template', 'notes.txt'), 'utf8'), 'draft');
  // Only trusted books sync (#282): a pulled template takes the path of the book's own edits, so the record marks
  // nothing for a review of its own.
  assert.equal('networkReview' in await readSyncState(b.folder), false);
  await rm(join(a.folder, 'template', 'notes.txt'));
  await sync(a, remote);
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal(await lstat(join(b.folder, 'template', 'notes.txt')).catch(() => undefined), undefined);
  assert.equal(await captureBookStateRevision(b.folder), (await tips(remote, a))[0].bookStateRevision);
  assert.equal('networkReview' in await readSyncState(b.folder), false);
});

coreEach('an incomplete or corrupted remote fails as still syncing and leaves the book untouched', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const photo = join(a.external, 'new.jpg');
  await image(photo, '#123456');
  await on(a, async (book) => importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo]));
  await writeFile(join(a.folder, 'template', 'notes.txt'), 'new');
  await edit(a, caption('shore', 'Remote edit'));
  await sync(a, remote);
  const state = (await stateOf(remote, (await tips(remote, a))[0]));
  const digest = sha(await readFile(photo));
  const proxyKey = proxyBlobKey(await bookId(a), digest, state.proxies[digest].ext);
  const goodProxy = await stored(remote, proxyKey);
  const before = { files: await manifests(b), ledger: (await readSaveLedger(b.folder)).records.length, synced: (await readSyncState(b.folder)).lastSynced };
  const untouched = async () => {
    assert.deepEqual(await manifests(b), before.files);
    assert.equal((await readSaveLedger(b.folder)).records.length, before.ledger);
    assert.equal(await lstat(join(b.folder, 'template', 'notes.txt')).catch(() => undefined), undefined);
    const now = await readSyncState(b.folder);
    assert.equal(now.pull, undefined);
    assert.deepEqual(now.lastSynced, before.synced);
  };
  // A proxy whose bytes fail its own SHA-256.
  await replace(remote, proxyKey, goodProxy.slice(0, goodProxy.length - 10));
  await assert.rejects(sync(b, remote), RemoteSyncingError);
  await untouched();
  await replace(remote, proxyKey, goodProxy);
  // A content blob that has not arrived.
  const notes = contentBlobKey(await bookId(a), state.content['template/notes.txt']);
  const notesBytes = await stored(remote, notes);
  await remove(remote, notes);
  await assert.rejects(sync(b, remote), /Remote still syncing/);
  await untouched();
  await replace(remote, notes, notesBytes);
  // A state blob that does not match its commit.
  const [tip] = await tips(remote, a);
  const stateBytes = await stored(remote, contentBlobKey(tip.bookId, tip.stateDigest));
  await replace(remote, contentBlobKey(tip.bookId, tip.stateDigest), new TextEncoder().encode('{}'));
  await assert.rejects(sync(b, remote), RemoteSyncingError);
  await untouched();
  await replace(remote, contentBlobKey(tip.bookId, tip.stateDigest), stateBytes);
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await manifests(b)).photos.shore.caption, 'Remote edit');
});

coreEach('a pull interrupted after it was staged is finished when the book opens', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await writeFile(join(a.folder, 'template', 'notes.txt'), 'new');
  await edit(a, caption('shore', 'Before the crash'));
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  // The laptop staged the pull and had written one file of it when it crashed.
  await on(b, async (book) => { await stageSyncPull(remote, book, tip); });
  await writeFile(join(b.folder, 'template', 'notes.txt'), 'new');
  assert.equal((await readSyncState(b.folder)).pull?.targetCommit, tip.commitId);
  // Opening the book finishes the pull before anything reads the manifests, without the remote.
  await on(b, async (book) => {
    assert.equal(book.photoIndex.shore.caption, 'Before the crash');
  });
  const state = await readSyncState(b.folder);
  assert.equal(state.pull, undefined);
  assert.equal(state.lastSynced?.commitId, tip.commitId);
  assert.equal(await captureBookStateRevision(b.folder), tip.bookStateRevision);
  assert.equal((await sync(b, remote)).action, 'in-sync', 'no false divergence');
  // A read-only load refuses a book with an unfinished pull.
  await on(b, async (book) => { await stageSyncPull(remote, book, tip); });
  await assert.rejects(loadProject(b.folder, b.cache, true), /interrupted sync/);
});

coreEach('an AirDropped book edited before its first sync keeps both versions', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await edit(b, caption('shore', 'Laptop, never synced'));
  const outcome = await sync(b, remote);
  assert.equal(outcome.action, 'diverged');
  assert.ok(outcome.conflictCopy && /Book \(Conflict \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\)\.imageflow$/.test(outcome.conflictCopy));
  const copy = JSON.parse(await readFile(join(outcome.conflictCopy, 'photos.json'), 'utf8'));
  const copyProject = JSON.parse(await readFile(join(outcome.conflictCopy, 'project.json'), 'utf8'));
  assert.equal(copy.shore.caption, 'Laptop, never synced');
  assert.notEqual(copyProject.bookId, await bookId(a), 'the copy is a new lineage');
  assert.equal((await readSyncState(outcome.conflictCopy)).lastSynced, undefined, 'and is not linked to the remote');
  assert.notEqual((await manifests(b)).photos.shore.caption, 'Laptop, never synced');
  assert.equal(await captureBookStateRevision(b.folder), (await tips(remote, a))[0].bookStateRevision);
  assert.equal((await sync(b, remote)).action, 'in-sync');
});

each('two tips stay until the user picks one, which closes the fork with both as parents', async (t) => {
  const { root, a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  // Both Macs edit offline; their pushes reach the remote independently.
  const offline = await newRemote(root, 'Offline');
  await copyObjects(remote, offline);
  await edit(a, caption('shore', 'Desktop'));
  const [cA] = (await sync(a, remote)).pushed;
  await edit(b, caption('shore', 'Laptop'));
  const [cB] = (await sync(b, offline)).pushed;
  await copyObjects(offline, remote);
  assert.equal((await tips(remote, a)).length, 2);
  // Without a choice nothing changes.
  const waiting = await sync(a, remote, { chooseTip: async () => undefined });
  assert.equal(waiting.action, 'diverged');
  assert.equal(waiting.changed, false);
  assert.equal(waiting.tips?.length, 2);
  assert.equal((await manifests(a)).photos.shore.caption, 'Desktop');
  assert.equal((await tips(remote, a)).length, 2, 'never closed automatically');
  // The desktop picks the laptop's version. Its own is on the remote already, so no copy is needed.
  const offered: string[][] = [];
  const resolved = await sync(a, remote, { chooseTip: async (choices) => { offered.push(choices.map(({ commitId }) => commitId)); return cB; } });
  assert.deepEqual(offered[0].sort(), [cA, cB].sort());
  assert.equal(resolved.pulled, cB);
  assert.equal(resolved.conflictCopy, undefined);
  assert.equal((await manifests(a)).photos.shore.caption, 'Laptop');
  const after = await tips(remote, a);
  assert.equal(after.length, 1);
  assert.deepEqual([...after[0].parents].sort(), [cA, cB].sort());
  assert.equal(after[0].commitId, resolved.pushed[0]);
  assert.equal((await sync(a, remote)).action, 'in-sync');
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await sync(b, remote)).action, 'in-sync');
});

each('an original left at an older digest never overrides a re-export from another Mac, and is not pushed back', async (t) => {
  const { a, b, remote } = await world(t);
  // Both Macs have the owned photo `shore` and a linked photo, each in their own folder, at the same digest.
  const desktopPhoto = join(a.external, 'shared.jpg');
  await image(desktopPhoto, '#445566');
  const linked = await on(a, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'link' }, [desktopPhoto])).imported[0]);
  await sync(a, remote);
  await copyBook(a, b);
  const laptopFolder = join(b.external, 'Shared');
  await mkdir(laptopFolder);
  await cp(desktopPhoto, join(laptopFolder, 'shared.jpg'));
  await on(b, async (book) => { assert.equal((await relinkFolder(book, laptopFolder)).repaired, 1); });
  assert.equal((await sync(b, remote)).action, 'adopt');
  assert.equal((await sync(b, remote)).action, 'in-sync');
  // The desktop replaces both: the owned photo in the book and the linked one in its folder.
  await image(join(a.folder, 'photos', 'shore.jpg'), '#ee0000', 200, 100);
  await image(desktopPhoto, '#00ee00', 150, 100);
  const shoreDigest = sha(await readFile(join(a.folder, 'photos', 'shore.jpg')));
  const linkedDigest = sha(await readFile(desktopPhoto));
  const fromDesktop = await sync(a, remote);
  assert.equal(fromDesktop.action, 'push', 'the desktop’s re-exports go up');
  const tip = (await tips(remote, a))[0];
  assert.equal((await stateOf(remote, tip)).assetsMeta.assets.shore.digest, shoreDigest);
  assert.equal((await stateOf(remote, tip)).assetsMeta.assets[linked].digest, linkedDigest);
  // The laptop still has the old bytes of both. It takes the new facts and proxies and pushes nothing back.
  const pulled = await sync(b, remote);
  assert.equal(pulled.action, 'fast-forward');
  assert.deepEqual(pulled.pushed, []);
  assert.equal((await tips(remote, a))[0].commitId, tip.commitId);
  const facts = await readAssetFacts(b.folder);
  assert.equal(facts.shore.digest, shoreDigest);
  assert.ok(await proxyFile(b, shoreDigest) && await proxyFile(b, linkedDigest), 'the new proxies arrived');
  assert.equal(await lstat(join(b.folder, 'photos', 'shore.jpg')).catch(() => undefined), undefined, 'the replaced owned original went');
  await on(b, async (book) => assert.equal(book.photos.get('shore')!.original, await proxyFile(b, shoreDigest)));
  // No ping-pong: the stale linked copy is not news.
  assert.equal((await sync(b, remote)).action, 'in-sync');
  assert.equal((await tips(remote, a))[0].commitId, tip.commitId);
  // Once the laptop's copies catch up, nothing changes either.
  await cp(desktopPhoto, join(laptopFolder, 'shared.jpg'));
  await on(b, async (book) => assert.deepEqual(await downloadOriginals({ remote, book }), ['shore']));
  assert.equal((await sync(b, remote)).action, 'in-sync');
  assert.equal(sha(await readFile(join(b.folder, 'photos', 'shore.jpg'))), shoreDigest);
  // And a later re-export on the laptop is news again.
  await image(join(laptopFolder, 'shared.jpg'), '#0000ee', 150, 100);
  const laptopDigest = sha(await readFile(join(laptopFolder, 'shared.jpg')));
  const fromLaptop = await sync(b, remote);
  assert.equal(fromLaptop.action, 'push');
  assert.equal((await stateOf(remote, (await tips(remote, a))[0])).assetsMeta.assets[linked].digest, laptopDigest);
});

each('keep both leaves no conflict copy behind while the remote is still syncing', async (t) => {
  const { b, a, remote } = await world(t);
  await writeFile(join(a.folder, 'template', 'notes.txt'), 'remote');
  await sync(a, remote);
  await copyBook(a, b);
  await edit(b, caption('shore', 'Laptop, never synced'));
  const [tip] = await tips(remote, a);
  const notes = contentBlobKey(tip.bookId, (await stateOf(remote, tip)).content['template/notes.txt']);
  const bytes = await stored(remote, notes);
  await remove(remote, notes);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(sync(b, remote), RemoteSyncingError);
  const conflicts = async () => (await readdir(b.base)).filter((name) => name.includes('Conflict'));
  assert.deepEqual(await conflicts(), []);
  assert.equal((await manifests(b)).photos.shore.caption, 'Laptop, never synced');
  await replace(remote, notes, bytes);
  const outcome = await sync(b, remote);
  assert.ok(outcome.conflictCopy);
  assert.equal((await conflicts()).length, 1);
});

each('a sync finishes an interrupted pull first, also for a book that still needs its lineage ID', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await edit(a, caption('shore', 'Pulled'));
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  await on(b, async (book) => { await stageSyncPull(remote, book, tip); });
  // The interrupted pull is finished by the sync itself. Opening the laptop's book would finish it first, so the open
  // book handed to the sync is the desktop's read under the laptop's folder.
  const project = JSON.parse(await readFile(join(b.folder, 'project.json'), 'utf8'));
  delete project.bookId;
  await writeFile(join(b.folder, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  await use(b);
  const release = await acquireProjectLock(b.folder);
  try {
    const book = { ...await loadProject(a.folder, a.cache, true), folder: b.folder, readOnly: false, cache: b.cache };
    const outcome = await syncBook({ remote, book });
    assert.equal(outcome.action, 'in-sync');
    assert.equal(outcome.changed, true);
  } finally { await AssetFacts.release(b.folder); await SourceStore.drain(); await release(); }
  assert.equal((await manifests(b)).photos.shore.caption, 'Pulled');
  assert.equal((await manifests(b)).project.bookId, await bookId(a));
});

each('a push refuses a proxy another Mac has not finished writing, and a failed download leaves no staging file', async (t) => {
  const { a, b, remote } = await world(t);
  const photo = join(a.external, 'both.jpg');
  await image(photo, '#778899');
  const id = await on(a, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo])).imported[0]);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const [tip] = await tips(remote, a);
  const state = (await stateOf(remote, tip));
  const digest = sha(await readFile(photo));
  const key = proxyBlobKey(tip.bookId, digest, state.proxies[digest].ext);
  const proxy = await stored(remote, key);
  // A snapshot from a Mac that had no proxy for this photo, then the remote's proxy is cut short: the laptop's next
  // push finds that proxy on the remote and would record it.
  await forge(remote, tip, (next) => { delete next.proxies[digest]; });
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  await replace(remote, key, proxy.slice(0, 200));
  await edit(b, caption(id, 'Laptop'));
  await on(b, async () => {});
  const before = await commitCount(remote);
  await assert.rejects(sync(b, remote), RemoteSyncingError);
  assert.equal(await commitCount(remote), before, 'no commit records a damaged proxy');
  await replace(remote, key, proxy);
  assert.equal((await sync(b, remote)).action, 'push');
  // The desktop lost its copy of the photo; a damaged original download stops without leaving files in the book.
  await rm(join(a.folder, (await manifests(a)).photos[id].path));
  await sync(a, remote);
  const original = originalBlobKey(tip.bookId, state.originals[id].digest, state.originals[id].ext);
  const good = await stored(remote, original);
  await replace(remote, original, good.slice(0, 100));
  await assert.rejects(on(a, (book) => downloadOriginals({ remote, book })), RemoteSyncingError);
  assert.deepEqual((await readdir(join(a.folder, 'photos'))).filter((name) => name.startsWith('.imageflow-write-')), []);
  await replace(remote, original, good);
  await on(a, async (book) => assert.deepEqual(await downloadOriginals({ remote, book }), [id]));
  // In the background: downloaded into the book's root and checked without holding the book, then placed. A damaged
  // download leaves nothing behind; a cancelled one before it started downloads nothing.
  const path = join(a.folder, (await manifests(a)).photos[id].path);
  await rm(path);
  await replace(remote, original, good.slice(0, 100));
  await assert.rejects(stageOriginals({ remote, folder: a.folder }), RemoteSyncingError);
  assert.deepEqual((await readdir(a.folder)).filter((name) => name.startsWith('.imageflow-write-')), []);
  await replace(remote, original, good);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await stageOriginals({ remote, folder: a.folder, signal: cancelled.signal }), []);
  const counts: number[][] = [];
  const staged = await stageOriginals({ remote, folder: a.folder, progress: (done, total) => counts.push([done, total]) });
  assert.deepEqual(staged.map(({ id: staged }) => staged), [id]);
  assert.deepEqual(counts, [[0, 1], [1, 1]]);
  assert.equal(await lstat(path).catch(() => undefined), undefined, 'nothing is in photos/ until it is placed');
  assert.deepEqual(await placeOriginals(a.folder, staged), [id]);
  assert.equal(sha(await readFile(path)), state.originals[id].digest);
  assert.deepEqual((await readdir(a.folder)).filter((name) => name.startsWith('.imageflow-write-')), []);
});

/** A commit on top of `tip` whose state blob is `change`d by hand, as another version or a hostile remote might write. */
async function forge(remote: Remote, tip: CommitHeader, change: (state: Record<string, any>) => void) {
  const state = JSON.parse(Buffer.from(await stored(remote, contentBlobKey(tip.bookId, tip.stateDigest))).toString('utf8'));
  change(state);
  const bytes = new TextEncoder().encode(canonicalJson(state));
  const stateDigest = sha(bytes);
  await replace(remote, contentBlobKey(tip.bookId, stateDigest), bytes);
  const bookStateRevision = await computeBookStateRevision({ project: projectSchema.parse(state.project), photos: photoIndexSchema.parse(state.photos), contentDigests: state.content });
  const header: CommitHeader = { ...tip, commitId: crypto.randomUUID(), parents: [tip.commitId], stateDigest, bookStateRevision, createdAt: new Date().toISOString() };
  await remote.putCommit(header);
  return header;
}

each('a remote that lists nothing, or not this Mac’s last commit yet, is still syncing', async (t) => {
  const { root, a, remote } = await world(t);
  await sync(a, remote);
  const empty = await newRemote(root, 'Empty');
  await assert.rejects(sync(a, empty), RemoteSyncingError);
  assert.equal(await commitCount(empty), 0, 'no second root commit');
});

each('a pull stages the snapshot as stored, so facts a newer version added never break it', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const [tip] = await tips(remote, a);
  const next = await forge(remote, tip, (state) => { state.assetsMeta.assets.shore.lens = 'from a newer version'; state.photos.shore.caption = 'Newer'; });
  const outcome = await sync(b, remote);
  assert.equal(outcome.action, 'fast-forward');
  assert.equal(outcome.pulled, next.commitId);
  assert.equal((await manifests(b)).photos.shore.caption, 'Newer');
  assert.equal((await readSyncState(b.folder)).pull, undefined);
});

each('a pull that cannot be written is refused before it is marked, and one that fails later is given up, not retried at every open', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await writeFile(join(a.folder, 'template', 'notes.txt'), 'new');
  await edit(a, caption('shore', 'Remote'));
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  // A folder where the snapshot has a file: refused before anything changes.
  await mkdir(join(b.folder, 'template', 'notes.txt'));
  const before = await manifests(b);
  await assert.rejects(sync(b, remote), /through a file or link|replace a folder/);
  assert.deepEqual(await manifests(b), before);
  assert.equal((await readSyncState(b.folder)).pull, undefined);
  await on(b, async () => {});
  await rm(join(b.folder, 'template', 'notes.txt'), { recursive: true });
  // A pull that fails after it was marked (here: a staged blob lost) is given up when the book opens: it opens.
  await on(b, (book) => stageSyncPull(remote, book, tip));
  const staged = sha(new TextEncoder().encode('new'));
  for (const name of await readdir(persistenceRoot)) await rm(join(persistenceRoot, name, 'sync', 'staged', staged), { force: true });
  await on(b, async (book) => assert.ok(book.photoIndex.shore));
  const state = await readSyncState(b.folder);
  assert.equal(state.pull, undefined);
  assert.equal(state.lastSynced, undefined, 'this Mac forgets what it last synced');
  // It leaves a trace: the status says why, and the editor tells the user once that it failed at open.
  assert.equal(state.abandoned?.targetCommit, tip.commitId);
  assert.match(state.abandoned!.error, /ENOENT|damaged/);
  assert.equal(state.abandoned!.bookStateRevision, await captureBookStateRevision(b.folder));
  assert.equal((await describeSync(b.folder, remote)).state, 'abandoned');
  assert.equal((await takeAbandonedAtOpen(b.folder))?.targetCommit, tip.commitId);
  assert.equal(await takeAbandonedAtOpen(b.folder), undefined, 'told once');
  await on(b, async () => {});
  // The half-pulled book holds nothing unique (this Mac's version was on the remote before the fast-forward): the
  // next sync pulls again without a conflict copy.
  const outcome = await sync(b, remote);
  assert.equal(outcome.action, 'diverged');
  assert.equal(outcome.conflictCopy, undefined);
  assert.equal((await readSyncState(b.folder)).abandoned, undefined);
  assert.equal(await captureBookStateRevision(b.folder), tip.bookStateRevision);
  assert.equal((await sync(b, remote)).action, 'in-sync');
});

each('commits and snapshots from a newer version stop sync with a request to update', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  const id = await bookId(a);
  await putHeader(remote, id, 'future', { ...tip, version: 3, commitId: crypto.randomUUID(), parents: [tip.commitId] });
  await assert.rejects(sync(a, remote), NewerSyncFormatError);
  await remove(remote, headerKey(id, 'future'));
  await putHeader(remote, id, 'extra', { ...tip, commitId: crypto.randomUUID(), parents: [tip.commitId], signature: 'x' });
  await assert.rejects(sync(a, remote), NewerSyncFormatError);
  await remove(remote, headerKey(id, 'extra'));
  await forge(remote, tip, (state) => { state.future = true; });
  await assert.rejects(sync(a, remote), NewerSyncFormatError);
});

each('a pull refuses template folders a book never carries', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const [tip] = await tips(remote, a);
  const bytes = new TextEncoder().encode('module.exports = 1');
  await replace(remote, contentBlobKey(tip.bookId, sha(bytes)), bytes);
  await forge(remote, tip, (state) => { state.content['template/node_modules/evil/index.js'] = sha(bytes); });
  await assert.rejects(sync(b, remote), /stay inside the book/);
  assert.equal(await lstat(join(b.folder, 'template', 'node_modules')).catch(() => undefined), undefined);
});

each('pushes reuse recorded proxies, and a pull reuses local bytes for a photo copied into the book elsewhere', async (t) => {
  const { a, b, remote } = await world(t);
  const photo = join(a.external, 'moved.jpg');
  await image(photo, '#665544');
  const id = await on(a, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'link' }, [photo])).imported[0]);
  await sync(a, remote);
  await copyBook(a, b);
  await cp(photo, join(b.external, 'moved.jpg'));
  await on(b, async (book) => { assert.equal((await relinkFolder(book, b.external)).repaired, 1); });
  await sync(b, remote);
  // An edit pushes without reading any proxy from the remote again.
  const getBlob = remote.getBlob.bind(remote);
  const read: string[] = [];
  remote.getBlob = async (key) => { read.push(key); return getBlob(key); };
  await edit(a, caption('shore', 'Edited'));
  assert.equal((await sync(a, remote)).action, 'push');
  assert.deepEqual(read.filter((key) => key.includes('/proxies/')), []);
  remote.getBlob = getBlob;
  // The desktop copies the linked photo into the book; the laptop has the same bytes in its own folder.
  await on(a, async (book) => { await collectSources(book, ['photo:' + id]); });
  assert.equal((await sync(a, remote)).action, 'push');
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  const owned = (await manifests(b)).photos[id];
  assert.equal(owned.linked, undefined);
  assert.equal(sha(await readFile(join(b.folder, owned.path))), sha(await readFile(photo)));
  await on(b, async (book) => assert.equal(book.sources!['photo:' + id].state, 'available'));
  assert.equal((await sync(b, remote)).action, 'in-sync');
});

// --- Sync by reach (ADR 0012): a provider of reach `online` that exists only here ---------------------------------------
// A photo on a server every Mac reads itself. Its locator has nothing of one Mac's in it, so it syncs whole; `shared`
// and `adopt` are for kinds of reach `mac` and would show in a snapshot or a pulled book if they were applied.
type OnlineLocator = { provider: 'online'; url: string; name?: string };
const onlineLocator: LocatorKind<OnlineLocator> = {
  provider: 'online',
  reach: 'online',
  fields: ['online'],
  read: (entry) => {
    const value = entry.online as Partial<OnlineLocator> | undefined;
    return typeof value?.url === 'string' ? { provider: 'online', url: value.url, ...(value.name ? { name: value.name } : {}) } : undefined;
  },
  write: ({ provider: _provider, ...online }) => ({ online }),
  portable: ({ url }) => ({ online: { url } }),
  shared: (locator) => ({ ...locator, url: 'reduced-for-another-mac' }),
  adopt: (shared) => ({ ...shared, url: 'adopted-on-this-mac' }),
  key: ({ url }) => url,
  name: ({ name }) => name,
};
type OnlineAsset = { revision: string; content: string; width: number; height: number; color: string; title: string };
class OnlineServer implements SourceProvider<OnlineLocator> {
  readonly provider = 'online' as const;
  readonly assets = new Map<string, OnlineAsset>();
  // Whether the Mac in use is signed in to the server; one that is not still lays out the book from synced previews.
  signedIn = true;
  // What a Mac behind a cache still sees of the server, when set.
  lagging?: Map<string, OnlineAsset>;
  // Originals asked for; sync never asks for one.
  materialized: string[] = [];
  private asset = (url: string) => (this.lagging ?? this.assets).get(url);
  private revisions = (asset: OnlineAsset): Revisions => ({ revision: asset.revision, contentRevision: asset.content });
  private unavailable = (url: string) => !this.signedIn ? { state: 'needs-sign-in' as const, problem: 'Sign in to the photo server' }
    : !this.asset(url) ? { state: 'missing' as const, problem: 'No longer on the photo server' } : undefined;
  async observe(_book: string, refs: readonly SourceRef<OnlineLocator>[]): Promise<Observed[]> {
    return refs.map(({ locator }) => {
      const asset = this.asset(locator.url);
      return this.unavailable(locator.url) ?? { state: 'available', revisions: this.revisions(asset!), facts: { width: asset!.width, height: asset!.height, provided: { title: asset!.title } } };
    });
  }
  async *preview(_book: string, refs: readonly SourceRef<OnlineLocator>[], { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
    for (const { id, locator } of refs) {
      if (signal.aborted) return;
      const failure = this.unavailable(locator.url);
      if (failure) { yield { id, ...failure }; continue; }
      const asset = this.asset(locator.url)!;
      const file = join(staging, id + '-' + asset.revision + '.jpg');
      await image(file, asset.color, asset.width / 25, asset.height / 25);
      yield { id, file, before: this.revisions(asset), after: this.revisions(asset) };
    }
  }
  async *materialize(_book: string, refs: readonly SourceRef<OnlineLocator>[]): AsyncGenerator<Materialized> {
    for (const { id } of refs) { this.materialized.push(id); yield { id, state: 'unreadable', problem: 'This test never downloads an original.' }; }
  }
  watch() { return () => {}; }
  repairs(state: Unavailable) { return state === 'needs-sign-in' ? ['sign-in'] as const : []; }
}
function onlineServer(t: { after: (fn: () => void) => void }) {
  const server = new OnlineServer();
  const unregister = [registerLocatorKind(onlineLocator), registerProvider(server)];
  t.after(() => unregister.forEach((remove) => remove()));
  return server;
}
// The keys of a remote's blobs of one kind (`originals`, `proxies`), optionally of one digest.
const blobKeys = async (remote: Remote, kind: string, digest = '') => (await remote.store.list('')).map(({ key }) => key).filter((key) => key.includes('/' + kind + '/' + digest));
const harbour = 'https://photos.example/albums/7/harbour';
const dawn: OnlineAsset = { revision: 'r1', content: 'c1', width: 3000, height: 2000, color: '#cc8844', title: 'Harbour at dawn' };

test('an online photo syncs its locator whole with facts and a preview, never an original, and its changes sync with every push', async (t) => {
  const { a, b, remote } = await world(t);
  const server = onlineServer(t);
  server.assets.set(harbour, dawn);
  await sync(a, remote);
  await copyBook(a, b);
  assert.equal((await sync(b, remote)).action, 'adopt');
  const originals = await blobKeys(remote, 'originals');
  assert.ok(originals.length, 'the book’s own photos synced their originals');

  // Desktop adds a photo from the server and pushes.
  const entry = { online: { url: harbour, name: 'harbour.jpg' } };
  await edit(a, (files) => { files.photoIndex.web = entry as never; });
  const pushed = await sync(a, remote);
  assert.equal(pushed.action, 'push');
  const c1 = await commit(remote, a, pushed.pushed[0]);
  const s1 = await stateOf(remote, c1);
  assert.deepEqual(s1.photos.web, entry, 'the locator syncs whole: nothing in it is one Mac’s');
  const fact1 = s1.assetsMeta.assets.web;
  assert.deepEqual([fact1.width, fact1.height, fact1.provided?.title], [3000, 2000, 'Harbour at dawn'], 'with the facts its provider reported');
  assert.ok(s1.proxies[fact1.digest], 'and its preview');
  const [proxy1] = await blobKeys(remote, 'proxies', fact1.digest);
  assert.equal(sha(await stored(remote, proxy1)), s1.proxies[fact1.digest].sha256, 'which was uploaded');
  assert.equal(s1.originals.web, undefined, 'no original is recorded for it');
  assert.deepEqual(await blobKeys(remote, 'originals'), originals, 'and none was uploaded');
  assert.deepEqual(server.materialized, [], 'or even asked for');
  await use(a);
  assert.deepEqual(await pendingOriginals(a.folder, remote), []);

  // Laptop, not signed in to the server: the pull writes the same locator and expects no original.
  server.signedIn = false;
  const pulled = await sync(b, remote, { fetchOriginals: true });
  assert.equal(pulled.action, 'fast-forward');
  assert.deepEqual(pulled.originals, { downloaded: [] }, 'keeping originals downloads none for it');
  assert.deepEqual((await manifests(b)).photos.web, entry);
  assert.deepEqual(await pendingOriginals(b.folder, remote), [], 'and none is pending');
  // It cannot read the photo itself, and shows the synced preview with the synced facts.
  await on(b, async (book) => {
    assert.equal(book.sources!['photo:web'].state, 'needs-sign-in');
    assert.equal(book.sources!['photo:web'].cached, true);
    const photo = book.photos.get('web')!;
    assert.equal(photo.original, await proxyFile(b, fact1.digest));
    assert.deepEqual([photo.width, photo.height, photo.title], [3000, 2000, 'Harbour at dawn']);
  });
  assert.equal((await sync(b, remote)).action, 'in-sync');

  // The photo changes on the server. Nothing in the book's own state does, so only `factsAhead` can see it.
  server.signedIn = true;
  server.assets.set(harbour, { ...dawn, revision: 'r2', content: 'c2', color: '#223366', title: 'Harbour at dusk' });
  const second = await sync(a, remote);
  assert.equal(second.action, 'push', 'the new fact is ahead of the last snapshot');
  const c2 = await commit(remote, a, second.pushed[0]);
  assert.equal(c2.bookStateRevision, c1.bookStateRevision, 'with the same book state');
  const s2 = await stateOf(remote, c2);
  const fact2 = s2.assetsMeta.assets.web;
  assert.notEqual(fact2.digest, fact1.digest);
  assert.equal(fact2.provided?.title, 'Harbour at dusk', 'the changed fact is in the snapshot, not the one carried forward');
  assert.equal(sha(await stored(remote, (await blobKeys(remote, 'proxies', fact2.digest))[0])), s2.proxies[fact2.digest].sha256, 'with its new preview');
  assert.equal(s2.originals.web, undefined);
  assert.equal((await sync(a, remote)).action, 'in-sync', 'a fact that was pushed is no longer ahead');

  // Laptop, still not signed in: the change reaches it.
  server.signedIn = false;
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  await on(b, async (book) => {
    const photo = book.photos.get('web')!;
    assert.equal(photo.original, await proxyFile(b, fact2.digest));
    assert.equal(photo.title, 'Harbour at dusk');
  });

  // And again, also with an edit of the book in the same push: every later push carries the fact of then.
  server.signedIn = true;
  server.assets.set(harbour, { ...dawn, revision: 'r3', content: 'c3', color: '#114422', width: 2000, height: 3000, title: 'Harbour at night' });
  await edit(a, caption('shore', 'Edited with the third version'));
  const third = await sync(a, remote);
  assert.equal(third.action, 'push');
  const fact3 = (await stateOf(remote, await commit(remote, a, third.pushed[0]))).assetsMeta.assets.web;
  assert.deepEqual([fact3.width, fact3.height, fact3.provided?.title], [2000, 3000, 'Harbour at night']);
  server.signedIn = false;
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.deepEqual((await readAssetFacts(b.folder)).web, fact3);
  assert.ok(await proxyFile(b, fact3.digest));
  assert.deepEqual(await blobKeys(remote, 'originals'), originals, 'no push uploaded an original for it');
  assert.deepEqual(server.materialized, []);
});

const outcome = (mac: Mac, remote: SyncRemote) => sync(mac, remote).then(({ action, pushed }) => ({ action, pushed: pushed.length }));
const webFactOf = async (remote: Remote, mac: Mac, id: string) => (await stateOf(remote, (await tips(remote, mac))[0])).assetsMeta.assets[id];
const webFact = (remote: Remote, mac: Mac) => webFactOf(remote, mac, 'web');

test('a fact of an online photo that a pull changed is never pushed back, however often a Mac that sees an older version syncs', async (t) => {
  const { a, b, remote } = await world(t);
  const server = onlineServer(t);
  server.assets.set(harbour, dawn);
  await edit(a, (files) => { files.photoIndex.web = { online: { url: harbour } } as never; });
  await sync(a, remote);
  const digest = async (mac: Mac) => (await readAssetFacts(mac.folder)).web.digest;
  const d1 = await digest(a);
  // Laptop: a copy of the book that reads the server itself and makes the same preview.
  await copyBook(a, b);
  assert.deepEqual(await outcome(b, remote), { action: 'adopt', pushed: 0 });
  assert.equal(await digest(b), d1);
  // A sync record from before `localKeys` loads; the next sync that reads the photo records what it saw.
  assert.ok((await readSyncState(b.folder)).lastSynced?.localKeys?.web);
  await updateSyncState(b.folder, (state) => { const { localKeys: _, ...lastSynced } = state.lastSynced!; return { ...state, lastSynced }; });
  assert.equal((await readSyncState(b.folder)).lastSynced?.localKeys, undefined);

  // The photo changes and the desktop pushes it. The laptop still sees the version before, behind a cache.
  const dusk = { ...dawn, revision: 'r2', content: 'c2', color: '#223366', title: 'Harbour at dusk' };
  server.assets.set(harbour, dusk);
  assert.equal((await sync(a, remote)).action, 'push');
  const d2 = await digest(a);
  server.lagging = new Map([[harbour, dawn]]);
  assert.deepEqual(await outcome(b, remote), { action: 'fast-forward', pushed: 0 }, 'what the laptop sees did not change since it last synced');
  assert.equal(await digest(b), d2, 'the snapshot’s fact replaces its own');
  // The laptop then draws what its own view shows again, which differs from the snapshot. That is no change here.
  for (const round of [1, 2, 3]) {
    assert.deepEqual(await outcome(b, remote), { action: 'in-sync', pushed: 0 }, 'sync ' + round + ' while lagging pushes nothing');
    assert.equal((await webFact(remote, a)).digest, d2, 'and the remote keeps the newer fact');
  }
  assert.equal(await digest(b), d1, 'the laptop shows what it can read');
  // Once the laptop sees the change too, it has nothing to add, and counts from that version on.
  server.lagging = undefined;
  assert.deepEqual(await outcome(b, remote), { action: 'in-sync', pushed: 0 });
  assert.equal(await digest(b), d2);

  // A third version, which the laptop again sees late: its fact of the second is merely older, and loses.
  server.assets.set(harbour, { ...dawn, revision: 'r3', content: 'c3', color: '#114422', title: 'Harbour at night' });
  assert.equal((await sync(a, remote)).action, 'push');
  const d3 = await digest(a);
  server.lagging = new Map([[harbour, dusk]]);
  assert.deepEqual(await outcome(b, remote), { action: 'fast-forward', pushed: 0 }, 'the second version is not pushed back over the third');
  assert.deepEqual(await outcome(b, remote), { action: 'in-sync', pushed: 0 });
  server.lagging = undefined;
  assert.equal((await sync(a, remote)).action, 'in-sync');
  assert.equal((await sync(b, remote)).action, 'in-sync');
  assert.equal((await tips(remote, a)).length, 1);
  assert.equal((await webFact(remote, a)).digest, d3);
  assert.equal(await digest(a), d3);
  assert.equal(await digest(b), d3);
});

test('two Macs that see different versions of an online photo for good stop pushing once each has synced', async (t) => {
  const { a, b, remote } = await world(t);
  const server = onlineServer(t);
  const dusk = { ...dawn, revision: 'r2', content: 'c2', color: '#223366', title: 'Harbour at dusk' };
  // The desktop always sees the photo at dawn, the laptop at dusk: two copies of one catalog, say.
  const desktop = () => { server.lagging = undefined; return a; };
  const laptop = () => { server.lagging = new Map([[harbour, dusk]]); return b; };
  server.assets.set(harbour, dawn);
  await edit(desktop(), (files) => { files.photoIndex.web = { online: { url: harbour } } as never; });
  await sync(desktop(), remote);
  await copyBook(a, b);
  // The laptop reads the photo for the first time: its other version is where it starts counting from, not a change.
  assert.deepEqual(await outcome(laptop(), remote), { action: 'adopt', pushed: 0 });
  assert.deepEqual(await outcome(desktop(), remote), { action: 'in-sync', pushed: 0 });
  const settled = { commits: await commitCount(remote), fact: await webFact(remote, a) };
  assert.equal(settled.fact.provided?.title, 'Harbour at dawn');
  // From then on neither pushes, though each draws its own version and so differs from the snapshot or the other.
  for (const round of [1, 2, 3]) {
    assert.deepEqual(await outcome(desktop(), remote), { action: 'in-sync', pushed: 0 }, 'desktop, round ' + round);
    assert.deepEqual(await outcome(laptop(), remote), { action: 'in-sync', pushed: 0 }, 'laptop, round ' + round);
  }
  // An edit of the book still syncs both ways, and carries the photo's fact forward as it is.
  await edit(desktop(), caption('shore', 'From the desktop'));
  assert.deepEqual(await outcome(desktop(), remote), { action: 'push', pushed: 1 });
  assert.deepEqual(await outcome(laptop(), remote), { action: 'fast-forward', pushed: 0 });
  await edit(laptop(), caption('segla', 'From the laptop'));
  assert.deepEqual(await outcome(laptop(), remote), { action: 'push', pushed: 1 });
  assert.deepEqual(await outcome(desktop(), remote), { action: 'fast-forward', pushed: 0 });
  for (const mac of [desktop, laptop, desktop, laptop]) assert.deepEqual(await outcome(mac(), remote), { action: 'in-sync', pushed: 0 });
  assert.equal(await commitCount(remote), settled.commits + 2, 'only the two edits made commits');
  assert.equal((await tips(remote, a)).length, 1);
  assert.deepEqual(await webFact(remote, a), settled.fact);

  // A real change on one side is still pushed, once, and the other takes it without answering.
  server.assets.set(harbour, { ...dawn, revision: 'r3', content: 'c3', color: '#114422', title: 'Harbour at night' });
  assert.deepEqual(await outcome(desktop(), remote), { action: 'push', pushed: 1 });
  assert.equal((await webFact(remote, a)).provided?.title, 'Harbour at night');
  assert.deepEqual(await outcome(laptop(), remote), { action: 'fast-forward', pushed: 0 });
  for (const mac of [desktop, laptop, desktop, laptop]) assert.deepEqual(await outcome(mac(), remote), { action: 'in-sync', pushed: 0 });
  assert.equal((await webFact(remote, a)).provided?.title, 'Harbour at night');
});

const keyOf = (content: string) => sha(Buffer.from(content));

test('what a Mac saw of an online photo survives an interrupted pull and a pull that keeps its own fact, with no push after either', async (t) => {
  const { a, b, remote } = await world(t);
  const server = onlineServer(t);
  const dusk = { ...dawn, revision: 'r2', content: 'c2', color: '#223366', title: 'Harbour at dusk' };
  const night = { ...dawn, revision: 'r3', content: 'c3', color: '#114422', title: 'Harbour at night' };
  // The desktop sees what the server has; the laptop sees what `behind` holds.
  let behind = dawn;
  const desktop = () => { server.lagging = undefined; return a; };
  const laptop = () => { server.lagging = new Map([[harbour, behind]]); return b; };
  const keys = async (mac: Mac) => (await readSyncState(mac.folder)).lastSynced?.localKeys;
  server.assets.set(harbour, dawn);
  await edit(desktop(), (files) => { files.photoIndex.web = { online: { url: harbour } } as never; });
  await sync(desktop(), remote);
  await copyBook(a, b);
  assert.deepEqual(await outcome(laptop(), remote), { action: 'adopt', pushed: 0 });
  assert.deepEqual(await keys(b), { web: keyOf('c1') });

  // The desktop pushes a second version. The laptop, still seeing the first, crashes after it marked the pull.
  server.assets.set(harbour, dusk);
  assert.equal((await sync(desktop(), remote)).action, 'push');
  const [tip] = await tips(remote, a);
  await on(laptop(), async (book) => { await stageSyncPull(remote, book, tip); });
  assert.deepEqual((await readSyncState(b.folder)).pull?.localKeys, { web: keyOf('c1') }, 'the marker carries what the laptop saw');
  // Opening the book finishes the pull. What the laptop saw is unchanged, so nothing of it is ahead.
  await on(laptop(), async () => {});
  assert.equal((await readSyncState(b.folder)).lastSynced?.commitId, tip.commitId);
  assert.deepEqual(await keys(b), { web: keyOf('c1') });
  for (const round of [1, 2]) assert.deepEqual(await outcome(laptop(), remote), { action: 'in-sync', pushed: 0 }, 'after the resumed pull, sync ' + round);
  assert.equal((await webFact(remote, a)).provided?.title, 'Harbour at dusk');

  // Now the photo changes where only the laptop sees it yet, while the desktop edits the book: the pull keeps the
  // laptop's fact, and one push carries it.
  behind = night;
  await edit(desktop(), caption('shore', 'Edited on the desktop'));
  assert.deepEqual(await outcome(desktop(), remote), { action: 'push', pushed: 1 });
  const kept = await sync(laptop(), remote);
  assert.deepEqual([kept.action, kept.pushed.length], ['fast-forward', 1]);
  assert.equal((await manifests(b)).photos.shore.caption, 'Edited on the desktop');
  assert.equal((await webFact(remote, a)).provided?.title, 'Harbour at night', 'the laptop’s newer fact went up');
  assert.deepEqual(await keys(b), { web: keyOf('c3') }, 'and what it saw then is recorded');
  for (const round of [1, 2]) assert.deepEqual(await outcome(laptop(), remote), { action: 'in-sync', pushed: 0 }, 'after the kept fact, sync ' + round);
  // The desktop, which still sees the second version, takes it and does not answer.
  assert.deepEqual(await outcome(desktop(), remote), { action: 'fast-forward', pushed: 0 });
  assert.deepEqual(await keys(a), { web: keyOf('c2') });
  for (const mac of [desktop, laptop, desktop]) assert.deepEqual(await outcome(mac(), remote), { action: 'in-sync', pushed: 0 });
  assert.equal((await webFact(remote, a)).provided?.title, 'Harbour at night');
  assert.equal((await tips(remote, a)).length, 1);
});

// --- Lightroom Classic (reach `mac`), through the fake plugin over the real bridge ------------------------------------
// One bridge and one plugin serve both Macs; `open` puts the catalog of the Mac in use into the plugin, so two Macs can
// hold the same catalog (same identity, same UUIDs) at different develop states.
async function lightroom(t: { after: (fn: () => Promise<void>) => void }) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'if-sync-lr-')));
  const bridge = new LightroomBridge({ file: join(folder, 'bridge.json'), version: 'test', hold: 300, grace: 5000, closeGrace: 200 });
  await bridge.start();
  const unregister = registerProvider(lightroomProvider(bridge));
  const plugin = new FakeLightroom(join(folder, 'bridge.json'));
  t.after(async () => { await plugin.quit(true); unregister(); await bridge.stop(); await rm(folder, { recursive: true, force: true }); });
  await plugin.connect();
  const end = Date.now() + 3000;
  while (!bridge.connection && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  const open = (catalog: Map<string, FakePhoto>) => { plugin.photos.clear(); for (const [id, photo] of catalog) plugin.photos.set(id, photo); };
  const jobs = (type: string, size?: string) => plugin.jobs.filter((job) => job.type === type && (!size || job.size === size)).length;
  return { plugin, open, jobs };
}
const catalogPhoto = (n: number, photo: Partial<FakePhoto> = {}): [string, FakePhoto] => [lightroomUuid(n), { lastEditTime: 785_000_000 + n, editCount: 1, width: 6000, height: 4000,
  develop: { Exposure2012: 0 }, color: '#808080', fileName: 'DSC_' + String(n).padStart(4, '0') + '.ARW', ...photo }];
const lightroomEntry = (n: number) => ({ provider: 'lightroom' as const, catalog: catalogId, uuid: lightroomUuid(n), name: 'DSC_' + String(n).padStart(4, '0') + '.ARW' });

test('a Lightroom photo syncs its locator, facts and preview but no original, a develop change reaches the other Mac, and two catalogs at different states do not push to each other', async (t) => {
  const { a, b, remote } = await world(t);
  const lr = await lightroom(t);
  // Both Macs have the catalog; the laptop's copy of it has the photo developed otherwise.
  const onDesktop = new Map([catalogPhoto(1, { title: 'Harbour' })]);
  // (Edited there at another time: Lightroom's revision of a photo moves with every edit.)
  const onLaptop = new Map([catalogPhoto(1, { title: 'Harbour', develop: { Exposure2012: 1 }, color: '#c0c0c0', lastEditTime: 785_000_500 })]);
  const desktop = () => { lr.open(onDesktop); return a; };
  const laptop = () => { lr.open(onLaptop); return b; };
  const fact = async (mac: Mac, id: string) => (await readAssetFacts(mac.folder))[id];
  await sync(desktop(), remote);
  await copyBook(a, b);
  assert.equal((await sync(laptop(), remote)).action, 'adopt');
  const originals = await blobKeys(remote, 'originals');

  // Desktop imports the photo from Lightroom and pushes.
  const [id] = await on(desktop(), async (book) => (await importProvidedPhotos(book, [lightroomEntry(1)])).imported);
  const pushed = await sync(desktop(), remote);
  assert.equal(pushed.action, 'push');
  const s1 = await stateOf(remote, await commit(remote, a, pushed.pushed[0]));
  assert.deepEqual(s1.photos[id], { lightroom: { catalog: catalogId, uuid: lightroomUuid(1), name: 'DSC_0001.ARW' } }, 'the locator: the catalog’s identity, never its path');
  const fact1 = s1.assetsMeta.assets[id];
  assert.deepEqual([fact1.width, fact1.height, fact1.provided?.title], [6000, 4000, 'Harbour']);
  assert.equal(sha(await stored(remote, (await blobKeys(remote, 'proxies', fact1.digest))[0])), s1.proxies[fact1.digest].sha256, 'its preview was uploaded');
  assert.equal(s1.originals[id], undefined);
  assert.deepEqual(await blobKeys(remote, 'originals'), originals, 'no original was uploaded');
  assert.equal(lr.jobs('render', 'full'), 0, 'and Lightroom rendered none');

  // Laptop: pulls the photo. Its own catalog shows it developed otherwise, which is where it starts, not a change.
  assert.deepEqual(await outcome(laptop(), remote), { action: 'fast-forward', pushed: 0 });
  assert.deepEqual((await manifests(b)).photos[id], s1.photos[id]);
  await use(b);
  assert.deepEqual(await pendingOriginals(b.folder, remote), []);
  for (const round of [1, 2]) {
    assert.deepEqual(await outcome(laptop(), remote), { action: 'in-sync', pushed: 0 }, 'laptop, sync ' + round);
    assert.deepEqual(await outcome(desktop(), remote), { action: 'in-sync', pushed: 0 }, 'desktop, sync ' + round);
  }
  assert.notEqual((await fact(b, id)).digest, fact1.digest, 'the laptop draws its own catalog’s version');
  assert.equal((await webFactOf(remote, a, id)).digest, fact1.digest, 'and leaves the snapshot’s alone');

  // A develop change on the desktop is detected at its next push, with nothing else changed in the book.
  lr.open(onDesktop);
  lr.plugin.edit(lightroomUuid(1), { develop: { Exposure2012: -1 }, color: '#404040', title: 'Harbour, darker' });
  const second = await sync(desktop(), remote);
  assert.equal(second.action, 'push');
  const s2 = await stateOf(remote, await commit(remote, a, second.pushed[0]));
  const fact2 = s2.assetsMeta.assets[id];
  assert.notEqual(fact2.digest, fact1.digest);
  assert.equal(fact2.provided?.title, 'Harbour, darker');
  assert.ok((await blobKeys(remote, 'proxies', fact2.digest)).length, 'with its new preview');
  // It reaches the laptop, which does not push its own state back, however often both sync.
  assert.deepEqual(await outcome(laptop(), remote), { action: 'fast-forward', pushed: 0 });
  assert.deepEqual(await fact(b, id), fact2);
  assert.ok(await proxyFile(b, fact2.digest));
  const commits = await commitCount(remote);
  for (const mac of [laptop, desktop, laptop, desktop]) assert.deepEqual(await outcome(mac(), remote), { action: 'in-sync', pushed: 0 });
  assert.equal(await commitCount(remote), commits);
  assert.equal((await tips(remote, a)).length, 1);
  assert.deepEqual(await webFactOf(remote, a, id), fact2);
  assert.deepEqual(await blobKeys(remote, 'originals'), originals);
  assert.equal(lr.jobs('render', 'full'), 0);
});

test('a sync asks Lightroom about a book’s photos once, not once per photo', async (t) => {
  const { a, remote } = await world(t);
  const lr = await lightroom(t);
  const count = 50;
  lr.open(new Map(Array.from({ length: count }, (_, index) => catalogPhoto(index + 1))));
  await on(a, async (book) => { await importProvidedPhotos(book, Array.from({ length: count }, (_, index) => lightroomEntry(index + 1))); });
  // Only the sync itself is counted, not the book's load before it.
  const asked = (mac: Mac) => on(mac, async (book) => {
    const before = lr.jobs('metadata');
    const result = await syncBook({ remote, book });
    return { action: result.action, metadata: lr.jobs('metadata') - before };
  });
  const first = await asked(a);
  const second = await asked(a);
  console.log('Lightroom metadata requests per sync of a book with ' + count + ' Lightroom photos: ' + JSON.stringify({ first, second }));
  assert.deepEqual(first, { action: 'initial-push', metadata: 1 });
  assert.deepEqual(second, { action: 'in-sync', metadata: 1 });
});

const conflictCopies = async (mac: Mac) => (await readdir(mac.base)).filter((name) => name.includes('(Conflict '));

each('a Keep Both that keeps failing makes one conflict copy, not one per sync', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await edit(a, caption('shore', 'Desktop'));
  await sync(a, remote);
  await edit(b, caption('segla', 'Laptop'));
  const [tip] = await tips(remote, a);
  // Something on this Mac breaks every pull after it was marked (here: a stray template file appears).
  const adopt = AssetFacts.adoptSynced;
  AssetFacts.adoptSynced = async (folder, facts) => { await writeFile(join(folder, 'template', 'stray.txt'), 'stray'); return adopt.call(AssetFacts, folder, facts); };
  try {
    await assert.rejects(sync(b, remote), /does not match its snapshot/);
    const { abandoned } = await readSyncState(b.folder);
    assert.equal(abandoned?.targetCommit, tip.commitId);
    assert.equal(abandoned?.atOpen, undefined, 'a sync reports its own failure');
    assert.ok(abandoned?.conflictCopy && await lstat(abandoned.conflictCopy), 'the trace names the copy made before the pull');
    assert.equal(abandoned?.bookStateRevision, await captureBookStateRevision(b.folder));
    assert.deepEqual(await conflictCopies(b), [abandoned.conflictCopy.split('/').at(-1)]);
    assert.deepEqual((await describeSync(b.folder, remote)).state, 'abandoned');
    // The cause persists: the next sync fails the same way without copying the half-pulled book again.
    await assert.rejects(sync(b, remote), /does not match its snapshot/);
    assert.equal((await conflictCopies(b)).length, 1);
    assert.equal((await readSyncState(b.folder)).abandoned?.conflictCopy, undefined, 'this attempt made none');
  } finally { AssetFacts.adoptSynced = adopt; }
  const outcome = await sync(b, remote);
  assert.equal(outcome.action, 'diverged');
  assert.equal(outcome.conflictCopy, undefined);
  assert.equal((await conflictCopies(b)).length, 1);
  assert.equal(await captureBookStateRevision(b.folder), tip.bookStateRevision);
  assert.equal((await readSyncState(b.folder)).abandoned, undefined);
  assert.equal((await describeSync(b.folder, remote)).state, 'in-sync');
  // A book edited after the abandon holds something new again: that one is kept.
  AssetFacts.adoptSynced = async (folder, facts) => { await writeFile(join(folder, 'template', 'stray.txt'), 'stray'); return adopt.call(AssetFacts, folder, facts); };
  try {
    await edit(a, caption('shore', 'Desktop again'));
    await sync(a, remote);
    await edit(b, caption('segla', 'Laptop again'));
    await assert.rejects(sync(b, remote), /does not match its snapshot/);
    assert.equal((await conflictCopies(b)).length, 2);
    await edit(b, caption('segla', 'Laptop, after the failure'));
  } finally { AssetFacts.adoptSynced = adopt; }
  assert.ok((await sync(b, remote)).conflictCopy);
  assert.equal((await conflictCopies(b)).length, 3);
});

/** A sync folder in a temporary directory, as iCloud Drive or Dropbox would hold it. */
async function syncFolder(root: string, name = 'Sync') {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return folderRemote(path);
}
const remoteFiles = async (remote: StoreRemote<FolderStore>) => (await readdir(remote.store.root, { recursive: true })).map(String);

test('a sync folder: push from the desktop, Download on the laptop, then edits both ways', async (t) => {
  const { root, a, b } = await world(t);
  const remote = await syncFolder(root);
  assert.equal((await sync(a, remote)).action, 'initial-push');
  const id = await bookId(a);
  const files = await remoteFiles(remote);
  assert.ok(files.some((path) => path.startsWith(join('books', id, 'snapshots')) && path.endsWith('.json')));
  // The layout of ADR 0012, section 4: everything the book needs is under its own prefix.
  for (const part of ['content', 'originals', 'proxies']) assert.ok(files.some((path) => path.startsWith(join('books', id, part) + '/')), part);
  assert.deepEqual((await readdir(remote.store.root)).filter((name) => !name.startsWith('.')), ['books', 'remote.json'], 'the books, and the remote’s identity');
  assert.deepEqual((await readdir(join(remote.store.root, 'books'))).filter((name) => !name.startsWith('.')), [id]);
  assert.deepEqual((await readdir(join(remote.store.root, 'books', id))).filter((name) => !name.startsWith('.')).sort(), ['content', 'originals', 'proxies', 'snapshots']);
  assert.equal(files.some((path) => path.split('/').at(-1)!.startsWith('.sync-')), false, 'no temporary files stay');

  // Laptop: the book is listed by the title in its tip header and opened into a new, untrusted package.
  await use(b);
  const [listed, ...others] = await remoteBooks(remote);
  assert.equal(others.length, 0);
  assert.equal(listed.bookId, id);
  assert.equal(listed.title, (await manifests(a)).project.title);
  const created = await cloneFromRemote({ remote, tip: listed.tips[0], destination: join(b.base, 'Book'), remoteId: await remote.remoteId() });
  assert.equal(created, b.folder, 'the .imageflow extension is added');
  assert.equal(await bookTrusted(b.folder), true, 'a downloaded book arrives trusted: the backend is inside the user’s trust boundary (ADR 0012)');
  assert.equal(await captureBookStateRevision(b.folder), listed.tips[0].bookStateRevision);
  const record = await readSyncState(b.folder);
  assert.equal(record.remoteId, await remote.remoteId());
  assert.equal(record.enabled, true);
  assert.equal(record.lastSynced?.commitId, listed.tips[0].commitId);
  assert.deepEqual((await readdir(b.base)).filter((name) => name.startsWith('.imageflow-create')), []);
  const shoreDigest = sha(await readFile(join(a.folder, 'photos/shore.jpg')));
  assert.equal(await lstat(join(b.folder, 'photos/shore.jpg')).catch(() => undefined), undefined, 'owned originals stay on the remote');
  await on(b, async (book) => {
    assert.equal(book.sources!['photo:shore'].state, 'missing');
    assert.equal(book.photos.get('shore')!.original, await proxyFile(b, shoreDigest));
  });
  assert.equal((await sync(b, remote)).action, 'in-sync');
  const status = await describeSync(b.folder, remote);
  assert.equal(status.state, 'in-sync');
  assert.ok(status.pendingOriginals > 0);
  await assert.rejects(cloneFromRemote({ remote, tip: listed.tips[0], destination: b.folder }), /already exists/);

  // Round trip: the laptop edits and pushes, the desktop pulls. After an edit the status needs no remote read.
  const seen = await describeSync(b.folder, remote);
  assert.equal(seen.remote, 'same');
  await edit(b, caption('shore', 'From the laptop'));
  // `describeLocalChange` is not given the remote: an edit never reads the sync folder.
  assert.equal((await describeLocalChange(b.folder, seen)).state, 'ahead');
  assert.equal((await describeSync(b.folder, remote)).state, 'ahead');
  assert.equal((await sync(b, remote)).action, 'push');
  assert.equal((await describeSync(a.folder, remote)).state, 'behind');
  assert.equal((await sync(a, remote)).action, 'fast-forward');
  assert.equal((await manifests(a)).photos.shore.caption, 'From the laptop');
  assert.equal(sha(await readFile(join(a.folder, 'photos/shore.jpg'))), shoreDigest, 'the desktop keeps its originals');

  // The desktop edits; the laptop keeps originals. Originals the remote lacks after the pull (here moved away) read as
  // still uploading from another Mac: the sync succeeds, and the next sync downloads them once they are there.
  await edit(a, caption('segla', 'From the desktop'));
  await sync(a, remote);
  const originals = join(remote.store.root, 'books', id, 'originals');
  await rename(originals, originals + '-away');
  const pulled = await sync(b, remote, { fetchOriginals: true });
  assert.equal(pulled.action, 'fast-forward');
  assert.equal(pulled.originals?.downloaded.length, 0);
  assert.equal(pulled.originals?.pending, undefined, 'no error');
  assert.ok((pulled.originals?.notUploaded ?? 0) > 0);
  assert.equal((await manifests(b)).photos.segla.caption, 'From the desktop');
  const waiting = await describeSync(b.folder, remote);
  assert.equal(waiting.state, 'in-sync');
  assert.equal(waiting.notUploaded, pulled.originals?.notUploaded);
  await rename(originals + '-away', originals);
  const retried = await sync(b, remote, { fetchOriginals: true });
  assert.equal(retried.action, 'in-sync');
  assert.ok(retried.originals?.downloaded.includes('shore'));
  assert.equal(retried.changed, true, 'the editor reloads to use them');
  assert.equal(sha(await readFile(join(b.folder, 'photos/shore.jpg'))), shoreDigest);
  assert.equal((await describeSync(b.folder, remote)).pendingOriginals, 0);
  assert.deepEqual((await readdir(join(b.folder, 'photos'))).filter((name) => name.startsWith('.')), [], 'downloads stage beside their target and clean up');
  assert.equal((await sync(b, remote, { fetchOriginals: true })).action, 'in-sync');
});

test('two offline Macs push to a sync folder: two tips, Keep Both, and a commit that closes the fork', async (t) => {
  const { root, a, b } = await world(t);
  const desktop = await syncFolder(root, 'Desktop Sync');
  await sync(a, desktop);
  // The laptop's copy of the sync folder, which the sync daemon delivers to and from later.
  const laptop = await syncFolder(root, 'Laptop Sync');
  await cp(desktop.store.root, laptop.store.root, { recursive: true });
  await copyBook(a, b);
  assert.equal((await sync(b, laptop)).action, 'adopt');
  await edit(a, caption('shore', 'Desktop, offline'));
  await edit(b, caption('shore', 'Laptop, offline'));
  await sync(a, desktop);
  await sync(b, laptop);
  // Both come back online: every file is immutable, so the folders simply merge.
  await cp(laptop.store.root, desktop.store.root, { recursive: true });
  await cp(desktop.store.root, laptop.store.root, { recursive: true });
  const forked = await tips(desktop, a);
  assert.equal(forked.length, 2);
  assert.equal((await describeSync(a.folder, desktop)).state, 'diverged');
  assert.equal((await describeSync(a.folder, desktop)).tips, 2);
  // Cancel leaves everything as it is.
  assert.equal((await sync(a, desktop, { chooseTip: async () => undefined })).pushed.length, 0);
  assert.equal((await tips(desktop, a)).length, 2);
  // The desktop continues with the laptop's version; its own is one of the tips, so no copy is needed.
  const chosen = (await readSyncState(b.folder)).lastSynced!.commitId;
  const outcome = await sync(a, desktop, { chooseTip: async (offered) => { assert.equal(offered.length, 2); return chosen; } });
  assert.equal(outcome.action, 'diverged');
  assert.equal(outcome.pulled, chosen);
  assert.equal(outcome.conflictCopy, undefined);
  const [closing] = await tips(desktop, a);
  assert.deepEqual([...closing.parents].sort(), forked.map((tip) => tip.commitId).sort());
  assert.equal(closing.bookStateRevision, (await commit(desktop, a, chosen)).bookStateRevision);
  assert.equal((await manifests(a)).photos.shore.caption, 'Laptop, offline');
  // The closing commit reaches the laptop, which only has to record it.
  await cp(desktop.store.root, laptop.store.root, { recursive: true });
  assert.equal((await describeSync(b.folder, laptop)).state, 'behind');
  assert.equal((await sync(b, laptop)).action, 'fast-forward');
  assert.equal((await sync(b, laptop)).action, 'in-sync');
  assert.equal((await sync(a, desktop)).action, 'in-sync');
});

test('an incomplete sync folder is still syncing: the book is not changed and nothing is created', async (t) => {
  const { root, a, b } = await world(t);
  const remote = await syncFolder(root);
  const photo = join(a.external, 'harbour.jpg');
  await image(photo, '#336699');
  await on(a, (book) => importIntoProject(book, { kind: 'photo', mode: 'link' }, [photo]));
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await edit(a, caption('shore', 'Remote edit'));
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  const before = await manifests(b);
  const unchanged = async () => {
    assert.deepEqual(await manifests(b), before);
    assert.equal((await readSyncState(b.folder)).pull, undefined);
  };
  // A header that is still being written is not a commit yet.
  const snapshots = join(remote.store.root, 'books', tip.bookId, 'snapshots');
  await writeFile(join(snapshots, crypto.randomUUID() + '.json'), '{"version":2,"commitId":');
  await writeFile(join(snapshots, '.' + crypto.randomUUID() + '.json.icloud'), 'placeholder');
  assert.deepEqual((await tips(remote, a)).map(({ commitId }) => commitId), [tip.commitId]);
  // The header arrived before its state blob.
  const state = join(remote.store.root, ...contentBlobKey(tip.bookId, tip.stateDigest).split('/'));
  await rename(state, state + '-away');
  await assert.rejects(sync(b, remote), RemoteSyncingError);
  await unchanged();
  await use(b);
  const destination = join(b.base, 'Opened.imageflow');
  await assert.rejects(cloneFromRemote({ remote, tip, destination }), RemoteSyncingError);
  assert.deepEqual((await readdir(b.base)).filter((name) => name.startsWith('Opened') || name.startsWith('.imageflow-create')), []);
  await rename(state + '-away', state);
  // A preview another Mac has only half written.
  const blob = stateBlobSchema.parse(JSON.parse(await readFile(state, 'utf8')));
  const [digest, entry] = Object.entries(blob.proxies).find(([digest]) => digest === blob.assetsMeta.assets[Object.keys(blob.photos).find((id) => (blob.photos[id] as { linked?: boolean }).linked)!].digest)!;
  const proxy = join(remote.store.root, ...proxyBlobKey(tip.bookId, digest, entry.ext).split('/'));
  const whole = await readFile(proxy);
  await rm((await proxyFile(b, digest))!, { force: true });
  await writeFile(proxy, whole.subarray(0, 64));
  await assert.rejects(sync(b, remote), RemoteSyncingError);
  await unchanged();
  await assert.rejects(cloneFromRemote({ remote, tip, destination }), RemoteSyncingError);
  assert.deepEqual((await readdir(b.base)).filter((name) => name.startsWith('Opened') || name.startsWith('.imageflow-create')), []);
  // Once it has arrived, the pull goes through.
  await writeFile(proxy, whole);
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await manifests(b)).photos.shore.caption, 'Remote edit');
});

core('a folder remote keeps files immutable, writes them whole, and clones blobs', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-folder-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await syncFolder(root);
  const bytes = new TextEncoder().encode('content');
  const book = crypto.randomUUID();
  const key = contentBlobKey(book, sha(bytes));
  assert.equal(await remote.hasBlob(key), false);
  assert.equal(await remote.getBlob(key), undefined);
  assert.equal(await remote.downloadBlob(key, join(root, 'nothing')), false);
  assert.equal(await lstat(join(root, 'nothing')).catch(() => undefined), undefined);
  await remote.putBlob(key, bytes);
  assert.deepEqual(await remote.getBlob(key), bytes);
  // An existing blob is kept: content-addressed, so it already has these bytes.
  await remote.putBlob(key, new TextEncoder().encode('other'));
  assert.deepEqual(await remote.getBlob(key), bytes);
  // From a file, cloned on the same volume, and back.
  const original = join(root, 'original.jpg');
  await image(original, '#123456');
  const originalBytes = await readFile(original);
  const originalKey = originalBlobKey(book, sha(originalBytes), '.jpg');
  await remote.putBlob(originalKey, { file: original });
  const downloaded = join(root, 'downloaded.jpg');
  await writeFile(downloaded, 'replaced whole');
  assert.equal(await remote.downloadBlob(originalKey, downloaded), true);
  assert.deepEqual(await readFile(downloaded), originalBytes);
  await assert.rejects(remote.putBlob('books/../escape', bytes), /Not a sync blob key/);
  await assert.rejects(remote.putBlob('blobs/content/' + sha(bytes), bytes), /Not a sync blob key/, 'the layout before per-book keys');
  await assert.rejects(remote.getCommit('../books', crypto.randomUUID()), /Not a sync book ID/);
  // Commit headers: one ID, one header.
  const header: CommitHeader = { version: 2, commitId: crypto.randomUUID(), bookId: book, parents: [], bookStateRevision: 'a'.repeat(64),
    createdAt: '2026-11-21T10:00:00.000Z', title: 'Book', stateDigest: sha(bytes) };
  await remote.putCommit(header);
  await remote.putCommit(structuredClone(header));
  await assert.rejects(remote.putCommit({ ...header, title: 'Other' }), /different commit/);
  assert.deepEqual(readCommitHeader(await remote.getCommit(header.bookId, header.commitId)), header);
  assert.deepEqual(await remote.listBooks(), [{ bookId: header.bookId }]);
  assert.deepEqual((await remoteTips(remote, header.bookId)).map(({ commitId }) => commitId), [header.commitId]);
  // A sync daemon's conflict copy of a header holds the same immutable header and changes nothing.
  await cp(join(remote.store.root, 'books', header.bookId, 'snapshots', header.commitId + '.json'), join(remote.store.root, 'books', header.bookId, 'snapshots', header.commitId + ' (1).json'));
  assert.equal((await remoteTips(remote, header.bookId)).length, 1);
  assert.deepEqual((await remoteFiles(remote)).filter((path) => path.split('/').at(-1)!.startsWith('.')), [], 'no temporary files stay');
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.')), []);
});

each('after an edit the status follows the local revision against what the remote last showed', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await edit(a, caption('shore', 'Desktop'));
  await sync(a, remote);
  const behind = await describeSync(b.folder, remote);
  assert.deepEqual([behind.state, behind.remote], ['behind', 'moved']);
  await edit(b, caption('segla', 'Laptop'));
  assert.equal((await describeLocalChange(b.folder, behind)).state, 'diverged');
  const inSync = await describeSync(a.folder, remote);
  assert.equal(inSync.remote, 'same');
  assert.equal((await describeLocalChange(a.folder, inSync)).state, 'in-sync');
  // Statuses that come from the remote alone stay as they were.
  const syncing = { state: 'remote-syncing' as const, pendingOriginals: 0 };
  assert.equal(await describeLocalChange(a.folder, syncing), syncing);
});

core('changes to a sync record are serialized, so none is lost', async (t) => {
  const { a } = await world(t);
  await Promise.all([
    updateSyncState(a.folder, (state) => ({ ...state, enabled: false })),
    updateSyncState(a.folder, (state) => ({ ...state, remoteId: '3f0c5c43-56a5-4d5b-9a51-0a6a0e1e2b11' })),
    ...Array.from({ length: 8 }, () => updateSyncState(a.folder, (state) => state)),
  ]);
  const state = await readSyncState(a.folder);
  assert.equal(state.enabled, false);
  assert.equal(state.remoteId, '3f0c5c43-56a5-4d5b-9a51-0a6a0e1e2b11');
});

each('a book a newer version synced is listed as such and hides no other book', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  const other = crypto.randomUUID();
  await putHeader(remote, other, crypto.randomUUID(), { ...tip, bookId: other, commitId: crypto.randomUUID(), version: 3 });
  const books = await remoteBooks(remote);
  assert.deepEqual(books.map(({ bookId, newer }) => [bookId, !!newer]), [[tip.bookId, false], [other, true]]);
});

// The store contract (tests/sync-store-conformance.ts), which the S3 store runs against itself later.
if (store === 'memory') {
  storeConformance('memory', async () => new MemoryStore());
  storeConformance('folder', async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'if-store-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    return new FolderStore(root);
  }, { sha256: 'checked' });
}

core('a folder store leaves no temporary files and no empty folders, and never lists hidden files', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-store-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = new FolderStore(root);
  const hidden = async () => (await readdir(root, { recursive: true })).map(String).filter((path) => path.split('/').at(-1)!.startsWith('.'));
  await folder.putIfAbsent('books/a/content/one', new TextEncoder().encode('one'));
  await folder.putIfAbsent('books/a/content/one', new TextEncoder().encode('other'));
  await folder.copy('books/a/content/one', 'books/b/content/one');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(folder.putIfAbsent('books/c/content/one', new TextEncoder().encode('one'), { signal: aborted.signal }));
  assert.deepEqual(await hidden(), []);
  // A sync service's placeholder or a temporary file of another writer is not an object, and a folder with nothing else is no prefix.
  await mkdir(join(root, 'books', 'd', 'content'), { recursive: true });
  await writeFile(join(root, 'books', 'd', 'content', '.two.icloud'), 'placeholder');
  await writeFile(join(root, 'books', 'a', 'content', '.sync-other.tmp'), 'partial');
  assert.deepEqual((await folder.list('')).map(({ key }) => key), ['books/a/content/one', 'books/b/content/one']);
  assert.deepEqual(await folder.listPrefixes('books/'), ['books/a/', 'books/b/']);
  assert.equal(await folder.head('books/a/content/.sync-other.tmp').catch(() => 'refused'), 'refused');
  // Deleting the last object of a prefix removes its folders, but never the root.
  await folder.delete(['books/b/content/one']);
  assert.equal(await lstat(join(root, 'books', 'b')).catch(() => undefined), undefined);
  await folder.delete(['books/a/content/one']);
  await rm(join(root, 'books'), { recursive: true });
  await folder.delete(['books/a/content/one']);
  assert.ok(await lstat(root));
});

each('every blob of a book lives under its prefix, and two books never share one', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  // The laptop's book is another book (a new lineage) with the same photos.
  await copyBook(a, b);
  const project = JSON.parse(await readFile(join(b.folder, 'project.json'), 'utf8'));
  await writeFile(join(b.folder, 'project.json'), JSON.stringify({ ...project, bookId: crypto.randomUUID() }, null, 2) + '\n');
  assert.equal((await sync(b, remote)).action, 'initial-push');
  const ids = [await bookId(a), await bookId(b)];
  assert.notEqual(ids[0], ids[1]);
  // Besides the books, only the remote's identity.
  const keys = (await remote.store.list('')).map(({ key }) => key).filter((key) => key !== 'remote.json');
  for (const key of keys) assert.ok(ids.some((id) => key.startsWith('books/' + id + '/')), key);
  for (const key of keys.filter((key) => !key.includes('/snapshots/'))) assert.match(key, blobKeyPattern);
  const digest = sha(await readFile(join(a.folder, 'photos/shore.jpg')));
  for (const id of ids) assert.ok(await remote.hasBlob(originalBlobKey(id, digest, '.jpg')), 'each book stores its own copy');
  // A book's listing is its own, by part, with sizes and times.
  const originals = await remote.listBook(ids[0], 'originals');
  assert.ok(originals.length > 0 && originals.every(({ key, size, lastModified }) => key.startsWith('books/' + ids[0] + '/originals/') && size > 0 && lastModified instanceof Date));
  assert.equal((await remote.listBook(ids[0])).length, keys.filter((key) => key.startsWith('books/' + ids[0] + '/')).length);
  assert.equal((await remote.listBook(ids[0], 'covers')).length, 0);
  assert.deepEqual((await remote.listBooks()).map((book) => book.bookId).sort(), [...ids].sort());
  // A blob is copied inside the remote, as a duplicated book's first push will do, and only between blob keys.
  const copy = crypto.randomUUID();
  // A store without a server-side copy (iCloud) answers false, and the caller uploads instead.
  assert.equal(await remote.copyBlob(originalBlobKey(ids[0], digest, '.jpg'), originalBlobKey(copy, digest, '.jpg')), !!remote.store.copy);
  if (remote.store.copy) assert.equal(sha(await stored(remote, originalBlobKey(copy, digest, '.jpg'))), digest);
  assert.equal(await remote.copyBlob(originalBlobKey(ids[0], 'f'.repeat(64), '.jpg'), originalBlobKey(copy, 'f'.repeat(64), '.jpg')), false);
  await assert.rejects(remote.copyBlob(originalBlobKey(ids[0], digest, '.jpg'), 'remote.json'), /Not a sync blob key/);
  assert.match(coverBlobKey(copy, digest), blobKeyPattern);
});

coreEach('a remote has one identity, also when two Macs initialize it at once', async (t) => {
  const { root, a, remote } = await world(t);
  const [first, second] = await Promise.all([remote.remoteId(), new StoreRemote(remote.store).remoteId()]);
  assert.equal(first, second);
  assert.equal(await remote.remoteId(), first);
  assert.deepEqual(readRemoteIdentity(JSON.parse(Buffer.from(await stored(remote, 'remote.json')).toString('utf8'))), { version: 1, remoteId: first });
  assert.notEqual(await (await newRemote(root, 'Other')).remoteId(), first);
  // The identity is no book and no blob: syncing beside it works, and the listing does not show it.
  await sync(a, remote);
  assert.deepEqual((await remoteBooks(remote)).map((book) => book.bookId), [await bookId(a)]);
  // One a newer version wrote is refused, never replaced.
  await replace(remote, 'remote.json', new TextEncoder().encode(JSON.stringify({ version: 2, remoteId: first })));
  await assert.rejects(remote.remoteId(), NewerSyncFormatError);
  await replace(remote, 'remote.json', new TextEncoder().encode('{"version":1,"remo'));
  await assert.rejects(remote.remoteId(), /cannot be read/);
});

each('a book deleted from sync leaves only its tombstone and is listed as deleted', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  const project = JSON.parse(await readFile(join(b.folder, 'project.json'), 'utf8'));
  await writeFile(join(b.folder, 'project.json'), JSON.stringify({ ...project, bookId: crypto.randomUUID(), title: 'Kept' }, null, 2) + '\n');
  await sync(b, remote);
  const [deleted, kept] = [await bookId(a), await bookId(b)];
  assert.equal(await remote.bookTombstone(deleted), undefined);
  const tombstone = await remote.deleteBook(deleted, new Date('2026-11-23T10:00:00.000Z'));
  assert.deepEqual(tombstone, { version: 1, bookId: deleted, deletedAt: '2026-11-23T10:00:00.000Z' });
  assert.deepEqual((await remote.listBook(deleted)).map(({ key }) => key), [tombstoneKey(deleted)]);
  assert.deepEqual(readBookTombstone(JSON.parse(Buffer.from(await stored(remote, tombstoneKey(deleted))).toString('utf8'))), tombstone);
  assert.deepEqual(await remote.bookTombstone(deleted), tombstone);
  // Deleting again keeps the first tombstone, and the other book is untouched.
  assert.deepEqual(await remote.deleteBook(deleted, new Date('2027-01-01T00:00:00.000Z')), tombstone);
  assert.ok((await remote.listBook(kept)).length > 3);
  assert.deepEqual((await remote.listBooks()).sort((x, y) => Number(!!x.deleted) - Number(!!y.deleted)), [{ bookId: kept }, { bookId: deleted, deleted: tombstone }]);
  const books = await remoteBooks(remote);
  assert.deepEqual(books.map(({ bookId, title, deleted }) => [bookId, title, deleted?.deletedAt]), [[kept, 'Kept', undefined], [deleted, '', tombstone.deletedAt]]);
  assert.deepEqual(books[1].tips, []);
  // Commits that reach the prefix later (a Mac that had not seen the tombstone) do not bring the book back.
  await putHeader(remote, deleted, crypto.randomUUID(), { version: 2, commitId: crypto.randomUUID(), bookId: deleted, parents: [], bookStateRevision: 'a'.repeat(64),
    createdAt: '2026-11-24T10:00:00.000Z', title: 'Back', stateDigest: 'b'.repeat(64) });
  assert.equal((await remoteBooks(remote)).find((book) => book.bookId === deleted)?.deleted?.deletedAt, tombstone.deletedAt);
  // A tombstone a newer version wrote marks the book as needing an update, and hides no other book.
  const newer = new TextEncoder().encode(JSON.stringify({ version: 2, bookId: kept, deletedAt: tombstone.deletedAt, by: 'x' }));
  await replace(remote, tombstoneKey(kept), newer);
  await replace(remote, deletedMarkerKey(kept), newer);
  await assert.rejects(remote.bookTombstone(kept, { fresh: true }), NewerSyncFormatError);
  assert.deepEqual((await remoteBooks(remote)).map(({ bookId, newer, deleted }) => [bookId, !!newer, !!deleted]), [[kept, true, false], [deleted, false, true]]);
});

each('a commit header is version 2 with an optional cover, and a version 1 reader refuses it', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  assert.equal(tip.version, 2);
  assert.equal(tip.coverDigest, undefined, 'a push without a cover writes none');
  const raw = JSON.parse(Buffer.from(await stored(remote, commitKey(tip.bookId, tip.commitId))).toString('utf8'));
  // The reader as it shipped before the per-book layout (tests/sync-v1-reader.ts): it asks for an update instead of
  // taking the header for one that is still arriving, or parsing it and looking for blobs where they no longer are.
  assert.throws(() => readCommitHeaderV1(raw), (error: Error & { code?: string }) => error.name === 'NewerSyncFormatError' && error.code === 'SYNC_FORMAT_NEWER');
  const covered = { ...raw, commitId: crypto.randomUUID(), parents: [tip.commitId], coverDigest: 'c'.repeat(64) };
  assert.throws(() => readCommitHeaderV1(covered), { name: 'NewerSyncFormatError' });
  assert.equal(readCommitHeaderV1({ ...raw, version: 1 })?.commitId, tip.commitId, 'the reader is the real one: it reads its own format');
  // This version reads the cover, and a header of the old format is no commit to it.
  assert.equal(readCommitHeader(covered)?.coverDigest, 'c'.repeat(64));
  assert.equal(readCommitHeader({ ...raw, version: 1 }), undefined);
  assert.throws(() => readCommitHeader({ ...raw, version: 3 }), NewerSyncFormatError);
  // A commit that closes a fork carries the chosen tip's cover on.
  await remote.putCommit(covered);
  await remote.putCommit({ ...covered, commitId: crypto.randomUUID(), createdAt: new Date(Date.parse(tip.createdAt) + 1000).toISOString(), coverDigest: 'd'.repeat(64) });
  const forked = await tips(remote, a);
  assert.equal(forked.length, 2);
  const outcome = await sync(a, remote, { chooseTip: async () => forked[0].commitId });
  assert.equal((await commit(remote, a, outcome.pushed[0])).coverDigest, forked[0].coverDigest);
});

core('a remote over a store without a server-side copy copies nothing, so the caller uploads', async () => {
  const store: SyncStore = new MemoryStore();
  store.copy = undefined;
  const remote = new StoreRemote(store);
  const [from, to] = [crypto.randomUUID(), crypto.randomUUID()].map((book) => originalBlobKey(book, 'a'.repeat(64), '.jpg'));
  await remote.putBlob(from, new TextEncoder().encode('original'));
  assert.equal(await remote.copyBlob(from, to), false);
  assert.equal(await remote.hasBlob(to), false);
  await assert.rejects(remote.copyBlob(from, 'remote.json'), /Not a sync blob key/);
});

const failing = (code: string) => Object.assign(new Error(code + ': injected'), { code });

core('a folder store on a volume without hard links renames into place, and still never replaces an object', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-store-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    let links = 0;
    const folder = new FolderStore(join(root, code), { link: async () => { links++; throw failing(code); } });
    const one = new TextEncoder().encode('one');
    assert.deepEqual(await folder.putIfAbsent('books/a/content/one', one), { existed: false });
    assert.equal(links, 1, 'the link was tried first');
    assert.deepEqual(await folder.get('books/a/content/one'), one);
    // One that is there is found by the look before the write.
    assert.deepEqual(await folder.putIfAbsent('books/a/content/one', new TextEncoder().encode('other')), { existed: true });
    // One that arrives while this writer copies is found by the look before the rename.
    const late = new FolderStore(join(root, code), { link: async (_from, to) => { await writeFile(to, 'theirs'); throw failing(code); } });
    assert.deepEqual(await late.putIfAbsent('books/a/content/two', new TextEncoder().encode('mine')), { existed: true });
    assert.deepEqual(await folder.get('books/a/content/two'), new TextEncoder().encode('theirs'));
    // From a file, with the time it was stored.
    const file = join(root, 'source-' + code + '.jpg');
    await image(file, '#445566');
    assert.deepEqual(await folder.putIfAbsent('books/a/originals/three.jpg', { file }), { existed: false });
    assert.deepEqual(await folder.get('books/a/originals/three.jpg'), new Uint8Array(await readFile(file)));
    assert.deepEqual((await folder.list('')).map(({ key }) => key), ['books/a/content/one', 'books/a/content/two', 'books/a/originals/three.jpg']);
    assert.deepEqual((await readdir(join(root, code), { recursive: true })).map(String).filter((path) => path.split('/').at(-1)!.startsWith('.')), [], 'no temporary files stay');
  }
  // Any other failure of the link is an error, and leaves nothing.
  const refused = new FolderStore(join(root, 'refused'), { link: async () => { throw failing('EACCES'); } });
  await assert.rejects(refused.putIfAbsent('books/a/content/one', new TextEncoder().encode('one')), /EACCES/);
  assert.deepEqual(await refused.list(''), []);
  assert.equal(await lstat(join(root, 'refused', 'books')).catch(() => undefined), undefined, 'not even the folders it made');
});

core('a folder store put or copy whose folder a delete removes meanwhile makes it again', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-store-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // What `delete` does when it empties a folder, at the worst moment: right after a writer made that folder.
  let removals = 0;
  const racing = (times: number) => new FolderStore(root, { mkdir: (async (path: string, options: object) => {
    const made = await mkdir(path, options);
    if (removals < times) { removals++; await rm(path, { recursive: true }); }
    return made;
  }) as typeof mkdir });
  const one = new TextEncoder().encode('one');
  assert.deepEqual(await racing(1).putIfAbsent('books/a/content/one', one), { existed: false });
  assert.equal(removals, 1);
  assert.deepEqual(await new FolderStore(root).get('books/a/content/one'), one);
  const file = join(root, 'source.jpg');
  await image(file, '#445566');
  removals = 0;
  assert.deepEqual(await racing(1).putIfAbsent('books/b/originals/two.jpg', { file }), { existed: false });
  removals = 0;
  assert.equal(await racing(1).copy('books/b/originals/two.jpg', 'books/c/originals/two.jpg'), true);
  assert.deepEqual(await new FolderStore(root).get('books/c/originals/two.jpg'), new Uint8Array(await readFile(file)));
  assert.equal(removals, 1);
  const folder = new FolderStore(root);
  // It is tried once more, not for ever: a folder that keeps going away is an error.
  removals = 0;
  await assert.rejects(racing(2).putIfAbsent('books/e/content/one', one), /ENOENT/);
  // A source that is not there is still just that.
  await assert.rejects(folder.putIfAbsent('books/e/originals/missing.jpg', { file: join(root, 'missing.jpg') }), /ENOENT/);
  assert.equal(await folder.copy('books/e/originals/missing.jpg', 'books/f/originals/missing.jpg'), false);
  assert.deepEqual((await readdir(root, { recursive: true })).map(String).filter((path) => path.split('/').at(-1)!.startsWith('.')), []);
});

coreEach('a blob is copied only to its own key in another book, and never over a blob that is there', async (t) => {
  const { remote } = await world(t);
  const [from, to, other] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const bytes = new TextEncoder().encode('original');
  const digest = sha(bytes);
  await remote.putBlob(originalBlobKey(from, digest, '.jpg'), bytes);
  // Another blob, another part or another extension is not a copy of this one.
  await assert.rejects(remote.copyBlob(originalBlobKey(from, digest, '.jpg'), originalBlobKey(to, 'f'.repeat(64), '.jpg')), /only copied to its own key/);
  await assert.rejects(remote.copyBlob(originalBlobKey(from, digest, '.jpg'), originalBlobKey(to, digest, '.png')), /only copied to its own key/);
  await assert.rejects(remote.copyBlob(originalBlobKey(from, digest, '.jpg'), proxyBlobKey(to, digest, '.jpg')), /only copied to its own key/);
  await assert.rejects(remote.copyBlob(contentBlobKey(from, digest), coverBlobKey(to, digest)), /only copied to its own key/);
  assert.deepEqual((await remote.store.list('')).map(({ key }) => key), [originalBlobKey(from, digest, '.jpg')]);
  // A blob the target book has is left as it is, and the copy counts as done.
  const theirs = new TextEncoder().encode('already there');
  await remote.store.putIfAbsent(originalBlobKey(to, digest, '.jpg'), theirs);
  const before = await remote.store.head(originalBlobKey(to, digest, '.jpg'));
  assert.equal(await remote.copyBlob(originalBlobKey(from, digest, '.jpg'), originalBlobKey(to, digest, '.jpg')), true);
  assert.deepEqual(await stored(remote, originalBlobKey(to, digest, '.jpg')), theirs);
  assert.deepEqual(await remote.store.head(originalBlobKey(to, digest, '.jpg')), before);
  // Also when the source is not there, and a blob copied onto itself stays.
  assert.equal(await remote.copyBlob(originalBlobKey(other, digest, '.jpg'), originalBlobKey(to, digest, '.jpg')), true);
  assert.equal(await remote.copyBlob(originalBlobKey(from, digest, '.jpg'), originalBlobKey(from, digest, '.jpg')), true);
  assert.equal(await remote.copyBlob(originalBlobKey(from, digest, '.jpg'), originalBlobKey(other, digest, '.jpg')), !!remote.store.copy);
  if (remote.store.copy) assert.deepEqual(await stored(remote, originalBlobKey(other, digest, '.jpg')), bytes);
});

each('a sync record names the book its commit belongs to, and originals are found there whatever project.json says later', async (t) => {
  const { a, b, remote } = await world(t);
  // Push, adopt, pull and clone all record it.
  await sync(a, remote);
  const id = await bookId(a);
  assert.equal((await readSyncState(a.folder)).lastSynced?.bookId, id, 'a push');
  await copyBook(a, b);
  assert.equal((await sync(b, remote)).action, 'adopt');
  assert.equal((await readSyncState(b.folder)).lastSynced?.bookId, id, 'an adopted tip');
  await edit(a, caption('shore', 'Edited'));
  await sync(a, remote);
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await readSyncState(b.folder)).lastSynced?.bookId, id, 'a pull');
  await rm(b.folder, { recursive: true });
  await use(b);
  const [tip] = await tips(remote, a);
  await cloneFromRemote({ remote, tip, destination: b.folder });
  assert.equal((await readSyncState(b.folder)).lastSynced?.bookId, id, 'a book made from the remote');
  const pending = await pendingOriginals(b.folder, remote);
  assert.ok(pending.includes('shore'));
  // The book gets another lineage ID, as one that syncs again as a new history does, before its record is reset.
  const writeBookId = async (bookId: string) => {
    const project = JSON.parse(await readFile(join(b.folder, 'project.json'), 'utf8'));
    await writeFile(join(b.folder, 'project.json'), JSON.stringify({ ...project, bookId }, null, 2) + '\n');
  };
  await writeBookId(crypto.randomUUID());
  assert.deepEqual(await pendingOriginals(b.folder, remote), pending, 'still read from the book the commit belongs to');
  const staged = await stageOriginals({ remote, folder: b.folder });
  assert.deepEqual(staged.map((original) => original.id).sort(), [...pending].sort());
  await Promise.all(staged.map(({ staging }) => rm(staging, { force: true })));
  await on(b, async (book) => assert.deepEqual(await downloadOriginals({ remote, book, ids: ['shore'] }), ['shore']));
  assert.equal(sha(await readFile(join(b.folder, 'photos/shore.jpg'))), sha(await readFile(join(a.folder, 'photos/shore.jpg'))));
  // A record from before the ID was kept loads, and falls back to project.json.
  await rm(join(b.folder, 'photos/shore.jpg'));
  await updateSyncState(b.folder, ({ lastSynced, ...state }) => { const { bookId: _, ...rest } = lastSynced!; return { ...state, lastSynced: rest }; });
  assert.equal((await readSyncState(b.folder)).lastSynced?.bookId, undefined);
  assert.deepEqual(await pendingOriginals(b.folder, remote), [], 'the other ID in project.json has no such snapshot');
  await writeBookId(id);
  assert.deepEqual(await pendingOriginals(b.folder, remote), pending);
  await on(b, async (book) => assert.deepEqual(await downloadOriginals({ remote, book, ids: ['shore'] }), ['shore']));
});

// The sync backend is a setting of the Mac (ADR 0012, #280): the service builds the remote from it, and a book records
// only whether it syncs here and which remote it last synced with.
async function folderBackend(root: string, name: string): Promise<FolderSyncBackend> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return { kind: 'folder', path };
}
async function syncPath(mac: Mac) {
  const folder = join((await bookStateFolder(mac.folder, true))!, 'sync');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return join(folder, 'sync.json');
}
/**
 * A sync through the app's sync service, then its background upload of the originals the commit named. The book is
 * the user's own (trusted), as every book that syncs in the app is.
 */
const syncWith = async (mac: Mac, service: SyncService) => {
  const outcome = await on(mac, async (book) => { await trustBook(mac.folder); return service.sync({ book }); });
  await service.upload(mac.folder);
  return outcome;
};

core('two books sync through the one configured remote, without any setup of their own', async (t) => {
  const { root, a, b } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  const other: Mac = { ...a, folder: join(a.base, 'Other.imageflow') };
  await copySample(resolve('sample/starter'), other.folder);
  assert.equal((await service.standing(a.folder)).sync, 'off');
  assert.equal((await syncWith(a, service)).action, 'initial-push');
  assert.equal((await syncWith(other, service)).action, 'initial-push');
  const { remote, remoteId } = await service.connect();
  assert.deepEqual((await remoteBooks(remote)).map((book) => book.bookId).sort(), [await bookId(a), await bookId(other)].sort());
  for (const mac of [a, other]) {
    assert.equal((await service.standing(mac.folder)).sync, 'syncing');
    // The record holds no location: only the remote's identity, that the book syncs, and what it last synced.
    const record = JSON.parse(await readFile(await syncPath(mac), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['enabled', 'lastSynced', 'remoteId', 'version']);
    assert.equal(record.remoteId, remoteId);
    assert.equal(JSON.stringify(record).includes(backend.path), false);
  }
  // Another Mac with the same backend opens the book from it and syncs it with nothing to set up per book.
  await use(b);
  const laptop = new SyncService(() => ({ ...backend }));
  const connection = await laptop.connect();
  assert.equal(connection.remoteId, remoteId);
  const id = await bookId(a);
  const listed = (await remoteBooks(connection.remote)).find((book) => book.bookId === id);
  assert.ok(listed);
  await cloneFromRemote({ remote: connection.remote, tip: listed.tips[0], destination: b.folder, remoteId: connection.remoteId });
  assert.equal((await laptop.standing(b.folder)).sync, 'syncing');
  await edit(b, caption('shore', 'From the laptop'));
  assert.equal((await syncWith(b, laptop)).action, 'push');
  assert.equal((await syncWith(a, service)).action, 'fast-forward');
  assert.equal((await manifests(a)).photos.shore.caption, 'From the laptop');
});

test('two Macs that initialize an empty remote at once adopt the identity that won, also where a store cannot tell', async (t) => {
  const { root, a, b } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const [desktop, laptop] = [new SyncService(() => backend), new SyncService(() => backend)];
  const [first, second] = await Promise.all([desktop.connect(), laptop.connect()]);
  assert.equal(first.remoteId, second.remoteId);
  await copyBook(a, b);
  await Promise.all([syncWith(a, desktop), syncWith(b, laptop)].map((step) => step.catch(() => undefined)));
  assert.equal((await readSyncState(a.folder)).remoteId, first.remoteId);
  assert.equal((await readSyncState(b.folder)).remoteId, first.remoteId);
  // A store that falls back to looking, then putting, may say an object was new when another Mac's write won: the
  // identity is read back, never taken from what this Mac wrote.
  class Unsure extends MemoryStore {
    override async putIfAbsent(...args: Parameters<MemoryStore['putIfAbsent']>) { await super.putIfAbsent(...args); return { existed: false }; }
  }
  const store = new Unsure();
  const ids = await Promise.all(Array.from({ length: 4 }, () => new StoreRemote(store).remoteId()));
  assert.equal(new Set(ids).size, 1);
  assert.equal(readRemoteIdentity(JSON.parse(Buffer.from((await store.get('remote.json'))!).toString('utf8')))?.remoteId, ids[0]);
});

test('changing the backend: a synced book asks before it starts a new history, pushes nothing by itself, and declining stops asking', async (t) => {
  const { root, a } = await world(t);
  const first = await folderBackend(root, 'First');
  const second = await folderBackend(root, 'Second');
  let backend = first;
  const service = new SyncService(() => backend);
  await syncWith(a, service);
  const synced = (await readSyncState(a.folder)).lastSynced;
  backend = second;
  const { remote } = await service.connect();
  assert.equal((await service.standing(a.folder)).sync, 'elsewhere', 'the book last synced with another remote');
  await assert.rejects(syncWith(a, service), SyncElsewhereError);
  assert.deepEqual(await remote.listBooks(), [], 'nothing was pushed');
  assert.deepEqual((await readSyncState(a.folder)).lastSynced, synced, 'and nothing changed');
  // Declining stops syncing on this Mac: the book no longer counts as one to ask about.
  await service.stop(a.folder);
  assert.equal((await service.standing(a.folder)).sync, 'stopped');
  await assert.rejects(syncWith(a, service), SyncElsewhereError, 'Start Syncing asks again');
  assert.deepEqual(await remote.listBooks(), []);
  // Accepting starts a new history here: the record names this remote and forgets what it synced with the other.
  await on(a, () => service.start(a.folder, { newHistory: true, trust: true }));
  const record = await readSyncState(a.folder);
  assert.equal(record.remoteId, (await service.connect()).remoteId);
  assert.equal(record.enabled, true);
  assert.equal(record.lastSynced, undefined);
  assert.equal((await syncWith(a, service)).action, 'initial-push');
  assert.deepEqual((await remote.listBooks()).map((book) => book.bookId), [await bookId(a)]);
  // Back on the first backend, the book has moved on: it asks again rather than syncing with a record of the other.
  backend = first;
  assert.equal((await service.standing(a.folder)).sync, 'elsewhere');
  // Stopped on its own remote, it starts again with the history it had.
  backend = second;
  await service.stop(a.folder);
  await on(a, () => service.start(a.folder, { trust: true }));
  assert.equal((await syncWith(a, service)).action, 'in-sync');
});

test('an old sync record that names a folder loads, reads as not syncing, and a book stuck on the old layout starts again', async (t) => {
  const { root, a } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  const { remote } = await service.connect();
  // A record from before ADR 0012 with no last sync: it reads without its folder, and the book does not sync. One from
  // before #282 may mark a pulled template for review; that is read without it, as only trusted books sync now.
  await writeFile(await syncPath(a), JSON.stringify({ version: 1, folder: backend.path, networkReview: true }) + '\n');
  assert.deepEqual(await readSyncState(a.folder), { version: 1 });
  assert.equal((await service.standing(a.folder)).sync, 'off');
  // A book that synced on the layout before #288: the commit it last synced is no commit on this remote, so it showed
  // "remote still syncing" for good. It reads as synced somewhere else, and a new history brings it back.
  await syncWith(a, service);
  const { lastSynced } = await readSyncState(a.folder);
  await writeFile(await syncPath(a), JSON.stringify({ version: 1, folder: backend.path, lastSynced: { ...lastSynced, commitId: crypto.randomUUID() } }) + '\n');
  assert.equal((await readSyncState(a.folder)).lastSynced?.bookStateRevision, lastSynced!.bookStateRevision);
  assert.equal((await describeSync(a.folder, remote)).state, 'remote-syncing', 'the record alone keeps it stuck');
  assert.equal((await service.standing(a.folder)).sync, 'elsewhere');
  await assert.rejects(syncWith(a, service), SyncElsewhereError);
  await on(a, () => service.start(a.folder, { newHistory: true, trust: true }));
  assert.equal((await syncWith(a, service)).action, 'adopt', 'the version on the remote is this book: no copy');
  assert.equal((await describeSync(a.folder, remote)).state, 'in-sync');
  // Writing the record never writes a folder again.
  assert.equal('folder' in JSON.parse(await readFile(await syncPath(a), 'utf8')), false);
});

/** Holds a book's writer lock without opening it, so an interrupted pull is not finished or given up by the open. */
async function locked<T>(mac: Mac, step: () => Promise<T>) {
  await use(mac);
  const release = await acquireProjectLock(mac.folder);
  try { return await step(); } finally { await release(); }
}

/**
 * The laptop was interrupted in a pull from the first backend (the desktop's caption and a template file, one file of
 * it written), while the desktop already syncs the book on the other backend at a version of its own.
 */
async function interruptedPull(t: TestContext) {
  const { root, a, b } = await world(t);
  const backends = { first: await folderBackend(root, 'First'), other: await folderBackend(root, 'Other'), empty: await folderBackend(root, 'Empty') };
  let backend = backends.first;
  const service = new SyncService(() => backend);
  await syncWith(a, service);
  await copyBook(a, b);
  assert.equal((await syncWith(b, service)).action, 'adopt');
  await writeFile(join(a.folder, 'template', 'notes.txt'), 'new');
  await edit(a, caption('shore', 'On the first remote'));
  await syncWith(a, service);
  const first = await service.connect();
  const [tip] = await tips(first.remote, a);
  await on(b, (book) => stageSyncPull(first.remote, book, tip));
  await writeFile(join(b.folder, 'template', 'notes.txt'), 'new');
  assert.equal((await readSyncState(b.folder)).pull?.targetCommit, tip.commitId);
  backend = backends.other;
  await on(a, () => service.start(a.folder, { newHistory: true, trust: true }));
  await edit(a, caption('shore', 'On the other remote'));
  assert.equal((await syncWith(a, service)).action, 'initial-push');
  const use = (name: keyof typeof backends) => { backend = backends[name]; return service.connect(); };
  return { a, b, service, tip, first, use };
}

for (const target of ['other', 'empty'] as const) {
  test('a new history on a remote that ' + (target === 'other' ? 'has' : 'lacks') + ' the book starts from an interrupted pull only once it is finished', async (t) => {
    const { b, service, tip, use } = await interruptedPull(t);
    const { remote, remoteId } = await use(target);
    assert.equal((await service.standing(b.folder)).sync, 'elsewhere');
    await locked(b, () => service.start(b.folder, { newHistory: true, trust: true }));
    const state = await readSyncState(b.folder);
    assert.deepEqual([state.remoteId, state.enabled, state.pull, state.lastSynced, state.abandoned], [remoteId, true, undefined, undefined, undefined]);
    assert.equal(await captureBookStateRevision(b.folder), tip.bookStateRevision, 'the pull was finished first');
    const outcome = await syncWith(b, service);
    if (target === 'empty') {
      assert.equal(outcome.action, 'initial-push');
      assert.equal((await tips(remote, b))[0].bookStateRevision, tip.bookStateRevision, 'what is pushed is the whole pull');
    } else {
      // This Mac's version differs from the other remote's: it is kept as a copy, and the book continues with it.
      assert.equal(outcome.action, 'diverged');
      assert.ok(outcome.conflictCopy);
      assert.equal(JSON.parse(await readFile(join(outcome.conflictCopy, 'photos.json'), 'utf8')).shore.caption, 'On the first remote');
      assert.equal((await manifests(b)).photos.shore.caption, 'On the other remote');
    }
  });
}

test('a book whose pull could not be finished starts no new history, on a remote with the book or without it, until it synced where it last did', async (t) => {
  const { b, service, use } = await interruptedPull(t);
  // The pull cannot be finished: a blob it staged is lost, and the book does not have that file yet.
  await rm(join(b.folder, 'template', 'notes.txt'));
  const staged = sha(new TextEncoder().encode('new'));
  for (const name of await readdir(persistenceRoot)) await rm(join(persistenceRoot, name, 'sync', 'staged', staged), { force: true });
  const halfDone = await captureBookStateRevision(b.folder);
  const other = await use('other');
  const commits = await commitCount(other.remote as Remote);
  await assert.rejects(locked(b, () => service.start(b.folder, { newHistory: true, trust: true })), SyncHalfPulledError);
  // It was given up, as when the book opens, and the record still belongs to the first remote.
  const state = await readSyncState(b.folder);
  assert.equal(state.pull, undefined);
  assert.ok(state.abandoned);
  assert.notEqual(state.remoteId, other.remoteId);
  // A pull given up there keeps it synced elsewhere, on either remote: never a plain first push of the half-done book.
  for (const target of ['other', 'empty'] as const) {
    await use(target);
    assert.equal((await service.standing(b.folder)).sync, 'elsewhere');
    await assert.rejects(syncWith(b, service), SyncElsewhereError);
    await assert.rejects(locked(b, () => service.start(b.folder, { newHistory: true, trust: true })), SyncHalfPulledError);
    await assert.rejects(locked(b, () => service.start(b.folder, { trust: true })), SyncElsewhereError);
  }
  assert.equal(await commitCount((await use('other')).remote as Remote), commits, 'nothing was pushed to the other remote');
  assert.deepEqual(await (await use('empty')).remote.listBooks(), [], 'nor to the empty one');
  assert.equal(await captureBookStateRevision(b.folder), halfDone, 'and the book is as the pull left it');
  // Where it last synced, the next sync pulls again; then it may start a new history.
  await use('first');
  assert.equal((await syncWith(b, service)).action, 'diverged');
  assert.equal((await readSyncState(b.folder)).abandoned, undefined);
  await use('other');
  await locked(b, () => service.start(b.folder, { newHistory: true, trust: true }));
  assert.ok((await syncWith(b, service)).conflictCopy, 'this Mac’s version is kept beside the other remote’s');
});

test('the remote’s identity is read at every use: a backend emptied while the app runs gets a new one, and its books ask again', async (t) => {
  const { root, a } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  // Uses that start together share one identity.
  const ids = new Set((await Promise.all(Array.from({ length: 8 }, () => service.connect()))).map((connection) => connection.remoteId));
  assert.equal(ids.size, 1);
  const [before] = ids;
  await syncWith(a, service);
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  // The folder is emptied and another Mac starts it again.
  await rm(backend.path, { recursive: true });
  await mkdir(backend.path);
  const other = await new SyncService(() => ({ ...backend })).connect();
  assert.notEqual(other.remoteId, before);
  assert.equal((await service.connect()).remoteId, other.remoteId);
  assert.equal((await service.standing(a.folder)).sync, 'elsewhere', 'the book does not push under the old identity');
  await assert.rejects(syncWith(a, service), SyncElsewhereError);
});

core('a sync folder inside a book is refused', async (t) => {
  const { a } = await world(t);
  const backend: FolderSyncBackend = { kind: 'folder', path: join(a.folder, 'files', 'Sync') };
  await mkdir(backend.path, { recursive: true });
  assert.equal(insideBook(backend.path), true);
  assert.equal(insideBook(join(a.base, 'Sync')), false);
  const service = new SyncService(() => backend);
  const standing = await service.standing(a.folder);
  assert.notEqual(standing.sync, 'syncing');
  assert.match(standing.error ?? '', /inside this book/);
  await assert.rejects(syncWith(a, service), /inside this book/);
  await assert.rejects(service.start(a.folder), /inside this book/);
  assert.equal((await readSyncState(a.folder)).remoteId, undefined);
});

/** A bucket on a fake S3 server of the test's own, and one Mac's view of it: its settings, key and Application Support. */
async function bucketWorld(t: TestContext, root: string) {
  const fake = await new FakeS3().start();
  t.after(() => fake.close());
  fake.bucket('books');
  const backend: S3SyncBackend = { kind: 's3', endpoint: fake.url, region: fake.region, bucket: 'books', prefix: 'ImageFlow/' };
  const mac = async (name: string, secretAccessKey = fakeCredentials.secretAccessKey) => {
    const credentials = new MemoryCredentialStore();
    await credentials.write(credentialScope(backend), { ...fakeCredentials, secretAccessKey });
    const support = join(root, name + ' Application Support');
    // Each Mac reads its own copy of the setting, as from its own settings.json.
    const service = new SyncService(() => ({ ...backend }), { credentials: () => credentials, cacheFolder: () => support, s3: { retryDelay: 1 } });
    return { service, credentials, support };
  };
  return { fake, backend, mac };
}

core('two Macs sync a book with owned originals through a bucket, and a wrong key on one shows sign-in until it is corrected, without a restart', async (t) => {
  const { root, a, b } = await world(t);
  const { fake, backend, mac } = await bucketWorld(t, root);
  const desktop = await mac('Desktop');
  const laptop = await mac('Laptop', 'a secret typed wrong');
  // The desktop pushes the book, with its owned original, to the bucket.
  assert.equal((await syncWith(a, desktop.service)).action, 'initial-push');
  const id = await bookId(a);
  const keys = [...fake.bucket('books').keys()];
  assert.ok(keys.includes('ImageFlow/remote.json'));
  assert.ok(keys.some((key) => key.startsWith('ImageFlow/books/' + id + '/originals/')), 'the owned original is in the bucket');
  const { remoteId } = await desktop.service.connect();
  // The laptop's key is wrong: its service says sign-in needed, which the status bar shows and points at Settings.
  const refused = await laptop.service.connect().catch((error) => error);
  assert.ok(refused instanceof StoreAccessError && refused.reason === 'sign-in', String(refused));
  assert.match(refused.message, /SignatureDoesNotMatch/);
  // Corrected in Settings (the credential store): the next use takes it, with the same service.
  await laptop.credentials.write(credentialScope(backend), fakeCredentials);
  const connection = await laptop.service.connect();
  assert.equal(connection.remoteId, remoteId);
  await use(b);
  const listed = (await remoteBooks(connection.remote)).find((book) => book.bookId === id)!;
  await cloneFromRemote({ remote: connection.remote, tip: listed.tips[0], destination: b.folder, remoteId: connection.remoteId });
  // Every owned original the desktop sent comes down to the laptop, whole (the engine checks each digest).
  const downloaded = await on(b, (book) => downloadOriginals({ remote: connection.remote, book }));
  const sent = keys.filter((key) => key.startsWith('ImageFlow/books/' + id + '/originals/'));
  assert.ok(downloaded.includes('shore'));
  assert.ok(downloaded.length >= sent.length && sent.length > 0, downloaded.length + ' downloaded, ' + sent.length + ' in the bucket');
  assert.equal((await laptop.service.standing(b.folder)).sync, 'syncing');
  // The key goes wrong again on the laptop: a book that syncs reads as unavailable with sign-in, and its status says so.
  await laptop.credentials.write(credentialScope(backend), { ...fakeCredentials, secretAccessKey: 'changed elsewhere' });
  const standing = await laptop.service.standing(b.folder);
  assert.deepEqual([standing.sync, standing.access], ['unavailable', 'sign-in']);
  assert.equal(unavailableStatus(standing.error!, standing.access).signIn, true);
  // A remote the bucket refuses once it is in use (describeSync reads its commits) gives the same status.
  const refusedRemote = new StoreRemote(new S3Store({ ...backend, credentials: { ...fakeCredentials, secretAccessKey: 'wrong' }, retryDelay: 1 }));
  const wrongStatus = await describeSync(b.folder, refusedRemote);
  assert.deepEqual([wrongStatus.state, wrongStatus.signIn], ['unavailable', true]);
  await laptop.credentials.write(credentialScope(backend), fakeCredentials);
  assert.equal((await laptop.service.standing(b.folder)).sync, 'syncing');
  // Edits both ways: the laptop pushes, the desktop fast-forwards.
  await edit(b, caption('shore', 'From the laptop, through the bucket'));
  assert.equal((await syncWith(b, laptop.service)).action, 'push');
  assert.equal((await syncWith(a, desktop.service)).action, 'fast-forward');
  assert.equal((await manifests(a)).photos.shore.caption, 'From the laptop, through the bucket');
  // Each Mac keeps the commit headers it read in its own Application Support, by remote and book.
  for (const { support } of [desktop, laptop]) assert.deepEqual(await readdir(join(support, 'Sync Cache', remoteId)), [id + '.json']);
  // And reads only headers it has not seen: the next sync fetches none it has.
  fake.requests.length = 0;
  assert.equal((await syncWith(a, desktop.service)).action, 'in-sync');
  assert.equal(fake.requests.filter(({ method, key }) => method === 'GET' && key.includes('/snapshots/')).length, 0);
});

test('a bucket emptied and set up again while the app runs gets a new identity at the next use, and its books ask again', async (t) => {
  const { root, a } = await world(t);
  const { fake, mac } = await bucketWorld(t, root);
  const desktop = await mac('Desktop');
  await syncWith(a, desktop.service);
  const before = (await desktop.service.connect()).remoteId;
  assert.equal((await desktop.service.standing(a.folder)).sync, 'syncing');
  // The bucket is emptied and another Mac writes a new remote.json.
  fake.bucket('books').clear();
  const other = await (await mac('Other')).service.connect();
  assert.notEqual(other.remoteId, before);
  // The running service reads it at its next use, also though its remote read the old one before.
  assert.equal((await desktop.service.connect()).remoteId, other.remoteId);
  assert.equal((await desktop.service.standing(a.folder)).sync, 'elsewhere', 'the book does not push under the old identity');
  await assert.rejects(syncWith(a, desktop.service), SyncElsewhereError);
  // Only remote.json changed: the store of the old remote.json is the same, and a new one under it is read too.
  await fake.bucket('books').delete('ImageFlow/remote.json');
  const third = await (await mac('Third')).service.connect();
  assert.equal((await desktop.service.connect()).remoteId, third.remoteId);
});

core('iCloud: a Mac signed in to iCloud syncs with nothing to set up, and another Apple ID is another remote that asks first', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const keyIndex = new MemoryKeyIndexCache();
  const backend: SyncBackend = { kind: 'icloud' };
  const service = new SyncService(() => backend, { cloudKit: () => native, keyIndex, headerCache: new MemoryHeaderCache() });
  assert.equal(service.name, 'iCloud');
  assert.equal((await syncWith(a, service)).action, 'initial-push');
  const first = await service.connect();
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  // The first push found no zone for the book; the next listing makes the index from the feed.
  assert.equal((await remoteTips(first.remote, await bookId(a))).length, 1);
  assert.ok([...keyIndex.books.keys()].some((key) => key.startsWith(first.remoteId + '/')), 'the key index is kept');
  // The account-change event also comes without a change (seen around Wi-Fi reconnecting): nothing changes.
  native.signIn(native.user);
  assert.equal((await service.connect()).remoteId, first.remoteId);
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  // Another Apple ID signs in: its database is another remote, the book is asked about, and nothing goes up.
  await edit(a, caption('shore', 'After the switch'));
  native.signIn('_user-two');
  const second = await service.connect();
  assert.notEqual(second.remoteId, first.remoteId);
  assert.equal((await service.standing(a.folder)).sync, 'elsewhere');
  await assert.rejects(syncWith(a, service), SyncElsewhereError);
  assert.deepEqual(await remoteBooks(second.remote), [], 'the other account’s database gets no book without asking');
  assert.equal([...keyIndex.books.keys()].some((key) => key.startsWith(first.remoteId + '/')), false, 'the former account’s key indexes are forgotten');
  // Back to the first Apple ID: its remote again, and the book syncs as before.
  native.signIn('_user-one');
  assert.equal((await service.connect()).remoteId, first.remoteId);
  assert.equal((await syncWith(a, service)).action, 'push');
});

test('iCloud: an account or build that cannot use it reads as unavailable, with the reason the status shows', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native });
  await syncWith(a, service);
  native.statusValue = { entitled: true, container: 'iCloud.test', environment: 'Production', accountStatus: 'noAccount' };
  assert.deepEqual(await service.standing(a.folder).then(({ sync, error, access }) => ({ sync, error, access })),
    { sync: 'unavailable', error: 'Sign in to iCloud, or turn on iCloud for ImageFlow.', access: 'sign-in' });
  native.statusValue = { entitled: false };
  assert.deepEqual(await service.standing(a.folder).then(({ sync, access }) => ({ sync, access })), { sync: 'unavailable', access: 'unavailable' });
  // No addon at all (not a Mac, or not staged).
  const without = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => undefined });
  assert.equal((await without.standing(a.folder)).error, 'iCloud sync is not available in this build of ImageFlow.');
});

test('iCloud storage full during the background upload: the commit and previews stay synced, the upload pauses with the status, and the rest uploads once there is room, without a second commit', async (t) => {
  const { a, b } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native });
  native.fail('putIfAbsent', 'quotaExceeded', { times: Infinity, name: (name) => name.startsWith('originals/') });
  await ownBook(a);
  const first = await on(a, (book) => service.sync({ book }));
  assert.equal(first.action, 'initial-push');
  const connection = await service.connect();
  const remote = connection.remote as Remote;
  const remoteId = connection.remoteId;
  const [tip] = await tips(remote, a);
  const state = await stateOf(remote, tip);
  assert.ok(state.originals.shore, 'the commit names every owned original, uploaded or not');
  assert.ok(Object.keys(state.proxies).length > 0, 'the previews went up');
  const pending = (await pendingUploads(a.folder, remote)).length;
  assert.ok(pending > 1);
  // The background upload finds no room: the queue stops at the first original instead of failing each in turn.
  native.calls.length = 0;
  const paused = await service.upload(a.folder);
  assert.equal(paused?.full?.message, 'iCloud storage full.');
  assert.equal(paused.left, pending);
  assert.equal(native.calls.filter((call) => call === 'putIfAbsent').length, 1);
  assert.deepEqual(service.uploadState(a.folder), { full: { message: 'iCloud storage full.', left: pending } });
  assert.deepEqual(service.pendingUploads(), [], 'nothing is uploading while it waits');
  // Another Mac reads the book: its previews, and originals that are still uploading, which is no sync error.
  await use(b);
  await cloneFromRemote({ remote, tip, destination: b.folder, remoteId });
  const away = await describeSync(b.folder, remote);
  assert.equal(away.state, 'in-sync');
  assert.equal(away.notUploaded, away.pendingOriginals);
  assert.ok(away.pendingOriginals > 0);
  await on(b, async (book) => assert.deepEqual(await downloadOriginals({ remote, book }), [], 'nothing to download yet, and no error'));
  assert.deepEqual(await stageOriginals({ remote, folder: b.folder }), []);
  // Still full, nothing edited: the next sync makes no commit and the upload pauses again.
  assert.equal((await syncWith(a, service)).action, 'in-sync');
  assert.ok(service.uploadState(a.folder).full);
  // Room again: the next sync uploads the rest from where it was, and makes no second commit.
  native.recover();
  assert.equal((await syncWith(a, service)).action, 'in-sync');
  assert.deepEqual(service.uploadState(a.folder), {});
  assert.deepEqual(await pendingUploads(a.folder, remote), []);
  assert.deepEqual((await tips(remote, a)).map(({ commitId }) => commitId), [tip.commitId], 'no second commit');
  // The other Mac now downloads every one of them.
  assert.equal((await describeSync(b.folder, remote)).notUploaded, undefined);
  const downloaded = await on(b, (book) => downloadOriginals({ remote, book }));
  assert.ok(downloaded.includes('shore'));
  assert.equal(downloaded.length, away.pendingOriginals);
  // When the book's own state does not fit, the sync fails with the same words and the remote keeps its tip.
  await edit(a, caption('shore', 'Full again'));
  native.fail('putIfAbsent', 'quotaExceeded', { times: Infinity });
  await assert.rejects(syncWith(a, service), (error: unknown) => error instanceof StoreFullError && error.message === 'iCloud storage full.');
  assert.deepEqual((await tips(remote, a)).map(({ commitId }) => commitId), [tip.commitId]);
});

test('iCloud emptied in System Settings: the books that synced ask first, nothing goes up before, and a new history syncs', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native, keyIndex: new MemoryKeyIndexCache() });
  await syncWith(a, service);
  const before = (await service.connect()).remoteId;
  await edit(a, caption('shore', 'After the wipe'));
  // Manage Storage → Delete: every zone, the index with remote.json too, answers userDeletedZone from now on.
  native.userDeletesAll();
  const after = await service.connect();
  assert.notEqual(after.remoteId, before, 'an emptied iCloud is another remote');
  assert.equal((await service.standing(a.folder)).sync, 'elsewhere', 'so the book is asked about');
  await assert.rejects(syncWith(a, service), SyncElsewhereError);
  assert.deepEqual(await remoteBooks(after.remote), [], 'and nothing went up without asking');
  // Agreed: the book starts a new history in the emptied iCloud.
  await service.start(a.folder, { newHistory: true, trust: true });
  assert.equal((await syncWith(a, service)).action, 'initial-push');
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  assert.equal((await remoteBooks(after.remote)).length, 1);
});

test('iCloud: a sync running when another Apple ID signs in writes no commit there, and connecting reads the user only after an account change', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native });
  await syncWith(a, service);
  native.calls.length = 0;
  for (let index = 0; index < 3; index++) await service.connect();
  assert.equal(native.calls.filter((call) => call === 'userRecordId').length, 0, 'the user is kept until the account changes');
  // Another Apple ID signs in while the sync uploads, and CloudKit's event has not arrived yet: its commit is refused.
  await edit(a, caption('shore', 'During the switch'));
  native.onCall = (op, _zone, record) => { if (op === 'putIfAbsent' && record?.startsWith('content/')) { native.user = '_user-two'; native.onCall = undefined; } };
  await assert.rejects(syncWith(a, service), (error: unknown) => error instanceof StoreAccessError && /account changed during the sync/.test(error.message));
  native.user = '_user-two';
  const other = await service.connect();
  assert.deepEqual(await remoteBooks(other.remote), [], 'no commit of the book reached the other account');
  assert.equal((await service.standing(a.folder)).sync, 'elsewhere');
});

// Every opened book syncs, with opt-out; originals upload after the commit (#282).

/** A book of the user's own on a Mac: trusted there, as one made with New Book is. */
async function ownBook(mac: Mac) {
  await use(mac);
  await trustBook(mac.folder);
}

core('only a book made under this set-up, or turned on, starts by itself; one that was there before does not', async (t) => {
  const { root, a, b } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  let setup: string | undefined;
  configureSyncSetup(() => setup);
  t.after(async () => configureSyncSetup(() => undefined));
  const service = new SyncService(() => (setup ? backend : undefined), { setup: () => setup });
  // Made with sync off, and with sync on.
  await ownBook(a);
  await startNewBook(a.folder);
  assert.equal(await service.startsOnOpen(a.folder), false, 'without a backend nothing starts');
  setup = randomUUID();
  assert.equal(await service.startsOnOpen(a.folder), false, 'a trusted book that was there before sync was turned on');
  await copySample(resolve('sample/starter'), b.folder);
  await trustBook(b.folder);
  assert.equal(await service.startsOnOpen(b.folder), false);
  assert.deepEqual(await readSyncState(b.folder), { version: 1 }, 'deciding writes nothing');
  await startNewBook(b.folder);
  assert.equal(await service.startsOnOpen(b.folder), true, 'a book made under this set-up');
  const { remote, remoteId } = await service.connect();
  assert.deepEqual(await remoteBooks(remote), [], 'nothing went up for any of them');
  // Another set-up (another backend, or sync turned off and on again) starts neither.
  const first = setup;
  setup = randomUUID();
  assert.equal(await service.startsOnOpen(b.folder), false);
  setup = first;
  // Its first sync replaces the mark, and it is not started again.
  await edit(b, caption('shore', 'First save'));
  assert.equal((await syncWith(b, service)).action, 'initial-push');
  assert.equal((await readSyncState(b.folder)).startWith, undefined);
  assert.deepEqual(await pendingUploads(b.folder, remote), [], 'its originals went up after the commit');
  assert.equal(await service.startsOnOpen(b.folder), false);
  // Turned on (the switch in the Sync window): it starts at its next open when its first sync did not happen at once.
  await on(a, () => service.start(a.folder));
  assert.deepEqual(await readSyncState(a.folder), { version: 1, remoteId, enabled: true });
  assert.equal(await service.startsOnOpen(a.folder), true);
  // Turned off again before it synced: it does not.
  await service.stop(a.folder);
  assert.equal(await service.startsOnOpen(a.folder), false);
  // A copy does what its book does: one of a book that syncs starts with the same remote, one of a book that does not stays.
  const copies = { syncing: join(b.base, 'Syncing.imageflow'), stopped: join(a.base, 'Stopped.imageflow'), off: join(b.base, 'Off.imageflow'), moved: join(a.base, 'Moved.imageflow') };
  await on(b, (book) => saveDocumentCopy(book, copies.syncing, false));
  assert.equal(await service.startsOnOpen(copies.syncing), true);
  await on(a, (book) => saveDocumentCopy(book, copies.stopped, false));
  assert.equal(await service.startsOnOpen(copies.stopped), false);
  assert.equal((await readSyncState(copies.stopped)).remoteId, undefined);
  // Made while sync is off, a copy of a book that synced is a book that was there before.
  setup = undefined;
  await on(b, (book) => saveDocumentCopy(book, copies.off, false));
  setup = first;
  assert.equal(await service.startsOnOpen(copies.off), false);
  // Moved to another volume, a book keeps its answer.
  await on(a, (book) => saveDocumentCopy(book, copies.moved, false, undefined, true));
  assert.equal((await readSyncState(copies.moved)).enabled, false);
  assert.equal((await remoteBooks(remote)).length, 1, 'only the book made under the set-up went up');
});

core('the sample, template previews, read-only opens and untrusted books never start by themselves; Start Syncing trusts an untrusted book once', async (t) => {
  const { root, a } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const setup = randomUUID();
  const service = new SyncService(() => backend, { setup: () => setup });
  await use(a);
  await updateSyncState(a.folder, (state) => ({ ...state, startWith: setup }));
  assert.equal(await bookTrusted(a.folder), false);
  assert.equal(await service.startsOnOpen(a.folder), false, 'an untrusted book');
  await trustBook(a.folder);
  assert.equal(await service.startsOnOpen(a.folder, { excluded: true }), false, 'the sample book or a template preview book');
  assert.equal(await service.startsOnOpen(a.folder, { readOnly: true }), false, 'a read-only open');
  assert.equal(await service.startsOnOpen(a.folder), true);
  const { remote } = await service.connect();
  assert.deepEqual(await remoteBooks(remote), [], 'nothing went up for any of them');
  // Start Syncing on an untrusted book asks to trust it first; agreeing trusts it and it syncs.
  await distrustBook(a.folder);
  await updateSyncState(a.folder, () => ({ version: 1 }));
  await assert.rejects(on(a, () => service.start(a.folder)), UntrustedBookError);
  assert.deepEqual(await readSyncState(a.folder), { version: 1 }, 'refusing wrote nothing');
  await on(a, () => service.start(a.folder, { trust: true }));
  assert.equal(await bookTrusted(a.folder), true);
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  assert.equal((await syncWith(a, service)).action, 'initial-push');
  // Stop Trusting This Book's Template… also stops syncing it on this Mac; the remote is left as it is.
  const [tip] = await tips(remote, a);
  await service.distrust(a.folder);
  assert.equal(await bookTrusted(a.folder), false);
  assert.equal((await readSyncState(a.folder)).enabled, false);
  assert.equal((await service.standing(a.folder)).sync, 'stopped');
  assert.equal(await service.startsOnOpen(a.folder), false);
  assert.deepEqual((await tips(remote, a)).map(({ commitId }) => commitId), [tip.commitId]);
  // The trust is local: another Mac keeps the book trusted and syncing (its own registry, untouched here).
});

core('an installation from before the Sync window goes on syncing exactly what it synced, and one that never answered which books sync starts nothing', async (t) => {
  const { root, a } = await world(t);
  await use(a);
  const backend = await folderBackend(root, 'Sync');
  const settingsFile = join(root, 'settings.json');
  const book = async (name: string, trust = true) => {
    const folder = join(a.base, name + '.imageflow');
    await copySample(resolve('sample/starter'), folder);
    if (trust) await trustBook(folder);
    return folder;
  };
  const store = new SettingsStore(settingsFile);
  const service = new SyncService(() => store.value.sync, { setup: () => store.value.syncSetup, booksUnchosen: () => !!store.value.syncBooksUnchosen });
  const { remoteId } = await new SyncService(() => backend).connect();
  // What such an installation holds: a book that syncs, one chosen and not opened since (no record), one left out, one
  // that synced with another remote, an untrusted one, and a trusted one that was never among the recent books.
  const synced = { commitId: randomUUID(), bookStateRevision: 'a'.repeat(64), stateDigest: 'b'.repeat(64), photoDigests: {} };
  const make = async (answered: string) => {
    const books = { syncing: await book(answered + ' Syncing'), chosen: await book(answered + ' Chosen'), left: await book(answered + ' Left'), elsewhere: await book(answered + ' Elsewhere'),
      untrusted: await book(answered + ' Untrusted', false), unseen: await book(answered + ' Unseen') };
    await updateSyncState(books.syncing, () => ({ version: 1, remoteId, enabled: true, lastSynced: synced }));
    await updateSyncState(books.left, () => ({ version: 1, remoteId, enabled: false }));
    await updateSyncState(books.elsewhere, () => ({ version: 1, remoteId: randomUUID(), enabled: true, lastSynced: synced }));
    return books;
  };
  const recent = ({ unseen: _, ...books }: Awaited<ReturnType<typeof make>>) => Object.values(books);
  const standing = async (folder: string) => [await service.startsOnOpen(folder), (await service.standing(folder)).sync];

  // Answered: the same books sync, and the one chosen starts at its next open. Nothing else does.
  const answered = await make('Answered');
  await store.update({ sync: backend });
  const before = await Promise.all(Object.values(answered).map((folder) => readSyncState(folder)));
  await settleSyncSetup(store, recent(answered));
  const setup = store.value.syncSetup;
  assert.ok(setup);
  assert.deepEqual(await standing(answered.syncing), [false, 'syncing'], 'it goes on syncing');
  assert.deepEqual(await standing(answered.chosen), [true, 'off'], 'chosen: it starts when it opens');
  assert.deepEqual(await standing(answered.left), [false, 'stopped']);
  assert.deepEqual(await standing(answered.elsewhere), [false, 'elsewhere'], 'it is asked about, as before');
  assert.deepEqual(await standing(answered.untrusted), [false, 'off']);
  assert.deepEqual(await standing(answered.unseen), [false, 'off'], 'a book that was never turned on does not start when it opens');
  const after = await Promise.all(Object.values(answered).map((folder) => readSyncState(folder)));
  assert.deepEqual(after, before.map((state, index) => (index === 1 ? { ...state, startWith: setup } : state)), 'only the chosen book is marked');
  // Settled once: a launch later changes nothing, also for a book made recent since.
  await settleSyncSetup(store, Object.values(answered));
  assert.equal(store.value.syncSetup, setup);
  assert.equal((await readSyncState(answered.unseen)).startWith, undefined);
  // A key changed keeps the set-up; another backend begins one, under which the chosen book no longer starts.
  assert.deepEqual(syncSetupPatch(backend, { ...backend }), {});
  await store.update({ sync: backend, ...syncSetupPatch({ kind: 'icloud' }, backend) });
  assert.notEqual(store.value.syncSetup, setup);
  assert.equal(await service.startsOnOpen(answered.chosen), false);

  // Never answered: until it is settled nothing syncs by itself, and then nothing starts, also not the book that synced
  // with this remote before; it keeps what it last synced, so turning it on continues its history.
  await writeFile(settingsFile, JSON.stringify({ sync: backend, syncBooksUnchosen: true }));
  await store.load();
  await store.update({ syncSetup: null });
  const unanswered = await make('Unanswered');
  assert.equal(service.booksUnchosen, true);
  for (const folder of Object.values(unanswered)) assert.equal(await service.startsOnOpen(folder), false);
  // A record that cannot be written leaves the question as it is, for the next launch.
  await assert.rejects(settleSyncSetup(store, [join(a.base, 'Gone.imageflow')]));
  assert.equal(store.value.syncBooksUnchosen, true);
  await settleSyncSetup(store, recent(unanswered));
  assert.equal(store.value.syncBooksUnchosen, undefined);
  assert.ok(store.value.syncSetup);
  for (const [name, folder] of Object.entries(unanswered)) {
    assert.equal(await service.startsOnOpen(folder), false, name);
    assert.notEqual((await service.standing(folder)).sync, 'syncing', name);
  }
  const kept = await readSyncState(unanswered.syncing);
  assert.deepEqual([kept.enabled, kept.remoteId, kept.lastSynced], [false, remoteId, synced]);
  assert.deepEqual(await remoteBooks((await service.connect()).remote), [], 'nothing was uploaded');
  // Kept over a restart, gone with sync.
  const restarted = new SettingsStore(settingsFile);
  await restarted.load();
  assert.equal(restarted.value.syncSetup, store.value.syncSetup);
  await restarted.update({ sync: null });
  assert.deepEqual([restarted.value.syncSetup, restarted.value.syncBooksUnchosen], [undefined, undefined]);
  // Without a backend there is nothing to settle, and a window sets neither.
  await settleSyncSetup(restarted, recent(answered));
  assert.equal(restarted.value.syncSetup, undefined);
  for (const patch of [{ syncBooksUnchosen: null }, { syncSetup: randomUUID() }]) assert.match(syncPatchError(patch)!, /Settings → Sync/);
});

core('a book turned on while it is closed syncs without being opened, and lets go of the book when it is', async (t) => {
  const { root, a } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  await use(a);
  const events: string[] = [];
  let holding = 0, wait: Promise<void> | undefined;
  const closed = new ClosedBookSyncs({ service, lock: acquireProjectLock, device: 'Desk', changed: () => { events.push(JSON.stringify(closed.state(a.folder) ?? null)); }, synced: (folder) => { events.push('synced ' + folder); },
    hold: async (folder) => {
      const release = await acquireProjectLock(folder);
      holding++;
      await wait;
      return { book: await loadProject(folder, a.cache), close: async () => { holding--; await AssetFacts.release(folder); await SourceStore.drain(); await release(); } };
    } });
  const settled = async () => { for (let attempt = 0; closed.state(a.folder)?.syncing && attempt < 2000; attempt++) await new Promise((resolve) => setTimeout(resolve, 10)); };
  // Untrusted: refused before anything is written; trusting it is the caller's question.
  await assert.rejects(closed.start(a.folder), UntrustedBookError);
  assert.deepEqual(await readSyncState(a.folder), { version: 1 });
  assert.equal(closed.state(a.folder), undefined);
  await closed.start(a.folder, { trust: true });
  assert.equal(closed.state(a.folder)?.syncing, true, 'it syncs in the background');
  await settled();
  const { remote } = await service.connect();
  assert.equal((await tips(remote, a)).length, 1);
  assert.equal(holding, 0);
  assert.ok(events.includes('synced ' + a.folder) && events.some((event) => event.includes('sending')), 'what it sends is shown');
  await service.upload(a.folder);
  assert.deepEqual(await pendingUploads(a.folder, remote), [], 'its originals follow');
  // Opening the book ends a sync that runs, which lets go of the lock first; its record stays, so the open book goes on.
  await service.stop(a.folder);
  await edit(a, caption('shore', 'While off'));
  let release = () => {};
  wait = new Promise((resolve) => { release = resolve; });
  await closed.start(a.folder);
  for (let attempt = 0; !holding && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const stopped = closed.stop(a.folder);
  release();
  await stopped;
  assert.equal(holding, 0);
  assert.equal(closed.state(a.folder), undefined, 'being opened is no failure');
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  assert.equal((await tips(remote, a)).length, 1, 'nothing was committed');
  wait = undefined;
  assert.equal((await syncWith(a, service)).action, 'push');
  // A failure is kept for the window until the book is opened or turned on again.
  await service.stop(a.folder);
  const failing = new ClosedBookSyncs({ service, lock: acquireProjectLock, hold: async () => { throw new Error('This book cannot be read.'); }, changed: () => {} });
  await failing.start(a.folder);
  for (let attempt = 0; failing.state(a.folder)?.syncing && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(failing.state(a.folder)?.failed?.message, 'This book cannot be read.');
  await failing.stop(a.folder);
  assert.equal(failing.state(a.folder), undefined);
  // After Quit nothing starts.
  await closed.shutdown();
  await closed.start(a.folder);
  assert.equal(closed.state(a.folder), undefined);
});

test('Stop Syncing and Start Syncing again continue the same history', async (t) => {
  const { root, a } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  await ownBook(a);
  await syncWith(a, service);
  const { remote } = await service.connect();
  const [first] = await tips(remote, a);
  await service.stop(a.folder);
  assert.equal((await service.standing(a.folder)).sync, 'stopped');
  assert.equal(await service.startsOnOpen(a.folder), false);
  await edit(a, caption('shore', 'While stopped'));
  await on(a, () => service.start(a.folder));
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  const pushed = await syncWith(a, service);
  assert.equal(pushed.action, 'push');
  assert.deepEqual((await commit(remote, a, pushed.pushed[0])).parents, [first.commitId], 'the same history');
});

coreEach('a push interrupted after its commit: the other Mac pulls and shows previews, its originals read as still uploading, and the first Mac resumes after a restart and a pull', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  // The desktop copies a photo into the book and syncs; it quits before the original has gone up.
  const photo = join(a.external, 'harbour.jpg');
  await image(photo, '#225588');
  const id = await on(a, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo])).imported[0]);
  assert.equal((await commitOnly(a, remote)).action, 'push');
  const digest = sha(await readFile(photo));
  const [tip] = await tips(remote, a);
  const state = await stateOf(remote, tip);
  assert.deepEqual(state.originals[id], { digest, ext: '.jpg' }, 'the commit names the original');
  assert.equal(await remote.hasBlob(originalBlobKey(tip.bookId, digest, '.jpg')), false, 'which is not on the remote yet');
  assert.ok(state.proxies[digest], 'its preview is');
  // The laptop pulls: a preview, and an original still uploading, which is no sync error.
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  await on(b, async (book) => {
    assert.equal(book.sources!['photo:' + id].state, 'missing');
    assert.equal(book.photos.get(id)!.original, await proxyFile(b, digest));
  });
  const status = await describeSync(b.folder, remote);
  assert.equal(status.state, 'in-sync');
  assert.equal(status.pendingOriginals, 1);
  assert.equal(status.notUploaded, 1);
  let away = -1;
  assert.deepEqual(await stageOriginals({ remote, folder: b.folder, notUploaded: (count) => { away = count; } }), []);
  assert.equal(away, 1);
  await on(b, async (book) => assert.deepEqual(await downloadOriginals({ remote, book }), []));
  const kept = await on(b, (book) => syncBook({ remote, book, fetchOriginals: true }));
  assert.deepEqual(kept.originals, { downloaded: [], notUploaded: 1 });
  // The laptop pushes a caption, and the desktop pulls it before it uploads again.
  await edit(b, caption('shore', 'From the laptop'));
  assert.equal((await sync(b, remote)).action, 'push');
  assert.equal((await commitOnly(a, remote)).action, 'fast-forward');
  // After the restart the desktop derives what is still to upload, from the snapshot it pulled, and uploads it.
  assert.deepEqual((await pendingUploads(a.folder, remote)).map(({ id: pending }) => pending), [id]);
  const resumed = await uploadAll(a, remote);
  assert.deepEqual({ uploaded: resumed.uploaded, left: resumed.left }, { uploaded: 1, left: 0 });
  assert.deepEqual(await pendingUploads(a.folder, remote), []);
  // The laptop now downloads it.
  assert.equal((await describeSync(b.folder, remote)).notUploaded, undefined);
  await on(b, async (book) => assert.deepEqual(await downloadOriginals({ remote, book }), [id]));
  assert.equal(sha(await readFile(join(b.folder, (await manifests(b)).photos[id].path))), digest);
});

each('an original deleted from the remote after it was uploaded goes up again at the next sync of a Mac that has it', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  const shore = (await stateOf(remote, tip)).originals.shore;
  const key = originalBlobKey(tip.bookId, shore.digest, shore.ext);
  assert.ok(await remote.hasBlob(key));
  await remove(remote, key);
  assert.deepEqual((await pendingUploads(a.folder, remote)).map(({ key: pending }) => pending), [key]);
  assert.equal((await sync(a, remote)).action, 'in-sync', 'no commit for it');
  assert.equal(sha(await stored(remote, key)), shore.digest);
  assert.deepEqual((await tips(remote, a)).map(({ commitId }) => commitId), [tip.commitId]);
});

each('an original changed here after the commit named it never goes up under the old digest', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const photo = join(a.external, 'edited.jpg');
  await image(photo, '#557711');
  const id = await on(a, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo])).imported[0]);
  await commitOnly(a, remote);
  const [tip] = await tips(remote, a);
  const named = (await stateOf(remote, tip)).originals[id];
  // Edited in place after the writer lock was released, before the background upload.
  await image(join(a.folder, (await manifests(a)).photos[id].path), '#aa0000');
  const outcome = await uploadAll(a, remote);
  assert.equal(outcome.changed, 1);
  assert.equal(await remote.hasBlob(originalBlobKey(tip.bookId, named.digest, named.ext)), false);
  // The next sync names the new version, and it goes up.
  assert.equal((await sync(a, remote)).action, 'push');
  const [next] = await tips(remote, a);
  const now = (await stateOf(remote, next)).originals[id];
  assert.notEqual(now.digest, named.digest);
  assert.equal(sha(await stored(remote, originalBlobKey(next.bookId, now.digest, now.ext))), now.digest);
});

test('a snapshot from before originals went up after the commit, which left one out, is read, and the next sync names it', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  // What #294 wrote when iCloud was full: the snapshot leaves the original out.
  await forge(remote, tip, (next) => { delete next.originals.shore; });
  const pulled = await sync(a, remote);
  assert.equal(pulled.action, 'fast-forward', 'the snapshot is read');
  assert.equal(pulled.pushed.length, 1, 'and a commit names the original');
  const [next] = await tips(remote, a);
  assert.ok((await stateOf(remote, next)).originals.shore);
  assert.equal((await sync(a, remote)).action, 'in-sync');
});

test('an Apple ID change between the commit and the upload of its originals uploads nothing to the other account', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native });
  await ownBook(a);
  assert.equal((await on(a, (book) => service.sync({ book }))).action, 'initial-push');
  const first = await service.connect();
  const pending = (await pendingUploads(a.folder, first.remote)).length;
  assert.ok(pending > 1);
  // Another Apple ID signs in after the commit: the upload asks the service for the remote, which is the other
  // account's database, and stops before anything goes up.
  native.signIn('_user-two');
  const stopped = await service.upload(a.folder);
  assert.deepEqual({ uploaded: stopped?.uploaded, stopped: stopped?.stopped }, { uploaded: 0, stopped: 'elsewhere' });
  const other = await service.connect();
  assert.notEqual(other.remoteId, first.remoteId);
  assert.deepEqual((await (other.remote as Remote).store.list('books/')).map(({ key }) => key), [], 'the other account got nothing');
  // Back to the first: the upload resumes. Then the account changes after the first original went up: the next
  // photo asks the service again and stops there.
  native.signIn('_user-one');
  const switched = await uploadOriginals({ folder: a.folder, connect: () => service.connect(a.folder),
    progress: (done) => { if (done === 1) native.signIn('_user-two'); } });
  assert.equal(switched.uploaded, 1);
  assert.equal(switched.stopped, 'elsewhere');
  assert.equal(switched.left, pending - 1);
  assert.deepEqual((await ((await service.connect()).remote as Remote).store.list('books/')).map(({ key }) => key), [], 'still nothing in the other account');
  native.signIn('_user-one');
  assert.equal((await service.upload(a.folder))?.uploaded, pending - 1);
  assert.deepEqual(await pendingUploads(a.folder, (await service.connect()).remote), []);
});

test('background uploads: one at a time per book, Stop Syncing cancels one cleanly, Quit lists what is left, and an upload clone left by a crash is swept', async (t) => {
  const { root, a } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  await ownBook(a);
  for (let index = 0; index < 3; index++) {
    const photo = join(a.external, 'photo-' + index + '.jpg');
    await image(photo, ['#112233', '#445566', '#778899'][index]);
    await on(a, (book) => importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo]));
  }
  await on(a, (book) => service.sync({ book }));
  const { remote } = await service.connect();
  const pending = (await pendingUploads(a.folder, remote)).length;
  assert.ok(pending >= 4);
  // A clone an upload left beside an original when the app crashed: the writer lock does not sweep photos/.
  const clone = join(a.folder, 'photos', '.imageflow-upload-' + crypto.randomUUID() + '.tmp');
  await writeFile(clone, 'left by a crash');
  const changes: string[] = [];
  service.onUploads((folder) => changes.push(folder));
  const running = service.upload(a.folder);
  const again = service.upload(a.folder);
  assert.deepEqual(service.pendingUploads().map(({ folder }) => folder), [a.folder], 'Quit names the book while it uploads');
  await service.stop(a.folder);
  const cancelled = await running;
  assert.equal(await again, cancelled, 'a second request joins the one running');
  assert.ok(!cancelled || cancelled.stopped === 'cancelled' || cancelled.stopped === 'elsewhere' || cancelled.left === 0);
  assert.deepEqual(service.pendingUploads(), []);
  assert.ok(changes.includes(a.folder), 'the status bar is told');
  assert.equal(await lstat(clone).catch(() => undefined), undefined, 'the crash’s clone is gone');
  // Nothing half-written is on the remote: every original there has its digest.
  for (const { key } of await remote.listBook(await bookId(a), 'originals')) assert.equal(sha(await stored(remote as Remote, key)), /originals\/([0-9a-f]{64})/.exec(key)![1]);
  // Stopped: no traffic. Started again: the rest goes up.
  assert.equal((await service.upload(a.folder))?.uploaded ?? 0, 0);
  await on(a, () => service.start(a.folder));
  await service.upload(a.folder);
  assert.deepEqual(await pendingUploads(a.folder, remote), []);
  await service.cancelUploads();
});

test('a push of an unchanged book over a bucket sends no request per file', async (t) => {
  const { root, a } = await world(t);
  const { fake, backend } = await bucketWorld(t, root);
  const credentials = new MemoryCredentialStore();
  await credentials.write(credentialScope(backend), fakeCredentials);
  const service = new SyncService(() => backend, { credentials: () => credentials, cacheFolder: () => join(root, 'Support'), s3: { retryDelay: 1 } });
  await ownBook(a);
  await syncWith(a, service);
  const previous = (await readSyncState(a.folder)).lastSynced!.stateDigest;
  // A caption changes the book's state blob and nothing else: its content files, previews and originals are there.
  await edit(a, caption('shore', 'Only a caption'));
  fake.requests.length = 0;
  assert.equal((await syncWith(a, service)).action, 'push');
  const next = (await readSyncState(a.folder)).lastSynced!.stateDigest;
  const perFile = fake.requests.filter(({ method, key }) => (method === 'HEAD' || method === 'GET' || method === 'PUT') &&
    /\/(content|proxies|originals)\//.test(key) && !key.endsWith('/' + previous) && !key.endsWith('/' + next));
  assert.deepEqual(perFile.map(({ method, key }) => method + ' ' + key), []);
  assert.ok(fake.requests.length < 15, fake.requests.length + ' requests: ' + fake.requests.map(({ method, key, query }) => method + ' ' + key + '?' + query).join(', '));
});

test('a failed background upload is kept with what is left until an upload ends without, and an untrusted book uploads nothing by itself', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native });
  await ownBook(a);
  await on(a, (book) => service.sync({ book }));
  const { remote } = await service.connect();
  const pending = (await pendingUploads(a.folder, remote)).length;
  assert.ok(pending > 0);
  // A request iCloud refuses: the upload fails, and the status keeps how many of this Mac's originals are not uploaded.
  native.fail('putIfAbsent', 'serverRejectedRequest', { times: Infinity, name: (name) => name.startsWith('originals/') });
  await assert.rejects(service.upload(a.folder));
  const failed = service.uploadState(a.folder).failed;
  assert.equal(failed?.left, pending);
  assert.match(failed?.message ?? '', /iCloud reported an error/);
  native.recover();
  assert.equal((await service.upload(a.folder))?.uploaded, pending);
  assert.deepEqual(service.uploadState(a.folder), {}, 'an upload that ends without any left clears it');
  // A book that syncs but is not trusted (one made by Open Synced Book, or one that synced before it was trusted here)
  // uploads nothing by itself.
  await edit(a, caption('shore', 'Before distrust'));
  const photo = join(a.external, 'late.jpg');
  await image(photo, '#123456');
  await on(a, (book) => importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo]));
  await on(a, (book) => service.sync({ book }));
  await distrustBook(a.folder);
  const left = (await pendingUploads(a.folder, remote)).length;
  assert.ok(left > 0);
  assert.equal(await service.upload(a.folder), undefined);
  assert.equal((await pendingUploads(a.folder, remote)).length, left);
});

test('a sync over iCloud asks the change feed once and lists nothing besides; over a bucket one listing answers every blob', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native, keyIndex: new MemoryKeyIndexCache() });
  await syncWith(a, service);
  await service.connect();
  native.calls.length = 0;
  assert.equal((await on(a, (book) => service.sync({ book }))).action, 'in-sync');
  assert.equal(native.calls.filter((call) => call === 'changes').length, 1, 'an unchanged book: one feed request, ' + native.calls.join(', '));
  await edit(a, caption('shore', 'A caption'));
  native.calls.length = 0;
  assert.equal((await on(a, (book) => service.sync({ book }))).action, 'push');
  assert.equal(native.calls.filter((call) => call === 'changes').length, 1, 'a push: one feed request, ' + native.calls.join(', '));
  // The tombstone is answered from the key index the feed just brought up to date: no request of its own, in a sync
  // and in a status refresh; a deleted book is still refused.
  const fetched: string[] = [];
  const fetch = native.fetch.bind(native);
  native.fetch = (zone, name, options) => { fetched.push(name); return fetch(zone, name, options); };
  assert.equal((await on(a, (book) => service.sync({ book }))).action, 'in-sync');
  const { remote } = await service.connect();
  assert.equal((await describeSync(a.folder, remote)).state, 'in-sync');
  assert.deepEqual(fetched.filter((name) => name.endsWith('deleted.json')), [], 'no tombstone request: ' + fetched.join(', '));
  await remote.deleteBook(await bookId(a));
  await assert.rejects(on(a, (book) => service.sync({ book })), { name: 'BookDeletedError' });
  assert.equal((await describeSync(a.folder, remote)).state, 'removed');
});

// Second review of #282.

coreEach('a pull keeps this Mac’s original until the remote has the one that replaces it, pushes nothing back, and replaces it once it has arrived', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const before = sha(await readFile(join(b.folder, 'photos/shore.jpg')));
  // The desktop replaces the photo's file and syncs, then sleeps before its background upload.
  await image(join(a.folder, 'photos/shore.jpg'), '#aa3300', 160, 100);
  const replaced = sha(await readFile(join(a.folder, 'photos/shore.jpg')));
  assert.equal((await commitOnly(a, remote)).action, 'push');
  const [tip] = await tips(remote, a);
  assert.equal((await stateOf(remote, tip)).originals.shore.digest, replaced);
  assert.equal(await remote.hasBlob(originalBlobKey(tip.bookId, replaced, '.jpg')), false);
  // The laptop pulls: its file stays, as the only copy of the photo besides the remote's old one.
  const pulled = await sync(b, remote);
  assert.equal(pulled.action, 'fast-forward');
  assert.deepEqual(pulled.pushed, [], 'nothing is pushed back');
  assert.equal(sha(await readFile(join(b.folder, 'photos/shore.jpg'))), before, 'the old file stays');
  assert.equal((await describeSync(b.folder, remote)).state, 'in-sync');
  // The book draws the photo from the new version's preview, not from the kept file, and says why, in the editor and in
  // an export's load alike, so output never shows the old image in the new crop (#283).
  for (const pinned of [false, true]) {
    const book = await on(b, (book) => (pinned ? loadProject(b.folder, b.cache, false, true) : Promise.resolve(book)));
    const photo = book.photos.get('shore')!;
    assert.notEqual(photo.original, join(b.folder, 'photos/shore.jpg'));
    assert.equal(photo.original, await proxyFile(b, replaced), 'the render data names the new preview');
    assert.deepEqual([photo.width, photo.height], [160, 100], 'laid out at the new version’s size');
    const status = book.sources!['photo:shore'];
    assert.equal(status.problem, 'Original still uploading from another Mac');
    assert.equal(printProblem(status), 'Original still uploading from another Mac', 'print warns as for any original that is not here');
  }
  assert.equal((await readAssetFacts(b.folder)).shore.digest, replaced, 'the fact stays the new version’s');
  assert.deepEqual((await pendingUploads(b.folder, remote)).map(({ id }) => id), [], 'it is not uploaded as the laptop’s own');
  // An edit on the laptop syncs without carrying its old original as a change made there.
  await edit(b, caption('segla', 'From the laptop'));
  const pushed = await sync(b, remote);
  assert.equal(pushed.action, 'push');
  const [next] = await tips(remote, b);
  const state = await stateOf(remote, next);
  assert.equal(state.originals.shore.digest, replaced);
  assert.equal(state.assetsMeta.assets.shore.digest, replaced, 'the snapshot keeps the desktop’s version');
  assert.equal((await sync(b, remote)).action, 'in-sync');
  // Once the desktop has uploaded it, the laptop's next sync replaces the old file, and then nothing changes.
  await commitOnly(a, remote);
  await uploadAll(a, remote);
  assert.equal((await sync(b, remote)).action, 'in-sync');
  assert.equal(sha(await readFile(join(b.folder, 'photos/shore.jpg'))), replaced);
  assert.equal((await sync(b, remote)).action, 'in-sync');
  assert.equal((await tips(remote, b)).length, 1);
  // Replaced: the book reads the file again.
  const book = await on(b, async (book) => book);
  assert.equal(book.photos.get('shore')!.original.startsWith(join(b.folder, 'photos')) || book.sources!['photo:shore'].state === 'available', true);
  assert.equal(book.sources!['photo:shore'].problem, undefined);
});

core('the sample books and template preview books are excluded by where they lie', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-excluded-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sample = join(root, 'Resources', 'sample');
  const cache = join(root, 'Cache');
  await mkdir(join(sample, 'starter'), { recursive: true });
  await mkdir(join(cache, 'template-preview-1'), { recursive: true });
  await mkdir(join(root, 'Books', 'Mine.imageflow'), { recursive: true });
  await mkdir(join(root, 'Resources', 'sample-like'), { recursive: true });
  assert.equal(await syncExcludedBook(join(sample, 'starter'), [sample, cache]), true);
  assert.equal(await syncExcludedBook(join(cache, 'template-preview-1'), [sample, cache]), true);
  assert.equal(await syncExcludedBook(join(root, 'Books', 'Mine.imageflow'), [sample, cache]), false);
  assert.equal(await syncExcludedBook(join(root, 'Resources', 'sample-like'), [sample + '/', cache]), false, 'a sibling whose name starts the same is not inside');
  assert.equal(await syncExcludedBook(join(root, 'Books', 'Mine.imageflow'), [undefined]), false);
});

test('a first sync by itself that failed is tried again after the next save, and still not while an earlier version’s question is to be settled', async (t) => {
  const { root, a } = await world(t);
  const path = join(root, 'Later');
  let unchosen = false;
  const setup = randomUUID();
  const service = new SyncService(() => ({ kind: 'folder', path }), { setup: () => setup, booksUnchosen: () => unchosen });
  await ownBook(a);
  await updateSyncState(a.folder, (state) => ({ ...state, startWith: setup }));
  let synced = 0;
  const first = new FirstSync(async () => {
    if (!await service.startsOnOpen(a.folder)) return;
    await syncWith(a, service);
    synced++;
  }, 10, () => {});
  // The sync folder is not there when the book opens: nothing synced, and it waits for a save.
  await assert.rejects(first.run());
  assert.equal(first.waiting, true);
  await mkdir(path);
  first.saved();
  for (let attempt = 0; first.waiting && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  await first.run();
  assert.equal(synced, 1, 'the save started it');
  assert.equal((await service.standing(a.folder)).sync, 'syncing');
  // A save after it worked starts nothing again.
  first.saved();
  assert.equal(first.waiting, false);
  // Until an earlier version's question which books sync is settled, the retry starts nothing.
  const b: Mac = { ...a, folder: join(a.base, 'Second.imageflow') };
  await copySample(resolve('sample/starter'), b.folder);
  await trustBook(b.folder);
  await updateSyncState(b.folder, (state) => ({ ...state, startWith: setup }));
  unchosen = true;
  let started = false;
  const second = new FirstSync(async () => { if (await service.startsOnOpen(b.folder)) started = true; }, 10, () => {});
  await second.run();
  second.saved();
  assert.equal(started, false);
  // A save made while an attempt runs (the edit that interrupted an automatic first sync) is the save a failure waits for.
  let attempts = 0;
  let fail = (_: Error) => {};
  const third = new FirstSync(() => { attempts++; return attempts === 1 ? new Promise<void>((_, reject) => { fail = reject; }) : Promise.resolve(); }, 10, () => {});
  const running = third.run();
  third.saved();
  fail(new Error('interrupted'));
  await assert.rejects(running);
  for (let attempt = 0; attempts < 2 && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(attempts, 2, 'tried again without another save');
  first.stop(); second.stop(); third.stop();
});

test('Quit names the books whose originals are still uploading, and an upload that fails before it could read the remote still shows', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  let backend: SyncBackend = { kind: 'icloud' };
  const service = new SyncService(() => backend, { cloudKit: () => native });
  await ownBook(a);
  await on(a, (book) => service.sync({ book }));
  assert.equal(pendingUploadsText([], () => ''), undefined);
  assert.equal(pendingUploadsText([{ folder: a.folder, left: 0 }], () => ''), undefined);
  const running = service.upload(a.folder);
  const listed = service.pendingUploads();
  assert.deepEqual(listed.map(({ folder }) => folder), [a.folder]);
  assert.match(pendingUploadsText([{ folder: a.folder, left: 3 }], () => 'Book') ?? '', /^“Book”: 3 originals\n\nThe books themselves have synced/);
  await running;
  // The remote cannot be read when the upload starts: what is left is not known, and the status says so without a count.
  native.fail('changes', 'serverRejectedRequest', { times: Infinity });
  await edit(a, caption('shore', 'Again'));
  await assert.rejects(service.upload(a.folder));
  const failed = service.uploadState(a.folder).failed;
  assert.ok(failed && failed.left === undefined, JSON.stringify(failed));
  native.recover();
  // Another backend: what the former left says nothing about it.
  backend = { kind: 'folder', path: join(a.base, 'Elsewhere') };
  assert.equal(service.configured, true);
  assert.deepEqual(service.uploadState(a.folder), {});
});

test('one listing per sync over a bucket answers its commits, its blobs and its originals, and is gone after it', async (t) => {
  const { root, a } = await world(t);
  const { fake, backend } = await bucketWorld(t, root);
  const credentials = new MemoryCredentialStore();
  await credentials.write(credentialScope(backend), fakeCredentials);
  const service = new SyncService(() => backend, { credentials: () => credentials, cacheFolder: () => join(root, 'Support'), s3: { retryDelay: 1 } });
  await ownBook(a);
  await syncWith(a, service);
  await service.connect();
  const lists = () => fake.requests.filter(({ method, query }) => method === 'GET' && query.has('list-type')).length;
  fake.requests.length = 0;
  assert.equal((await on(a, (book) => service.sync({ book, fetchOriginals: true }))).action, 'in-sync');
  assert.equal(lists(), 1, 'an unchanged book: one listing, ' + fake.requests.map(({ method, key, query }) => method + ' ' + key + '?' + query).join(', '));
  const tombstoneRequests = () => fake.requests.filter(({ key }) => key.endsWith('/deleted.json')).length;
  assert.equal(tombstoneRequests(), 0, 'the listing answers whether the book was deleted');
  // A status refresh: one listing of the book's commits alone (not of the whole book), and no request for its tombstone
  // or marker: the book has commits, and a sync reads the tombstone from its listing before it pushes.
  fake.requests.length = 0;
  assert.equal((await describeSync(a.folder, (await service.connect()).remote)).state, 'in-sync');
  const listings = fake.requests.filter(({ method, query }) => method === 'GET' && query.has('list-type'));
  assert.equal(listings.length, 1, 'a status refresh: one listing, ' + fake.requests.map(({ method, key, query }) => method + ' ' + key + '?' + query).join(', '));
  assert.match(listings[0].query.get('prefix') ?? '', /\/snapshots\/$/, 'of the commits only');
  assert.equal(fake.requests.filter(({ key }) => key.endsWith('/deleted.json') || key.includes('deleted/')).length, 0);
  // A book that kept no older original reads its state once, not again to look for one.
  fake.requests.length = 0;
  assert.equal((await on(a, (book) => service.sync({ book }))).action, 'in-sync');
  assert.equal(fake.requests.filter(({ method, key, query }) => method === 'GET' && !query.has('list-type') && key.includes('/content/')).length, 1,
    'the state blob is read once: ' + fake.requests.map(({ method, key }) => method + ' ' + key).join(', '));
  await edit(a, caption('shore', 'A caption'));
  fake.requests.length = 0;
  assert.equal((await on(a, (book) => service.sync({ book, fetchOriginals: true }))).action, 'push');
  assert.equal(lists(), 1, 'a push: one listing');
  // Outside a sync, a listing asks the bucket again.
  fake.requests.length = 0;
  await (await service.connect()).remote.listBook(await bookId(a), 'originals');
  assert.equal(lists(), 1);
  // A deleted book: the sync's listing has its tombstone, and the sync is refused; so is the status.
  const { remote } = await service.connect();
  await remote.deleteBook(await bookId(a));
  await assert.rejects(on(a, (book) => service.sync({ book })), { name: 'BookDeletedError' });
  assert.equal((await describeSync(a.folder, remote)).state, 'removed');
  assert.deepEqual((await uploadAll(a, remote)).stopped, 'deleted');
});

// The library (#283): covers, Download, Delete from Sync and its tombstone on the other Macs.

const jpeg = (color: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer().then((bytes) => new Uint8Array(bytes));

each('a push records the cached cover, uploads it once, and carries the parent’s forward when there is none or it is unchanged', async (t) => {
  const { a, remote } = await world(t);
  const red = await jpeg('#aa0000');
  await sync(a, remote, { cover: async () => red });
  const [first] = await tips(remote, a);
  assert.equal(first.coverDigest, sha(red));
  assert.deepEqual(await remote.getBlob(coverBlobKey(first.bookId, sha(red))), red);
  // No cover here now (not made yet, or not readable), or one that is not a whole JPEG: the parent's is carried forward.
  for (const cover of [async () => undefined, async () => new Uint8Array([1, 2, 3]), async () => { throw new Error('unreadable'); }]) {
    await edit(a, caption('shore', 'Edit ' + Math.random()));
    await sync(a, remote, { cover });
    assert.equal((await tips(remote, a))[0].coverDigest, sha(red));
  }
  // The same cover again uploads nothing; a new one replaces it in the header, and the old blob stays for Clean Up.
  await edit(a, caption('shore', 'Same cover'));
  await sync(a, remote, { cover: async () => red });
  assert.equal((await tips(remote, a))[0].coverDigest, sha(red));
  const blue = await jpeg('#0000aa');
  await edit(a, caption('shore', 'New cover'));
  await sync(a, remote, { cover: async () => blue });
  assert.equal((await tips(remote, a))[0].coverDigest, sha(blue));
  assert.deepEqual((await remote.listBook(first.bookId, 'covers')).map(({ key }) => key).sort(), [coverBlobKey(first.bookId, sha(red)), coverBlobKey(first.bookId, sha(blue))].sort());
});

coreEach('Download counts the files and previews it brings, and one that is cancelled leaves nothing behind', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  await use(b);
  const folder = join(b.base, 'Books');
  await mkdir(folder);
  const destination = join(folder, 'Book.imageflow');
  const remoteId = await remote.remoteId();
  const counts = async (stopAt?: number) => {
    const seen: [number, number][] = [];
    const job = new AbortController();
    const made = cloneFromRemote({ remote, tip, destination, remoteId, signal: job.signal, progress: (done, total) => {
      seen.push([done, total]);
      if (done === stopAt) job.abort(new Error('cancelled'));
    } });
    return { seen, made };
  };
  const state = await stateOf(remote, tip);
  const files = Object.keys(state.content).length;
  // Cancelled before anything, in the middle of its files, and at the last preview, when everything has arrived.
  for (const stopAt of [0, 2, files + 1]) {
    const { seen, made } = await counts(stopAt);
    await assert.rejects(made, /cancelled/);
    assert.deepEqual(await readdir(folder), [], 'neither the book nor its staging folder after ' + stopAt);
    assert.equal(seen.at(-1)![0], stopAt, 'nothing was fetched after the cancel');
    assert.equal(await bookTrusted(destination).catch(() => false), false);
  }
  // A transfer that runs when the download is cancelled stops, with the signal it was given.
  const job = new AbortController();
  const signals: (AbortSignal | undefined)[] = [];
  const stalled = new Proxy(remote, { get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver) as unknown;
    if (name === 'getBlob') return (key: string, options?: { signal?: AbortSignal }) => { signals.push(options?.signal); return target.getBlob(key, options); };
    if (name === 'downloadBlob') return (_key: string, _file: string, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
      signals.push(options?.signal);
      options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      job.abort(new Error('stopped'));
    });
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(cloneFromRemote({ remote: stalled, tip, destination, remoteId, signal: job.signal }), /stopped/);
  assert.ok(signals.length >= 2 && signals.every((signal) => signal === job.signal), 'the state blob and the files are given the signal');
  assert.deepEqual(await readdir(folder), []);
  // Not cancelled: every file and preview is counted once, and the total is known from the start.
  const { seen, made } = await counts();
  await made;
  const total = seen[0][1];
  assert.ok(total > files, 'previews count too');
  assert.deepEqual(seen, Array.from({ length: total + 1 }, (_, done) => [done, total]));
});

test('downloads run one at a time, are cancelled before or during their turn, and end with the app', async () => {
  let changes = 0;
  const downloads = new BookDownloads(() => { changes++; }, 0);
  const ends = new Map<string, () => void>();
  const download = (id: string) => downloads.start(id, ({ signal, progress }) => new Promise<string>((resolve, reject) => {
    progress(1, 4);
    ends.set(id, () => resolve(id));
    signal.addEventListener('abort', () => reject(new Error('the transfer stopped')), { once: true });
  }));
  const first = download('a'), second = download('b'), third = download('c');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(downloads.list(), [{ bookId: 'a', done: 1, total: 4 }, { bookId: 'b', waiting: true }, { bookId: 'c', waiting: true }]);
  assert.equal(await download('a'), undefined, 'one that runs is not started again');
  // Waiting: cancelled at once, while the first goes on.
  await downloads.cancel('b');
  assert.equal(await second, undefined);
  assert.deepEqual(downloads.list().map(({ bookId }) => bookId), ['a', 'c']);
  ends.get('a')!();
  assert.equal(await first, 'a');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(downloads.list(), [{ bookId: 'c', done: 1, total: 4 }]);
  // Running: a cancel is no failure, and a real failure is.
  await downloads.cancel('c');
  assert.equal(await third, undefined);
  await assert.rejects(downloads.start('d', async () => { throw new Error('offline'); }), /offline/);
  // Quit cancels what runs and starts nothing more.
  const last = download('e');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await downloads.shutdown();
  assert.equal(await last, undefined);
  assert.equal(await download('f'), undefined);
  assert.deepEqual(downloads.list(), []);
  assert.ok(changes > 8, 'the windows are told');
});

coreEach('Download makes the book under the chosen name, never over a book or file that is there, trusted, with its originals left on the remote', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  await use(b);
  const folder = join(b.base, 'Books');
  await mkdir(join(folder, 'Book.imageflow'), { recursive: true });
  await writeFile(join(folder, 'Book 2.imageflow'), 'a file, not a book');
  const remoteId = await remote.remoteId();
  // A name that is taken is refused before anything is downloaded, also after the panel's own Replace question (#303).
  for (const name of ['Book.imageflow', 'Book 2.imageflow']) {
    await assert.rejects(cloneFromRemote({ remote, tip, destination: join(folder, name), remoteId }), { message: 'A book named “' + name + '” already exists there. Choose another name.' });
  }
  assert.deepEqual((await readdir(folder)).sort(), ['Book 2.imageflow', 'Book.imageflow'], 'nothing is left behind');
  const made = await cloneFromRemote({ remote, tip, destination: join(folder, downloadName('Book 3')), remoteId });
  assert.equal(made, join(await realpath(folder), 'Book 3.imageflow'));
  assert.deepEqual(await readdir(join(folder, 'Book.imageflow')), [], 'the book that was there is untouched');
  assert.equal(await readFile(join(folder, 'Book 2.imageflow'), 'utf8'), 'a file, not a book');
  assert.equal(await bookTrusted(made), true, 'a downloaded book arrives trusted (ADR 0012, section 2)');
  assert.equal((await readSyncState(made)).remoteId, remoteId);
  // Its owned originals stay on the remote until downloaded (Keep originals downloads them after it opens); Delete from
  // Sync counts them from the book's own files.
  const mac: Mac = { ...b, folder: made };
  assert.ok((await pendingOriginals(made, remote)).length > 0);
  assert.equal(await originalsAway(made), (await pendingOriginals(made, remote)).length);
  assert.ok((await on(mac, (book) => downloadOriginals({ remote, book }))).length > 0);
  assert.deepEqual(await pendingOriginals(made, remote), []);
  assert.equal(await originalsAway(made), 0);
  // A title becomes a name Finder takes.
  assert.equal(downloadName('  ../Trip: 2026/11 '), 'Trip- 2026-11');
  assert.equal(downloadName('...'), 'Untitled');
  assert.equal(downloadName('x'.repeat(300)).length, 100);
});

coreEach('Delete from Sync on one Mac: the other Mac’s sync pushes nothing, its upload stops, and it keeps the book here only or syncs it again as a new book', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const id = await bookId(a);
  const before = await commitCount(remote);
  // The laptop replaces an original and commits, then the desktop deletes the book while that upload is still to come.
  await image(join(b.folder, 'photos/shore.jpg'), '#0044aa', 150, 100);
  await commitOnly(b, remote);
  const commits = await commitCount(remote);
  assert.equal(commits, before + 1);
  const tombstone = await remote.deleteBook(id);
  assert.deepEqual((await remote.listBooks()).find((book) => book.bookId === id)?.deleted, tombstone);
  assert.deepEqual((await uploadAll(b, remote)).stopped, 'deleted', 'the upload uploads nothing for a deleted book');
  assert.deepEqual((await remote.listBook(id)).map(({ key }) => key), [tombstoneKey(id)]);
  // Its sync pushes nothing, also after an edit, and the status says it was removed.
  await edit(b, caption('shore', 'After the delete'));
  await assert.rejects(commitOnly(b, remote), (error: Error & { code?: string }) => error.name === 'BookDeletedError' && error.code === 'SYNC_DELETED');
  assert.deepEqual((await remote.listBook(id)).map(({ key }) => key), [tombstoneKey(id)], 'nothing was pushed back');
  assert.equal((await describeSync(b.folder, remote)).state, 'removed');
  // Download refuses it too.
  await assert.rejects(cloneFromRemote({ remote, tip: (await stateOfTip(remote, a, id))!, destination: join(b.base, 'Again') }), { name: 'BookDeletedError' });
  // Sync Again on the closed book: a new lineage and a fresh history; the old book stays deleted.
  const remoteId = await remote.remoteId();
  const release = await acquireProjectLock(b.folder);
  let fresh: string;
  try { fresh = (await newBookHistory(b.folder, remoteId)).bookId; } finally { await release(); }
  assert.notEqual(fresh, id);
  assert.equal(await bookId(b), fresh);
  assert.equal((await readSyncState(b.folder)).lastSynced, undefined);
  assert.equal((await sync(b, remote)).action, 'initial-push');
  assert.equal((await manifests(b)).photos.shore.caption, 'After the delete');
  assert.deepEqual((await remote.listBooks()).map(({ bookId, deleted }) => [bookId, !!deleted]).sort(), [[fresh, false], [id, true]].sort());
  // Sync Again on the open book, through the session that holds it: the same.
  await sync(a, remote).catch(() => undefined);
  const again = (await on(a, () => newBookHistory(a.folder, remoteId))).bookId;
  assert.ok(again !== id && again !== fresh);
  assert.equal((await sync(a, remote)).action, 'initial-push');
  // Outside the writer lock it is refused.
  await assert.rejects(newBookHistory(a.folder, remoteId), /Open the book for editing/);
});

/** A commit of a book as it was before it was deleted, for a Mac that still names it. */
async function stateOfTip(remote: Remote, mac: Mac, id: string) {
  const record = (await readSyncState(mac.folder)).lastSynced;
  return record && { version: 2 as const, commitId: record.commitId, bookId: id, parents: [], bookStateRevision: record.bookStateRevision,
    createdAt: new Date().toISOString(), title: 'Book', stateDigest: record.stateDigest };
}

test('Delete from Sync through the service, while a background upload runs: the upload stops, the copies here stop syncing, nothing comes back, and Keep Here Only stays local', async (t) => {
  const { root, a, b } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  await ownBook(a);
  for (let index = 0; index < 3; index++) {
    const photo = join(a.external, 'photo-' + index + '.jpg');
    await image(photo, ['#112233', '#445566', '#778899'][index]);
    await on(a, (book) => importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo]));
  }
  await on(a, (book) => service.sync({ book }));
  const { remote } = await service.connect();
  const id = await bookId(a);
  assert.ok((await pendingUploads(a.folder, remote)).length >= 4);
  const running = service.upload(a.folder);
  let settled = false;
  await service.deleteBook(id, { folders: [a.folder], settle: async () => { settled = true; } });
  assert.ok(settled, 'a running sync of the book is waited for');
  const outcome = await running;
  assert.ok(!outcome || outcome.stopped || outcome.left === 0);
  assert.deepEqual(service.pendingUploads(), []);
  assert.equal((await readSyncState(a.folder)).enabled, false, 'the copy here stops syncing');
  assert.deepEqual((await remote.listBook(id)).map(({ key }) => key), [tombstoneKey(id)], 'nothing the upload had under way came back');
  assert.ok(await lstat(join(a.folder, 'project.json')), 'the copy on this Mac stays');
  // A later upload or Start Syncing of it pushes nothing.
  assert.equal((await service.upload(a.folder))?.uploaded ?? 0, 0);
  await on(a, () => service.start(a.folder));
  await assert.rejects(on(a, (book) => service.sync({ book })), { name: 'BookDeletedError' });
  // On the other Mac: Keep Here Only is Stop Syncing, local to it.
  await use(b);
  await copyBook(a, b);
  await service.stop(b.folder);
  assert.equal((await service.standing(b.folder)).sync, 'stopped');
  assert.deepEqual((await remote.listBook(id)).map(({ key }) => key), [tombstoneKey(id)]);
  // Sync Again through the service: a new book on the remote.
  const { bookId: fresh } = await on(b, () => service.syncAgain(b.folder, { trust: true }));
  assert.equal((await syncWith(b, service)).action, 'initial-push');
  assert.ok((await remote.listBooks()).some((book) => book.bookId === fresh && !book.deleted));
});

each('an original a commit named a week ago that never arrived is reported as never uploaded from the Mac that named it, and the record is carried forward', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const photo = join(a.external, 'harbour.jpg');
  await image(photo, '#225588');
  await on(a, (book) => importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo]));
  // The desktop commits on a day eight days ago and is never heard from again.
  const named = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await commitOnly(a, remote, { now: () => named, device: 'Desktop' });
  const [tip] = await tips(remote, a);
  const [id] = Object.entries((await stateOf(remote, tip)).named ?? {}).filter(([, entry]) => entry.by === 'Desktop').map(([id]) => id);
  assert.ok(id);
  assert.equal((await stateOf(remote, tip)).named![id].at, named.toISOString());
  await sync(b, remote);
  const away = await originalsNotHere(b.folder, remote);
  assert.ok(away.notUploaded.includes(id));
  assert.deepEqual(away.neverUploaded, [{ id, namedAt: named.toISOString(), by: 'Desktop' }]);
  assert.match((await describeSync(b.folder, remote)).neverUploaded ?? '', /^1 original was never uploaded from “Desktop”\./);
  // Within the week it is still uploading.
  assert.equal((await originalsNotHere(b.folder, remote, new Date(named.getTime() + 24 * 60 * 60 * 1000))).neverUploaded, undefined);
  // The laptop's next push carries when and where it was named.
  await edit(b, caption('shore', 'From the laptop'));
  await sync(b, remote, { device: 'Laptop' });
  const [next] = await tips(remote, b);
  assert.deepEqual((await stateOf(remote, next)).named![id], (await stateOf(remote, tip)).named![id]);
});

each('a deletion that stops after its marker reads as not deleted, one that stops after its commits or its tombstone pushes nothing, and deleting again finishes each', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const id = await bookId(a);
  const record = new TextEncoder().encode(JSON.stringify({ version: 1, bookId: id, deletedAt: '2026-11-23T10:00:00.000Z' }));
  // Stopped after the marker: the book is not deleted, and syncs as before.
  await remote.store.putIfAbsent(deletedMarkerKey(id), record);
  assert.deepEqual((await remote.listBooks()).find((book) => book.bookId === id), { bookId: id });
  await edit(a, caption('shore', 'Still syncing'));
  assert.equal((await sync(a, remote)).action, 'push');
  // Stopped after its commits went: a marker and no commits read as deleted, on this Mac and for a Finder duplicate
  // without a sync record, which would otherwise push the book back; the status says so too.
  const snapshots = (await remote.store.list('books/' + id + '/snapshots/')).map(({ key }) => key);
  await remote.store.delete(snapshots);
  await edit(a, caption('shore', 'After the commits went'));
  await assert.rejects(commitOnly(a, remote), { name: 'BookDeletedError' });
  assert.equal((await describeSync(a.folder, remote)).state, 'removed');
  const { b: duplicate } = await world(t);
  await copyBook(a, duplicate);
  await assert.rejects(commitOnly(duplicate, remote), { name: 'BookDeletedError' });
  assert.equal(await commitCount(remote), 0);
  // Stopped after the tombstone (its marker is there): the book reads as deleted, and nothing is pushed.
  await remote.store.putIfAbsent(tombstoneKey(id), record);
  assert.ok((await remote.listBooks()).find((book) => book.bookId === id)?.deleted);
  await assert.rejects(commitOnly(a, remote), { name: 'BookDeletedError' });
  assert.equal(await commitCount(remote), 0);
  // Deleting again finishes it, keeping the first tombstone.
  const tombstone = await remote.deleteBook(id, new Date('2027-01-01T00:00:00.000Z'));
  assert.equal(tombstone.deletedAt, '2026-11-23T10:00:00.000Z');
  assert.deepEqual((await remote.listBook(id)).map(({ key }) => key), [tombstoneKey(id)]);
  // A deletion that stopped after its marker alone is finished the same way.
  const { b } = await world(t);
  await copySample(resolve('sample/starter'), b.folder);
  await sync(b, remote);
  const other = await bookId(b);
  await remote.store.putIfAbsent(deletedMarkerKey(other), new TextEncoder().encode(JSON.stringify({ version: 1, bookId: other, deletedAt: '2026-11-23T10:00:00.000Z' })));
  await remote.deleteBook(other);
  assert.deepEqual((await remote.listBook(other)).map(({ key }) => key), [tombstoneKey(other)]);
  assert.ok((await remote.listBooks()).find((book) => book.bookId === other)?.deleted);
});

test('the actions on a missing photo leave a kept older original on disk, and Replace counts as this Mac’s own change', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const kept = join(b.folder, 'photos/shore.jpg');
  const before = sha(await readFile(kept));
  await image(join(a.folder, 'photos/shore.jpg'), '#aa3300', 160, 100);
  await commitOnly(a, remote);
  await sync(b, remote);
  assert.equal(sha(await readFile(kept)), before);
  assert.equal(await originalsAway(b.folder), 1, 'Delete from Sync counts it as an original not on this Mac');
  // Nothing to locate: the status offers no repair, and Locate Folder and Copy into Book leave the file as it is.
  await on(b, async (book) => {
    assert.deepEqual(book.sources!['photo:shore'].repairs, []);
    const folder = join(b.base, 'Pictures');
    await mkdir(folder, { recursive: true });
    await image(join(folder, 'shore.jpg'), '#00ff00');
    assert.equal((await relinkFolder(book, folder)).repaired, 0);
    await collectSources(book);
  });
  assert.equal(sha(await readFile(kept)), before, 'Locate Folder and Copy into Book leave the kept file');
  // Replace with a file the user chooses: the photo is that file from now on, it pushes as a change made here, and the
  // kept file stays on disk.
  const chosen = join(b.external, 'chosen.jpg');
  await image(chosen, '#123456', 90, 60);
  await on(b, (book) => relocateSource(book, 'photo:shore', chosen));
  assert.equal(sha(await readFile(kept)), before, 'Replace leaves the kept file');
  const replaced = await on(b, async (book) => book);
  assert.equal(replaced.sources!['photo:shore'].state, 'available');
  assert.equal(replaced.sources!['photo:shore'].problem, undefined);
  assert.equal(replaced.photos.get('shore')!.width, 90);
  assert.equal((await sync(b, remote)).action, 'push');
  const [tip] = await tips(remote, b);
  assert.equal((await stateOf(remote, tip)).assetsMeta.assets.shore.digest, sha(await readFile(chosen)), 'the user’s choice is this Mac’s change');
  // Remove: the photo leaves the book, its files stay for Undo.
  await on(b, (book) => removeSources(book, ['photo:shore']));
  assert.equal(sha(await readFile(kept)), before, 'Remove leaves the kept file');
});

core('a folder store put that is cancelled leaves no folder it made behind', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-folder-cancel-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FolderStore(root);
  const job = new AbortController();
  job.abort(new Error('cancelled'));
  await store.putIfAbsent('books/a/content/kept', new Uint8Array([1]));
  await assert.rejects(store.putIfAbsent('books/a/originals/x.jpg', new Uint8Array([1, 2]), { sha256: 'f'.repeat(64) }));
  assert.deepEqual((await readdir(join(root, 'books', 'a'))).sort(), ['content'], 'the originals folder it made is gone');
  await assert.rejects(store.putIfAbsent('books/a/originals/y.jpg', new Uint8Array([1]), { signal: job.signal }));
  assert.deepEqual((await readdir(join(root, 'books', 'a'))).sort(), ['content']);
});

/** A store whose next `failures` writes fail, as offline. */
function failingWrites<Store extends SyncStore>(store: Store, failures: { count: number }) {
  const put = store.putIfAbsent.bind(store);
  store.putIfAbsent = async (...args) => { if (failures.count > 0) { failures.count--; throw new StoreAccessError('unavailable', 'The sync store cannot be reached.'); } return put(...args); };
  return store;
}

test('a Delete from Sync that fails on its first request deletes nothing: the copies here and on another Mac sync as before', async (t) => {
  const { root, a, b } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  await ownBook(a);
  await syncWith(a, service);
  const id = await bookId(a);
  const { remote } = await service.connect();
  const failures = { count: 1 };
  failingWrites((remote as StoreRemote).store, failures);
  await assert.rejects(service.deleteBook(id, { folders: [a.folder] }), (error: Error & { started?: boolean }) =>
    error.name === 'BookDeleteError' && error.started === false && /^Nothing was deleted/.test(error.message));
  assert.equal((await readSyncState(a.folder)).enabled, true, 'the copy here syncs again');
  assert.equal(await remote.deletionMarker(id), undefined);
  // This Mac pushes as before (the remote does not refuse the book), and so does another Mac.
  await edit(a, caption('shore', 'After the failed delete'));
  assert.equal((await syncWith(a, service)).action, 'push');
  await use(b);
  const laptop = new SyncService(() => ({ ...backend }));
  await copyBook(a, b);
  await edit(b, caption('shore', 'On the laptop'));
  assert.notEqual((await on(b, async (book) => { await trustBook(b.folder); return laptop.sync({ book }); })).action, undefined);
  assert.ok((await remoteTips(remote, id)).length >= 1);
  // One that fails after it changed the remote says so, and deleting again finishes it.
  failures.count = 0;
  const store = (remote as StoreRemote).store;
  const remove = store.delete.bind(store);
  let once = true;
  store.delete = async (keys) => { if (once) { once = false; throw new Error('offline'); } return remove(keys); };
  await assert.rejects(service.deleteBook(id, { folders: [a.folder] }), (error: Error & { started?: boolean }) => error.name === 'BookDeleteError' && error.started === true && /Delete it from sync again/.test(error.message));
  await service.deleteBook(id, { folders: [a.folder] });
  assert.deepEqual((await remote.listBook(id)).map(({ key }) => key), [tombstoneKey(id)]);
});

test('Sync Again on a book that is not deleted is refused and changes nothing; Delete from Sync refuses a book a newer ImageFlow synced', async (t) => {
  const { root, a } = await world(t);
  const backend = await folderBackend(root, 'Sync');
  const service = new SyncService(() => backend);
  await ownBook(a);
  await syncWith(a, service);
  const id = await bookId(a);
  await assert.rejects(on(a, () => service.syncAgain(a.folder)), { name: 'BookNotDeletedError' });
  assert.equal(await bookId(a), id);
  assert.ok((await readSyncState(a.folder)).lastSynced);
  // A newer ImageFlow's commit: this version does not delete the book.
  const { remote } = await service.connect();
  await putHeader(remote as StoreRemote, id, crypto.randomUUID(), { version: 3, commitId: crypto.randomUUID(), bookId: id });
  await assert.rejects(service.deleteBook(id, { folders: [a.folder] }), NewerSyncFormatError);
  assert.equal(await remote.deletionMarker(id), undefined);
  assert.equal((await readSyncState(a.folder)).enabled, true);
});

test('Sync Again of a book with a kept older original makes the file this Mac’s version of the photo, consistently', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const kept = sha(await readFile(join(b.folder, 'photos/shore.jpg')));
  await image(join(a.folder, 'photos/shore.jpg'), '#aa3300', 160, 100);
  await commitOnly(a, remote);
  await sync(b, remote);
  await remote.deleteBook(await bookId(a));
  const remoteId = await remote.remoteId();
  const { reverted } = await on(b, () => newBookHistory(b.folder, remoteId));
  assert.equal(reverted, 1);
  const book = await on(b, async (book) => book);
  assert.equal(book.photos.get('shore')!.original, join(b.folder, 'photos/shore.jpg'), 'the photo is its file again');
  assert.equal(book.sources!['photo:shore'].problem, undefined);
  await on(b, async () => { await AssetFacts.forBook(b.folder); });
  assert.equal((await sync(b, remote)).action, 'initial-push');
  const [tip] = await tips(remote, b);
  const state = await stateOf(remote, tip);
  assert.equal(state.assetsMeta.assets.shore.digest, kept, 'the new book has the file this Mac has');
  assert.equal(state.originals.shore.digest, kept);
});

core('a digest that arrives for a note taken before a pull does not put the old file’s fact back', async (t) => {
  const { a } = await world(t);
  await use(a);
  const release = await acquireProjectLock(a.folder);
  try {
    const facts = await AssetFacts.forBook(a.folder);
    const old = facts.get('shore')!;
    facts.note('shore', 'old-observation', { width: 1, height: 1 });
    await AssetFacts.adoptSynced(a.folder, { ...facts.all(), shore: { ...old, digest: 'e'.repeat(64), width: 160, height: 100 } });
    facts.digest('shore', 'old-observation', 'd'.repeat(64));
    assert.equal(facts.get('shore')!.digest, 'e'.repeat(64));
  } finally { await AssetFacts.release(a.folder); await release(); }
});

each('an original carried forward from a snapshot without a record of who named it is not named by a Mac that does not have it', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const [tip] = await tips(remote, a);
  const state = await stateOf(remote, tip);
  // A snapshot as written before the record existed, naming an original that is on no Mac here.
  const ghost = 'f'.repeat(64);
  const older: StateBlob = { ...state, named: undefined, originals: { ...state.originals, shore: { digest: ghost, ext: '.jpg' } }, assetsMeta: { ...state.assetsMeta,
    assets: { ...state.assetsMeta.assets, shore: { ...state.assetsMeta.assets.shore, digest: ghost } } } };
  delete (older as { named?: unknown }).named;
  const bytes = new TextEncoder().encode(canonicalJson(older));
  await remote.putBlob(contentBlobKey(tip.bookId, sha(bytes)), bytes);
  await remote.putCommit({ ...tip, commitId: crypto.randomUUID(), parents: [tip.commitId], stateDigest: sha(bytes), createdAt: new Date(Date.parse(tip.createdAt) + 1000).toISOString() });
  await sync(b, remote).catch(() => undefined);
  await edit(b, caption('segla', 'On the laptop'));
  await sync(b, remote, { device: 'Laptop' }).catch(() => undefined);
  const [next] = await tips(remote, b);
  assert.notEqual(next.stateDigest, sha(bytes), 'the laptop pushed');
  assert.equal((await stateOf(remote, next)).originals.shore?.digest, ghost, 'and carried the original forward');
  const named = (await stateOf(remote, next)).named ?? {};
  assert.notEqual(named.shore?.by, 'Laptop', 'the laptop does not have that file, so it does not name it');
});

// Automatic sync (#284): the engine's fast-forward-only and push-only modes, and the scheduler over the fake CloudKit.

core('an automatic sync applies only a fast-forward: a divergence with one tip or several, also by a race with another Mac, is left as it is', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  // Edit on one Mac, and the other fast-forwards by itself.
  await edit(a, caption('shore', 'From the desktop'));
  await sync(a, remote, { fastForwardOnly: true });
  const pulled = await sync(b, remote, { fastForwardOnly: true });
  assert.deepEqual([pulled.action, pulled.changed], ['fast-forward', true]);
  assert.equal((await manifests(b)).photos.shore.caption, 'From the desktop');
  // Both edit while offline: one remote tip, and this Mac's version differs. Nothing is copied, pulled or overwritten.
  await edit(a, caption('shore', 'Desktop, offline'));
  await sync(a, remote);
  await edit(b, caption('shore', 'Laptop, offline'));
  const siblings = async () => (await readdir(b.base)).filter((name) => name.endsWith('.imageflow'));
  for (const options of [{ fastForwardOnly: true }, { pushOnly: true }]) {
    const diverged = await sync(b, remote, options);
    assert.deepEqual([diverged.action, diverged.pulled, diverged.conflictCopy, diverged.pushed, diverged.changed], ['diverged', undefined, undefined, [], false]);
    assert.equal(diverged.tips?.length, 1);
  }
  assert.equal((await manifests(b)).photos.shore.caption, 'Laptop, offline', 'the open book is not overwritten');
  assert.deepEqual(await siblings(), ['Book.imageflow'], 'no conflict copy');
  assert.equal((await describeSync(b.folder, remote)).state, 'diverged');
  // Sync Now keeps both, as before, once the user asks.
  assert.ok((await sync(b, remote)).conflictCopy);
  assert.equal((await siblings()).length, 2);
  await sync(a, remote);
  // A race: another Mac commits between this Mac's listing and its commit. The push makes a second tip, and nothing
  // is merged or kept both; the next automatic sync on either Mac leaves the fork for the user.
  await edit(a, caption('shore', 'Desktop again'));
  let raced = false;
  const racing = new Proxy(remote, { get: (target, name, receiver) => (name !== 'putCommit' ? Reflect.get(target, name, receiver) : async (header: CommitHeader) => {
    if (!raced) { raced = true; await target.putCommit({ ...header, commitId: randomUUID(), bookStateRevision: 'e'.repeat(64) }); }
    return target.putCommit(header);
  }) });
  assert.equal((await sync(a, racing, { fastForwardOnly: true })).action, 'push');
  assert.equal((await tips(remote, a)).length, 2);
  for (const mac of [a, b]) {
    const forked = await sync(mac, remote, { fastForwardOnly: true });
    assert.deepEqual([forked.action, forked.pulled, forked.pushed.length, forked.tips?.length], ['diverged', undefined, 0, 2]);
  }
  assert.equal((await tips(remote, a)).length, 2, 'no commit closed the fork');
  assert.equal((await siblings()).length, 2, 'and no second copy');
});

test('a push that must not change the book defers a pull, and a bounded push stops at once when the remote does not answer', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await edit(a, caption('shore', 'Waiting for the editor'));
  await sync(a, remote);
  const before = await manifests(b);
  const deferred = await sync(b, remote, { pushOnly: true });
  assert.deepEqual([deferred.action, deferred.changed, deferred.pushed], ['deferred', false, []]);
  assert.deepEqual(await manifests(b), before);
  assert.equal((await sync(b, remote, { fastForwardOnly: true })).action, 'fast-forward', 'once nothing blocks it, it pulls');
  // A remote that never answers: the push gives up as soon as its bound is reached, and the book is unchanged.
  await edit(b, caption('shore', 'Closing'));
  const hanging = new Proxy(remote, { get: (target, name, receiver) => (name === 'listCommits' ? () => new Promise(() => {}) : Reflect.get(target, name, receiver)) });
  const job = new AbortController();
  setTimeout(() => job.abort(new Error('The book closed before it finished syncing.')), 50);
  const started = Date.now();
  await assert.rejects(sync(b, hanging, { pushOnly: true, signal: job.signal }), /closed before it finished/);
  assert.ok(Date.now() - started < 2000);
  assert.equal((await tips(remote, a))[0].bookStateRevision, (await readSyncState(b.folder)).lastSynced!.bookStateRevision, 'nothing was pushed');
  assert.equal((await sync(b, remote, { pushOnly: true })).action, 'push', 'the next sync pushes');
});

test('an automatic pull keeps an older original until its replacement is listed, and an automatic push never sends it back', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const old = sha(await readFile(join(b.folder, 'photos', 'shore.jpg')));
  // The desktop re-exports the owned photo and commits, and quits before its original has gone up.
  await image(join(a.folder, 'photos', 'shore.jpg'), '#ee0000', 200, 100);
  const replaced = sha(await readFile(join(a.folder, 'photos', 'shore.jpg')));
  assert.equal((await commitOnly(a, remote, { fastForwardOnly: true })).action, 'push');
  assert.equal((await commitOnly(b, remote, { fastForwardOnly: true })).action, 'fast-forward');
  assert.equal(sha(await readFile(join(b.folder, 'photos', 'shore.jpg'))), old, 'the laptop keeps its older original');
  // The laptop edits and pushes by itself: the snapshot keeps the desktop's version, and the old file is not uploaded.
  await edit(b, caption('shore', 'Laptop caption'));
  assert.equal((await commitOnly(b, remote, { pushOnly: true })).action, 'push');
  const [tip] = await tips(remote, a);
  const state = await stateOf(remote, tip);
  assert.equal(state.originals.shore.digest, replaced);
  assert.equal(state.assetsMeta.assets.shore.digest, replaced);
  assert.deepEqual(await pendingUploads(b.folder, remote), [], 'the older file is not to upload');
  assert.equal(sha(await readFile(join(b.folder, 'photos', 'shore.jpg'))), old);
});

test('a full remote pauses the upload of originals for automatic syncs: the same original is not tried again at every idle', async (t) => {
  const { a } = await world(t);
  const native = new FakeCloudKit();
  const service = new SyncService(() => ({ kind: 'icloud' }), { cloudKit: () => native });
  native.fail('putIfAbsent', 'quotaExceeded', { times: Infinity, name: (name) => name.startsWith('originals/') });
  await ownBook(a);
  await on(a, (book) => service.sync({ book }));
  let originals = 0;
  native.onCall = (op, _zone, record) => { if (op === 'putIfAbsent' && record?.startsWith('originals/')) originals++; };
  assert.ok((await service.upload(a.folder))?.full);
  assert.equal(originals, 1, 'the queue stops at the first original that does not fit');
  // Idle pushes: each commits the book, and none starts the paused upload again.
  for (const text of ['One', 'Two']) {
    await edit(a, caption('shore', text));
    assert.equal((await on(a, (book) => service.sync({ book, fastForwardOnly: true }))).action, 'push');
    assert.equal(await service.uploadAfterSync(a.folder, { automatic: true }), undefined);
  }
  assert.equal(originals, 1, 'no original was tried again');
  assert.ok(service.uploadState(a.folder).full, 'the status still says the remote is full');
  // Sync Now asks again.
  assert.ok((await service.uploadAfterSync(a.folder))?.full);
  assert.equal(originals, 2);
});

test('a push from iCloud fast-forwards the open book, and waits like a focus while an editor is open', async (t) => {
  const { a, b } = await world(t);
  const native = new FakeCloudKit();
  const remote = new StoreRemote(new CloudKitStore(native, { backoff: () => 0 }));
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await remote.subscribe();
  assert.deepEqual([...native.subscriptions], ['books'], 'one database subscription');
  let editorOpen = true;
  const auto = new AutoSync({
    allowed: async () => true,
    blocked: () => (editorOpen ? 'A text of the book is open in its editor.' : undefined),
    start: async () => {},
    look: async () => { await use(b); const { state } = await describeSync(b.folder, remote); return state === 'behind' ? 'pull' : state === 'ahead' ? 'push' : 'none'; },
    edited: async () => true,
    sync: async ({ pushOnly, signal }) => { const outcome = await commitOnly(b, remote, { fastForwardOnly: true, pushOnly, signal }); return outcome.action === 'deferred' ? 'deferred' : undefined; },
    failure: () => 'retry',
  }, { ...autoSyncTiming, notified: 1, gate: 10 });
  t.after(() => auto.close());
  await edit(a, caption('shore', 'Pushed from the desktop'));
  await sync(a, remote);
  // The push arrives while a Markdown editor of the book is open: the pull waits.
  auto.notified();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await auto.settled();
  assert.equal(auto.state.waitingForGate, true);
  assert.notEqual((await manifests(b)).photos.shore.caption, 'Pushed from the desktop');
  editorOpen = false;
  for (let attempt = 0; attempt < 100 && (await manifests(b)).photos.shore.caption !== 'Pushed from the desktop'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await auto.settled();
  }
  assert.equal((await manifests(b)).photos.shore.caption, 'Pushed from the desktop');
});

test('what an automatic look costs over a bucket: a status read is one listing of the commits, and a sync only when it shows something to do', async (t) => {
  const { root, a } = await world(t);
  const { fake, backend } = await bucketWorld(t, root);
  const credentials = new MemoryCredentialStore();
  await credentials.write(credentialScope(backend), fakeCredentials);
  const service = new SyncService(() => backend, { credentials: () => credentials, cacheFolder: () => join(root, 'Support'), s3: { retryDelay: 1 } });
  await ownBook(a);
  await syncWith(a, service);
  const { remote } = await service.connect();
  const described = (requests: typeof fake.requests) => requests.map(({ method, key, query }) => method + ' ' + key + (query.size ? '?' + query : '')).join(', ');
  // A focus with nothing to do: the status alone. The first read after the push takes what it has not seen yet.
  assert.equal((await describeSync(a.folder, remote)).state, 'in-sync');
  fake.requests.length = 0;
  assert.equal((await describeSync(a.folder, remote)).state, 'in-sync');
  assert.deepEqual(fake.requests.map(({ method }) => method), ['GET'], described(fake.requests));
  assert.match(fake.requests[0].query.get('prefix') ?? '', /\/snapshots\/$/, 'a listing of the commits');
  // A sync, which an automatic look starts only when the status shows something to do: one listing of the whole book.
  fake.requests.length = 0;
  assert.equal((await on(a, (book) => syncBook({ remote, book, fastForwardOnly: true }))).action, 'in-sync');
  assert.ok(fake.requests.length <= 3, described(fake.requests));
});

test('the pull gate is read again as a fast-forward is applied: an editor opened while the sync read the remote defers it, with nothing lost', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await edit(a, caption('shore', 'Opened an editor meanwhile'));
  await sync(a, remote);
  const before = await manifests(b);
  let asked = 0;
  const deferred = await sync(b, remote, { fastForwardOnly: true, beforeApply: () => { asked++; return false; } });
  assert.deepEqual([deferred.action, deferred.changed, asked], ['deferred', false, 1]);
  assert.deepEqual(await manifests(b), before, 'the book is as it was');
  assert.equal((await readSyncState(b.folder)).pull, undefined, 'and no pull is marked');
  assert.equal((await describeSync(b.folder, remote)).state, 'behind');
  const applied = await sync(b, remote, { fastForwardOnly: true, beforeApply: () => true });
  assert.equal(applied.action, 'fast-forward');
  assert.equal((await manifests(b)).photos.shore.caption, 'Opened an editor meanwhile');
});

core('an edit during an automatic push stops it and is kept; one during a pull being applied waits for it', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const runs = new AutomaticRuns();
  // A push that takes a while at the remote, as the edit comes in: stopped before its commit.
  const slowAt = (method: string) => {
    let started!: () => void;
    const reached = new Promise<void>((resolve) => { started = resolve; });
    const slowed = new Proxy(remote, { get: (target, name, receiver) => (name !== method ? Reflect.get(target, name, receiver)
      : async (...args: unknown[]) => { started(); await new Promise((resolve) => setTimeout(resolve, 300));
        return (Reflect.get(target, name, receiver) as (...values: unknown[]) => unknown).apply(target, args); }) });
    return { slowed, reached };
  };
  let holding = true;
  const automaticPush = (via: SyncRemote) => {
    const begun = runs.begin();
    holding = true;
    return commitOnly(b, via, { pushOnly: true, signal: begun.run.job.signal, beforeApply: () => begun.mayApply(() => false) })
      .finally(() => { holding = false; begun.end(); });
  };
  await edit(b, caption('shore', 'First edit'));
  const atBlob = slowAt('putBlob');
  const pushing = automaticPush(atBlob.slowed);
  await atBlob.reached;
  assert.equal(await runs.yieldTo(() => holding), true);
  await assert.rejects(pushing, SyncInterruptedError);
  const tipBefore = (await tips(remote, a))[0].commitId;
  // The edit goes ahead and is kept; the next push sends both.
  await edit(b, caption('segla', 'Second edit, during the push'));
  assert.equal((await manifests(b)).photos.segla.caption, 'Second edit, during the push');
  // An edit that comes while the commit is being sent waits for it: the commit is recorded, and nothing forks.
  const atCommit = slowAt('putCommit');
  const committing = automaticPush(atCommit.slowed);
  await atCommit.reached;
  assert.equal(await runs.yieldTo(() => holding), true);
  assert.equal((await committing).action, 'push');
  await edit(b, caption('segla', 'Third edit, during the commit'));
  assert.equal((await sync(b, remote, { pushOnly: true })).action, 'push');
  const after = await tips(remote, a);
  assert.equal(after.length, 1, 'no fork of this Mac’s own making');
  assert.notEqual(after[0].commitId, tipBefore);
  await sync(a, remote, { fastForwardOnly: true });
  assert.deepEqual([(await manifests(a)).photos.shore.caption, (await manifests(a)).photos.segla.caption], ['First edit', 'Third edit, during the commit']);
  // A pull that began to be applied finishes; the edit waits and then finds the pulled book.
  await edit(a, caption('shore', 'Pulled while editing'));
  await sync(a, remote);
  const pull = runs.begin();
  holding = true;
  let applying!: () => void;
  const applyingNow = new Promise<void>((resolve) => { applying = resolve; });
  const pulling = commitOnly(b, remote, { fastForwardOnly: true, signal: pull.run.job.signal,
    beforeApply: () => { const may = pull.mayApply(() => false); applying(); return may; } }).finally(() => { holding = false; pull.end(); });
  await applyingNow;
  assert.equal(await runs.yieldTo(() => holding), true);
  assert.equal((await pulling).action, 'fast-forward');
  assert.equal(pull.run.job.signal.aborted, false);
  assert.equal((await manifests(b)).photos.shore.caption, 'Pulled while editing');
});

// Storage figures, Clean Up, and Duplicate without uploading again (#285).

const later = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
/** Records the keys a store is asked to put, so a test can tell an upload from a copy inside the store. */
function recordPuts(remote: Remote) {
  const puts: string[] = [];
  const put = remote.store.putIfAbsent.bind(remote.store);
  remote.store.putIfAbsent = (key, source, options) => { puts.push(key); return put(key, source, options); };
  return puts;
}
async function importPhoto(mac: Mac, name: string, color: string) {
  const photo = join(mac.external, name);
  await image(photo, color);
  const id = await on(mac, async (book) => (await importIntoProject(book, { kind: 'photo', mode: 'copy' }, [photo])).imported[0]);
  return { id, digest: sha(await readFile(photo)) };
}

coreEach('Clean Up: an unused original, preview and cover go after the grace period; what a tip names, content and commits stay', async (t) => {
  const { a, remote } = await world(t);
  const red = await jpeg('#aa0000');
  await sync(a, remote, { cover: async () => red });
  const harbour = await importPhoto(a, 'harbour.jpg', '#225588');
  await sync(a, remote, { cover: async () => red });
  const [named] = await tips(remote, a);
  const book = named.bookId;
  const original = originalBlobKey(book, harbour.digest, '.jpg');
  const preview = proxyBlobKey(book, harbour.digest, (await stateOf(remote, named)).proxies[harbour.digest].ext);
  assert.ok(await remote.hasBlob(original) && await remote.hasBlob(preview));
  // The photo is removed and a new cover made: the photo's original and preview and the old cover are used by no tip.
  await on(a, (opened) => removeSources(opened, ['photo:' + harbour.id]));
  const blue = await jpeg('#0000aa');
  await sync(a, remote, { cover: async () => blue });
  const unused = [original, preview, coverBlobKey(book, sha(red))].sort();
  // Inside the grace period nothing goes: a Mac in the middle of a push uploads blobs before its commit.
  assert.deepEqual((await planCleanUp(remote)).books, []);
  const plan = await planCleanUp(remote, later(8));
  assert.deepEqual(plan.books.map(({ bookId, blobs }) => [bookId, blobs.map(({ key }) => key).sort()]), [[book, unused]]);
  assert.equal(plan.bytes, plan.books[0].blobs.reduce((sum, { size }) => sum + size, 0));
  // A second tip that still names the photo keeps it (a fork another Mac made before the removal).
  const fork: CommitHeader = { ...named, commitId: randomUUID() };
  await remote.putCommit(fork);
  assert.equal((await tips(remote, a)).length, 2);
  assert.deepEqual((await planCleanUp(remote, later(8))).books, [], 'the fork names the photo and the old cover');
  await remove(remote, commitKey(book, fork.commitId));
  const freed = await cleanUp(remote, await planCleanUp(remote, later(8)), later(8));
  assert.deepEqual(freed, { bytes: plan.bytes, objects: 3 });
  for (const key of unused) assert.equal(await remote.hasBlob(key), false, key);
  // What a tip names stays, and so does every commit and everything under content/ (also the state blob of the commit
  // that named the photo, which a three-way merge may need).
  const [tip] = await tips(remote, a);
  const state = await stateOf(remote, tip);
  for (const { digest, ext } of Object.values(state.originals)) assert.ok(await remote.hasBlob(originalBlobKey(book, digest, ext)));
  for (const [digest, { ext }] of Object.entries(state.proxies)) assert.ok(await remote.hasBlob(proxyBlobKey(book, digest, ext)));
  assert.ok(await remote.hasBlob(coverBlobKey(book, sha(blue))));
  assert.ok(await remote.hasBlob(contentBlobKey(book, named.stateDigest)));
  assert.equal(await commitCount(remote), 3);
  assert.deepEqual((await planCleanUp(remote, later(8))).books, [], 'nothing is left to clean up');
  assert.equal((await sync(a, remote)).action, 'in-sync');
});

each('Clean Up reads the tips again before it deletes: a photo added again meanwhile keeps its original and preview, and one lost anyway goes up again', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const first = await importPhoto(a, 'harbour.jpg', '#225588');
  await sync(a, remote);
  const book = await bookId(a);
  const original = originalBlobKey(book, first.digest, '.jpg');
  await on(a, (opened) => removeSources(opened, ['photo:' + first.id]));
  await sync(a, remote);
  const plan = await planCleanUp(remote, later(8));
  assert.ok(plan.books[0].blobs.some(({ key }) => key === original));
  // Added again from the same file while the sweep is between its plan and its deletion: the push finds the old blobs
  // and reuses them, which does not renew their time, and its commit names them.
  const again = await importPhoto(a, 'harbour again.jpg', '#225588');
  assert.equal(again.digest, first.digest);
  await sync(a, remote);
  assert.deepEqual(await cleanUp(remote, plan, later(8)), { bytes: 0, objects: 0 });
  assert.ok(await remote.hasBlob(original));
  const [tip] = await tips(remote, a);
  const preview = proxyBlobKey(book, first.digest, (await stateOf(remote, tip)).proxies[first.digest].ext);
  assert.ok(await remote.hasBlob(preview));
  // Lost in the window that remains (here: deleted behind the sweep's back): the Mac that has the original uploads it
  // again at its next sync, also over iCloud, whose key index forgot what Clean Up deleted.
  await remote.deleteBlobs([original]);
  assert.equal(await remote.hasBlob(original), false, 'the key index does not answer for a blob that is gone');
  assert.equal((await sync(a, remote)).action, 'in-sync');
  assert.equal(sha(await stored(remote, original)), first.digest);
  await assert.rejects(remote.deleteBlobs([contentBlobKey(book, tip.stateDigest)]), /only originals, previews and covers/);
});

each('Clean Up empties what is left of a book deleted from sync down to its tombstone', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const book = await bookId(a);
  await remote.deleteBook(book);
  // A push that raced the deletion left a preview and a commit behind (written through the store alone).
  const left = proxyBlobKey(book, 'e'.repeat(64), '.jpg');
  await remote.store.putIfAbsent(left, await jpeg('#00aa00'));
  await remote.store.putIfAbsent(commitKey(book, randomUUID()), new TextEncoder().encode('{}'));
  const plan = await planCleanUp(remote);
  assert.deepEqual(plan.books.map(({ bookId, deleted, blobs }) => [bookId, deleted, blobs.length]), [[book, true, 2]], 'no grace period for a deleted book');
  assert.equal((await cleanUp(remote, plan)).objects, 2);
  assert.deepEqual((await remote.store.list(bookPrefix(book))).map(({ key }) => key).filter((key) => key !== tombstoneKey(book)), []);
  assert.ok(await remote.bookTombstone(book, { fresh: true }), 'the tombstone stays');
  await assert.rejects(remote.deleteRemains(randomUUID()), /deleted from sync/);
});

test('storage figures: what a book takes up, with the part that is originals, and what is left of a deleted one', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const book = await bookId(a);
  const listed = await remote.store.list(bookPrefix(book));
  const originals = listed.filter(({ key }) => key.includes('/originals/')).reduce((sum, { size }) => sum + size, 0);
  const total = listed.reduce((sum, { size }) => sum + size, 0);
  assert.ok(originals > 0 && originals < total);
  assert.deepEqual(await remote.usage(book), { bytes: total, originals });
  const other = randomUUID();
  await remote.store.putIfAbsent(proxyBlobKey(other, 'f'.repeat(64), '.jpg'), new Uint8Array(10));
  await remote.deleteBook(other);
  const left = await remote.usage(other);
  assert.ok(left.bytes > 0 && left.originals === 0);
});

coreEach('Duplicate of a synced book copies its originals inside the store at the copy’s first sync, and uploads none where it can', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const source = await bookId(a);
  const [sourceTip] = await tips(remote, a);
  const named = (await stateOf(remote, sourceTip)).originals;
  assert.ok(Object.keys(named).length > 0);
  const copy: Mac = { ...a, folder: join(a.base, 'Copy.imageflow') };
  await on(a, (book) => saveDocumentCopy(book, copy.folder, false));
  const hint = (await readSyncState(copy.folder)).copiedFrom!;
  assert.equal(hint.bookId, source);
  assert.deepEqual(hint.originals, named);
  const remoteId = await remote.remoteId();
  await updateSyncState(copy.folder, (state) => ({ ...state, remoteId }));
  const puts = recordPuts(remote);
  assert.equal((await sync(copy, remote)).action, 'initial-push');
  const copied = await bookId(copy);
  assert.notEqual(copied, source);
  for (const { digest, ext } of Object.values(named)) assert.equal(sha(await stored(remote, originalBlobKey(copied, digest, ext))), digest);
  // A store that copies inside itself uploads no original; iCloud, which cannot, uploads them from the files here.
  assert.deepEqual(puts.filter((key) => key.includes('/originals/')).length, remote.store.copy ? 0 : Object.keys(named).length);
  assert.deepEqual(await pendingUploads(copy.folder, remote), []);
  assert.equal((await readSyncState(copy.folder)).copiedFrom, undefined, 'the hint goes once every original it named is there');
  // A photo added to the copy later uploads as in any book, with no copy request to the book it was made from.
  const copies: string[] = [];
  const copyBlob = remote.copyBlob.bind(remote);
  remote.copyBlob = (from, to) => { copies.push(from); return copyBlob(from, to); };
  const added = await importPhoto(copy, 'added.jpg', '#884422');
  assert.equal((await sync(copy, remote)).action, 'push');
  assert.equal(sha(await stored(remote, originalBlobKey(copied, added.digest, '.jpg'))), added.digest);
  assert.deepEqual(copies, []);
});

each('Duplicate on a Mac that keeps only previews: the copy names the originals and gets them from the book it was copied from', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  const named = (await stateOf(remote, tip)).originals;
  await use(b);
  const remoteId = await remote.remoteId();
  const downloaded = await cloneFromRemote({ remote, tip, destination: b.folder, remoteId });
  const laptop: Mac = { ...b, folder: downloaded };
  assert.ok((await pendingOriginals(downloaded, remote)).length > 0, 'the laptop has previews only');
  const copy: Mac = { ...b, folder: join(b.base, 'Copy.imageflow') };
  await on(laptop, (book) => saveDocumentCopy(book, copy.folder, false));
  await updateSyncState(copy.folder, (state) => ({ ...state, remoteId }));
  const puts = recordPuts(remote);
  assert.equal((await sync(copy, remote)).action, 'initial-push');
  const copied = await bookId(copy);
  const [copyTip] = await remoteTips(remote, copied);
  assert.deepEqual((await stateOf(remote, copyTip)).originals, named, 'the copy names the originals it does not have');
  for (const { digest, ext } of Object.values(named)) assert.equal(sha(await stored(remote, originalBlobKey(copied, digest, ext))), digest);
  // Copied inside the store; iCloud downloads each from the book it was copied from and uploads it again.
  assert.equal(puts.filter((key) => key.includes('/originals/')).length, remote.store.copy ? 0 : Object.keys(named).length);
  assert.deepEqual(await readdir(join(copy.folder, 'photos')).then((names) => names.filter((name) => name.startsWith('.imageflow-upload-'))), [], 'no upload clone is left');
  // The copy downloads its originals as any synced book does.
  assert.ok((await on(copy, (book) => downloadOriginals({ remote, book }))).length > 0);
});

test('a copy made of a book that does not sync, or synced with another remote, uploads its originals as any new book', async (t) => {
  const { a, remote } = await world(t);
  const plain: Mac = { ...a, folder: join(a.base, 'Plain.imageflow') };
  await on(a, (book) => saveDocumentCopy(book, plain.folder, false));
  assert.equal((await readSyncState(plain.folder)).copiedFrom, undefined, 'the source never synced');
  await sync(a, remote);
  const copy: Mac = { ...a, folder: join(a.base, 'Copy.imageflow') };
  await on(a, (book) => saveDocumentCopy(book, copy.folder, false));
  // Synced with another remote: the hint names a book this remote does not hold, and is not used.
  const other = memoryRemote();
  const otherId = await other.remoteId();
  await updateSyncState(copy.folder, (state) => ({ ...state, remoteId: otherId }));
  assert.notEqual((await readSyncState(copy.folder)).copiedFrom?.remoteId, otherId);
  assert.equal((await sync(copy, other)).action, 'initial-push');
  const [tip] = await remoteTips(other, await bookId(copy));
  for (const { digest, ext } of Object.values((await stateOf(other, tip)).originals)) assert.ok(await other.hasBlob(originalBlobKey(tip.bookId, digest, ext)));
});

test('Clean Up over iCloud lists each book in the store itself, never from the key index, and the index forgets what it deleted', async (t) => {
  const { a } = await world(t);
  const keyIndex = new MemoryKeyIndexCache();
  const remote = new StoreRemote(new CloudKitStore(new FakeCloudKit(), { backoff: () => 0 }), { keyIndex });
  await sync(a, remote);
  const book = await bookId(a);
  const listed: string[] = [];
  const list = remote.store.list.bind(remote.store);
  remote.store.list = (prefix) => { listed.push(prefix); return list(prefix); };
  const stray = proxyBlobKey(book, 'd'.repeat(64), '.jpg');
  await remote.putBlob(stray, await jpeg('#123456'));
  const plan = await planCleanUp(remote, later(8));
  assert.ok(listed.includes(bookPrefix(book)), 'listed in full: ' + listed.join(', '));
  assert.deepEqual(plan.books.map(({ blobs }) => blobs.map(({ key }) => key)), [[stray]]);
  const remoteId = await remote.remoteId();
  assert.ok((await keyIndex.read(remoteId, book))!.entries[stray]);
  await cleanUp(remote, plan, later(8));
  assert.equal((await keyIndex.read(remoteId, book))!.entries[stray], undefined, 'the kept index no longer has it');
  assert.equal(await remote.hasBlob(stray), false);
});

each('Clean Up counts the week from the commit that removed a photo, not from the upload', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const photo = await importPhoto(a, 'harbour.jpg', '#225588');
  await sync(a, remote);
  const original = originalBlobKey(await bookId(a), photo.digest, '.jpg');
  // Uploaded long ago and removed (in this test's clock) 7.5 days later: half a day after the removal it stays, so the
  // other Macs have a week to pull the removal while the original is still there.
  await on(a, (book) => removeSources(book, ['photo:' + photo.id]));
  await sync(a, remote, { now: () => later(7.5) });
  const keys = async (now: Date) => (await planCleanUp(remote, now)).books.flatMap(({ blobs }) => blobs.map(({ key }) => key));
  assert.equal((await keys(later(8))).includes(original), false);
  assert.deepEqual(await cleanUp(remote, await planCleanUp(remote, later(8)), later(8)), { bytes: 0, objects: 0 });
  assert.equal((await keys(later(15))).includes(original), true, 'a week after the removal it goes');
});

each('a preview a push reused after Clean Up removed it is sent again, so the other Mac can still pull', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  const photo = await importPhoto(a, 'harbour.jpg', '#225588');
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  const preview = proxyBlobKey(tip.bookId, photo.digest, (await stateOf(remote, tip)).proxies[photo.digest].ext);
  // Lost between Clean Up's last look and the deletion: the next push carries the entry forward and sends the preview again.
  await remote.deleteBlobs([preview]);
  await edit(a, caption('shore', 'After the sweep'));
  assert.equal((await sync(a, remote)).action, 'push');
  assert.ok(await remote.hasBlob(preview), 'a push sends a preview it carries forward again');
  // A sync with nothing to push sends it again as well.
  await remote.deleteBlobs([preview]);
  assert.equal((await sync(a, remote)).action, 'in-sync');
  assert.ok(await remote.hasBlob(preview), 'a sync with nothing to push sends it again');
  assert.equal((await sync(b, remote)).action, 'fast-forward', 'the other Mac pulls');
});

each('Clean Up keeps an original in the book a duplicate was made from while the duplicate still waits to copy it', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  const named = (await stateOf(remote, tip)).originals;
  const [id, original] = Object.entries(named)[0];
  await use(b);
  const remoteId = await remote.remoteId();
  const laptop: Mac = { ...b, folder: await cloneFromRemote({ remote, tip, destination: b.folder, remoteId }) };
  const copy: Mac = { ...b, folder: join(b.base, 'Copy.imageflow') };
  await on(laptop, (book) => saveDocumentCopy(book, copy.folder, false));
  await updateSyncState(copy.folder, (state) => ({ ...state, remoteId }));
  // The duplicate's commit names the original; its upload has not run yet.
  assert.equal((await commitOnly(copy, remote)).action, 'initial-push');
  // On the desktop the photo is removed, and a week later Clean Up runs.
  await on(a, (book) => removeSources(book, ['photo:' + id]));
  await sync(a, remote);
  const source = originalBlobKey(tip.bookId, original.digest, original.ext);
  const keys = async () => (await planCleanUp(remote, later(8))).books.flatMap(({ blobs }) => blobs.map(({ key }) => key));
  assert.equal((await keys()).includes(source), false, 'kept while the duplicate waits for it');
  await uploadAll(copy, remote);
  assert.equal(sha(await stored(remote, originalBlobKey(await bookId(copy), original.digest, original.ext))), original.digest);
  assert.equal((await keys()).includes(source), true, 'once the duplicate has it, it goes from the book that no longer uses it');
});

test('Clean Up asks before it deletes: the question names the backend and what it frees', () => {
  const plan = { books: [{ bookId: randomUUID(), blobs: [{ key: 'k', size: 2_500_000 }], bytes: 2_500_000 }], bytes: 2_500_000, objects: 1, skipped: 0, wanted: [] };
  const question = cleanUpQuestion(plan, 'books');
  assert.equal(question.message, 'Clean up “books”?');
  assert.deepEqual([question.buttons, question.defaultId, question.cancelId], [['Clean Up', 'Cancel'], 1, 1]);
  assert.match(question.detail, /^Clean Up can free 2\.5 MB: originals, previews and covers unused for a week in 1 book\. They are deleted for every Mac\./);
});

// The first sync of a book of 1210 photos held the book for over half an hour: one upload at a time, each after asking
// for a blob that was not there, which fails over iCloud.
async function manyPhotos(mac: Mac, count: number) {
  const files = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const file = join(mac.external, 'many-' + index + '.jpg');
    await image(file, '#' + (0x101010 + index * 4099).toString(16).padStart(6, '0'));
    return file;
  }));
  await on(mac, (book) => importIntoProject(book, { kind: 'photo', mode: 'copy' }, files));
  // The lineage ID, which the app gives a book before it sends anything.
  await on(mac, () => ensureBookId(mac.folder));
}
/** What a store is asked: how many puts run at once at most, and the keys it is asked for that it lacks. */
function recordTraffic(remote: Remote, delay = 5) {
  const traffic = { most: 0, missed: [] as string[], read: [] as string[], put: [] as string[] };
  let running = 0;
  const { store } = remote;
  const put = store.putIfAbsent.bind(store);
  const head = store.head.bind(store);
  const get = store.get.bind(store);
  store.putIfAbsent = async (key, source, options) => {
    traffic.put.push(key);
    traffic.most = Math.max(traffic.most, ++running);
    try { await new Promise((done) => setTimeout(done, delay)); return await put(key, source, options); } finally { running--; }
  };
  store.head = async (key) => { const found = await head(key); if (!found && /\/(content|proxies)\//.test(key)) traffic.missed.push(key); return found; };
  store.get = async (key) => { traffic.read.push(key); return get(key); };
  return traffic;
}

coreEach('a push uploads a few blobs at once, and asks for none that is not there', async (t) => {
  const { a, remote } = await world(t);
  await manyPhotos(a, 24);
  const traffic = recordTraffic(remote);
  await commitOnly(a, remote);
  assert.ok(traffic.most > 1 && traffic.most <= 8, traffic.most + ' at once');
  // Over iCloud each such question is a failed request, which CloudKit answers with delays. (The folder and S3 stores
  // look for an object themselves before they send one.)
  if (store === 'memory' || store === 'cloudkit') assert.deepEqual(traffic.missed, []);
  const state = await stateOf(remote, (await tips(remote, a))[0]);
  for (const { digest } of Object.values(state.assetsMeta.assets)) assert.ok(state.proxies[digest], 'every photo has its preview');
});

coreEach('what goes up ahead of a sync changes nothing in the book, and the sync then sends little and reads no preview back', async (t) => {
  const { a, remote } = await world(t);
  await manyPhotos(a, 24);
  await on(a, async (book) => {
    const before = [await readFile(join(a.folder, 'project.json')), await readFile(join(a.folder, 'photos.json'))];
    const ahead: UploadedPreviews = new Map();
    const seen: number[] = [];
    await uploadAhead({ remote, book, ahead, progress: (done, total) => { seen.push(done); assert.ok(total >= 24); } });
    assert.deepEqual([await readFile(join(a.folder, 'project.json')), await readFile(join(a.folder, 'photos.json'))], before);
    assert.equal((await readSyncState(a.folder)).lastSynced, undefined);
    assert.equal(await commitCount(remote), 0, 'no commit');
    assert.ok(ahead.size >= 24, ahead.size + ' previews');
    assert.ok(seen.at(-1)! >= 24);
    const traffic = recordTraffic(remote);
    assert.equal((await syncBook({ remote, book, ahead })).action, 'initial-push');
    assert.deepEqual(traffic.read.filter((key) => key.includes('/proxies/')), []);
    assert.deepEqual(traffic.put.filter((key) => key.includes('/proxies/') && [...ahead.keys()].some((kept) => key.includes(kept.split('/')[1]))), []);
  });
  const state = await stateOf(remote, (await tips(remote, a))[0]);
  for (const [digest, { ext, sha256 }] of Object.entries(state.proxies)) {
    assert.equal(sha(await stored(remote, proxyBlobKey(await bookId(a), digest, ext))), sha256);
  }
});

coreEach('an upload ahead of a sync stops with its signal and goes on where it stopped', async (t) => {
  const { a, remote } = await world(t);
  await manyPhotos(a, 24);
  await on(a, async (book) => {
    const ahead: UploadedPreviews = new Map();
    const job = new AbortController();
    const why = new Error('Stopped.');
    await assert.rejects(uploadAhead({ remote, book, ahead, signal: job.signal, progress: (done) => { if (done === 10) job.abort(why); } }), (error) => error === why);
    assert.equal(await commitCount(remote), 0);
    const kept = new Set([...ahead.keys()].map((key) => key.split('/')[1]));
    const traffic = recordTraffic(remote);
    await uploadAhead({ remote, book, ahead });
    for (const digest of kept) assert.ok(![...traffic.put, ...traffic.read].some((key) => key.includes(digest)), 'neither sent nor read again');
    assert.equal((await syncBook({ remote, book, ahead })).action, 'initial-push');
  });
});

coreEach('a preview Clean Up removes between what went up ahead and the sync is sent again', async (t) => {
  const { a, remote } = await world(t);
  await manyPhotos(a, 6);
  const id = await bookId(a);
  await on(a, async (book) => {
    const ahead: UploadedPreviews = new Map();
    await uploadAhead({ remote, book, ahead });
    const removed = (await remote.listBook(id, 'proxies')).map(({ key }) => key).slice(0, 3);
    assert.equal(removed.length, 3);
    await remote.deleteBlobs(removed);
    const traffic = recordTraffic(remote);
    assert.equal((await syncBook({ remote, book, ahead })).action, 'initial-push');
    for (const key of removed) assert.ok(traffic.put.includes(key), 'sent again: ' + key);
  });
  const state = await stateOf(remote, (await tips(remote, a))[0]);
  for (const [digest, { ext, sha256 }] of Object.entries(state.proxies)) assert.equal(sha(await stored(remote, proxyBlobKey(id, digest, ext))), sha256);
});

coreEach('a book given a new lineage stores its previews anew, ahead of the sync', async (t) => {
  const { a, remote } = await world(t);
  await manyPhotos(a, 6);
  const ahead: UploadedPreviews = new Map();
  await on(a, (book) => uploadAhead({ remote, book, ahead }));
  const file = join(a.folder, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  const id = randomUUID();
  await writeFile(file, JSON.stringify({ ...project, bookId: id }, null, 2) + '\n');
  await on(a, async (book) => {
    await uploadAhead({ remote, book, ahead });
    const stored = (await remote.listBook(id, 'proxies')).length;
    assert.ok(stored >= 6, stored + ' previews under the new lineage');
    const traffic = recordTraffic(remote);
    assert.equal((await syncBook({ remote, book, ahead })).action, 'initial-push');
    assert.deepEqual(traffic.put.filter((key) => key.includes('/proxies/') && [...ahead.keys()].some((kept) => key.includes(kept.split('/')[1]))), []);
  });
});

coreEach('a photo whose file cannot be read while it goes up ahead is left to the sync', async (t) => {
  const { a, remote } = await world(t);
  await manyPhotos(a, 6);
  await on(a, async (book) => {
    // The photo's file goes while the book is not held, after it was looked at and before its preview is made.
    const [id] = Object.keys(book.photoIndex).slice(-1);
    const photo = book.photos.get(id)!;
    let looked = 0;
    book.photos.set(id, Object.defineProperty({ ...photo }, 'original', { get: () => { if (looked++) throw new Error('The file is gone.'); return photo.original; } }) as typeof photo);
    const ahead: UploadedPreviews = new Map();
    await uploadAhead({ remote, book, ahead });
    assert.ok(looked > 1, 'its preview was tried');
    assert.ok(ahead.size >= 5, 'the others went up');
    book.photos.set(id, photo);
    assert.equal((await syncBook({ remote, book, ahead })).action, 'initial-push');
  });
  const state = await stateOf(remote, (await tips(remote, a))[0]);
  for (const { digest } of Object.values(state.assetsMeta.assets)) assert.ok(state.proxies[digest]);
});

core('a sync that begins to hold the book does not turn sync on again after it was turned off', async (t) => {
  const { a } = await world(t);
  const remoteId = randomUUID();
  await startSyncing(a.folder, remoteId);
  // Turned off between the sync's beginning and its hold: the record decides as it is written.
  const off = updateSyncState(a.folder, (state) => ({ ...state, enabled: false }));
  await assert.rejects(startSyncing(a.folder, remoteId, { unless: ({ enabled }) => enabled === false }), SyncStoppedError);
  await off;
  assert.equal((await readSyncState(a.folder)).enabled, false);
  await startSyncing(a.folder, remoteId);
  assert.equal((await readSyncState(a.folder)).enabled, true, 'Start Syncing turns it on');
});

each('nothing goes up ahead for a book deleted from sync', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const id = await bookId(a);
  await remote.deleteBook(id);
  await edit(a, caption('shore', 'After the deletion'));
  const traffic = recordTraffic(remote);
  await on(a, (book) => uploadAhead({ remote, book, ahead: new Map() }));
  assert.deepEqual(traffic.put, []);
});
