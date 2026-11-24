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

test('the removed folder for downloaded books is ignored, whatever it holds, and costs the other settings nothing', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const saved = { appearance: 'dark', automaticUpdates: false, updateChannel: 'beta', newBookSize: { width: 800, height: 600 }, agentAccess: true,
    keepOriginals: false, syncAutomatically: false, sync: { kind: 'icloud' }, syncBooksUnchosen: true };
  for (const booksFolder of ['/Users/someone/Books', null, 7]) {
    await writeFile(file, JSON.stringify({ ...saved, booksFolder }));
    const store = new SettingsStore(file);
    await store.load();
    assert.deepEqual(store.value, saved);
    await store.update({ appearance: 'light' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...saved, appearance: 'light' });
    await assert.rejects(store.update({ booksFolder: '/tmp' }), /Invalid app settings/);
  }
});

test('the set-up of sync is kept with its backend, validated, and goes with it', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const setup = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const store = new SettingsStore(file);
  await store.update({ syncSetup: setup });
  assert.equal(store.value.syncSetup, undefined, 'nothing without a backend');
  await store.update({ sync: { kind: 'icloud' }, syncSetup: setup });
  await store.update({ appearance: 'dark' });
  const reopened = new SettingsStore(file);
  await reopened.load();
  assert.equal(reopened.value.syncSetup, setup);
  await assert.rejects(reopened.update({ syncSetup: 'yes' }), /Invalid sync setting/);
  await reopened.update({ sync: null });
  assert.equal(reopened.value.syncSetup, undefined);
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

test('agent access is remembered across reloads and only stored while on', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-agents-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  const store = new SettingsStore(file);
  await store.load();
  assert.equal(store.value.agentAccess, undefined);
  await store.update({ agentAccess: true });
  await store.update({ appearance: 'dark' });
  const reopened = new SettingsStore(file);
  await reopened.load();
  assert.equal(reopened.value.agentAccess, true);
  await reopened.update({ agentAccess: false });
  assert.equal('agentAccess' in JSON.parse(await readFile(file, 'utf8')), false);
  await assert.rejects(store.update({ agentAccess: 'yes' }), /Invalid agent access/);
});

test('a stored setting for the removed faster book updates is dropped, not a reason to reset the others', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-updates-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  await writeFile(file, JSON.stringify({ appearance: 'dark', automaticUpdates: true, updateChannel: 'beta', fasterBookUpdates: false }));
  const store = new SettingsStore(file);
  await store.load();
  assert.equal(store.value.appearance, 'dark');
  assert.equal('fasterBookUpdates' in store.value, false);
  await assert.rejects(store.update({ fasterBookUpdates: false }), /Invalid app settings/);
});

test('a sync backend this version cannot read leaves sync off and keeps the other settings', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'if-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'settings.json');
  await writeFile(file, JSON.stringify({ appearance: 'dark', automaticUpdates: false, updateChannel: 'beta', sync: { kind: 'later', where: 'x' } }));
  const warn = t.mock.method(console, 'warn', () => {});
  const store = new SettingsStore(file); await store.load();
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(store.value, { appearance: 'dark', automaticUpdates: false, updateChannel: 'beta' });
  await writeFile(file, JSON.stringify({ appearance: 'dark', automaticUpdates: false, updateChannel: 'beta', sync: { kind: 'folder', path: '/Volumes/Sync' } }));
  const readable = new SettingsStore(file); await readable.load();
  assert.deepEqual(readable.value.sync, { kind: 'folder', path: '/Volumes/Sync' });
});
