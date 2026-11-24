import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { libraryRows, libraryStateLabels } from '../src/book-library';
import { syncPlace, syncRows, syncRowState, syncSwitch } from '../src/sync-rows';
import { channels } from '../src/desktop';
import type { LibraryRemote, RecentDocument } from '../src/desktop';
import { maximumRecents, RecentDocuments } from '../desktop/documents';
import { coverDataUrl, deleteFromSyncQuestion, libraryBook, libraryListing, limited, networkNotice, syncsWithRemote } from '../desktop/sync-library';
import { memoryRemote, remoteTips, StoreRemote } from '../desktop/sync-remote';
import { CloudKitStore } from '../desktop/sync-store-cloudkit';
import { MemoryKeyIndexCache } from '../desktop/sync-key-index';
import { MemoryHeaderCache } from '../desktop/sync-header-cache';
import { S3Store } from '../desktop/sync-store-s3';
import { commitHeaderVersion, contentBlobKey, coverBlobKey, NewerSyncFormatError } from '../src/sync-snapshot';
import type { CommitHeader } from '../src/sync-snapshot';
import { FakeCloudKit } from './cloudkit-fake';
import { FakeS3, fakeCredentials } from './s3-fake';
import { createHash } from 'node:crypto';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const remoteId = randomUUID();
const book = (fields: Partial<RecentDocument> = {}): RecentDocument => ({ id: randomUUID(), path: '/Books/' + randomUUID() + '.imageflow', title: 'Book', openedAt: '2026-11-23T10:00:00.000Z',
  available: true, bookId: randomUUID(), ...fields });
const syncing = (fields: Partial<RecentDocument> = {}) => book({ sync: { remoteId, enabled: true }, ...fields });
const listing = (books: LibraryRemote['books']): LibraryRemote => ({ remoteId, name: 'books', books });
const states = (rows: ReturnType<typeof libraryRows>) => rows.map((row) => (row.kind === 'local' ? row.book.id : row.bookId) + ':' + row.state);

test('the library lists each state: synced, not syncing, on the remote only, removed elsewhere and synced by a newer ImageFlow', () => {
  const synced = syncing();
  const stopped = syncing({ sync: { remoteId, enabled: false } });
  const never = book();
  const elsewhere = book({ sync: { remoteId: randomUUID(), enabled: true } });
  const removed = syncing();
  const newer = syncing();
  const remoteOnly = randomUUID();
  const remoteNewer = randomUUID();
  const gone = randomUUID();
  const rows = libraryRows([synced, stopped, never, elsewhere, removed, newer], listing([
    { bookId: synced.bookId! }, { bookId: stopped.bookId! }, { bookId: removed.bookId!, deleted: true }, { bookId: newer.bookId!, newer: true },
    { bookId: remoteOnly }, { bookId: remoteNewer, newer: true }, { bookId: gone, deleted: true }]));
  assert.deepEqual(states(rows), [synced.id + ':synced', stopped.id + ':not-syncing', never.id + ':not-syncing', elsewhere.id + ':not-syncing',
    removed.id + ':removed', newer.id + ':newer', remoteOnly + ':remote', remoteNewer + ':newer'], 'a book deleted from sync that is on no Mac is not listed');
});

test('the books on this Mac are listed before the remote answers, and still when it cannot be read', () => {
  const synced = syncing();
  const local = book();
  assert.deepEqual(states(libraryRows([synced, local], undefined)), [synced.id + ':checking', local.id + ':not-syncing']);
  assert.deepEqual(states(libraryRows([synced, local], { error: 'offline' })), [synced.id + ':unavailable', local.id + ':not-syncing']);
  assert.deepEqual(states(libraryRows([synced, local], null)), [synced.id + ':checking', local.id + ':not-syncing'], 'without a backend the window shows no sync state');
});

test('the Sync window lists books here and on the remote together, switched on only where this Mac’s record says they sync', () => {
  const synced = syncing(), stopped = syncing({ sync: { remoteId, enabled: false } }), never = book(), elsewhere = book({ sync: { remoteId: randomUUID(), enabled: true } });
  const made = book({ sync: { starts: true } }), sample = book({ syncExcluded: true }), gone = book({ available: false }), away = syncing({ available: false });
  const removed = syncing();
  const remoteOnly = randomUUID();
  const rows = syncRows(libraryRows([synced, stopped, never, elsewhere, made, sample, gone, away, removed], listing([{ bookId: synced.bookId! }, { bookId: stopped.bookId! },
    { bookId: away.bookId! }, { bookId: removed.bookId!, deleted: true }, { bookId: remoteOnly }])));
  assert.deepEqual(rows.map((row) => [row.kind === 'local' ? row.book.id : row.bookId, syncSwitch(row)]), [[synced.id, true], [stopped.id, false], [never.id, false], [elsewhere.id, false],
    [made.id, true], [removed.id, false], [remoteOnly, undefined], [away.id, undefined]], 'the sample book and a book that is nowhere are left out');
  const [syncedRow, , neverRow, , madeRow, removedRow, remoteRow, awayRow] = rows;
  assert.deepEqual(rows.map((row) => syncPlace(row, 'iCloud', false)).slice(-2), ['Only in iCloud', 'Not found on this Mac']);
  assert.equal(syncPlace(remoteRow, 'iCloud', true), 'Downloading to this Mac');
  // Their states, in a few words.
  assert.equal(syncRowState(neverRow).text, 'Not syncing');
  assert.equal(syncRowState(madeRow).text, 'Not synced yet');
  assert.equal(syncRowState(removedRow).text, 'Removed on another Mac');
  for (const row of [remoteRow, awayRow]) assert.equal(syncRowState(row).action, 'download');
  assert.equal(syncRowState(remoteRow, { details: { bookId: remoteOnly, title: '', versions: 0, newer: true } }).action, 'update');
  assert.equal(syncRowState(awayRow, { details: { bookId: remoteOnly, title: '', versions: 0, newer: true } }).action, 'update');
  assert.equal(syncRowState(remoteRow, { details: { error: 'offline' } }).text, 'Cannot be read now');
  assert.deepEqual(syncRowState(remoteRow, { download: { bookId: remoteOnly, done: 124, total: 200 } }), { text: '124 of 200', bar: { done: 124, total: 200 } });
  assert.equal(syncRowState(remoteRow, { download: { bookId: remoteOnly, waiting: true } }).text, 'Waiting…');
  // A closed book is as its status says once it was read; an open or busy one as its view does.
  assert.equal(syncRowState(syncedRow).text, 'Looking…');
  assert.equal(syncRowState(syncedRow, { status: { state: 'in-sync', pendingOriginals: 0 } }).text, 'Up to date');
  const view = (fields: object) => syncRowState(syncedRow, { view: { folder: 'iCloud', ...fields }, status: { state: 'in-sync', pendingOriginals: 0 } });
  assert.deepEqual(view({ syncing: true, sending: { done: 3, total: 20 } }), { bar: { done: 3, total: 20 }, text: 'Uploading 3 of 20' });
  assert.equal(view({ syncing: true }).text, 'Syncing…');
  assert.equal(view({ uploading: { done: 1, total: 9 } }).text, 'Uploading 1 of 9');
  assert.equal(view({ uploadFailed: { left: 3, message: 'offline' } }).text, '3 originals not uploaded');
  assert.deepEqual(view({ storageFull: { message: 'iCloud storage is full.', notUploaded: 2, manage: true } }), { text: 'iCloud full', tone: 'problem', detail: 'iCloud storage is full.', action: 'manage-storage' });
  assert.equal(view({ storageFull: { message: 'The bucket is full.' } }).action, undefined);
  assert.equal(view({ status: { state: 'diverged', pendingOriginals: 0 } }).text, 'Changed on two Macs');
  assert.deepEqual(view({ status: { state: 'unavailable', signIn: true, detail: 'Sign-in needed: …', pendingOriginals: 0 } }), { text: 'Sign-in needed', tone: 'problem', detail: 'Sign-in needed: …', action: 'settings' });
  assert.equal(view({ status: { state: 'newer', pendingOriginals: 0 } }).action, 'update');
  for (const state of ['in-sync', 'ahead', 'behind', 'diverged', 'remote-syncing', 'abandoned', 'newer', 'unavailable', 'removed'] as const) {
    assert.ok(view({ status: { state, pendingOriginals: 0 } }).text!.length <= 24, 'short words');
  }
});

test('two copies with one lineage are both listed and keep the book off the remote-only rows; a book that cannot be found offers its remote copy on its row', () => {
  const lineage = randomUUID();
  const original = syncing({ bookId: lineage });
  const copy = book({ bookId: lineage });
  const missing = book({ available: false, bookId: randomUUID() });
  const rows = libraryRows([original, copy, missing], listing([{ bookId: lineage }, { bookId: missing.bookId! }]));
  assert.deepEqual(states(rows), [original.id + ':synced', copy.id + ':not-syncing', missing.id + ':missing']);
  const last = rows.at(-1)!;
  assert.ok(last.kind === 'local' && last.onRemote, 'the missing book offers Download on its own row');
});

test('more than 20 synced books stay tracked, so none is listed as only on the remote; removing one makes it count toward the cap again', async (t) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'if-library-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'recent-documents.json');
  const store = new RecentDocuments(file);
  const paths: string[] = [];
  for (let index = 0; index < 30; index++) {
    const path = join(folder, 'Book ' + index + '.imageflow');
    await mkdir(path);
    await writeFile(join(path, 'project.json'), JSON.stringify({ title: 'Book ' + index, bookId: randomUUID() }));
    paths.push(path);
    await store.remember(path, 'Book ' + index);
    // The first 25 sync on this Mac.
    if (index < 25) await store.track(path, true);
  }
  const listed = await store.list();
  assert.equal(listed.length, 30, 'the 25 that sync and the 5 most recent that do not');
  assert.ok(listed.every((entry) => entry.bookId), 'every entry records its lineage');
  // After a restart, as written.
  const restored = new RecentDocuments(file);
  await restored.load();
  assert.equal((await restored.list()).length, 30);
  const remote = listing((await restored.list()).map(({ bookId }) => ({ bookId: bookId! })));
  assert.equal(libraryRows(await restored.list(), remote).filter((row) => row.kind === 'remote').length, 0);
  // Ten stop syncing: with the five that never did, 15 count toward the cap, and all stay.
  for (const path of paths.slice(0, 10)) await restored.track(path, false);
  assert.equal((await restored.list()).length, 30);
  // All stop: the 20 most recent stay.
  for (const path of paths.slice(10, 25)) await restored.track(path, false);
  const after = await restored.list();
  assert.equal(after.length, maximumRecents);
  assert.deepEqual(after.map(({ path }) => path).sort(), paths.slice(10).sort());
});

test('an entry from before lineages were recorded gets its bookId from the book, and a lineage changed by Sync Again replaces it', async (t) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'if-library-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'Old.imageflow');
  await mkdir(path);
  const lineage = randomUUID();
  await writeFile(join(path, 'project.json'), JSON.stringify({ title: 'Old', bookId: lineage }));
  const file = join(folder, 'recent-documents.json');
  await writeFile(file, JSON.stringify([{ id: randomUUID(), path, identity: '1:2', title: 'Old', openedAt: '2026-01-01T00:00:00.000Z' }]));
  const store = new RecentDocuments(file);
  await store.load();
  assert.equal((await store.list())[0].bookId, lineage);
  await store.settled();
  assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].bookId, lineage, 'and keeps it');
  const fresh = randomUUID();
  await store.refresh(path, 'Old', undefined, fresh);
  assert.equal((await store.list())[0].bookId, fresh);
});

test('a cover from the remote reaches the window only as a JPEG made again here, at most 320 pixels', async () => {
  const cover = new Uint8Array(await sharp({ create: { width: 640, height: 480, channels: 3, background: '#336699' } }).jpeg().toBuffer());
  const url = await coverDataUrl(cover);
  assert.match(url ?? '', /^data:image\/jpeg;base64,/);
  const decoded = await sharp(Buffer.from(url!.split(',')[1], 'base64')).metadata();
  assert.deepEqual([decoded.format, decoded.width, decoded.height], ['jpeg', 320, 240]);
  const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer());
  assert.equal(await coverDataUrl(png), undefined, 'not a JPEG');
  assert.equal(await coverDataUrl(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9])), undefined, 'not a whole image');
  assert.equal(await coverDataUrl(new Uint8Array(300_000).fill(0xff)), undefined, 'too large');
  assert.equal(await coverDataUrl(undefined), undefined);
});

test('a downloaded book names the sites its template reaches once; a book made here says nothing, and a pulled change names what it added', () => {
  assert.match(networkNotice(['https://tile.example.com'], { known: false, downloaded: true }) ?? '', /loads maps or data from https:\/\/tile\.example\.com\. It was downloaded/);
  assert.equal(networkNotice(['https://tile.example.com'], { known: false, downloaded: false }), undefined);
  assert.match(networkNotice(['https://new.example.com'], { known: true, downloaded: false }) ?? '', /now also loads/);
  assert.equal(networkNotice([], { known: true, downloaded: true }), undefined);
});

const header = (bookId: string, fields: Partial<CommitHeader> = {}): CommitHeader => ({ version: commitHeaderVersion, commitId: randomUUID(), bookId, parents: [],
  bookStateRevision: 'a'.repeat(64), createdAt: '2026-11-23T10:00:00.000Z', title: 'Book', stateDigest: 'b'.repeat(64), ...fields });

test('a library row shows the latest version’s title, time and cover, and how many versions a book has', async () => {
  const remote = memoryRemote();
  const id = randomUUID();
  const cover = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#aa3300' } }).jpeg().toBuffer());
  await remote.putBlob(coverBlobKey(id, sha(cover)), cover);
  const first = header(id, { title: 'Trip' });
  await remote.putCommit(first);
  await remote.putCommit(header(id, { parents: [first.commitId], title: 'Trip to the coast', createdAt: '2026-11-24T10:00:00.000Z', coverDigest: sha(cover) }));
  const row = await libraryBook(remote, id);
  assert.deepEqual([row.title, row.updatedAt, row.versions], ['Trip to the coast', '2026-11-24T10:00:00.000Z', 1]);
  assert.match(row.cover ?? '', /^data:image\/jpeg;base64,/);
  await remote.putCommit(header(id, { parents: [first.commitId], title: 'Trip (other Mac)', createdAt: '2026-11-23T12:00:00.000Z' }));
  assert.equal((await libraryBook(remote, id)).versions, 2);
  // A cover that is not one is left out; the row still shows.
  const other = randomUUID();
  await remote.putBlob(coverBlobKey(other, 'c'.repeat(64)), new Uint8Array([1, 2, 3]));
  await remote.putCommit(header(other, { coverDigest: 'c'.repeat(64) }));
  assert.equal((await libraryBook(remote, other)).cover, undefined);
  // A book a newer ImageFlow synced.
  const newer = randomUUID();
  await remote.store.putIfAbsent('books/' + newer + '/snapshots/' + randomUUID() + '.json', new TextEncoder().encode(JSON.stringify({ ...header(newer), version: 3 })));
  assert.deepEqual(await libraryBook(remote, newer), { bookId: newer, title: '', versions: 0, newer: true });
  // Download reads its versions first, and is refused with the update message.
  await assert.rejects(remoteTips(remote, newer), (error: Error) => error instanceof NewerSyncFormatError && /Update ImageFlow/.test(error.message));
  assert.deepEqual(states(libraryRows([], { ...listing([{ bookId: newer, newer: true }]) })), [newer + ':newer']);
});

/** A remote with several books of many blobs each, and one deleted. */
async function library(remote: StoreRemote) {
  await remote.remoteId();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  for (const id of ids) {
    await remote.putCommit(header(id));
    for (let index = 0; index < 12; index++) await remote.putBlob(contentBlobKey(id, sha(new TextEncoder().encode(id + index))), new TextEncoder().encode(id + index));
  }
  await remote.deleteBook(ids[4]);
  return ids;
}

test('listing a library of several remote-only books over iCloud does not list any book, and tombstones are read only for deleted books', async () => {
  const native = new FakeCloudKit();
  const remote = new StoreRemote(new CloudKitStore(native, { backoff: () => 0 }), { keyIndex: new MemoryKeyIndexCache(), headerCache: new MemoryHeaderCache() });
  const ids = await library(remote);
  const id = await remote.remoteId();
  native.calls.length = 0;
  const listed = await libraryListing(remote, id, 'iCloud');
  assert.deepEqual(listed.books.map(({ bookId, deleted }) => [bookId, !!deleted]).sort(), ids.map((id, index) => [id, index === 4]).sort());
  // One listing of zones, the index zone (for the books whose zone is gone and for the deletion markers), and one read
  // of the one tombstone: no book's zone is listed.
  assert.equal(native.calls.filter((call) => call === 'listZones').length, 1);
  assert.equal(native.calls.filter((call) => call === 'changes').length, 2, 'only the index zone');
  assert.equal(native.calls.filter((call) => call === 'fetch').length, 1, 'only the deleted book’s tombstone');
  // A row in view lists its own book once; the key index keeps it.
  native.calls.length = 0;
  await libraryBook(remote, ids[0]);
  await libraryBook(remote, ids[0]);
  assert.equal(native.calls.filter((call) => call === 'changes').length, 2, 'the book’s zone, then only what changed');
});

test('listing a library over a bucket takes two listings, whatever the number of books, and reads only the deleted book’s tombstone', async (t) => {
  const fake = await new FakeS3().start();
  t.after(() => fake.close());
  fake.bucket('books');
  const remote = new StoreRemote(new S3Store({ endpoint: fake.url, region: fake.region, bucket: 'books', prefix: 'ImageFlow/', credentials: fakeCredentials, retryDelay: 1 }));
  const ids = await library(remote);
  const id = await remote.remoteId();
  fake.requests.length = 0;
  const listed = await libraryListing(remote, id, 'books');
  assert.deepEqual(listed.books.filter(({ deleted }) => deleted).map(({ bookId }) => bookId), [ids[4]]);
  const methods = fake.requests.map(({ method }) => method);
  assert.equal(methods.filter((method) => method === 'GET').length, 2 + 1, 'the books, the deletion markers, and one tombstone');
});

test('every IPC channel has a name of its own, so no handler is registered twice', () => {
  const names = Object.values(channels);
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), []);
});

test('Delete from Sync says what goes: a book only on the remote is deleted for good unless another Mac has it, and a copy here names its originals that are not here', () => {
  const remoteOnly = deleteFromSyncQuestion({ title: 'Trip', backend: 'books', here: false });
  assert.equal(remoteOnly.message, 'Delete “Trip” from sync?');
  assert.match(remoteOnly.detail, /It is not on this Mac: unless another Mac still has a copy, the book is deleted for good\.$/);
  assert.deepEqual([remoteOnly.buttons, remoteOnly.defaultId, remoteOnly.cancelId], [['Delete from Sync', 'Cancel'], 1, 1], 'Cancel is the default');
  assert.match(deleteFromSyncQuestion({ title: 'Trip', backend: 'books', here: true, away: 0 }).detail, /The copy on this Mac stays where it is\. This Mac has all its originals\.$/);
  assert.match(deleteFromSyncQuestion({ title: 'Trip', backend: 'books', here: true, away: 1 }).detail, /1 original of this book is not on this Mac: it is removed with it, unless another Mac has it\.$/);
  assert.match(deleteFromSyncQuestion({ title: 'Trip', backend: 'books', here: true, away: 12 }).detail, /12 originals of this book are not on this Mac: they are removed with it, unless another Mac has them\.$/);
  assert.match(deleteFromSyncQuestion({ title: 'Trip', backend: 'books', here: true }).detail, /Originals that are not on this Mac are removed with it, unless another Mac has them\.$/);
  for (const here of [true, false]) assert.match(deleteFromSyncQuestion({ title: 'Trip', backend: 'books', here }).detail, /^It is removed from “books”, and every Mac stops syncing it\./);
});

test('a book that syncs here by its record but that the remote does not have reads as not synced yet', () => {
  const first = syncing();
  const unnamed = syncing({ bookId: undefined });
  assert.deepEqual(states(libraryRows([first, unnamed], listing([]))), [first.id + ':unsynced', unnamed.id + ':unsynced']);
  assert.equal(libraryStateLabels.unsynced, 'Not synced yet');
});

test('a book counts as syncing here only with the configured remote: not with sync off or another remote, and unknown while the remote cannot be read', () => {
  const record = { remoteId, enabled: true };
  assert.equal(syncsWithRemote(record, remoteId), true);
  assert.equal(syncsWithRemote(record, randomUUID()), false, 'it synced with another remote');
  assert.equal(syncsWithRemote(record, null), false, 'sync is off');
  assert.equal(syncsWithRemote({ remoteId, enabled: false }, remoteId), false, 'stopped here');
  assert.equal(syncsWithRemote(undefined, remoteId), false);
  assert.equal(syncsWithRemote(record, undefined), undefined, 'offline: neither kept nor refused on a guess');
  assert.equal(syncsWithRemote({ remoteId, enabled: false }, undefined), false);
});

test('reading a row again fetches no cover it has, and rows are read four at a time', async () => {
  const remote = memoryRemote();
  const id = randomUUID();
  const cover = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } }).jpeg().toBuffer());
  await remote.putBlob(coverBlobKey(id, sha(cover)), cover);
  await remote.putCommit(header(id, { coverDigest: sha(cover) }));
  let fetched = 0;
  const get = remote.getBlob.bind(remote);
  remote.getBlob = async (key) => { if (key.includes('/covers/')) fetched++; return get(key); };
  const covers = new Map<string, Promise<string | undefined>>();
  const first = await libraryBook(remote, id, covers);
  const again = await libraryBook(remote, id, covers);
  assert.ok(first.cover);
  assert.equal(again.cover, first.cover);
  assert.equal(fetched, 1, 'a cover is content-addressed: read once');
  const limit = limited(4);
  let running = 0, most = 0;
  await Promise.all(Array.from({ length: 12 }, () => limit(async () => { running++; most = Math.max(most, running); await new Promise((resolve) => setTimeout(resolve, 5)); running--; })));
  assert.equal(most, 4);
});
