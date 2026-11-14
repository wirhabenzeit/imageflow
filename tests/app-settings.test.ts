import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsStore } from '../desktop/settings';

test('old app import preferences migrate without losing appearance or window size', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  await writeFile(file, JSON.stringify({ appearance: 'dark', importMode: 'link', newBookSize: { width: 800, height: 600 } }));
  const store = new SettingsStore(file);
  await store.load();
  assert.deepEqual(store.value, { appearance: 'dark', newBookSize: { width: 800, height: 600 } });
  await store.update({ appearance: 'light' });
  assert.equal('importMode' in JSON.parse(await readFile(file, 'utf8')), false);
  await assert.rejects(() => store.update({ importMode: 'link' }), /Invalid app settings/);
});
