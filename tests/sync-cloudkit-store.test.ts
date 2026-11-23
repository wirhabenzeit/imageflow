import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ChangeTokenExpiredError } from '../desktop/sync-store';
import { CloudKitAccessError, CloudKitError, CloudKitStore, cloudKitAvailability, cloudKitReason, isCloudKitError } from '../desktop/sync-store-cloudkit';
import { StoreAccessError } from '../desktop/sync-store';
import type { CloudKitNative } from '../desktop/sync-store-cloudkit';
import { StoreRemote } from '../desktop/sync-remote';
import { FakeCloudKit } from './cloudkit-fake';
import { storeConformance } from './sync-store-conformance';

const bytes = (text: string) => new TextEncoder().encode(text);
const book = '0f8fad5b-d9cb-469f-a165-70867728950e';
const other = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const make = (options: ConstructorParameters<typeof CloudKitStore>[1] = {}) => {
  const native = new FakeCloudKit();
  return { native, store: new CloudKitStore(native, { backoff: () => 0, ...options }) };
};

storeConformance('cloudkit (fake)', async () => make().store);

test('cloudkit store: keys map onto a zone per book and the index zone', () => {
  const { store } = make();
  assert.deepEqual(store.locate('books/' + book + '/snapshots/one.json'), { zone: book, name: 'snapshots/one.json' });
  assert.deepEqual(store.locate('books/' + book + '/originals/abc.jpg'), { zone: book, name: 'originals/abc.jpg' });
  // The tombstone outlives the book's zone.
  assert.deepEqual(store.locate('books/' + book + '/deleted.json'), { zone: 'index', name: 'books/' + book + '/deleted.json' });
  assert.deepEqual(store.locate('remote.json'), { zone: 'index', name: 'remote.json' });
  assert.deepEqual(store.locate('books/index/content/x'), { zone: 'index', name: 'books/index/content/x' }, 'a book segment cannot be the index zone');
  assert.deepEqual(store.locate('books/a b/content/x'), { zone: 'index', name: 'books/a b/content/x' }, 'nor a name CloudKit refuses');
  assert.deepEqual(make({ namespace: 'test-1-' }).store.locate('books/' + book + '/content/x'), { zone: 'test-1-' + book, name: 'content/x' });
  assert.equal(make({ namespace: 'test-1-' }).store.indexZone, 'test-1-index');
  assert.throws(() => store.locate('books/' + book + '/_hidden'), /cannot be stored in iCloud/);
  assert.throws(() => store.locate('books/' + book + '/content/café'), /cannot be stored in iCloud/);
});

test('cloudkit store: deleting a book empties and removes its zone, and its tombstone stays a listed book', async () => {
  const { native, store } = make();
  const remote = new StoreRemote(store);
  await store.putIfAbsent('books/' + book + '/content/one', bytes('1'));
  await store.putIfAbsent('books/' + other + '/content/one', bytes('1'));
  assert.deepEqual([...native.zones.keys()].sort(), [book, other].sort());
  await remote.deleteBook(book, new Date('2026-11-23T00:00:00Z'));
  assert.deepEqual([...native.zones.keys()].sort(), ['index', other].sort(), 'the emptied zone is gone');
  assert.deepEqual(await store.listPrefixes('books/'), ['books/' + book + '/', 'books/' + other + '/']);
  assert.deepEqual((await remote.listBooks()).find((entry) => entry.bookId === book)?.deleted?.deletedAt, '2026-11-23T00:00:00.000Z');
  // Listing books is one listing of zones and one of the index, never a listing of each book.
  native.calls.length = 0;
  await store.listPrefixes('books/');
  assert.deepEqual(native.calls.filter((call) => call !== 'status'), ['listZones', 'changes']);
});

test('cloudkit store: the change feed gives what changed since a token', async () => {
  const { native, store } = make();
  assert.equal(await store.changes(book), undefined, 'nothing for a book without a zone');
  await store.putIfAbsent('books/' + book + '/snapshots/one.json', bytes('{}'));
  await store.putIfAbsent('books/' + book + '/content/a', bytes('a'));
  await store.putIfAbsent('books/' + book + '/deleted.json', bytes('{}'));
  const first = await store.changes(book);
  assert.deepEqual(first?.changed.map(({ key, size }) => [key, size]), [['books/' + book + '/content/a', 1], ['books/' + book + '/snapshots/one.json', 2]], 'the tombstone is not in the feed');
  assert.deepEqual(first?.deleted, []);
  const quiet = await store.changes(book, first!.token);
  assert.deepEqual([quiet?.changed, quiet?.deleted], [[], []]);
  await store.putIfAbsent('books/' + book + '/content/b', bytes('bb'));
  await store.delete(['books/' + book + '/content/a']);
  const next = await store.changes(book, quiet!.token);
  assert.deepEqual(next?.changed.map(({ key }) => key), ['books/' + book + '/content/b']);
  assert.deepEqual(next?.deleted, ['books/' + book + '/content/a']);
  // A token CloudKit no longer accepts: the caller lists in full.
  native.expiredBefore = Infinity;
  await assert.rejects(store.changes(book, next!.token), ChangeTokenExpiredError);
  native.expiredBefore = 0;
  // The book's zone deleted on the server (another Mac deleted the book, or the user in System Settings).
  await store.delete(['books/' + book + '/content/b', 'books/' + book + '/snapshots/one.json']);
  assert.equal(await store.changes(book, next!.token), undefined);
  await store.putIfAbsent('books/' + other + '/content/x', bytes('x'));
  native.userDeletes(other);
  assert.equal(await store.changes(other), undefined);
});

test('cloudkit store: what CloudKit asks to retry is retried after the time it names, and nothing else is', async () => {
  const waits: number[] = [];
  const { native, store } = make({ onRetry: (_, seconds) => waits.push(seconds) });
  native.fail('putIfAbsent', 'requestRateLimited', { retryAfter: 0, times: 2 });
  assert.deepEqual(await store.putIfAbsent('remote.json', bytes('{}')), { existed: false });
  assert.deepEqual(waits, [0, 0]);
  native.fail('fetch', 'zoneBusy', { retryAfter: 0 });
  assert.deepEqual(await store.get('remote.json'), bytes('{}'));
  // Offline: at once, without waiting.
  native.fail('fetch', 'networkUnavailable', { retryAfter: 3 });
  await assert.rejects(store.get('remote.json'), (error: unknown) => error instanceof StoreAccessError && error.reason === 'unavailable' && error instanceof CloudKitAccessError && error.cloudKitReason === 'offline' && error.message === 'This Mac is offline.');
  // A call that keeps failing gives up after the attempts allowed.
  native.fail('fetch', 'serviceUnavailable', { retryAfter: 0, times: 10 });
  await assert.rejects(store.head('remote.json'), (error: unknown) => error instanceof StoreAccessError && isCloudKitError(error) && error.code === 'serviceUnavailable');
});

test('cloudkit store: iCloud storage full is an error of its own, and nothing is stored', async () => {
  const { native, store } = make();
  await store.putIfAbsent('books/' + book + '/content/one', bytes('1'));
  native.fail('putIfAbsent', 'quotaExceeded');
  await assert.rejects(store.putIfAbsent('books/' + book + '/originals/big.jpg', bytes('x'.repeat(300_000))),
    (error: unknown) => error instanceof CloudKitError && !(error instanceof StoreAccessError) && error.cloudKitReason === 'quota' && error.message === 'iCloud storage full.');
  assert.deepEqual((await store.list('books/')).map(({ key }) => key), ['books/' + book + '/content/one']);
  assert.deepEqual(await readdir(tmpdir()).then((names) => names.filter((name) => name.startsWith('imageflow-icloud-'))), [], 'no staging file stays');
});

test('cloudkit store: a zone deleted by another Mac is made again for a write, one the user deleted is not', async () => {
  const { native, store } = make();
  await store.putIfAbsent('books/' + book + '/content/one', bytes('1'));
  native.zones.delete(book);
  assert.deepEqual(await store.putIfAbsent('books/' + book + '/content/two', bytes('2')), { existed: false });
  native.userDeletes(book);
  await assert.rejects(store.putIfAbsent('books/' + book + '/content/three', bytes('3')), (error: unknown) => error instanceof CloudKitError && error.cloudKitReason === 'deleted');
  assert.equal(native.zones.has(book), false);
});

test('cloudkit store: without the entitlements CloudKit is never called', async () => {
  const { native, store } = make();
  native.statusValue = { entitled: false };
  for (const run of [() => store.putIfAbsent('remote.json', bytes('{}')), () => store.get('remote.json'), () => store.list(''), () => store.listPrefixes('books/'), () => store.changes(book), () => store.userRecordId()]) {
    await assert.rejects(run(), (error: unknown) => error instanceof StoreAccessError && error.reason === 'unavailable' && isCloudKitError(error) && error.cloudKitReason === 'not-entitled');
  }
  assert.deepEqual(new Set(native.calls), new Set(['status']));
  assert.deepEqual(cloudKitAvailability(await store.status()), { available: false, reason: 'not-entitled', message: 'iCloud sync is not available in this build of ImageFlow.' });
});

test('cloudkit store: account statuses read as sync statuses', () => {
  const status = (accountStatus: 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'couldNotDetermine') =>
    cloudKitAvailability({ entitled: true, container: 'iCloud.test', environment: 'Production', accountStatus });
  assert.deepEqual(status('available'), { available: true });
  assert.deepEqual(status('noAccount'), { available: false, reason: 'sign-in', message: 'Sign in to iCloud, or turn on iCloud for ImageFlow.' });
  assert.equal((status('restricted') as { reason: string }).reason, 'restricted');
  assert.equal((status('temporarilyUnavailable') as { reason: string }).reason, 'unavailable');
  assert.equal((status('couldNotDetermine') as { reason: string }).reason, 'unavailable');
  assert.equal(cloudKitReason('notAuthenticated'), 'sign-in');
  assert.equal(cloudKitReason('networkFailure'), 'offline');
  assert.equal(cloudKitReason('quotaExceeded'), 'quota');
  assert.equal(cloudKitReason('somethingNew'), 'other');
  assert.match(new CloudKitError('somethingNew', 'Details.').message, /Details\. \(somethingNew\)$/);
});

test('cloudkit store: iCloud out of reach is a store access error the sync status shows, one that answered is not', async () => {
  const { native, store } = make();
  native.fail('fetch', 'notAuthenticated');
  await assert.rejects(store.get('remote.json'), (error: unknown) => error instanceof StoreAccessError && error.reason === 'sign-in'
    && error.message === 'Sign in to iCloud, or turn on iCloud for ImageFlow.');
  native.fail('fetch', 'permissionFailure');
  await assert.rejects(store.get('remote.json'), (error: unknown) => error instanceof CloudKitError && !(error instanceof StoreAccessError));
});

test('cloudkit store: the account and its changes come from the addon', async () => {
  const { native, store } = make();
  assert.equal(await store.userRecordId(), '_user-one');
  let changes = 0;
  await store.onAccountChange(() => { changes++; });
  native.changeAccount();
  assert.equal(changes, 1);
});

// The real addon, in a process without the iCloud entitlements: it must report that, not trap inside CloudKit.
test('cloudkit addon: an unentitled process reports CloudKit as unavailable instead of crashing', { skip: process.platform !== 'darwin' }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'if-cloudkit-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const { buildCloudKit } = await import(join(process.cwd(), 'scripts', 'build-mac-header.mjs'));
  try { await buildCloudKit(work); }
  catch (error) { if (/Node-API headers/.test(String(error))) { t.skip('no Node-API headers'); return; } throw error; }
  const addon = join(work, 'native', 'cloudkit.node');
  // In a child process first, so a trap shows as a failed check rather than ending this test run.
  const script = 'require(process.argv[1]).status().then((status) => process.stdout.write(JSON.stringify(status)))';
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script, addon]);
  assert.deepEqual(JSON.parse(stdout), { entitled: false });
  const native = createRequire(import.meta.url)(addon) as CloudKitNative;
  assert.deepEqual(await native.status(), { entitled: false });
  assert.throws(() => native.saveZone('anything'), /not available in this build/);
  assert.equal(native.cancel(1), false);
});
