import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ProxyStore } from '../desktop/proxy-store';

async function store(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-proxies-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, proxies: await ProxyStore.at(join(root, 'Cache', 'proxies')) };
}
const jpeg = (width = 60, height = 40) => sharp({ create: { width, height, channels: 3, background: 'teal' } }).jpeg().toBuffer();
const png = () => sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
const digest = (c: string) => c.repeat(64);

test('put stores a proxy by digest from bytes or a file, and path finds it', async (t) => {
  const { root, proxies } = await store(t);
  assert.equal(await proxies.path(digest('a')), undefined);
  const bytes = await jpeg();
  const stored = await proxies.put(digest('a'), bytes);
  assert.equal(stored, join(proxies.root, digest('a') + '-preview-v1.jpg'));
  assert.equal(await proxies.path(digest('a')), stored);
  assert.deepEqual(await readFile(stored), bytes);
  const file = join(root, 'proxy.png');
  await writeFile(file, await png());
  assert.equal(await proxies.put(digest('b'), file), join(proxies.root, digest('b') + '-preview-v1.png'));
  // A proxy of the other type replaces the earlier one: one proxy per digest.
  await proxies.put(digest('a'), await png());
  assert.equal(await proxies.path(digest('a')), join(proxies.root, digest('a') + '-preview-v1.png'));
  assert.deepEqual((await readdir(proxies.root)).sort(), [digest('a') + '-preview-v1.png', digest('b') + '-preview-v1.png']);
});

test('put is atomic and refuses anything that is not a proxy of a digest', async (t) => {
  const { proxies } = await store(t);
  const good = await proxies.put(digest('c'), await jpeg());
  const before = await readFile(good);
  await assert.rejects(proxies.put('../escape', await jpeg()), /digest/);
  await assert.rejects(proxies.put(digest('c').toUpperCase(), await jpeg()), /digest/);
  await assert.rejects(proxies.put(digest('c'), Buffer.from('not an image')));
  const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).webp().toBuffer();
  await assert.rejects(proxies.put(digest('c'), webp), /JPEG or PNG/);
  // A truncated download never replaces the proxy that was there.
  const full = await jpeg(400, 300);
  await assert.rejects(proxies.put(digest('c'), full.subarray(0, full.length / 2)));
  assert.deepEqual(await readFile(good), before);
  assert.deepEqual(await readdir(proxies.root), [digest('c') + '-preview-v1.jpg'], 'no staging file is left behind');
  assert.equal(await proxies.path('nope'), undefined);
});

test('path never follows a symbolic link', async (t) => {
  const { root, proxies } = await store(t);
  const outside = join(root, 'outside.jpg');
  await writeFile(outside, await jpeg());
  await symlink(outside, join(proxies.root, digest('d') + '-preview-v1.jpg'));
  assert.equal(await proxies.path(digest('d')), undefined);
});

test('prune evicts the least recently used proxies down to the limit and keeps unrelated files', async (t) => {
  const { proxies } = await store(t);
  const old = await proxies.put(digest('1'), await jpeg());
  const used = await proxies.put(digest('2'), await jpeg());
  const recent = await proxies.put(digest('3'), await jpeg());
  await utimes(old, 1, 1); await utimes(used, 2, 2); await utimes(recent, 3, 3);
  // Looking a proxy up marks it as used.
  await proxies.path(digest('2'));
  const staleStaging = join(proxies.root, '.proxy-abandoned.tmp');
  const activeStaging = join(proxies.root, '.proxy-active.tmp');
  await writeFile(staleStaging, 'x'); await utimes(staleStaging, 1, 1);
  await writeFile(activeStaging, 'x');
  await writeFile(join(proxies.root, 'unrelated'), 'keep');
  const size = (await lstat(used)).size;
  await proxies.prune(size);
  assert.equal(await proxies.path(digest('1')), undefined);
  assert.equal(await proxies.path(digest('3')), undefined);
  assert.equal(await proxies.path(digest('2')), used);
  assert.deepEqual((await readdir(proxies.root)).sort(), ['.proxy-active.tmp', digest('2') + '-preview-v1.jpg', 'unrelated']);
  await proxies.prune(0);
  assert.equal(await proxies.path(digest('2')), undefined);
});
