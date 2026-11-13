import { waitForPage } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/settings-transition-'));
let app;
try {
  app = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_TEMPLATES: join(work, 'Templates') } });
  const start = await app.firstWindow();
  await start.locator('.start-window').waitFor();
  const library = await start.evaluate(() => window.imageflow.library());
  await app.evaluate(({ ipcMain }, library) => {
    globalThis.libraryGate = new Promise(resolve => { globalThis.releaseLibrary = resolve; });
    ipcMain.removeHandler('library:list');
    ipcMain.handle('library:list', async () => { await globalThis.libraryGate; return library; });
  }, library);
  const opened = app.waitForEvent('window', { predicate: page => page.waitForURL('imageflow://editor/templates').then(() => true, () => false) });
  await start.evaluate(() => window.imageflow.showTemplates());
  const templates = await opened;
  await templates.getByText('Loading templates…').waitFor();
  // Slow template loading never blocks global preferences or resizes their window.
  const preferences = app.waitForEvent('window', { predicate: page => page.waitForURL('imageflow://editor/settings').then(() => true, () => false) });
  await start.evaluate(() => window.imageflow.showSettings('general'));
  const settings = await preferences;
  await settings.getByRole('tab', { name: 'General', selected: true }).waitFor();
  assert.equal(await settings.getByRole('tab', { name: 'Templates' }).count(), 0);
  await settings.getByLabel('New imports:').selectOption('link');
  await waitForPage(settings, async () => (await window.imageflow.getSettings()).value.importMode === 'link');
  const size = await settings.evaluate(() => [innerWidth, innerHeight]);
  await app.evaluate(() => globalThis.releaseLibrary());
  await templates.getByRole('listbox', { name: 'Templates' }).getByRole('option').filter({ hasText: 'Photobook' }).waitFor();
  assert.deepEqual(await settings.evaluate(() => [innerWidth, innerHeight]), size);
  assert.equal((await settings.evaluate(() => window.imageflow.getSettings())).value.importMode, 'link');
  // Opening the library again focuses the existing independent window.
  await start.evaluate(() => window.imageflow.showTemplates());
  assert.equal(app.windows().filter(page => page.url() === 'imageflow://editor/templates').length, 1);
  console.log('Independent Templates and Settings windows passed.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
