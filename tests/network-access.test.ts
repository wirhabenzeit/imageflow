import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { approveNetwork, approvedNetwork, approveSource, approvedSource, bookTrusted, configureSourceAccess, distrustBook, sourceBookKey, transferBookTrust, trustBook } from '../desktop/source-access';
import { networkPendingSuggestion, pendingNetwork } from '../src/network-access';

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
  assert.match(networkPendingSuggestion(['https://b.example.com']), /Allow/);
});

test('a book is the user\'s own once trusted, survives restarts, and can be untrusted', async (t) => {
  const { root, book } = await fixture(t);
  assert.equal(await bookTrusted(book), false, 'a book from elsewhere is not trusted');
  await trustBook(book);
  assert.equal(await bookTrusted(book), true);
  configureSourceAccess(join(root, 'source-access'));
  assert.equal(await bookTrusted(book), true, 'the mark survives a restart');
  await approveNetwork(book, ['https://tiles.example.com']);
  const photo = join(root, 'one.jpg');
  await writeFile(photo, '');
  await approveSource(book, { key: 'photo:1', kind: 'photo', path: photo, linked: true });
  await distrustBook(book);
  assert.equal(await bookTrusted(book), false);
  assert.deepEqual(await approvedNetwork(book), [], 'untrusting withdraws the allowed sites');
  assert.equal(await approvedSource(book, { key: 'photo:1', kind: 'photo', path: await realpath(photo), linked: true }), true, 'linked originals stay approved');
});

test('a book that had sites allowed before the mark existed counts as trusted', async (t) => {
  const { book } = await fixture(t);
  await approveNetwork(book, ['https://api.mapbox.com'], hash);
  assert.equal(await bookTrusted(book), true);
});

test('a saved copy of a trusted book is trusted, with its sites; a copy of another book is not', async (t) => {
  const { root, book } = await fixture(t);
  const copy = join(root, 'copy.imageflow'), other = join(root, 'other.imageflow'), otherCopy = join(root, 'other-copy.imageflow');
  await Promise.all([mkdir(copy), mkdir(other), mkdir(otherCopy)]);
  await trustBook(book);
  await approveNetwork(book, ['https://tiles.example.com']);
  await transferBookTrust(book, copy);
  assert.equal(await bookTrusted(copy), true);
  assert.deepEqual(await approvedNetwork(copy), ['https://tiles.example.com']);
  await transferBookTrust(other, otherCopy);
  assert.equal(await bookTrusted(otherCopy), false);
});
