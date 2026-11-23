import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { StoreRemote } from '../desktop/sync-remote';
import { CloudKitStore } from '../desktop/sync-store-cloudkit';
import type { CloudKitNative } from '../desktop/sync-store-cloudkit';
import { MemoryKeyIndexCache } from '../desktop/sync-key-index';
import { commitHeaderVersion, contentBlobKey } from '../src/sync-snapshot';
import { storeConformance } from './sync-store-conformance';

/*
 * The iCloud store against the real CloudKit (#292): the store conformance suite and the change feed under StoreRemote.
 * Needs a build entitled to iCloud and a Mac signed in to it, so it runs inside the packaged app in Node mode
 * (`npm run test:cloudkit`, scripts/test-cloudkit.mjs), never in CI. Every test gets zones of its own under a namespace
 * (`test-<run>-<n>-`) in the user's private database, deleted again afterwards.
 */
const native = createRequire(import.meta.url)(process.env.IMAGEFLOW_CLOUDKIT_ADDON!) as CloudKitNative;
const status = await native.status();
assert.ok(status.entitled, 'This process is not entitled to iCloud: run it inside a build signed with the Developer ID provisioning profile.');
assert.equal(status.accountStatus, 'available', 'iCloud is not available on this Mac: ' + status.accountStatus);
console.log('CloudKit:', status.container, status.environment);

const run = 'test-' + randomUUID().slice(0, 8) + '-';
let next = 0;
async function cleanup(namespace: string) {
  const zones = (await native.listZones()).filter((zone) => zone.startsWith(namespace));
  if (zones.length) await native.deleteZones(zones);
}
const fresh = (t: { after: (run: () => Promise<void>) => void }) => {
  const namespace = run + next++ + '-';
  t.after(() => cleanup(namespace));
  return new CloudKitStore(native, { namespace });
};

storeConformance('cloudkit (iCloud)', async (t) => fresh(t));

test('cloudkit (iCloud): a second listing of a book asks only for what changed', async (t) => {
  const store = fresh(t);
  const remote = new StoreRemote(store, { keyIndex: new MemoryKeyIndexCache() });
  await remote.remoteId();
  const bookId = randomUUID();
  const header = (commitId: string, parents: string[]) => ({ version: commitHeaderVersion as 2, commitId, bookId, parents, bookStateRevision: 'a'.repeat(64),
    createdAt: new Date().toISOString(), title: 'Book', stateDigest: 'b'.repeat(64) });
  const first = randomUUID();
  await remote.putCommit(header(first, []));
  await remote.putBlob(contentBlobKey(bookId, 'c'.repeat(64)), new TextEncoder().encode('content'));
  assert.equal((await remote.listCommits(bookId)).length, 1);
  await new StoreRemote(store).putCommit(header(randomUUID(), [first]));
  const started = Date.now();
  assert.equal((await remote.listCommits(bookId)).length, 2);
  console.log('Changes since the token: ' + (Date.now() - started) + ' ms');
  assert.equal(await remote.hasBlob(contentBlobKey(bookId, 'c'.repeat(64))), true);
});
