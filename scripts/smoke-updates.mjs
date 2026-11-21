import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import semver from 'semver';
import { menuAction, testBook } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';
import { bookStateFile } from './book-state.mjs';

// UI/quit integration with simulated native events. No release or feed is published by this test.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.build'), { recursive: true });
const work = await mkdtemp(join(root, '.build/update-smoke-'));
const folder = join(work, 'Updates.imageflow'), profile = join(work, 'profile');
await copySample(join(root, 'sample', 'starter'), folder);
const projectFile = join(folder, 'project.json');
const initial = JSON.parse(await readFile(projectFile, 'utf8'));
initial.spreads = [{ ...initial.spreads[0], definition: 'title', boxes: {} }];
await writeFile(projectFile, JSON.stringify(initial));
// Settings are written asynchronously after the control changes; wait for the file rather than racing the write.
async function savedSetting(key, expected) {
  let value;
  for (const deadline = Date.now() + 10000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    value = await readFile(join(profile, 'settings.json'), 'utf8').then((text) => JSON.parse(text)[key], () => undefined);
    if (value === expected) return;
  }
  assert.equal(value, expected, 'saved ' + key);
}
let instance, appProcess;
try {
  instance = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 15000 });
  appProcess = instance.process();
  const page = await testBook(instance, folder);
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  assert.equal((await page.evaluate(() => window.imageflow.updateState())).status, 'unavailable');
  await menuAction(instance, 'Check for Updates…');
  // Preview render windows open in the background too, so find Settings by its URL rather than the next window.
  let settings;
  for (const deadline = Date.now() + 15000; !settings && Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    settings = instance.windows().find((window) => window.url() === 'imageflow://editor/settings');
  }
  assert.ok(settings, 'Settings window opened');
  await settings.getByText('Updates are available in the signed macOS release of ImageFlow.', { exact: true }).waitFor();
  const automatic = settings.getByRole('checkbox', { name: 'Automatically check for updates' });
  assert.equal(await automatic.isChecked(), true);
  assert.equal(await automatic.isDisabled(), true);
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-not-available'); });
  await settings.getByText('You’re up to date.', { exact: true }).waitFor();
  await automatic.uncheck();
  await savedSetting('automaticUpdates', false);
  const channel = settings.getByRole('combobox', { name: 'Update channel' });
  // A fresh install starts on its own release's channel (releaseChannel in src/update-feed.ts): Beta for a -beta.N
  // version, Stable otherwise.
  const version = await instance.evaluate(({ app }) => app.getVersion());
  const fresh = semver.prerelease(version)?.[0] === 'beta' ? 'beta' : 'stable';
  const other = fresh === 'beta' ? 'stable' : 'beta';
  assert.equal(await channel.inputValue(), fresh, 'the default channel for ' + version);
  await channel.selectOption(other);
  await savedSetting('updateChannel', other);
  await channel.selectOption(fresh);
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-not-available'); });
  await settings.getByText('You’re up to date.', { exact: true }).waitFor();
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('error', new Error('offline')); });
  await settings.getByText('Could not check for updates. Check your internet connection and try again.', { exact: true }).waitFor();
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-available'); });
  await settings.getByText('Downloading update…', { exact: true }).waitFor();
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-downloaded', {}, '', '1.0.1'); });
  assert.equal(await channel.isDisabled(), true);
  await page.getByRole('complementary', { name: 'ImageFlow update' }).waitFor();
  await page.screenshot({ path: join(root, '.build/update-notice.png') });
  await settings.screenshot({ path: join(root, '.build/update-settings.png') });
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.locator('.update-notice').waitFor({ state: 'detached' });
  assert.equal((await settings.evaluate(() => window.imageflow.updateState())).dismissed, true);
  assert.equal(await instance.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('restart-update').enabled), true);
  await settings.getByRole('button', { name: 'Restart to Update', exact: true }).last().waitFor();
  // No installation should be attempted by a cancelled quit. The eventual install sees no book lock or MCP descriptor.
  const lockPath = await bookStateFile(profile, folder, 'writer.lock');
  await stat(lockPath); // the path is right, so its later absence is meaningful
  await instance.evaluate(({ autoUpdater, app }, { lockPath, profile, work }) => {
    const fs = process.getBuiltinModule('node:fs');
    autoUpdater.quitAndInstall = () => {
      fs.writeFileSync(work + '/install.json', JSON.stringify({
        lock: fs.existsSync(lockPath),
        descriptor: fs.existsSync(profile + '/mcp-connection.json'),
      }));
      app.quit();
    };
  }, { lockPath, profile, work });
  await page.evaluate(() => { globalThis.quitMessages = []; window.imageflow.onAppError((message) => globalThis.quitMessages.push(message)); });
  // Put unsaved text in the real inline editor, then try both restart and ordinary Quit.
  const heading = page.frameLocator('iframe.book-frame-book[data-current][data-ready]').locator('[data-edit="heading"]').first();
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const input = page.frameLocator('.inline-text-editor iframe').getByRole('textbox');
  await input.fill('Changes survive an update');
  await menuAction(instance, 'Restart to Update');
  await page.waitForFunction(() => globalThis.quitMessages.length === 1);
  await page.getByText(/Finish or discard the active edit/).waitFor();
  assert.equal(page.isClosed(), false);
  assert.equal(await input.innerText(), 'Changes survive an update');
  await assert.rejects(stat(join(work, 'install.json')), { code: 'ENOENT' });
  assert.equal(await page.locator('.workspace').evaluate((node) => node.inert), false);
  await instance.evaluate(({ app }) => { app.quit(); });
  await page.waitForFunction(() => globalThis.quitMessages.length === 2);
  await page.getByText(/Finish or discard the active edit/).waitFor();
  // A cancelled restart must not retain the request to relaunch. Squirrel may still apply a staged update on a later ordinary Quit.
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.inline-text-editor').waitFor({ state: 'detached' });
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).spreads[0].params.heading, 'Changes survive an update');
  const mcp = await page.evaluate(() => window.imageflow.mcpSettings(true));
  assert.ok(mcp.value.enabled);
  await stat(join(profile, 'mcp-connection.json'));
  const exited = once(appProcess, 'exit', { signal: AbortSignal.timeout(20000) });
  await menuAction(instance, 'Restart to Update');
  const [code] = await exited;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(work, 'install.json'), 'utf8')), { lock: false, descriptor: false });
  assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).spreads[0].params.heading, 'Changes survive an update');
  assert.deepEqual(errors, []);
  console.log('Update preference, manual feedback, non-modal notice, cancelled quit, saved text, lock and MCP cleanup passed (simulated update).');
} finally {
  if (appProcess?.exitCode === null) await instance.close().catch(() => {});
  await rm(work, { recursive: true, force: true });
}
