import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveNetwork, approvedNetwork, configureSourceAccess, sourceBookKey } from '../desktop/source-access';
import { networkPendingIssue, pendingNetwork } from '../src/network-access';

// A book's network approvals (ADR 0006) belong to the book, not to one version of its template, so editing the
// template never asks again for sites it was already allowed to reach.
const hash = 'a'.repeat(64);

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'imageflow-network-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const book = join(root, 'book.imageflow');
  await mkdir(book);
  configureSourceAccess(join(root, 'source-access'));
  return { root, book };
}

test('approved origins hold for the book across template versions and restarts', async (t) => {
  const { root, book } = await fixture(t);
  assert.deepEqual(await approvedNetwork(book), []);
  await approveNetwork(book, ['https://tiles.example.com'], hash);
  await approveNetwork(book, ['https://tiles.example.com', 'https://api.example.com']);
  assert.deepEqual((await approvedNetwork(book)).sort(), ['https://api.example.com', 'https://tiles.example.com']);
  configureSourceAccess(join(root, 'source-access'));
  assert.deepEqual((await approvedNetwork(book)).sort(), ['https://api.example.com', 'https://tiles.example.com'], 'approvals survive a restart');
  const stored = JSON.parse(await readFile(join(root, 'source-access', await sourceBookKey(book) + '.json'), 'utf8'));
  assert.equal(stored['network:https://tiles.example.com'].hash, hash, 'an existing approval is not rewritten');
});

test('approvals stored with a template hash by earlier versions keep working', async (t) => {
  const { root, book } = await fixture(t);
  await mkdir(join(root, 'source-access'), { recursive: true });
  await writeFile(join(root, 'source-access', await sourceBookKey(book) + '.json'), JSON.stringify({
    'network:https://api.mapbox.com': { path: 'https://api.mapbox.com', hash: 'c'.repeat(64) },
    'photo-1': { path: '/Photos/one.jpg' },
  }));
  configureSourceAccess(join(root, 'source-access'));
  assert.deepEqual(await approvedNetwork(book), ['https://api.mapbox.com']);
});

test('declared origins the book may not reach are reported as waiting for permission', () => {
  assert.deepEqual(pendingNetwork(['https://a.example.com', 'https://b.example.com'], ['https://a.example.com']), ['https://b.example.com']);
  assert.deepEqual(pendingNetwork(['https://a.example.com'], undefined), [], 'no report when the app did not decide the origins');
  assert.deepEqual(pendingNetwork(undefined, []), []);
  const issue = networkPendingIssue(['https://b.example.com']);
  assert.equal(issue.code, 'network-permission-pending');
  assert.equal(issue.details.origins, 'https://b.example.com');
  assert.match(issue.suggestion, /Allow/);
});
