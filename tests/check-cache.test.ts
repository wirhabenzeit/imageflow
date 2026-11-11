import assert from 'node:assert/strict';
import fs, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CheckRenditionCache } from '../desktop/check-cache';

const firstKey = 'a'.repeat(64);
const secondKey = 'b'.repeat(64);
const name = (key = firstKey, rendition = 'export') => key + '-' + rendition + '.jpg';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-check-cache-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = async (label: string) => {
    const path = join(root, label);
    await mkdir(path);
    return path;
  };
  return { root, folder };
}

function cacheFor(t: TestContext, options?: ConstructorParameters<typeof CheckRenditionCache>[0]) {
  const cache = new CheckRenditionCache(options);
  t.after(() => cache.close());
  return cache;
}

test('only regular rendition files with current photo keys enter a seeded check', async (t) => {
  const { root, folder } = await fixture(t);
  const cache = cacheFor(t);
  const validated = await folder('validated');
  const target = await folder('target');
  const allowed = [name(), name(firstKey, 'preview'), name(firstKey, 'export-1200'), firstKey + '-thumb.png'];
  for (const file of allowed) await writeFile(join(validated, file), file);
  for (const file of [name(secondKey), firstKey + '-preview-100.jpg', firstKey + '-export-0.jpg', firstKey + '-export.jpeg',
    'unknown-rendition', '../invalid'.replace('/', '_')]) await writeFile(join(validated, file), 'reject');
  const outside = join(root, 'outside.jpg');
  await writeFile(outside, 'original');
  await symlink(outside, join(validated, name(firstKey, 'thumb')));
  await mkdir(join(validated, '.render-incomplete'));
  assert.equal(await cache.retain(validated, new Set([firstKey])), true);
  assert.deepEqual((await readdir(validated)).sort(), allowed.sort());
  await cache.seed(target, new Set([firstKey]));
  assert.deepEqual((await readdir(target)).sort(), allowed.sort());
  for (const file of allowed) {
    assert.equal(await readFile(join(target, file), 'utf8'), file);
    assert.equal((await lstat(join(target, file))).ino, (await lstat(join(validated, file))).ino);
  }
  assert.equal(await readFile(outside, 'utf8'), 'original');
});

test('file and byte limits bound the retained folder', async (t) => {
  const { folder } = await fixture(t);
  for (const [index, options] of [{ maxFiles: 2, maxBytes: 100 }, { maxFiles: 100, maxBytes: 5 }].entries()) {
    const cache = cacheFor(t, options);
    const validated = await folder('validated-' + index);
    for (const rendition of ['export', 'preview', 'thumb']) await writeFile(join(validated, name(firstKey, rendition)), '123');
    assert.equal(await cache.retain(validated, new Set([firstKey])), true);
    const files = await readdir(validated);
    assert.equal(files.length, index === 0 ? 2 : 1);
    const bytes = await Promise.all(files.map((file) => lstat(join(validated, file)).then(({ size }) => size)));
    assert.ok(bytes.reduce((total, size) => total + size, 0) <= options.maxBytes);
  }
});

test('replacement transfers ownership and filters seeds to current keys without losing linked files', async (t) => {
  const { folder } = await fixture(t);
  const cache = cacheFor(t);
  const previous = await folder('previous');
  const current = await folder('current');
  const next = await folder('next');
  await writeFile(join(previous, name()), 'first');
  await writeFile(join(previous, name(secondKey)), 'second');
  await cache.retain(previous, new Set([firstKey, secondKey]));
  await cache.seed(current, new Set([firstKey]));
  assert.deepEqual(await readdir(current), [name()]);
  assert.equal(await cache.retain(current, new Set([firstKey])), true);
  await assert.rejects(lstat(previous), { code: 'ENOENT' });
  await cache.seed(next, new Set([firstKey]));
  assert.equal(await readFile(join(next, name()), 'utf8'), 'first');
  await cache.close();
  await assert.rejects(lstat(current), { code: 'ENOENT' });
  assert.equal(await readFile(join(next, name()), 'utf8'), 'first');
});

test('a failed check replacing a seeded file cannot contaminate the retained rendition', async (t) => {
  const { folder } = await fixture(t);
  const cache = cacheFor(t);
  const validated = await folder('validated');
  const failed = await folder('failed');
  const next = await folder('next');
  await writeFile(join(validated, name()), 'validated pixels');
  await cache.retain(validated, new Set([firstKey]));
  await cache.seed(failed, new Set([firstKey]));
  await writeFile(join(failed, 'replacement'), 'unverified pixels');
  await rename(join(failed, 'replacement'), join(failed, name()));
  await cache.seed(next, new Set([firstKey]));
  assert.equal(await readFile(join(next, name()), 'utf8'), 'validated pixels');
  assert.equal(await readFile(join(validated, name()), 'utf8'), 'validated pixels');
  assert.equal(await readFile(join(failed, name()), 'utf8'), 'unverified pixels');
});

test('missing, replaced, and symlinked cached files are misses and existing target files are preserved', async (t) => {
  const { root, folder } = await fixture(t);
  const cache = cacheFor(t);
  const validated = await folder('validated');
  const target = await folder('target');
  const cached = join(validated, name());
  await writeFile(cached, 'valid');
  await cache.retain(validated, new Set([firstKey]));
  await writeFile(join(target, name()), 'current attempt');
  await cache.seed(target, new Set([firstKey]));
  assert.equal(await readFile(join(target, name()), 'utf8'), 'current attempt');
  await rm(cached);
  const empty = await folder('empty');
  await cache.seed(empty, new Set([firstKey]));
  assert.deepEqual(await readdir(empty), []);
  const outside = join(root, 'outside.jpg');
  await writeFile(outside, 'outside');
  await symlink(outside, cached);
  await cache.seed(empty, new Set([firstKey]));
  assert.deepEqual(await readdir(empty), []);
  await cache.close();
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('closing waits for an in-flight seed and retires without deleting the active target', async (t) => {
  const { folder } = await fixture(t);
  const cache = cacheFor(t);
  const validated = await folder('validated');
  const target = await folder('target');
  await writeFile(join(validated, name()), 'pixels');
  await cache.retain(validated, new Set([firstKey]));
  const link = fs.link;
  let reached!: () => void;
  let proceed!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { proceed = resolve; });
  try {
    fs.link = async (source, destination) => { reached(); await gate; return link(source, destination); };
    const seeding = cache.seed(target, new Set([firstKey]));
    await started;
    const closing = cache.close();
    proceed();
    await seeding;
    await closing;
    await assert.rejects(lstat(validated), { code: 'ENOENT' });
    assert.equal(await readFile(join(target, name()), 'utf8'), 'pixels');
    assert.equal(await cache.retain(target, new Set([firstKey])), false);
    await cache.close();
  } finally { proceed(); fs.link = link; }
});

test('close during candidate pruning declines ownership and preserves that caller-owned folder', async (t) => {
  const { folder } = await fixture(t);
  const cache = cacheFor(t);
  const previous = await folder('previous');
  const candidate = await folder('candidate');
  await writeFile(join(previous, name()), 'previous');
  await cache.retain(previous, new Set([firstKey]));
  await writeFile(join(candidate, name()), 'new pixels');
  await writeFile(join(candidate, 'invalid'), 'prune');
  const remove = fs.rm;
  let reached!: () => void;
  let proceed!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { proceed = resolve; });
  try {
    fs.rm = async (path, options) => {
      if (path === join(candidate, 'invalid')) { reached(); await gate; }
      return remove(path, options);
    };
    const retaining = cache.retain(candidate, new Set([firstKey]));
    await started;
    const closing = cache.close();
    proceed();
    assert.equal(await retaining, false);
    await closing;
    await assert.rejects(lstat(previous), { code: 'ENOENT' });
    assert.equal(await readFile(join(candidate, name()), 'utf8'), 'new pixels');
  } finally { proceed(); fs.rm = remove; }
});

test('cache failures remain misses and a failed retain keeps the earlier validated folder', async (t) => {
  const { folder } = await fixture(t);
  const cache = cacheFor(t);
  const previous = await folder('previous');
  const candidate = await folder('candidate');
  const target = await folder('target');
  await writeFile(join(previous, name()), 'previous');
  await cache.retain(previous, new Set([firstKey]));
  await writeFile(join(candidate, 'invalid'), 'cannot prune');
  const remove = fs.rm;
  try {
    fs.rm = async () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); };
    assert.equal(await cache.retain(candidate, new Set([firstKey])), false);
  } finally { fs.rm = remove; }
  await cache.seed(target, new Set([firstKey]));
  assert.equal(await readFile(join(target, name()), 'utf8'), 'previous');
  await cache.seed(join(target, 'missing'), new Set([firstKey]));
  assert.equal(await cache.retain(join(target, 'missing'), new Set([firstKey])), false);
});
