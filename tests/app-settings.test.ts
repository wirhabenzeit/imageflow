import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSettings } from '../src/settings';
import { SettingsStore } from '../desktop/settings';

test('old app import preferences migrate without losing appearance or window size', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  await writeFile(file, JSON.stringify({ appearance: 'dark', importMode: 'link', newBookSize: { width: 800, height: 600 } }));
  const store = new SettingsStore(file);
  await store.load();
  assert.deepEqual(store.value, { appearance: 'dark', automaticUpdates: true, updateChannel: 'stable', newBookSize: { width: 800, height: 600 } });
  await store.update({ appearance: 'light' });
  assert.equal('importMode' in JSON.parse(await readFile(file, 'utf8')), false);
  await assert.rejects(() => store.update({ importMode: 'link' }), /Invalid app settings/);
});

test('automatic update preference is validated and survives reload and unrelated changes', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const store = new SettingsStore(file);
  await store.load();
  assert.equal(store.value.automaticUpdates, true);
  await store.update({ automaticUpdates: false });
  await store.update({ appearance: 'dark' });
  const reopened = new SettingsStore(file);
  await reopened.load();
  assert.equal(reopened.value.automaticUpdates, false);
  assert.equal(reopened.value.appearance, 'dark');
  await assert.rejects(store.update({ automaticUpdates: 'false' }), /Invalid automatic update/);
  assert.equal(store.value.automaticUpdates, false);
});

test('channel preference defaults safely, persists explicit opt-in, and rejects unknown channels', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-channel-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const store = new SettingsStore(file); await store.load();
  assert.equal(store.value.updateChannel, 'stable');
  await store.update({ updateChannel: 'beta' });
  const reopened = new SettingsStore(file); await reopened.load();
  assert.equal(reopened.value.updateChannel, 'beta');
  await assert.rejects(store.update({ updateChannel: 'nightly' }), /Invalid update channel/);
  await store.update({ updateChannel: 'stable' });
  assert.equal(store.value.updateChannel, 'stable');
});


test('a beta installation defaults to Beta while an explicit Stable preference survives it', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-beta-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const betaDefaults = { ...defaultSettings, updateChannel: 'beta' as const };
  const store = new SettingsStore(file, betaDefaults); await store.load();
  assert.equal(store.value.updateChannel, 'beta');
  await store.update({ updateChannel: 'stable' });
  const reopened = new SettingsStore(file, betaDefaults); await reopened.load();
  assert.equal(reopened.value.updateChannel, 'stable');
});
