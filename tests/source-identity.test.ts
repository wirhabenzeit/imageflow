import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSourceRegistry } from '../desktop/source-identity';

test('legacy migration rejects different births, conflicting grants, and does not resurrect revoked grants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'if-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'book'); await mkdir(folder);
  const info = await stat(folder, { bigint: true });
  const suffix = `${info.ino}-${info.birthtimeNs}`;
  const parse = (value: unknown) => value as Record<string, { path: string }>;
  await writeFile(join(root, `1-${suffix}.json`), JSON.stringify({ photo: { path: '/old' }, text: { path: '/text' } }));
  await writeFile(join(root, `2-${suffix}.json`), JSON.stringify({ photo: { path: '/different' } }));
  await writeFile(join(root, `3-${info.ino}-${info.birthtimeNs + 1n}.json`), JSON.stringify({ other: { path: '/wrong-book' } }));
  assert.deepEqual((await readSourceRegistry(root, folder, 'volume-test', parse)).entries, { text: { path: '/text' } });
  assert.deepEqual((await readSourceRegistry(root, folder, `9-${suffix}`, parse)).entries, {},
    'Device-scoped volumes do not migrate grants from other devices');
  await writeFile(join(root, 'volume-test.json'), '{}');
  assert.deepEqual((await readSourceRegistry(root, folder, 'volume-test', parse)).entries, {});
  await writeFile(join(root, 'volume-test.json'), 'corrupt');
  assert.deepEqual((await readSourceRegistry(root, folder, 'volume-test', parse)).entries, {});
});
