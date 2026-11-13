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
  assert.ok('value' in library);
  await app.evaluate(({ app, ipcMain }, library) => {
    globalThis.libraryResult = library;
    globalThis.libraryRequests = 0;
    globalThis.libraryGate = new Promise(resolve => { globalThis.releaseLibrary = resolve; });
    ipcMain.removeHandler('library:list');
    ipcMain.handle('library:list', async () => {
      globalThis.libraryRequests++;
      await globalThis.libraryGate;
      return globalThis.libraryResult;
    });
    globalThis.settingsSizes = [];
    app.on('browser-window-created', (_event, owner) => {
      const resize = owner.setContentSize.bind(owner);
      owner.setContentSize = (width, height, animate) => {
        globalThis.settingsSizes.push({ height, animate });
        resize(width, height, animate);
      };
      // Exercise the animated sizing branch while keeping test windows hidden.
      owner.isVisible = () => true;
    });
  }, library);
  const openSettings = async (label = 'Settings…') => {
    const created = app.waitForEvent('window');
    await app.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items ?? [])
      .find(item => item.label === label).click(), label);
    const page = await created;
    page.setDefaultTimeout(15000);
    await page.getByRole('main', { name: 'Settings', exact: true }).waitFor();
    return page;
  };
  const fit = page => page.waitForFunction(() => innerHeight === Math.min(760,
    Math.max(120, Math.ceil(document.querySelector('.settings-window > div').getBoundingClientRect().height))));
  const clearSizes = () => app.evaluate(() => { globalThis.settingsSizes = []; });
  const closeSettings = async page => {
    const closed = page.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find(owner => owner.webContents.getURL() === 'imageflow://editor/settings').close());
    await closed;
  };
  let page = await openSettings();
  await page.getByRole('tab', { name: 'General', selected: true }).waitFor();
  await fit(page);
  await app.evaluate(() => { if (globalThis.libraryRequests !== 1) throw new Error('Settings must preload the library'); });
  await clearSizes();
  await page.getByRole('tab', { name: 'Templates', exact: true }).click();
  assert.equal(await page.getByRole('main').getAttribute('aria-busy'), 'true');
  assert.equal(await page.getByRole('tab', { name: 'General' }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(await app.evaluate(() => globalThis.settingsSizes), [], 'Slow loading does not start a resize');

  // Selecting General cancels the pending request; a late library result cannot switch panes.
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await app.evaluate(() => globalThis.releaseLibrary());
  await page.waitForFunction(() => document.querySelector('main').getAttribute('aria-busy') === 'false');
  await page.getByRole('tab', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Export Photobook' }).waitFor();
  await fit(page);
  let sizes = await app.evaluate(() => globalThis.settingsSizes);
  assert.equal(sizes.length, 1, 'Templates resizes directly to its final size exactly once');
  assert.equal(sizes[0].animate, true);
  assert.equal(await page.getByText('Loading templates…').count(), 0);
  assert.equal(await app.evaluate(() => globalThis.libraryRequests), 1, 'The prepared library is reused');

  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await fit(page);
  await clearSizes();
  await page.getByRole('tab', { name: 'Templates', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('tab', { name: 'Templates', selected: true }).waitFor();
  await fit(page);
  assert.equal((await app.evaluate(() => globalThis.settingsSizes)).length, 1, 'Keyboard switching also resizes once');
  assert.equal(await app.evaluate(() => globalThis.libraryRequests), 1, 'Revisiting does not reload the list');

  // The preloaded library still follows changes while another pane is selected.
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await fit(page);
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.libraryResult = { value: [] };
    BrowserWindow.getAllWindows().find(owner => owner.webContents.getURL() === 'imageflow://editor/settings')
      .webContents.send('library:changed');
  });
  await page.getByRole('tab', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Export Photobook' }).waitFor({ state: 'detached' });
  assert.equal(await page.getByText('Loading templates…').count(), 0, 'An empty library is ready');
  await closeSettings(page);

  // Direct Templates opening waits for a failed request and presents its error once.
  await app.evaluate(() => {
    globalThis.libraryResult = { error: 'Library unavailable for transition test.' };
    globalThis.libraryGate = new Promise(resolve => { globalThis.releaseLibrary = resolve; });
    globalThis.settingsSizes = [];
  });
  page = await openSettings('Manage Templates…');
  assert.equal(await page.locator('[role=tabpanel]').count(), 0);
  assert.deepEqual(await app.evaluate(() => globalThis.settingsSizes), [], 'Direct Templates opening waits before sizing');
  await app.evaluate(() => globalThis.releaseLibrary());
  await page.getByRole('alert').filter({ hasText: 'Library unavailable for transition test.' }).waitFor();
  await fit(page);
  sizes = await app.evaluate(() => globalThis.settingsSizes);
  assert.equal(sizes.length, 1);
  assert.equal(sizes[0].animate, false, 'Initial presentation keeps its nonanimated sizing');
  console.log('Settings template transition passed: preload, slow loading, cancellation, one resize, keyboard navigation, reuse, live updates, empty library, and direct-open errors.');
} finally { await app?.close(); await rm(work, { recursive: true, force: true }); }
