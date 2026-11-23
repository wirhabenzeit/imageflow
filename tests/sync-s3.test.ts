import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { amzDate, canonicalRequest, signRequest } from '../desktop/sync-s3-signer';
import { maxObjectSize, S3Store } from '../desktop/sync-store-s3';
import { syncPatchError } from '../desktop/sync-settings';
import { splitEndpoint } from '../src/sync-endpoint';
import { StoreAccessError } from '../desktop/sync-store';
import { StoreRemote } from '../desktop/sync-remote';
import { FileHeaderCache, MemoryHeaderCache } from '../desktop/sync-header-cache';
import { credentialScope, FileCredentialStore, MemoryCredentialStore } from '../desktop/sync-credentials';
import type { CredentialCipher } from '../desktop/sync-credentials';
import { normalizeS3Backend, s3BackendError, syncRemoteFor } from '../desktop/sync-backend';
import { SettingsStore } from '../desktop/settings';
import { commitKey, remoteIdentityKey } from '../src/sync-snapshot';
import { FakeS3, fakeCredentials } from './s3-fake';
import { cleanupS3, newS3Store, realBucket } from './s3-remote';
import { storeConformance } from './sync-store-conformance';

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const scratch = async (t: TestContext) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'if-s3-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
};
/** A fake server of the test's own, so its faults and modes touch no other test. */
async function server(t: TestContext, setup: (fake: FakeS3) => void = () => {}) {
  const fake = await new FakeS3().start();
  t.after(() => fake.close());
  setup(fake);
  fake.bucket('photos');
  const make = (options: Partial<ConstructorParameters<typeof S3Store>[0]> = {}) =>
    new S3Store({ endpoint: fake.url, region: fake.region, bucket: 'photos', credentials: fakeCredentials, retries: 3, retryDelay: 5, timeout: 2_000, ...options });
  return { fake, store: make(), make };
}
const objectKeys = (fake: FakeS3, bucket = 'photos') => [...fake.bucket(bucket).keys()].sort();

// The store contract, over the fake server (or a real bucket, with IMAGEFLOW_S3_TEST_*): `many` above S3's page size of
// 1,000, so the listing test pages; a checksum given to a put is checked.
storeConformance('s3', async () => newS3Store(), { many: 1005, sha256: 'checked' });
after(cleanupS3);
// Once more under a key prefix with characters that need encoding, so every request encodes keys the way it signs them.
if (!realBucket()) storeConformance('s3 under a prefix', async () => newS3Store({ prefix: 'Imageflow Sync/a+b (1)/' }), { many: 30 });

test('the SigV4 signer gives the signatures of the AWS documentation', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object" and the others.
  const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const now = new Date('2013-05-24T00:00:00Z');
  const signature = (headers: Record<string, string>) => /Signature=([0-9a-f]+)/.exec(headers.authorization)![1];
  const get = signRequest({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' },
    payloadSha256: sha(''), region: 'us-east-1', credentials, now });
  assert.equal(signature(get), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(get.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  const put = signRequest({ method: 'PUT', url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadSha256: sha('Welcome to Amazon S3.'), region: 'us-east-1', credentials, now });
  assert.equal(signature(put), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  const list = signRequest({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'), headers: {},
    payloadSha256: sha(''), region: 'us-east-1', credentials, now });
  assert.equal(signature(list), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  assert.equal(amzDate(now), '20130524T000000Z');
  // A query is sorted and encoded, an empty value keeps its `=`.
  assert.match(canonicalRequest('POST', new URL('https://h/b?delete'), { host: 'h' }, 'x'), /^POST\n\/b\ndelete=\n/);
});

test('an S3 store retries 5xx answers and dropped connections, and stores an upload whole and once', async (t) => {
  const { fake, store, make } = await server(t);
  const folder = await scratch(t);
  const file = join(folder, 'large.jpg');
  const content = new Uint8Array(1_500_000).map((_, index) => (index * 7) % 251);
  await writeFile(file, content);
  fake.fail({ status: 500 }, { method: 'PUT' });
  fake.fail('drop-mid-upload', { method: 'PUT' });
  fake.fail({ status: 503, code: 'SlowDown' }, { method: 'HEAD' });
  const seen: number[] = [];
  assert.deepEqual(await store.putIfAbsent('books/a/originals/large.jpg', { file }, { sha256: sha(content), onProgress: (done) => seen.push(done) }), { existed: false });
  assert.equal(sha(fake.bucket('photos').get('books/a/originals/large.jpg')!.bytes), sha(content), 'stored whole');
  const puts = fake.requests.filter(({ method }) => method === 'PUT');
  assert.equal(puts.length, 3, 'a 500, a dropped connection, then the upload');
  assert.ok(puts.every(({ headers }) => headers['x-amz-content-sha256'] === sha(content) && headers['content-length'] === String(content.length) && headers['if-none-match'] === '*'));
  assert.ok(puts.every(({ headers }) => !headers['transfer-encoding']), 'never chunked');
  assert.ok(seen.length > 1 && seen.every((value, index) => value >= (seen[index - 1] ?? 0)) && seen.at(-1) === content.length, 'progress goes forward, also across retries');
  // A download cut short is fetched again; the file is whole.
  fake.fail('cut-body', { method: 'GET' });
  assert.equal(await store.download('books/a/originals/large.jpg', join(folder, 'copy.jpg')), true);
  assert.equal(sha(await readFile(join(folder, 'copy.jpg'))), sha(content));
  assert.deepEqual((await readdir(folder)).sort(), ['copy.jpg', 'large.jpg']);
  // A request that never answers times out and is tried again.
  const quick = make({ timeout: 150 });
  fake.fail('hang', { method: 'HEAD' });
  assert.equal((await quick.head('books/a/originals/large.jpg'))?.size, content.length);
});

test('an S3 store gives up after its retries, as unavailable, and never retries a 4xx', async (t) => {
  const { fake, store, make } = await server(t);
  fake.fail({ status: 503, code: 'SlowDown' }, { times: 10 });
  const failure = await store.get('books/a/content/one').catch((error) => error);
  assert.ok(failure instanceof StoreAccessError && failure.reason === 'unavailable', String(failure));
  assert.match(failure.message, /not available right now \(503 SlowDown\)/);
  assert.equal(fake.requests.length, 4, 'the first attempt and three retries');
  fake.requests.length = 0;
  (fake as unknown as { faults: unknown[] }).faults.length = 0;
  fake.fail({ status: 403, code: 'AccessDenied' });
  const denied = await store.list('books/').catch((error) => error);
  assert.ok(denied instanceof StoreAccessError && denied.reason === 'sign-in');
  assert.match(denied.message, /^Sign-in needed: .*Settings → Sync\.$/);
  assert.equal(fake.requests.length, 1, 'a 403 is not retried');
  fake.requests.length = 0;
  fake.fail({ status: 400, code: 'InvalidRequest' });
  await assert.rejects(store.get('books/a/content/one'), /400 InvalidRequest/);
  assert.equal(fake.requests.length, 1, 'nor is a 400');
  // Nothing listens: offline.
  await fake.close();
  const offline = await make({ retries: 1 }).head('books/a/content/one').catch((error) => error);
  assert.ok(offline instanceof StoreAccessError && offline.reason === 'unavailable');
  assert.match(offline.message, /cannot be reached/);
});

test('a listing pages with continuation tokens, refuses one cut short, and lists child prefixes with Delimiter=/', async (t) => {
  const { fake, store, make } = await server(t, (fake) => { fake.pageSize = 3; });
  const keys = ['books/a/content/1', 'books/a/content/2', 'books/a/originals/3.jpg', 'books/b/deleted.json', 'books/c/snapshots/x.json', 'books/d/content/4', 'books/e/content/5', 'remote.json'];
  for (const key of keys) await store.putIfAbsent(key, bytes(key));
  fake.requests.length = 0;
  assert.deepEqual((await store.list('')).map(({ key }) => key), keys);
  assert.equal(fake.requests.length, 3, 'three pages of three');
  assert.deepEqual(fake.requests.map(({ query }) => query.has('continuation-token')), [false, true, true]);
  fake.requests.length = 0;
  assert.deepEqual(await store.listPrefixes('books/'), ['books/a/', 'books/b/', 'books/c/', 'books/d/', 'books/e/']);
  assert.ok(fake.requests.every(({ query }) => query.get('delimiter') === '/' && query.get('prefix') === 'books/'));
  assert.equal(fake.requests.length, 2, 'five prefixes in pages of three');
  // A listing that says it goes on without saying how is retried, and refused if it stays so.
  fake.fail('truncate-listing');
  assert.equal((await store.list('books/a/')).length, 3);
  fake.fail('truncate-listing', { times: 10 });
  const cut = await store.list('books/').catch((error) => error);
  assert.ok(cut instanceof StoreAccessError && /incomplete answer/.test(cut.message), String(cut));
  (fake as unknown as { faults: unknown[] }).faults.length = 0;
  fake.fail('cut-listing', { times: 10 });
  await assert.rejects(store.list('books/'), StoreAccessError);
  (fake as unknown as { faults: unknown[] }).faults.length = 0;
  // Keys that are no store keys (a folder marker, a hidden file) are not listed.
  fake.bucket('photos').set('books/a/', { bytes: new Uint8Array(), lastModified: new Date(), etag: '"x"' });
  fake.bucket('photos').set('books/a/.DS_Store', { bytes: new Uint8Array(), lastModified: new Date(), etag: '"x"' });
  assert.deepEqual((await store.list('books/a/')).map(({ key }) => key), keys.slice(0, 3));
  assert.ok((await store.list('books/a/')).every(({ etag }) => typeof etag === 'string'), 'with ETags');
});

test('CopyObject encodes its source with the prefix, and DeleteObjects goes in chunks of 1,000 with a Content-MD5', async (t) => {
  const { fake, store, make } = await server(t);
  const prefixed = make({ prefix: 'My Books/sync+1/' });
  await prefixed.putIfAbsent('books/a/snapshots/One (1).json', bytes('{}'));
  assert.equal(await prefixed.copy('books/a/snapshots/One (1).json', 'books/b/snapshots/One (1).json'), true);
  const copy = fake.requests.find(({ headers }) => headers['x-amz-copy-source'])!;
  assert.equal(copy.headers['x-amz-copy-source'], '/photos/My%20Books/sync%2B1/books/a/snapshots/One%20%281%29.json');
  assert.equal(copy.key, 'My Books/sync+1/books/b/snapshots/One (1).json');
  assert.deepEqual(objectKeys(fake), ['My Books/sync+1/books/a/snapshots/One (1).json', 'My Books/sync+1/books/b/snapshots/One (1).json']);
  assert.equal(await prefixed.copy('books/a/snapshots/missing.json', 'books/b/snapshots/missing.json'), false);
  // 2,345 keys: three requests of at most 1,000, the fake refusing any more in one.
  const many = Array.from({ length: 2345 }, (_, index) => 'books/c/content/' + String(index).padStart(5, '0'));
  for (const key of many) fake.bucket('photos').set(key, { bytes: bytes(key), lastModified: new Date(), etag: '"x"' });
  fake.requests.length = 0;
  await store.delete([...many, 'books/c/content/missing']);
  const deletes = fake.requests.filter(({ method }) => method === 'POST');
  assert.equal(deletes.length, 3);
  assert.ok(deletes.every(({ query, headers, status }) => query.has('delete') && !!headers['content-md5'] && status === 200));
  assert.deepEqual(objectKeys(fake).filter((key) => key.startsWith('books/c/')), []);
});

test('a put checks its SHA-256: the service refuses other bytes, and a file that changed is never stored, also by a service that does not check', async (t) => {
  const { fake, store, make } = await server(t);
  const folder = await scratch(t);
  const file = join(folder, 'photo.jpg');
  const content = new Uint8Array(400_000).map((_, index) => index % 13);
  await writeFile(file, content);
  // Bytes in memory are checked before anything is sent.
  await assert.rejects(store.putIfAbsent('books/a/content/x', bytes('real'), { sha256: sha('other') }), /does not have the SHA-256/);
  assert.equal(fake.requests.filter(({ method }) => method === 'PUT').length, 0);
  for (const mode of ['verified', 'ignored'] as const) {
    fake.checksums = mode;
    fake.requests.length = 0;
    // The checksum of other content, as for a file that changed after it was hashed.
    await assert.rejects(store.putIfAbsent('books/a/originals/' + mode + '.jpg', { file }, { sha256: sha('another photo') }), /does not have the SHA-256/, mode);
    assert.deepEqual(objectKeys(fake), [], mode + ': nothing stored');
    assert.ok(fake.requests.filter(({ method }) => method === 'PUT').length <= 1, mode + ': not retried');
  }
  fake.checksums = 'verified';
  assert.deepEqual(await store.putIfAbsent('books/a/originals/right.jpg', { file }, { sha256: sha(content) }), { existed: false });
  // Without a checksum the file is hashed first, and what is sent is checked against it.
  assert.deepEqual(await store.putIfAbsent('books/a/originals/hashed.jpg', { file }), { existed: false });
  assert.equal(fake.requests.at(-1)!.headers['x-amz-content-sha256'], sha(content));
});

test('a service that refuses If-None-Match gets a look, then a plain put, from then on', async (t) => {
  const { fake, store, make } = await server(t, (fake) => { fake.conditional = 'rejected'; });
  const s3 = make();
  assert.deepEqual(await s3.putIfAbsent('books/a/content/one', bytes('one')), { existed: false });
  assert.equal(s3.conditionalWrites, false);
  assert.deepEqual(await s3.putIfAbsent('books/a/content/one', bytes('two')), { existed: true }, 'found by the look first');
  fake.requests.length = 0;
  assert.deepEqual(await s3.putIfAbsent('books/a/content/two', bytes('two')), { existed: false });
  assert.deepEqual(fake.requests.map(({ method, headers }) => method + (headers['if-none-match'] ? ' conditional' : '')), ['HEAD', 'PUT']);
  assert.deepEqual(await s3.get('books/a/content/one'), bytes('one'));
  // The remote's identity is read back after the write, so it holds also here.
  const remote = new StoreRemote(make());
  const [first, second] = await Promise.all([remote.remoteId(), new StoreRemote(make()).remoteId()]);
  assert.equal(await new StoreRemote(make()).remoteId(), first);
  assert.ok(first === second || objectKeys(fake).includes(remoteIdentityKey));
});

test('Test Connection reports conditional writes and checksums, and leaves nothing behind', async (t) => {
  for (const [conditional, checksums, expected] of [['enforced', 'verified', { conditionalWrites: 'enforced', checksums: 'verified' }],
    ['ignored', 'ignored', { conditionalWrites: 'ignored', checksums: 'not-verified' }], ['rejected', 'verified', { conditionalWrites: 'unsupported', checksums: 'verified' }]] as const) {
    const { fake, store, make } = await server(t, (fake) => { fake.conditional = conditional; fake.checksums = checksums; });
    assert.deepEqual(await make({ prefix: 'sync/' }).testConnection(), { ...expected, addressing: 'path' });
    assert.deepEqual(objectKeys(fake), [], conditional + ': nothing left');
  }
  const { fake, store, make } = await server(t);
  fake.credentials = { ...fakeCredentials, secretAccessKey: 'another secret' };
  const failure = await make().testConnection().catch((error) => error);
  assert.ok(failure instanceof StoreAccessError && failure.reason === 'sign-in', String(failure));
});

test('the secret access key is never in an error, an inspection or JSON of a store', async (t) => {
  const { fake, store, make } = await server(t);
  const secret = 'wrong/secret+' + randomUUID();
  const s3 = make({ credentials: { accessKeyId: fakeCredentials.accessKeyId, secretAccessKey: secret } });
  const failures = await Promise.all([s3.head('books/a/content/x'), s3.list(''), s3.putIfAbsent('books/a/content/x', bytes('x')), s3.delete(['books/a/content/x'])].map((run) => run.catch((error) => error)));
  for (const error of failures) {
    assert.ok(error instanceof StoreAccessError && error.reason === 'sign-in', String(error));
    assert.ok(!inspect(error, { depth: 10 }).includes(secret) && !JSON.stringify(error).includes(secret) && !error.message.includes(fakeCredentials.accessKeyId));
  }
  assert.ok(!inspect(s3, { depth: 10, showHidden: true }).includes(secret));
  assert.ok(!JSON.stringify(s3).includes(secret));
  assert.ok(fake.requests.every(({ headers }) => !JSON.stringify(headers).includes(secret)), 'never sent');
});

test('an S3 setting is checked and normalized, and needs https except on this Mac', () => {
  const backend = { kind: 's3' as const, endpoint: 'https://s3.example.com/', region: 'auto', bucket: 'books', prefix: '/ImageFlow' };
  assert.equal(s3BackendError(backend), undefined);
  assert.deepEqual(normalizeS3Backend(backend), { kind: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'books', prefix: 'ImageFlow/' });
  assert.match(s3BackendError({ ...backend, endpoint: 'http://s3.example.com' })!, /https/);
  assert.equal(s3BackendError({ ...backend, endpoint: 'http://127.0.0.1:9000' }), undefined);
  assert.match(s3BackendError({ ...backend, endpoint: 'https://user:pw@s3.example.com' })!, /no user name or password/);
  // One path segment is the bucket (see the endpoint test below); a deeper path is not an endpoint.
  assert.match(s3BackendError({ ...backend, endpoint: 'https://s3.example.com/books/more' })!, /server address/);
  assert.match(s3BackendError({ ...backend, bucket: '' })!, /bucket/);
  assert.match(s3BackendError({ ...backend, prefix: '../up' })!, /prefix/);
  // AWS endpoints are addressed virtual-hosted, others path style, unless set.
  const credentials = fakeCredentials;
  assert.equal(new S3Store({ ...normalizeS3Backend(backend), endpoint: 'https://s3.eu-central-1.amazonaws.com', credentials }).url('a/b c').href, 'https://books.s3.eu-central-1.amazonaws.com/a/b%20c');
  assert.equal(new S3Store({ ...normalizeS3Backend(backend), credentials }).url('a/b c').href, 'https://s3.example.com/books/a/b%20c');
  assert.equal(new S3Store({ ...normalizeS3Backend(backend), addressing: 'virtual', credentials }).url().href, 'https://books.s3.example.com/');
});

test('settings keep the sync backend and never credentials', async (t) => {
  const folder = await scratch(t);
  const file = join(folder, 'settings.json');
  const settings = new SettingsStore(file);
  const backend = { kind: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'books' };
  await settings.update({ sync: backend });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).sync, backend);
  await assert.rejects(settings.update({ sync: { ...backend, secretAccessKey: 'secret' } }), /Invalid sync setting/);
  await assert.rejects(settings.update({ sync: { ...backend, endpoint: 'http://s3.example.com' } }), /https/);
  await settings.update({ sync: { kind: 'folder', path: '/Volumes/Drive/Sync' } });
  assert.deepEqual(settings.value.sync, { kind: 'folder', path: '/Volumes/Drive/Sync' });
  await settings.update({ sync: null });
  assert.equal(settings.value.sync, undefined);
  assert.ok(!(await readFile(file, 'utf8')).includes('secret'));
  // A sync setting this version cannot read is dropped, and the other settings stay.
  await writeFile(file, JSON.stringify({ appearance: 'dark', automaticUpdates: false, updateChannel: 'beta', sync: { kind: 'cloud', account: 'x' } }));
  const reloaded = new SettingsStore(file);
  await reloaded.load();
  assert.deepEqual(reloaded.value, { appearance: 'dark', automaticUpdates: false, updateChannel: 'beta' });
});

test('credentials are encrypted in a 0600 file of their own, per endpoint and bucket', async (t) => {
  const folder = await scratch(t);
  const file = join(folder, 'sync-credentials.json');
  // A stand-in for safeStorage that changes the bytes, so the file can be checked for plain text.
  let available = true;
  const cipher: CredentialCipher = { available: () => available, encrypt: (text) => Buffer.from([...Buffer.from(text)].map((byte) => byte ^ 0x5a)), decrypt: (data) => Buffer.from([...data].map((byte) => byte ^ 0x5a)).toString() };
  const store = new FileCredentialStore(file, cipher);
  const scope = credentialScope({ endpoint: 'https://s3.example.com/', bucket: 'books' });
  assert.equal(scope, 'https://s3.example.com/books');
  await store.write(scope, { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'very-secret-value' });
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, 'utf8');
  assert.ok(!text.includes('very-secret-value') && !text.includes('AKIAEXAMPLE'));
  assert.deepEqual(await new FileCredentialStore(file, cipher).read(scope), { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'very-secret-value' });
  assert.equal(await store.read(credentialScope({ endpoint: 'https://other.example.com', bucket: 'books' })), undefined, 'never for another server');
  // Without encryption nothing is written, and nothing can be read.
  available = false;
  await assert.rejects(store.write(scope, { accessKeyId: 'a', secretAccessKey: 'b' }), /cannot encrypt/);
  assert.equal(await store.read(scope), undefined);
  available = true;
  // Ciphertext from elsewhere reads as no credentials.
  assert.equal(await new FileCredentialStore(file, { ...cipher, decrypt: () => { throw new Error('other keychain'); } }).read(scope), undefined);
  await store.remove(scope);
  assert.equal(await store.read(scope), undefined);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(folder)).sort(), ['sync-credentials.json'], 'no temporary file stays');
});

test('a remote over an S3 setting needs stored credentials, and refuses with sign-in needed without them', async (t) => {
  const { fake } = await server(t);
  const backend = { kind: 's3' as const, endpoint: fake.url, region: fake.region, bucket: 'photos', prefix: 'sync' };
  const credentials = new MemoryCredentialStore();
  const missing = await syncRemoteFor(backend, { credentials }).catch((error) => error);
  assert.ok(missing instanceof StoreAccessError && missing.reason === 'sign-in' && /Settings → Sync/.test(missing.message));
  await credentials.write(credentialScope(backend), fakeCredentials);
  const remote = await syncRemoteFor(backend, { credentials, s3: { retryDelay: 1 } });
  const id = await remote.remoteId();
  assert.deepEqual(objectKeys(fake), ['sync/remote.json']);
  assert.equal(await (await syncRemoteFor(backend, { credentials })).remoteId(), id);
});

test('commit headers are read once per remote and book, and again only when the object behind a key changed', async (t) => {
  const { fake, store, make } = await server(t);
  const cache = new MemoryHeaderCache();
  const remote = new StoreRemote(make(), { headerCache: cache });
  const bookId = randomUUID();
  const header = (n: number, parents: string[] = []) => ({ version: 2 as const, commitId: '00000000-0000-4000-8000-00000000000' + n, bookId, parents,
    bookStateRevision: String(n).repeat(64), createdAt: '2026-11-23T10:00:00.000Z', title: 'Book ' + n, stateDigest: 'f'.repeat(64) });
  await remote.putCommit(header(1));
  // A remote without an identity yet is read whole and caches nothing.
  assert.equal((await remote.listCommits(bookId)).length, 1);
  assert.equal(cache.books.size, 0);
  const remoteId = await remote.remoteId();
  await remote.putCommit(header(2, [header(1).commitId]));
  const gets = () => fake.requests.filter(({ method, key }) => method === 'GET' && key.includes('/snapshots/')).length;
  fake.requests.length = 0;
  assert.deepEqual((await remote.listCommits(bookId)).map((value) => (value as { title: string }).title).sort(), ['Book 1', 'Book 2']);
  assert.equal(gets(), 2);
  fake.requests.length = 0;
  const fresh = new StoreRemote(make(), { headerCache: cache });
  assert.equal((await fresh.listCommits(bookId)).length, 2);
  assert.equal(gets(), 0, 'all from the cache');
  assert.deepEqual([...cache.books.keys()], [remoteId + '/' + bookId]);
  // A header deleted and stored again (other bytes) is read again; one gone is dropped.
  await fresh.store.delete([commitKey(bookId, header(1).commitId)]);
  await fresh.store.putIfAbsent(commitKey(bookId, header(1).commitId), bytes(JSON.stringify({ ...header(1), title: 'Book one' })));
  await fresh.store.delete([commitKey(bookId, header(2).commitId)]);
  fake.requests.length = 0;
  assert.deepEqual((await fresh.listCommits(bookId)).map((value) => (value as { title: string }).title), ['Book one']);
  assert.equal(gets(), 1);
  assert.deepEqual([...cache.books.get(remoteId + '/' + bookId)!.keys()], [commitKey(bookId, header(1).commitId)]);
  // On disk, by remote and book; a damaged file counts as empty.
  const folder = await scratch(t);
  const files = new FileHeaderCache(folder);
  const onDisk = new StoreRemote(make(), { headerCache: files });
  assert.equal((await onDisk.listCommits(bookId)).length, 1);
  assert.deepEqual(await readdir(join(folder, remoteId)), [bookId + '.json']);
  assert.equal((await files.read(remoteId, bookId)).size, 1);
  await writeFile(join(folder, remoteId, bookId + '.json'), '{ damaged');
  assert.equal((await files.read(remoteId, bookId)).size, 0);
  assert.equal((await onDisk.listCommits(bookId)).length, 1);
  assert.equal((await files.read('../escape', bookId)).size, 0, 'only plain identities name files');
});

test('an endpoint pasted with its bucket is split into server and bucket, and a stored setting never has a path', () => {
  const r2 = 'https://0123abcd.r2.cloudflarestorage.com';
  assert.deepEqual(splitEndpoint(r2 + '/photo-books'), { endpoint: r2, bucket: 'photo-books' });
  assert.deepEqual(splitEndpoint(r2 + '/photo-books/'), { endpoint: r2, bucket: 'photo-books' });
  assert.deepEqual(splitEndpoint(r2 + '/'), { endpoint: r2 });
  assert.deepEqual(splitEndpoint('https://s3.eu-central-1.amazonaws.com/books'), { endpoint: 'https://s3.eu-central-1.amazonaws.com', bucket: 'books' });
  // AWS virtual-hosted, where the split is unambiguous; the region comes along.
  assert.deepEqual(splitEndpoint('https://books.s3.eu-central-1.amazonaws.com'), { endpoint: 'https://s3.eu-central-1.amazonaws.com', bucket: 'books', region: 'eu-central-1' });
  assert.deepEqual(splitEndpoint('https://books.s3-eu-west-1.amazonaws.com/'), { endpoint: 'https://s3.eu-west-1.amazonaws.com', bucket: 'books', region: 'eu-west-1' });
  assert.deepEqual(splitEndpoint('https://books.s3.amazonaws.com'), { endpoint: 'https://s3.amazonaws.com', bucket: 'books' });
  for (const unclear of ['https://my.books.s3.eu-central-1.amazonaws.com', 'https://books.s3.dualstack.eu-central-1.amazonaws.com', 'https://books.s3-accelerate.amazonaws.com',
    'https://books.s3.eu-central-1.amazonaws.com/more']) assert.match((splitEndpoint(unclear) as { error: string }).error, /regional S3 endpoint/, unclear);
  for (const wrong of [r2 + '/photo-books/sub', r2 + '/photo-books?x=1', r2 + '/#bucket']) assert.match((splitEndpoint(wrong) as { error: string }).error, /server address/, wrong);
  // The main process splits the same way when it checks and stores a setting.
  const backend = { kind: 's3' as const, endpoint: r2 + '/photo-books', region: 'auto', bucket: '' };
  assert.equal(s3BackendError(backend), undefined);
  const stored = normalizeS3Backend(backend);
  assert.deepEqual(stored, { kind: 's3', endpoint: r2, region: 'auto', bucket: 'photo-books' });
  assert.equal(s3BackendError({ ...backend, bucket: 'photo-books' }), undefined);
  assert.match(s3BackendError({ ...backend, bucket: 'other' })!, /names the bucket “photo-books”, but Bucket is “other”/);
  assert.match(s3BackendError({ ...backend, endpoint: r2 + '/a/b' })!, /server address/);
  assert.deepEqual(normalizeS3Backend({ kind: 's3', endpoint: 'https://books.s3.eu-central-1.amazonaws.com', region: '', bucket: '' }),
    { kind: 's3', endpoint: 'https://s3.eu-central-1.amazonaws.com', region: 'eu-central-1', bucket: 'books' });
  // A setting entered either way keeps the credential scope of the server and bucket.
  assert.equal(credentialScope(stored), credentialScope({ endpoint: r2, bucket: 'photo-books' }));
});

test('a window may only turn sync off through the settings patch, and never set the books folder', () => {
  const backend = { kind: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'books' };
  assert.match(syncPatchError({ sync: backend })!, /Settings → Sync/);
  assert.match(syncPatchError({ sync: { kind: 'folder', path: '/tmp/x' } })!, /Settings → Sync/);
  assert.match(syncPatchError({ sync: { kind: 'icloud' } })!, /Settings → Sync/);
  assert.equal(syncPatchError({ sync: null }), undefined);
  assert.equal(syncPatchError({ sync: undefined }), undefined);
  assert.match(syncPatchError({ syncBooksUnchosen: true })!, /Settings → Sync/);
  assert.match(syncPatchError({ booksFolder: '/tmp' })!, /Settings → Sync/);
  assert.equal(syncPatchError({ appearance: 'dark' }), undefined);
  assert.equal(syncPatchError(undefined), undefined);
});

test('refusals say what to fix: the access key ID, the secret, the permission for the operation, or the clock', async (t) => {
  const { fake, make } = await server(t);
  await make().putIfAbsent('books/a/content/one', bytes('one'));
  const reasons = async (store: S3Store, run: (store: S3Store) => Promise<unknown>) => run(store).then(() => assert.fail('no error'), (error) => error as StoreAccessError);
  const unknownKey = await reasons(make({ credentials: { accessKeyId: 'AKIAUNKNOWN000000000', secretAccessKey: 'x' } }), (store) => store.get('books/a/content/one'));
  assert.equal(unknownKey.reason, 'sign-in');
  assert.match(unknownKey.message, /does not know this access key ID \(InvalidAccessKeyId\)/);
  const wrongSecret = { credentials: { ...fakeCredentials, secretAccessKey: 'not the secret' } };
  for (const run of [(store: S3Store) => store.get('books/a/content/one'), (store: S3Store) => store.head('books/a/content/one'), (store: S3Store) => store.list('books/')]) {
    const error = await reasons(make(wrongSecret), run);
    assert.equal(error.reason, 'sign-in');
    assert.match(error.message, /^Sign-in needed: the secret access key does not match the access key ID \(SignatureDoesNotMatch\)\. Enter it again in Settings → Sync\.$/);
  }
  // A valid key without the permission: which operation, and what the key needs.
  for (const [operation, method, run] of [['read objects in', 'GET', (store: S3Store) => store.get('books/a/content/one')], ['write objects to', 'PUT', (store: S3Store) => store.putIfAbsent('books/a/content/two', bytes('2'))],
    ['list the objects of', 'GET', (store: S3Store) => store.list('books/')], ['delete objects from', 'POST', (store: S3Store) => store.delete(['books/a/content/one'])]] as const) {
    fake.fail({ status: 403, code: 'AccessDenied' }, { method, match: operation === 'list the objects of' ? /list-type/ : operation === 'read objects in' ? /content\/one$/ : undefined });
    const error = await reasons(make(), run);
    assert.equal(error.reason, 'sign-in', operation);
    assert.match(error.message, new RegExp('may not ' + operation + ' the bucket “photos” \\(AccessDenied\\)\\. It needs permission to read, write, list and delete objects'));
  }
  // A HEAD refused without a body is explained by the same read with one.
  fake.fail({ status: 403, code: 'AllAccessDisabled' }, { method: 'HEAD' });
  fake.fail({ status: 403, code: 'AllAccessDisabled' }, { method: 'GET' });
  assert.match((await reasons(make(), (store) => store.head('books/a/content/one'))).message, /may not read objects in the bucket “photos” \(AllAccessDisabled\)/);
  // A clock too far off is not a sign-in.
  fake.clockOffset = 20 * 60_000;
  const skewed = await reasons(make(), (store) => store.get('books/a/content/one'));
  assert.equal(skewed.reason, 'clock');
  assert.match(skewed.message, /This Mac’s clock is too far off .*\(RequestTimeTooSkewed\).*Date & Time/);
  assert.ok(!/access key/i.test(skewed.message));
  // Test Connection reports the same.
  assert.equal((await reasons(make(), (store) => store.testConnection())).reason, 'clock');
  fake.clockOffset = 0;
  assert.match((await reasons(make(wrongSecret), (store) => store.testConnection())).message, /SignatureDoesNotMatch/);
});

test('a redirect to another region or endpoint is never followed nor retried, and names where the bucket is', async (t) => {
  const { fake, make } = await server(t);
  const elsewhere = await new FakeS3().start();
  t.after(() => elsewhere.close());
  elsewhere.bucket('photos');
  fake.fail({ status: 301, code: 'PermanentRedirect', region: 'eu-west-1', endpoint: 'photos.s3.eu-west-1.amazonaws.com' });
  const moved = await make().list('books/').catch((error) => error);
  assert.ok(moved instanceof StoreAccessError && moved.reason === 'settings', String(moved));
  assert.match(moved.message, /is in the region “eu-west-1”, not “us-east-1” \(PermanentRedirect\)\. Set Region to eu-west-1 in Settings → Sync\./);
  assert.equal(fake.requests.length, 1, 'not retried');
  // A HEAD has no body: the region comes from x-amz-bucket-region.
  fake.requests.length = 0;
  fake.fail({ status: 301, code: 'PermanentRedirect', region: 'ap-south-1' }, { method: 'HEAD' });
  assert.match((await make().head('books/a/content/one').catch((error) => error)).message, /region “ap-south-1”/);
  // A temporary redirect with a Location is not followed: the signed request never goes there.
  fake.fail({ status: 307, code: 'TemporaryRedirect', endpoint: 'photos.s3-external-1.amazonaws.com', location: elsewhere.url + '/photos/books/a/content/one' });
  const temporary = await make().get('books/a/content/one').catch((error) => error);
  assert.match(temporary.message, /is served at photos\.s3-external-1\.amazonaws\.com.*\(TemporaryRedirect\)/);
  assert.equal(elsewhere.requests.length, 0, 'nothing reached the Location');
  // Signed for the wrong region: S3 answers 400 AuthorizationHeaderMalformed, naming the right one.
  fake.requests.length = 0;
  const wrongRegion = await make({ region: 'eu-central-1' }).list('').catch((error) => error);
  assert.ok(wrongRegion instanceof StoreAccessError && wrongRegion.reason === 'settings');
  assert.match(wrongRegion.message, /is in the region “us-east-1”, not “eu-central-1” \(AuthorizationHeaderMalformed\)/);
  assert.equal(fake.requests.length, 1);
});

test('a missing bucket is an error that points at Settings, not an empty remote, and is checked once per store', async (t) => {
  const { fake, make } = await server(t);
  const folder = await scratch(t);
  const missing = make({ bucket: 'photoz' });
  for (const run of [() => missing.head('books/a/content/one'), () => missing.get('books/a/content/one'), () => missing.download('books/a/content/one', join(folder, 'x')),
    () => missing.list('books/'), () => missing.listPrefixes('books/'), () => missing.putIfAbsent('books/a/content/one', bytes('1')), () => missing.copy('books/a/content/one', 'books/b/content/one'),
    () => new StoreRemote(missing).listBooks()]) {
    const error = await run().catch((failure) => failure);
    assert.ok(error instanceof StoreAccessError && error.reason === 'settings', String(error));
    assert.match(error.message, /^There is no bucket “photoz” at 127\.0\.0\.1:\d+ \(NoSuchBucket\)\. Check its name and the endpoint in Settings → Sync\.$/);
  }
  assert.deepEqual(await readdir(folder), []);
  // An existing bucket: the first HEAD that finds nothing is checked with a read, later ones are not.
  const store = make();
  fake.requests.length = 0;
  assert.equal(await store.head('books/a/content/one'), undefined);
  assert.deepEqual(fake.requests.map(({ method }) => method), ['HEAD', 'GET']);
  fake.requests.length = 0;
  assert.equal(await store.head('books/a/content/two'), undefined);
  assert.equal(await store.get('books/a/content/two'), undefined);
  assert.deepEqual(fake.requests.map(({ method }) => method), ['HEAD', 'GET']);
  // A store that has seen the bucket answer needs no check at all.
  const other = make();
  await other.list('');
  fake.requests.length = 0;
  assert.equal(await other.head('books/a/content/one'), undefined);
  assert.equal(fake.requests.length, 1);
});

test('conditional writes go off only when a plain put works, or the refusal names the condition', async (t) => {
  const { fake, make } = await server(t);
  // A 400 that was about the condition: the plain put works, so the store stops sending it.
  const refusing = make();
  await refusing.list('');
  fake.fail({ status: 400, code: 'InvalidArgument' }, { method: 'PUT' });
  assert.deepEqual(await refusing.putIfAbsent('books/a/content/one', bytes('one')), { existed: false });
  assert.equal(refusing.conditionalWrites, false);
  // A 400 for another reason, which the plain put gets too: reported, and conditional writes stay on.
  const other = make();
  fake.fail({ status: 400, code: 'InvalidArgument', message: 'Invalid storage class.' }, { method: 'PUT', times: 2 });
  await assert.rejects(other.putIfAbsent('books/a/content/two', bytes('two')), /400 InvalidArgument\): Invalid storage class/);
  assert.equal(other.conditionalWrites, true);
  assert.equal(fake.bucket('photos').has('books/a/content/two'), false);
  // A refusal that names the header turns them off even when the plain put fails for another reason.
  const named = make();
  fake.fail({ status: 400, code: 'InvalidRequest', message: 'If-None-Match is not supported.' }, { method: 'PUT' });
  fake.fail({ status: 403, code: 'AccessDenied' }, { method: 'PUT' });
  await assert.rejects(named.putIfAbsent('books/a/content/three', bytes('three')), /may not write objects to/);
  assert.equal(named.conditionalWrites, false);
});

test('a file over the 5 GiB of a single PUT is refused before anything is sent', async (t) => {
  const { fake, store } = await server(t);
  const folder = await scratch(t);
  const file = join(folder, 'Panorama.tif');
  await writeFile(file, '');
  // Sparse: no 5 GiB are written.
  await truncate(file, maxObjectSize + 1);
  fake.requests.length = 0;
  await assert.rejects(store.putIfAbsent('books/a/originals/' + 'f'.repeat(64) + '.tif', { file }), /^Error: “Panorama\.tif” is 5\.0 GiB, more than the 5 GiB one upload to a bucket can hold/);
  assert.equal(fake.requests.length, 0);
  assert.equal(maxObjectSize, 5 * 1024 ** 3);
});
