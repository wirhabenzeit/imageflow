// Settings → Sync (#281) in the app, against the fake S3 server of the unit tests: the pane exists only with the
// development flag, Test Connection reports what the service does, Save keeps the bucket in settings.json and the
// access key in the credential store (in memory here, as `IMAGEFLOW_SYNC_CREDENTIALS=memory` allows in development),
// a wrong key reads as "Sign-in needed", and the secret never reaches settings.json, the renderer or the app's output.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
import { _electron } from 'playwright-core';
import { closeApp, closeSettings } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/sync-settings-smoke-')));
const profile = join(work, 'profile');
await build({ entryPoints: [join(root, 'tests/s3-fake.ts')], outfile: join(work, 's3-fake.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
const { FakeS3 } = await import(pathToFileURL(join(work, 's3-fake.mjs')).href);
const fake = await new FakeS3().start();
fake.bucket('books');
const secret = fake.credentials.secretAccessKey;
const wrongSecret = 'wrong-secret-' + Date.now();

const output = [];
async function launch(flag) {
  const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_SYNC_CREDENTIALS: 'memory', IMAGEFLOW_SYNC: flag ? '1' : '' } });
  app.process().stdout.on('data', (bytes) => output.push(String(bytes)));
  app.process().stderr.on('data', (bytes) => output.push(String(bytes)));
  return app;
}
async function openSettings(app, pane) {
  const start = await app.firstWindow();
  await start.waitForLoadState();
  await start.evaluate((pane) => window.imageflow.showSettings(pane), pane);
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    const settings = app.windows().find((page) => page.url() === 'imageflow://editor/settings');
    if (settings) { settings.setDefaultTimeout(20000); return { start, settings }; }
  }
  throw new Error('Settings did not open.');
}
const savedSettings = async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8').catch(() => '{}'));

let app;
try {
  app = await launch(true);
  const { start, settings } = await openSettings(app, 'sync');
  const errors = [];
  settings.on('pageerror', (error) => errors.push(error.message));
  await settings.getByRole('tab', { name: 'Sync', selected: true }).waitFor();
  // Keep originals moved here from General.
  await settings.getByRole('checkbox', { name: 'Keep originals of synced books on this Mac' }).waitFor();
  // The S3 URL as R2 shows it, with the bucket: split into Endpoint and Bucket when the field is left.
  const endpoint = settings.getByRole('textbox', { name: 'Endpoint' });
  await endpoint.fill(fake.url + '/books');
  await settings.getByRole('textbox', { name: 'Region' }).click();
  await settings.getByText('Took the bucket “books” from the URL.', { exact: true }).waitFor();
  assert.equal(await endpoint.inputValue(), fake.url);
  assert.equal(await settings.getByRole('textbox', { name: 'Bucket' }).inputValue(), 'books');
  // Another bucket in the URL than in Bucket is pointed out, and Bucket is kept.
  await endpoint.fill(fake.url + '/other');
  await settings.getByRole('textbox', { name: 'Region' }).click();
  await settings.getByText('The URL names the bucket “other”, but Bucket is “books”. Enter the one to sync with.', { exact: true }).waitFor();
  assert.equal(await settings.getByRole('textbox', { name: 'Bucket' }).inputValue(), 'books');
  await settings.getByRole('textbox', { name: 'Region' }).fill(fake.region);
  await settings.getByRole('textbox', { name: 'Prefix' }).fill('ImageFlow');
  await settings.getByRole('textbox', { name: 'Access key ID' }).fill(fake.credentials.accessKeyId);
  await settings.getByLabel('Secret access key').fill(wrongSecret);
  // A key the service refuses: sign-in needed, without the key in the message.
  await settings.getByRole('button', { name: 'Test Connection' }).click();
  const refused = await settings.getByRole('alert').textContent({ timeout: 20000 });
  assert.match(refused, /^Sign-in needed: .*Settings → Sync\.$/);
  assert.ok(!refused.includes(wrongSecret));
  await settings.getByLabel('Secret access key').fill(secret);
  await settings.getByRole('button', { name: 'Test Connection' }).click();
  await settings.getByText(/^Connected\. The service refuses to replace an object \(conditional writes\)\. It checks the SHA-256 of every upload\.$/).waitFor();
  assert.deepEqual([...fake.bucket('books').keys()], [], 'the connection test left nothing behind');
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.getByText('Saved.', { exact: true }).waitFor();
  assert.equal(await settings.getByLabel('Secret access key').inputValue(), '', 'the field is cleared once stored');
  await settings.screenshot({ path: join(root, '.build/sync-settings.png') });
  assert.equal(await settings.getByRole('textbox', { name: 'Access key ID' }).getAttribute('placeholder'), 'Stored (…' + fake.credentials.accessKeyId.slice(-4) + ')');
  // settings.json has the bucket and nothing of the key; the memory credential store writes no file.
  const saved = await savedSettings();
  assert.deepEqual(saved.sync, { kind: 's3', endpoint: fake.url, region: fake.region, bucket: 'books', prefix: 'ImageFlow/' });
  const text = await readFile(join(profile, 'settings.json'), 'utf8');
  assert.ok(!text.includes(secret) && !text.includes(fake.credentials.accessKeyId));
  assert.ok(!(await readdir(profile)).includes('sync-credentials.json'));
  // What a renderer can ask for never holds the key.
  for (const page of [settings, start]) {
    const answers = await page.evaluate(async () => JSON.stringify([await window.imageflow.getSettings(), await window.imageflow.syncBackendState()]));
    assert.ok(!answers.includes(secret) && !answers.includes(fake.credentials.accessKeyId), answers);
  }
  // Only Settings may test or save: not the Start window.
  assert.match((await start.evaluate((backend) => window.imageflow.testSyncConnection({ backend }), saved.sync)).error, /only available to Settings/);
  // A backend is set only here: the generic settings patch may not set one, from any window; it may turn sync off.
  for (const page of [settings, start]) {
    assert.match((await page.evaluate((sync) => window.imageflow.updateSettings({ sync }), { ...saved.sync, bucket: 'elsewhere' })).error, /Settings → Sync/);
  }
  assert.deepEqual((await savedSettings()).sync, saved.sync);
  // Test Connection with the stored key, after Save.
  await settings.getByRole('button', { name: 'Test Connection' }).click();
  await settings.getByText(/^Connected\./).waitFor();
  // Remove forgets the bucket and its key.
  await settings.getByRole('button', { name: 'Remove' }).click();
  await settings.getByText('This Mac no longer syncs through a bucket.', { exact: true }).waitFor();
  assert.equal((await savedSettings()).sync, undefined);
  assert.deepEqual(errors, []);
  await closeSettings(app);
  await closeApp(app);

  // Without the flag there is no Sync pane: Keep originals stays in General, and the requests are refused.
  app = await launch(false);
  const plain = await openSettings(app, 'sync');
  await plain.settings.getByRole('tab', { name: 'General', selected: true }).waitFor();
  assert.equal(await plain.settings.getByRole('tab', { name: 'Sync' }).count(), 0);
  await plain.settings.getByRole('checkbox', { name: 'Keep originals of synced books on this Mac' }).waitFor();
  assert.deepEqual(await plain.settings.evaluate(() => window.imageflow.syncBackendState()), { value: { available: false } });
  assert.match((await plain.settings.evaluate(() => window.imageflow.saveSyncBackend(null))).error, /not available/);
  assert.match((await plain.settings.evaluate(() => window.imageflow.updateSettings({ sync: null }))).error, /Settings → Sync/);
  await closeApp(app);
  app = undefined;
  assert.ok(!output.join('').includes(secret) && !output.join('').includes(wrongSecret), 'the key is never in the app’s output');
  console.log('Sync settings smoke passed.');
} finally {
  if (app) await closeApp(app);
  await fake.close();
  await rm(work, { recursive: true, force: true });
}
