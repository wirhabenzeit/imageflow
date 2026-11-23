import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySha256, signRequest } from '../desktop/sync-s3-signer';
import { S3Store } from '../desktop/sync-store-s3';
import { cleanupS3, newS3Store, realBucket } from './s3-remote';

/**
 * The S3 spike of #281 against a real bucket: off unless IMAGEFLOW_S3_TEST_* name one (tests/s3-remote.ts,
 * docs/development/testing.md). It answers the spike's questions for the configured service and prints them as test
 * diagnostics; with IMAGEFLOW_S3_TEST_REPORT=<file> it also writes them as JSON. The store conformance suite
 * (tests/sync-s3.test.ts) and the engine scenarios (tests/sync-s3-store.test.ts) run against the same bucket in the
 * same `npm run test:unit`.
 */
const real = realBucket();
const answers: Record<string, unknown> = {};
after(async () => {
  await cleanupS3();
  if (real && process.env.IMAGEFLOW_S3_TEST_REPORT) await writeFile(process.env.IMAGEFLOW_S3_TEST_REPORT, JSON.stringify({ endpoint: real.endpoint, region: real.region, answers }, null, 2) + '\n');
});

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sha64 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('base64');
const bytes = (text: string) => new TextEncoder().encode(text);

/** One signed request outside the store, to ask the service what the store does not. */
async function raw(store: S3Store, method: string, key: string | undefined, { body, headers = {}, claimed, query = '' }: { body?: Uint8Array; headers?: Record<string, string>; claimed?: string; query?: string } = {}) {
  const url = store.url(key === undefined ? undefined : store.prefix + key, query);
  const signed = signRequest({ method, url, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) }, payloadSha256: claimed ?? (body ? sha(body) : emptySha256),
    region: store.region, credentials: real!.credentials });
  const response = await fetch(url, { method, headers: signed, ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}) });
  const text = await response.text();
  return { status: response.status, code: /<Code>([^<]*)<\/Code>/.exec(text)?.[1], headers: response.headers };
}

const spike = (title: string, run: (t: TestContext) => Promise<void>) => real ? test('S3 spike (real bucket): ' + title, run)
  : test('S3 spike (real bucket): ' + title, { skip: 'set IMAGEFLOW_S3_TEST_ENDPOINT and the other IMAGEFLOW_S3_TEST_* variables to run' });

spike('Test Connection', async (t) => {
  const report = await (await newS3Store()).testConnection();
  answers.testConnection = report;
  t.diagnostic(JSON.stringify(report));
});

spike('does If-None-Match: * on PUT work?', async (t) => {
  const store = await newS3Store();
  const key = 'spike/conditional-' + randomUUID();
  const first = await raw(store, 'PUT', key, { body: bytes('first'), headers: { 'if-none-match': '*' } });
  const second = await raw(store, 'PUT', key, { body: bytes('second'), headers: { 'if-none-match': '*' } });
  const kept = await store.get(key);
  answers.ifNoneMatch = { first: first.status + ' ' + (first.code ?? ''), second: second.status + ' ' + (second.code ?? ''), kept: kept && new TextDecoder().decode(kept) };
  t.diagnostic(JSON.stringify(answers.ifNoneMatch));
  // Whatever the service does, the store keeps its promise: putIfAbsent never replaces.
  assert.deepEqual(await store.putIfAbsent(key, bytes('third')), { existed: true });
});

spike('does a single PUT verify x-amz-content-sha256, and how does x-amz-checksum-sha256 behave?', async (t) => {
  const store = await newS3Store();
  const body = bytes('checked ' + randomUUID());
  const wrongContent = await raw(store, 'PUT', 'spike/content-sha', { body, claimed: sha('other') });
  const rightChecksum = await raw(store, 'PUT', 'spike/checksum-right', { body, headers: { 'x-amz-checksum-sha256': sha64(body) } });
  const wrongChecksum = await raw(store, 'PUT', 'spike/checksum-wrong', { body, headers: { 'x-amz-checksum-sha256': sha64('other') } });
  const head = await raw(store, 'HEAD', 'spike/checksum-right', { headers: { 'x-amz-checksum-mode': 'ENABLED' } });
  answers.checksums = {
    wrongContentSha256: wrongContent.status + ' ' + (wrongContent.code ?? ''),
    rightChecksumSha256: rightChecksum.status + ' ' + (rightChecksum.code ?? ''),
    wrongChecksumSha256: wrongChecksum.status + ' ' + (wrongChecksum.code ?? ''),
    checksumReturnedByHead: head.headers.get('x-amz-checksum-sha256') === sha64(body),
  };
  t.diagnostic(JSON.stringify(answers.checksums));
});

spike('path-style and virtual-hosted endpoints', async (t) => {
  const results: Record<string, string> = {};
  for (const addressing of ['path', 'virtual'] as const) {
    const store = new S3Store({ ...real!, prefix: real!.prefix + 'addressing/', addressing, retries: 0 });
    results[addressing] = await store.list('').then(() => 'works', (error: Error) => 'fails: ' + error.message);
  }
  answers.addressing = results;
  t.diagnostic(JSON.stringify(results));
});

spike('is a listing consistent right after a put?', async (t) => {
  const store = await newS3Store();
  let missing = 0;
  for (let index = 0; index < 20; index++) {
    const key = 'spike/consistency/' + String(index).padStart(3, '0');
    await store.putIfAbsent(key, bytes(key));
    if (!(await store.list('spike/consistency/')).some((entry) => entry.key === key)) missing++;
    if (!(await store.head(key))) missing++;
  }
  answers.listAfterPut = { puts: 20, notSeenAtOnce: missing };
  t.diagnostic(JSON.stringify(answers.listAfterPut));
  assert.equal(missing, 0, 'a put is listed at once');
});

spike('a large original goes up in one streamed PUT and comes back whole', async (t) => {
  const store = await newS3Store();
  const folder = await mkdtemp(join(tmpdir(), 'if-s3-real-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'large.jpg');
  const content = new Uint8Array(24 * 1024 * 1024).map((_, index) => (index * 31) % 251);
  await writeFile(file, content);
  const reports: number[] = [];
  const started = Date.now();
  await store.putIfAbsent('spike/large.jpg', { file }, { sha256: sha(content), onProgress: (done) => reports.push(done) });
  const uploaded = Date.now() - started;
  assert.equal(await store.download('spike/large.jpg', join(folder, 'back.jpg')), true);
  assert.equal(sha(await readFile(join(folder, 'back.jpg'))), sha(content));
  answers.largeUpload = { bytes: content.length, milliseconds: uploaded, progressReports: reports.length };
  t.diagnostic(JSON.stringify(answers.largeUpload));
});
