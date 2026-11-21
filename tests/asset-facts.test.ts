import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetsMetaSchema, resolveAssetFact } from '../src/asset-facts';
import type { AssetFact } from '../src/asset-facts';

const fact = (digest: string, verified: string, width = 100): AssetFact => ({ digest: digest.repeat(64).slice(0, 64), width, height: 50, verified });
const old = fact('a', '2026-01-01T00:00:00.000Z');
const recent = fact('b', '2026-02-01T00:00:00.000Z');

test('a replica with an available verified original wins, even against a newer observation', () => {
  assert.deepEqual(resolveAssetFact({ local: old, remote: recent, localOriginalVerified: true }), { winner: 'local', fact: old });
  assert.deepEqual(resolveAssetFact({ local: old, remote: recent, localOriginalVerified: false, remoteOriginalVerified: true }), { winner: 'remote', fact: recent });
});

test('without a verified original on either side, or on both, the newer observation wins and a tie keeps the local entry', () => {
  assert.equal(resolveAssetFact({ local: old, remote: recent, localOriginalVerified: false })!.winner, 'remote');
  assert.equal(resolveAssetFact({ local: recent, remote: old, localOriginalVerified: false })!.winner, 'local');
  assert.equal(resolveAssetFact({ local: old, remote: recent, localOriginalVerified: true, remoteOriginalVerified: true })!.winner, 'remote');
  assert.equal(resolveAssetFact({ local: { ...old, digest: 'c'.repeat(64) }, remote: old, localOriginalVerified: false })!.winner, 'local');
});

test('an entry on one side only is taken, and nothing on either side resolves to nothing', () => {
  assert.deepEqual(resolveAssetFact({ remote: recent, localOriginalVerified: false }), { winner: 'remote', fact: recent });
  assert.deepEqual(resolveAssetFact({ local: old, localOriginalVerified: false }), { winner: 'local', fact: old });
  assert.equal(resolveAssetFact({ localOriginalVerified: true }), undefined);
});

test('assets-meta.json needs version 1 and complete facts', () => {
  assert.ok(assetsMetaSchema.safeParse({ version: 1, assets: { a: old } }).success);
  assert.ok(assetsMetaSchema.safeParse({ version: 1, assets: { a: { ...old, captured: { dateTime: '2024-06-01T18:20:30', offset: null }, camera: { make: 'X' } } } }).success);
  assert.equal(assetsMetaSchema.safeParse({ version: 2, assets: {} }).success, false);
  assert.equal(assetsMetaSchema.safeParse({ version: 1, assets: { a: { ...old, width: 0 } } }).success, false);
  assert.equal(assetsMetaSchema.safeParse({ version: 1, assets: { a: { ...old, digest: 'short' } } }).success, false);
});
