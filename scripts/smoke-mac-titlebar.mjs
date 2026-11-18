import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { buildMacHeaderState } from './mac-header-state.mjs';
import { closeApp, testBook } from './ui-actions.mjs';

if (process.platform !== 'darwin') process.exit(0);
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/titlebar-'));
let app;
try {
  const helper = buildMacHeaderState(work);
  app = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const page = await testBook(app, join(work, 'Title Bar.imageflow'), true);
  const window = await app.browserWindow(page);
  const display = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  await window.evaluate((win, display) => win.setBounds({
    x: display.x + 20, y: display.y + 20, width: display.width - 80, height: display.height - 80,
  }), display);
  await page.locator('header.toolbar').waitFor();
  const original = await window.evaluate(win => win.getBounds());
  const click = async (action) => {
    const { x, y } = await page.locator('header.toolbar').evaluate(node => {
      const { left, top, width, height } = node.getBoundingClientRect();
      return { x: left + width / 2, y: top + height / 2 };
    });
    return window.evaluate((win, { helper, x, y, action }) => {
      const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
      require(helper).doubleClick(win.getNativeWindowHandle(), x, y, action);
      return win.getBounds();
    }, { helper, x, y, action });
  };
  assert.deepEqual(await click('None'), original);
  assert.deepEqual(await click('Fill'), display, 'Double-clicking the blank toolbar fills the available screen');
  assert.deepEqual(await click('Fill'), original, 'A second double-click restores the previous bounds');
  assert.notDeepEqual(await click('Maximize'), original, 'The macOS Zoom action resizes the window');
  assert.deepEqual(await click('Maximize'), original, 'Zoom restores the previous window size');
  // The title row above the toolbar responds the same way (F-031), outside the window buttons and the document icon.
  const titleRow = async (action, x = 0.62) => {
    await window.evaluate((win, { helper, x, action }) => {
      const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
      require(helper).titleRowDoubleClick(win.getNativeWindowHandle(), win.getBounds().width * x, 12, action);
    }, { helper, x, action });
    await page.waitForTimeout(600);
    return window.evaluate(win => win.getBounds());
  };
  assert.deepEqual(await titleRow('None'), original);
  assert.deepEqual(await titleRow('Fill'), display, 'Double-clicking the title row fills the available screen');
  assert.deepEqual(await titleRow('Fill'), original, 'and restores the previous bounds');
  assert.deepEqual(await titleRow('Fill', 0.01), original, 'The window buttons keep their own clicks');
  console.log('macOS toolbar and title row double-click Fill, Zoom, restore and No Action passed.');
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
