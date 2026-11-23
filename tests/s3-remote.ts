import { randomUUID } from 'node:crypto';
import { StoreRemote } from '../desktop/sync-remote';
import { S3Store } from '../desktop/sync-store-s3';
import type { S3StoreOptions } from '../desktop/sync-store-s3';
import { FakeS3 } from './s3-fake';

/**
 * S3 stores for tests: over the fake server (tests/s3-fake.ts) by default, or over a real bucket when the environment
 * names one. The real run is off unless these are set (see docs/development/testing.md, "S3 against a real bucket"):
 *
 *     IMAGEFLOW_S3_TEST_ENDPOINT=https://<account>.r2.cloudflarestorage.com
 *     IMAGEFLOW_S3_TEST_REGION=auto
 *     IMAGEFLOW_S3_TEST_BUCKET=imageflow-test
 *     IMAGEFLOW_S3_TEST_ACCESS_KEY_ID=…
 *     IMAGEFLOW_S3_TEST_SECRET_ACCESS_KEY=…
 *     IMAGEFLOW_S3_TEST_PREFIX=imageflow-test/        (optional; every run writes below <prefix>run-<uuid>/)
 *     IMAGEFLOW_S3_TEST_ADDRESSING=path|virtual       (optional)
 *
 * Each store gets a prefix of its own below the run's, and `cleanupS3` deletes what the run left.
 */
export function realBucket(): Omit<S3StoreOptions, 'prefix'> & { prefix: string } | undefined {
  const env = process.env;
  if (!env.IMAGEFLOW_S3_TEST_ENDPOINT) return undefined;
  const missing = ['REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].filter((name) => !env['IMAGEFLOW_S3_TEST_' + name]);
  if (missing.length) throw new Error('The real-bucket test needs ' + missing.map((name) => 'IMAGEFLOW_S3_TEST_' + name).join(', ') + '.');
  const addressing = env.IMAGEFLOW_S3_TEST_ADDRESSING;
  return {
    endpoint: env.IMAGEFLOW_S3_TEST_ENDPOINT, region: env.IMAGEFLOW_S3_TEST_REGION!, bucket: env.IMAGEFLOW_S3_TEST_BUCKET!,
    credentials: { accessKeyId: env.IMAGEFLOW_S3_TEST_ACCESS_KEY_ID!, secretAccessKey: env.IMAGEFLOW_S3_TEST_SECRET_ACCESS_KEY! },
    prefix: (env.IMAGEFLOW_S3_TEST_PREFIX ?? 'imageflow-test/').replace(/\/?$/, '/') + 'run-' + runId + '/',
    ...(addressing === 'path' || addressing === 'virtual' ? { addressing } : {}),
  };
}
const runId = randomUUID();

let fake: Promise<FakeS3> | undefined;
/** The fake server this process shares between its tests. */
export const sharedFake = () => (fake ??= new FakeS3().start().then((server) => server.unref()));

const made: S3Store[] = [];
let count = 0;
/** A new, empty S3 store: a bucket of its own on the fake server, or a prefix of its own in the real bucket. */
export async function newS3Store(options: Partial<S3StoreOptions> = {}) {
  const real = realBucket();
  const index = ++count;
  if (real) {
    const store = new S3Store({ ...real, prefix: real.prefix + index + '/', retries: 2, ...options });
    made.push(store);
    return store;
  }
  const server = await sharedFake();
  const bucket = 'bucket-' + index;
  server.bucket(bucket);
  return new S3Store({ endpoint: server.url, region: server.region, bucket, credentials: server.credentials, retries: 3, retryDelay: 5, timeout: 5_000, ...options });
}

/** A sync remote over a new S3 store. */
export const s3Remote = async (options: Partial<S3StoreOptions> = {}) => new StoreRemote(await newS3Store(options));

/** Deletes everything the stores of a real-bucket run wrote. */
export async function cleanupS3() {
  for (const store of made.splice(0)) await store.delete((await store.list('')).map(({ key }) => key)).catch(() => {});
}
