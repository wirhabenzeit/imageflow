import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import { relinkFolder } from '../desktop/source-actions';
import { captureBookStateRevision } from '../desktop/revisions';
import { downloadOriginals, RemoteSyncingError, stageSyncPull, syncBook } from '../desktop/sync-engine';
import type { SyncOptions } from '../desktop/sync-engine';
import { MemoryRemote, remoteTips } from '../desktop/sync-remote';
import { readSyncState, updateSyncState } from '../desktop/sync-pull';
import { contentBlobKey, decideSync, deriveTips, isUnlocatedPath, originalBlobKey, portableManifests, projectManifests, proxyBlobKey, stateBlobSchema } from '../src/sync-snapshot';
import type { CommitHeader, StateBlob } from '../src/sync-snapshot';
import type { ProjectFiles } from '../src/project';
import { copySample } from '../desktop/sample-book.mjs';
import './persistence-root';

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
  return { root, a, b, remote: new MemoryRemote() };
}
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
const sync = (mac: Mac, remote: MemoryRemote, options: Omit<SyncOptions, 'remote' | 'book'> = {}) => on(mac, (book) => syncBook({ remote, book, ...options }));
const edit = (mac: Mac, change: (files: ProjectFiles) => void) => on(mac, async (book) => {
  const files = structuredClone({ project: book.project, photoIndex: book.photoIndex });
  change(files);
  return updateProject(book, files);
});
const caption = (id: string, text: string) => (files: ProjectFiles) => { files.photoIndex[id].caption = text; };
const manifests = async (mac: Mac) => ({ project: JSON.parse(await readFile(join(mac.folder, 'project.json'), 'utf8')), photos: JSON.parse(await readFile(join(mac.folder, 'photos.json'), 'utf8')) });
const bookId = async (mac: Mac) => (await manifests(mac)).project.bookId as string;
const tips = async (remote: MemoryRemote, mac: Mac) => remoteTips(remote, await bookId(mac));
const stateOf = (remote: MemoryRemote, header: CommitHeader): StateBlob =>
  stateBlobSchema.parse(JSON.parse(Buffer.from(remote.blobs.get(contentBlobKey(header.stateDigest))!).toString('utf8')));
const commit = async (remote: MemoryRemote, mac: Mac, id: string) => (await remote.getCommit(await bookId(mac), id))!;
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
  const header = (commitId: string, bookStateRevision: string, parents: string[] = []): CommitHeader => ({ version: 1, commitId, bookId: '00000000-0000-4000-8000-000000000000',
    parents, bookStateRevision, createdAt: '2026-11-21T10:00:00.000Z', title: 'Book', stateDigest: 'f'.repeat(64) });
  const [r1, r2, r3] = ['1', '2', '3'].map((digit) => digit.repeat(64));
  const c1 = header('00000000-0000-4000-8000-000000000001', r1);
  const c2 = header('00000000-0000-4000-8000-000000000002', r2, [c1.commitId]);
  const c3 = header('00000000-0000-4000-8000-000000000003', r3, [c1.commitId]);
  assert.deepEqual(deriveTips([c1, c2]).map(({ commitId }) => commitId), [c2.commitId]);
  assert.equal(deriveTips([c1, c2, c3]).length, 2);
  const synced = { commitId: c1.commitId, bookStateRevision: r1 };
  const decide = (input: Partial<Parameters<typeof decideSync>[0]>) => decideSync({ pullInProgress: false, tips: [c1], lastSynced: synced, localRevision: r1, factsChanged: false, ...input }).action;
  assert.equal(decide({ pullInProgress: true }), 'resume');
  assert.equal(decide({ tips: [] }), 'initial-push');
  assert.equal(decide({ tips: [c2, c3] }), 'diverged');
  assert.equal(decide({ lastSynced: undefined }), 'adopt');
  assert.equal(decide({ lastSynced: undefined, localRevision: r2 }), 'diverged');
  assert.equal(decide({}), 'in-sync');
  assert.equal(decide({ localRevision: r2 }), 'push');
  assert.equal(decide({ factsChanged: true }), 'push');
  assert.equal(decide({ tips: [c2] }), 'fast-forward');
  assert.deepEqual(decideSync({ pullInProgress: false, tips: [c2], lastSynced: synced, localRevision: r1, factsChanged: true }), { action: 'fast-forward', tip: c2, thenPush: true });
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

test('desktop and laptop: adopt, push after import, proxies first, originals on demand, linked paths stay per Mac', async (t) => {
  const { a, b, remote } = await world(t);
  // Desktop: the first push gives the book its lineage ID and uploads everything.
  const first = await sync(a, remote);
  assert.equal(first.action, 'initial-push');
  assert.equal(first.changed, true, 'the lineage ID was saved');
  const [c1] = await tips(remote, a);
  assert.deepEqual(c1.parents, []);
  assert.equal(c1.bookStateRevision, await captureBookStateRevision(a.folder));
  const s1 = stateOf(remote, c1);
  assert.ok(s1.originals.shore && remote.blobs.has(originalBlobKey(s1.originals.shore.digest, s1.originals.shore.ext)));
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
  const s2 = stateOf(remote, c2);
  assert.deepEqual(s2.photos[linked], { path: 'harbour.jpg', linked: true, title: 'harbour' }, 'the desktop’s folder layout never leaves it');
  const linkedDigest = sha(await readFile(linkedPhoto));
  assert.equal(s2.assetsMeta.assets[linked].digest, linkedDigest, 'a push right after an import waits for the digest');
  assert.equal(s2.originals[linked], undefined, 'linked originals stay where they are');
  const proxyEntry = s2.proxies[linkedDigest];
  assert.ok(proxyEntry, 'the proxy goes along');
  assert.equal(sha(remote.blobs.get(proxyBlobKey(linkedDigest, proxyEntry.ext))!), proxyEntry.sha256, 'with its own SHA-256');

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
  const s3 = stateOf(remote, await commit(remote, b, fromLaptop.pushed[0]));
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
  const s4 = stateOf(remote, await commit(remote, a, carried.pushed[0]));
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

test('an in-place re-export and a caption edit elsewhere fast-forward, merge facts and push, with no conflict copy', async (t) => {
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
  const state = stateOf(remote, tip);
  assert.equal(state.assetsMeta.assets[linked].digest, digest);
  assert.deepEqual([state.assetsMeta.assets[linked].width, state.assetsMeta.assets[linked].height], [160, 90]);
  assert.ok(state.proxies[digest]);
  assert.equal((await readAssetFacts(a.folder))[linked].digest, digest);
  assert.deepEqual((await readdir(join(root, 'desktop'))).filter((name) => name.includes('Conflict')), []);
  // The laptop takes the new facts without a conflict either.
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await readAssetFacts(b.folder))[linked].digest, digest);
});

test('a pull deletes template files the snapshot no longer has, and asks again about network sites', async (t) => {
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

test('an incomplete or corrupted remote fails as still syncing and leaves the book untouched', async (t) => {
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
  const state = stateOf(remote, (await tips(remote, a))[0]);
  const digest = sha(await readFile(photo));
  const proxyKey = proxyBlobKey(digest, state.proxies[digest].ext);
  const goodProxy = remote.blobs.get(proxyKey)!;
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
  remote.blobs.set(proxyKey, goodProxy.slice(0, goodProxy.length - 10));
  await assert.rejects(sync(b, remote), RemoteSyncingError);
  await untouched();
  remote.blobs.set(proxyKey, goodProxy);
  // A content blob that has not arrived.
  const notes = contentBlobKey(state.content['template/notes.txt']);
  const notesBytes = remote.blobs.get(notes)!;
  remote.blobs.delete(notes);
  await assert.rejects(sync(b, remote), /Remote still syncing/);
  await untouched();
  remote.blobs.set(notes, notesBytes);
  // A state blob that does not match its commit.
  const [tip] = await tips(remote, a);
  const stateBytes = remote.blobs.get(contentBlobKey(tip.stateDigest))!;
  remote.blobs.set(contentBlobKey(tip.stateDigest), new TextEncoder().encode('{}'));
  await assert.rejects(sync(b, remote), RemoteSyncingError);
  await untouched();
  remote.blobs.set(contentBlobKey(tip.stateDigest), stateBytes);
  assert.equal((await sync(b, remote)).action, 'fast-forward');
  assert.equal((await manifests(b)).photos.shore.caption, 'Remote edit');
});

test('a pull interrupted after it was staged is finished when the book opens', async (t) => {
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

test('an AirDropped book edited before its first sync keeps both versions', async (t) => {
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

test('two tips stay until the user picks one, which closes the fork with both as parents', async (t) => {
  const { a, b, remote } = await world(t);
  await sync(a, remote);
  await copyBook(a, b);
  await sync(b, remote);
  // Both Macs edit offline; their pushes reach the remote independently.
  const offline = new MemoryRemote();
  for (const [key, value] of remote.commits) offline.commits.set(key, value);
  for (const [key, value] of remote.blobs) offline.blobs.set(key, value);
  await edit(a, caption('shore', 'Desktop'));
  const [cA] = (await sync(a, remote)).pushed;
  await edit(b, caption('shore', 'Laptop'));
  const [cB] = (await sync(b, offline)).pushed;
  for (const [key, value] of offline.commits) remote.commits.set(key, value);
  for (const [key, value] of offline.blobs) if (!remote.blobs.has(key)) remote.blobs.set(key, value);
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
