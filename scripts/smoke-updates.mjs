import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { menuAction, testBook } from './ui-actions.mjs';

// UI/quit integration with simulated native events. No release or feed is published by this test.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.build'), { recursive: true });
const work = await mkdtemp(join(root, '.build/update-smoke-'));
const folder = join(work, 'Updates.imageflow'), profile = join(work, 'profile');
await cp(join(root, 'sample/starter'), folder, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
const projectFile = join(folder, 'project.json');
const initial = JSON.parse(await readFile(projectFile, 'utf8'));
initial.spreads = [{ ...initial.spreads[0], definition: 'title', boxes: {} }];
await writeFile(projectFile, JSON.stringify(initial));
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
  const settingsOpened = instance.waitForEvent('window');
  await menuAction(instance, 'Check for Updates…');
  const settings = await settingsOpened;
  await settings.getByText('Updates are available in the signed macOS release of ImageFlow.', { exact: true }).waitFor();
  const automatic = settings.getByRole('checkbox', { name: 'Automatically check for updates' });
  assert.equal(await automatic.isChecked(), true);
  assert.equal(await automatic.isDisabled(), true);
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-not-available'); });
  await settings.getByText('You’re up to date.', { exact: true }).waitFor();
  await automatic.uncheck();
  await settings.waitForFunction(async () => !(await window.imageflow.getSettings()).value.automaticUpdates);
  assert.equal(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).automaticUpdates, false);
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-not-available'); });
  await settings.getByText('You’re up to date.', { exact: true }).waitFor();
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('error', new Error('offline')); });
  await settings.getByText('Could not check for updates. Check your internet connection and try again.', { exact: true }).waitFor();
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-available'); });
  await settings.getByText('Downloading update…', { exact: true }).waitFor();
  await instance.evaluate(({ autoUpdater }) => { autoUpdater.emit('update-downloaded', {}, '', '1.0.1'); });
  await page.getByRole('complementary', { name: 'ImageFlow update' }).waitFor();
  await page.screenshot({ path: join(root, '.build/update-notice.png') });
  await settings.screenshot({ path: join(root, '.build/update-settings.png') });
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.locator('.update-notice').waitFor({ state: 'detached' });
  assert.equal((await settings.evaluate(() => window.imageflow.updateState())).dismissed, true);
  assert.equal(await instance.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('restart-update').enabled), true);
  await settings.getByRole('button', { name: 'Restart to Update', exact: true }).last().waitFor();
  // No installation should be attempted by a cancelled quit. The eventual install sees no book lock or MCP descriptor.
  await instance.evaluate(({ autoUpdater, app }, { folder, profile, work }) => {
    const fs = process.getBuiltinModule('node:fs');
    autoUpdater.quitAndInstall = () => {
      fs.writeFileSync(work + '/install.json', JSON.stringify({
        lock: fs.existsSync(folder + '/.imageflow/writer.lock'),
        descriptor: fs.existsSync(profile + '/mcp-connection.json'),
      }));
      app.quit();
    };
  }, { folder, profile, work });
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
