import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ReleasedTemplates } from '../desktop/released-templates';
import { templateHash } from '../desktop/template-library';
import { starters } from '../src/starters';

// Books copy their template, so after an update changes a built-in, books made from an earlier release keep its old
// hash. The app ships every released built-in hash and trusts those like the current built-ins (ADR 0006).

// Loaded at run time rather than bundled, so the release script runs as it does in the workflow.
const script = (): Promise<{ builtInHashes: () => Promise<{ folder: string; hash: string }[]> }> =>
  import(pathToFileURL(join(process.cwd(), 'scripts', 'released-templates.mjs')).href);

test('the release script records the app’s built-in templates with the app’s hashes', async () => {
  const builtIns = await (await script()).builtInHashes();
  assert.deepEqual(builtIns.map(({ folder }) => folder), starters.map(({ folder }) => folder));
  for (const { folder, hash } of builtIns) assert.equal(hash, await templateHash(join('sample', folder, 'template')), folder);
});

test('released built-in hashes are read from the shipped list; a damaged list trusts none', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-released-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'released-templates.json');
  const hash = 'a'.repeat(64);
  assert.equal((await ReleasedTemplates.read(file)).has(hash), false);
  await writeFile(file, JSON.stringify({ schema: 1, templates: { [hash]: { template: 'starter', app: '1.0.0' }, short: {} } }));
  const released = await ReleasedTemplates.read(file);
  assert.equal(released.has(hash), true);
  assert.equal(released.has('short'), false);
  await writeFile(file, '{ not json');
  assert.equal((await ReleasedTemplates.read(file)).has(hash), false);
});

test('a released template keeps its sites when an open book’s access is refreshed before it renders again', () => {
  const hash = 'a'.repeat(64);
  const released = new ReleasedTemplates(new Set([hash]));
  const declared = ['https://tiles.example.com'];
  assert.equal(released.trusted('b'.repeat(64), declared), undefined, 'other hashes fall through to the user’s grants');
  // Opening the book, before its first render, knows no sites yet; the render then trusts everything declared.
  assert.deepEqual(released.trusted(hash), []);
  assert.deepEqual(released.trusted(hash, declared), declared);
  // A refresh, such as after another template's switch changed in Manage Templates, asks without declarations: the
  // book keeps its sites, so a running export or check is not stopped.
  assert.deepEqual(released.trusted(hash), declared);
});
