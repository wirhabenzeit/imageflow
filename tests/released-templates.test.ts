import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readReleasedTemplates } from '../desktop/released-templates';
import { templateHash } from '../desktop/template-library';
import { trustedOrigins } from '../desktop/template-trust';
import { pathToFileURL } from 'node:url';

// Loaded at run time rather than bundled, so the release script runs as it does in the workflow.
const script = (): Promise<{ builtInHashes: () => Promise<{ folder: string; hash: string }[]>; templateHash: (folder: string) => Promise<string> }> =>
  import(pathToFileURL(join(process.cwd(), 'scripts', 'released-templates.mjs')).href);

// Books copy their template, so after an update changes a built-in, books made from an earlier release keep its old
// hash. The app ships every released built-in hash and trusts those like the current built-ins (ADR 0006).
test('the release script hashes built-in templates exactly like the app', async () => {
  const { builtInHashes, templateHash: scriptHash } = await script();
  const builtIns = await builtInHashes();
  assert.deepEqual(builtIns.map(({ folder }) => folder), ['starter', 'calendar']);
  for (const { folder, hash } of builtIns) assert.equal(hash, await templateHash(join('sample', folder, 'template')), folder);
  assert.equal(await scriptHash(join('sample', 'whitewall', 'template')), await templateHash(join('sample', 'whitewall', 'template')));
});

test('released built-in hashes are read from the shipped list; a damaged list trusts none', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'imageflow-released-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'released-templates.json');
  const hash = 'a'.repeat(64);
  assert.deepEqual(await readReleasedTemplates(file), new Set());
  await writeFile(file, JSON.stringify({ schema: 1, templates: { [hash]: { template: 'starter', app: '1.0.0' }, short: {} } }));
  const released = await readReleasedTemplates(file);
  assert.deepEqual(released, new Set([hash]));
  // A released hash gets everything its template declares, like a current built-in.
  const declared = ['https://tiles.example.com'];
  assert.deepEqual(trustedOrigins(declared, { builtIn: released.has(hash), allowed: [] }), declared);
  assert.deepEqual(trustedOrigins(declared, { builtIn: released.has('b'.repeat(64)), allowed: [] }), []);
  await writeFile(file, '{ not json');
  assert.deepEqual(await readReleasedTemplates(file), new Set());
  assert.deepEqual(await readReleasedTemplates(join('sample', 'released-templates.json')) instanceof Set, true);
});
