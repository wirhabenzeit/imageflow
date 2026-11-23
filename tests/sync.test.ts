import assert from 'node:assert/strict';
import { test as runTest } from 'node:test';
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { configureRenditionCache } from '../desktop/rendition-cache';
import { configureProxyStore } from '../desktop/proxy-store';
import { AssetFacts, readAssetFacts } from '../desktop/asset-facts';
import { acquireProjectLock, readSaveLedger } from '../desktop/persistence';
import { importIntoProject, loadProject, updateProject } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { collectSources, relinkFolder } from '../desktop/source-actions';
import { captureBookStateRevision } from '../desktop/revisions';
import { cloneFromRemote, describeLocalChange, describeSync, downloadOriginals, pendingOriginals, placeOriginals, RemoteSyncingError, stageOriginals, stageSyncPull, syncBook } from '../desktop/sync-engine';
import type { SyncOptions } from '../desktop/sync-engine';
import { memoryRemote, remoteBooks, remoteTips, StoreRemote } from '../desktop/sync-remote';
import type { SyncRemote } from '../desktop/sync-remote';
import { FolderStore, folderRemote } from '../desktop/sync-store-folder';
import { MemoryStore } from '../desktop/sync-store';
import type { SyncStore } from '../desktop/sync-store';
import { storeConformance } from './sync-store-conformance';
import { readCommitHeaderV1 } from './sync-v1-reader';
import { bookTrusted } from '../desktop/source-access';
import { readSyncState, takeAbandonedAtOpen, updateSyncState } from '../desktop/sync-pull';
import { blobKeyPattern, commitKey, contentBlobKey, coverBlobKey, decideSync, readBookTombstone, readCommitHeader, readRemoteIdentity, NewerSyncFormatError, deriveTips, isUnlocatedPath, originalBlobKey, portableManifests,
  projectManifests, proxyBlobKey, stateBlobSchema, tombstoneKey } from '../src/sync-snapshot';
import type { CommitHeader, StateBlob } from '../src/sync-snapshot';
import type { ProjectFiles } from '../src/project';
import { copySample } from '../desktop/sample-book.mjs';
import { canonicalJson } from '../src/canonical-json';
import { computeBookStateRevision } from '../src/book-revision';
import { photoIndexSchema, projectSchema } from '../src/project';
import { persistenceRoot } from './persistence-root';

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
// folder store in a process of its own (tests/sync-folder-store.test.ts), so the two runs go side by side. Every other
// test (`test`) runs once, here.
type Remote = StoreRemote;
const store = process.env.IMAGEFLOW_SYNC_TEST_STORE === 'folder' ? 'folder' : 'memory';
const test: typeof runTest = store === 'memory' ? runTest : ((() => {}) as unknown as typeof runTest);
const each = (name: string, run: (t: TestContext) => Promise<void>) => runTest(name + ' (' + store + ' store)', run);
async function newRemote(root: string, name = 'Remote'): Promise<Remote> {
  if (store === 'memory') return memoryRemote();
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
const sync = (mac: Mac, remote: SyncRemote, options: Omit<SyncOptions, 'remote' | 'book'> = {}) => on(mac, (book) => syncBook({ remote, book, ...options }));
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

test('the decision table: fast-forward or keep both, and facts never diverge', () => {
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

test('a snapshot carries linked paths as file names, and a pull keeps this Mac’s own paths', () => {
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

each('desktop and laptop: adopt, push after import, proxies first, originals on demand, linked paths stay per Mac', async (t) => {
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

each('an in-place re-export and a caption edit elsewhere fast-forward, merge facts and push, with no conflict copy', async (t) => {
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

each('a pull deletes template files the snapshot no longer has, and asks again about network sites', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  await writeFile(join(a.folder, 'template', 'notes.txt'), 'draft');
  assert.equal((await sync(a, remote)).action, 'push');
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal(await readFile(join(b.folder, 'template', 'notes.txt'), 'utf8'), 'draft');
  assert.equal((await readSyncState(b.folder)).networkReview, true, 'a template from the remote does not inherit trust silently');
  await updateSyncState(b.folder, ({ networkReview: _, ...state }) => state);
  await rm(join(a.folder, 'template', 'notes.txt'));
  await sync(a, remote);
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal(await lstat(join(b.folder, 'template', 'notes.txt')).catch(() => undefined), undefined);
  assert.equal(await captureBookStateRevision(b.folder), (await tips(remote, a))[0].bookStateRevision);
  await updateSyncState(b.folder, ({ networkReview: _, ...state }) => state);
  // A caption is not code.
  await edit(a, caption('shore', 'Only a caption'));
  await sync(a, remote);
  await sync(b, remote);
  assert.equal((await readSyncState(b.folder)).networkReview, undefined);
});

each('an incomplete or corrupted remote fails as still syncing and leaves the book untouched', async (t) => {
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

each('a pull interrupted after it was staged is finished when the book opens', async (t) => {
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

each('an AirDropped book edited before its first sync keeps both versions', async (t) => {
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

test('a sync folder: push from the desktop, Open from Sync Folder on the laptop, then edits both ways', async (t) => {
  const { root, a, b } = await world(t);
  const remote = await syncFolder(root);
  assert.equal((await sync(a, remote)).action, 'initial-push');
  const id = await bookId(a);
  const files = await remoteFiles(remote);
  assert.ok(files.some((path) => path.startsWith(join('books', id, 'snapshots')) && path.endsWith('.json')));
  // The layout of ADR 0012, section 4: everything the book needs is under its own prefix.
  for (const part of ['content', 'originals', 'proxies']) assert.ok(files.some((path) => path.startsWith(join('books', id, part) + '/')), part);
  assert.deepEqual((await readdir(remote.store.root)).filter((name) => !name.startsWith('.')), ['books']);
  assert.deepEqual((await readdir(join(remote.store.root, 'books'))).filter((name) => !name.startsWith('.')), [id]);
  assert.deepEqual((await readdir(join(remote.store.root, 'books', id))).filter((name) => !name.startsWith('.')).sort(), ['content', 'originals', 'proxies', 'snapshots']);
  assert.equal(files.some((path) => path.split('/').at(-1)!.startsWith('.sync-')), false, 'no temporary files stay');

  // Laptop: the book is listed by the title in its tip header and opened into a new, untrusted package.
  await use(b);
  const [listed, ...others] = await remoteBooks(remote);
  assert.equal(others.length, 0);
  assert.equal(listed.bookId, id);
  assert.equal(listed.title, (await manifests(a)).project.title);
  const created = await cloneFromRemote({ remote, tip: listed.tips[0], destination: join(b.base, 'Book'), syncFolder: remote.store.root });
  assert.equal(created, b.folder, 'the .imageflow extension is added');
  assert.equal(await bookTrusted(b.folder), false, 'a template from a sync folder is not trusted');
  assert.equal(await captureBookStateRevision(b.folder), listed.tips[0].bookStateRevision);
  const record = await readSyncState(b.folder);
  assert.equal(record.folder, remote.store.root);
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

  // The desktop edits; the laptop keeps originals. A download that fails after the pull leaves the sync successful
  // with originals pending, and the next sync retries it.
  await edit(a, caption('segla', 'From the desktop'));
  await sync(a, remote);
  const originals = join(remote.store.root, 'books', id, 'originals');
  await rename(originals, originals + '-away');
  const pulled = await sync(b, remote, { fetchOriginals: true });
  assert.equal(pulled.action, 'fast-forward');
  assert.equal(pulled.originals?.downloaded.length, 0);
  assert.match(pulled.originals?.pending ?? '', /not fully arrived/);
  assert.equal((await manifests(b)).photos.segla.caption, 'From the desktop');
  assert.equal((await describeSync(b.folder, remote)).state, 'in-sync');
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

test('a folder remote keeps files immutable, writes them whole, and clones blobs', async (t) => {
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

test('changes to a sync record are serialized, so none is lost', async (t) => {
  const { a } = await world(t);
  await Promise.all([
    updateSyncState(a.folder, (state) => ({ ...state, folder: '/Sync' })),
    updateSyncState(a.folder, (state) => ({ ...state, networkReview: true })),
    ...Array.from({ length: 8 }, () => updateSyncState(a.folder, (state) => state)),
  ]);
  const state = await readSyncState(a.folder);
  assert.equal(state.folder, '/Sync');
  assert.equal(state.networkReview, true);
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
  }, { sha256: 'ignored' });
}

test('a folder store leaves no temporary files and no empty folders, and never lists hidden files', async (t) => {
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
  const keys = (await remote.store.list('')).map(({ key }) => key);
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
  assert.equal(await remote.copyBlob(originalBlobKey(ids[0], digest, '.jpg'), originalBlobKey(copy, digest, '.jpg')), true);
  assert.equal(sha(await stored(remote, originalBlobKey(copy, digest, '.jpg'))), digest);
  assert.equal(await remote.copyBlob(originalBlobKey(ids[0], 'f'.repeat(64), '.jpg'), originalBlobKey(copy, 'f'.repeat(64), '.jpg')), false);
  await assert.rejects(remote.copyBlob(originalBlobKey(ids[0], digest, '.jpg'), 'remote.json'), /Not a sync blob key/);
  assert.match(coverBlobKey(copy, digest), blobKeyPattern);
});

each('a remote has one identity, also when two Macs initialize it at once', async (t) => {
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
  await replace(remote, tombstoneKey(kept), new TextEncoder().encode(JSON.stringify({ version: 2, bookId: kept, deletedAt: tombstone.deletedAt, by: 'x' })));
  await assert.rejects(remote.bookTombstone(kept), NewerSyncFormatError);
  assert.deepEqual((await remoteBooks(remote)).map(({ bookId, newer, deleted }) => [bookId, !!newer, !!deleted]), [[kept, true, false], [deleted, false, true]]);
});

each('a commit header is version 2 with an optional cover, and a version 1 reader refuses it', async (t) => {
  const { a, remote } = await world(t);
  await sync(a, remote);
  const [tip] = await tips(remote, a);
  assert.equal(tip.version, 2);
  assert.equal(tip.coverDigest, undefined, 'no push writes a cover yet');
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

test('a remote over a store without a server-side copy copies nothing, so the caller uploads', async () => {
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

test('a folder store on a volume without hard links renames into place, and still never replaces an object', async (t) => {
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
  assert.deepEqual(await readdir(join(root, 'refused', 'books', 'a', 'content')), []);
});

test('a folder store put or copy whose folder a delete removes meanwhile makes it again', async (t) => {
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

each('a blob is copied only to its own key in another book, and never over a blob that is there', async (t) => {
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
  assert.equal(await remote.copyBlob(originalBlobKey(from, digest, '.jpg'), originalBlobKey(other, digest, '.jpg')), true);
  assert.deepEqual(await stored(remote, originalBlobKey(other, digest, '.jpg')), bytes);
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
