import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, nextPresentation, testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.build'), { recursive: true });
const work = await mkdtemp(join(root, '.build/background-'));
let app;
try {
  app = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 20000 });
  const checkHidden = async () => {
    const state = await app.evaluate(({ app, BrowserWindow }) => ({
      dock: process.platform === 'darwin' ? app.dock.isVisible() : false,
      windows: BrowserWindow.getAllWindows().map((window) => ({ title: window.getTitle(),
        visible: window.isVisible(), focused: window.isFocused(), fullscreen: window.isFullScreen() || window.isSimpleFullScreen() })),
    }));
    assert.equal(state.dock, false, 'Hidden tests never appear in the Dock');
    for (const window of state.windows) {
      assert.equal(window.visible, false, JSON.stringify(window));
      assert.equal(window.focused, false, JSON.stringify(window));
      assert.equal(window.fullscreen, false, JSON.stringify(window));
    }
  };
  const dialogs = await app.evaluate(({ dialog }) => {
    const errors = [];
    for (const method of ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync',
      'showSaveDialog', 'showSaveDialogSync', 'showErrorBox']) {
      try { dialog[method]({ message: 'Template URL request warning' }); }
      catch (error) { errors.push(error.message); }
    }
    return errors;
  });
  assert.equal(dialogs.length, 7, 'Every native dialog is blocked unless explicitly mocked');
  assert.ok(dialogs.every((message) => message.includes('Template URL request warning')));
  await app.firstWindow();
  await checkHidden();
  const editor = await testBook(app, join(work, 'Background.imageflow'), true);
  await editor.locator('.book-frame-book[data-current][data-ready]').waitFor();
  await checkHidden();
  const templates = app.waitForEvent('window', { predicate: async (page) => {
    try { await page.waitForURL('imageflow://editor/templates'); return true; } catch { return false; }
  } });
  await editor.evaluate(() => window.imageflow.showTemplates());
  await templates;
  await checkHidden();
  const opened = nextPresentation(app);
  const result = await editor.evaluate(async () => {
    const { value } = await window.imageflow.currentProject();
    return window.imageflow.startPresentation(value.project.spreads[0].id);
  });
  assert.ok('value' in result, JSON.stringify(result));
  const viewer = await opened;
  await viewer.locator('.book-frame-present[data-current][data-ready]').waitFor();
  await checkHidden();
  await viewer.close();
  await checkHidden();
  let stderr = '';
  app.process().stderr.on('data', (data) => { stderr += data; });
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(() => {
    setTimeout(() => { throw new Error('Template URL request regression check'); }, 100);
  });
  assert.equal(await exited, 1, 'Uncaught exceptions exit instead of opening Electron error dialogs');
  assert.match(stderr, /ImageFlow hidden-mode exception:.*Template URL request regression check/);
  app = undefined;
  console.log('Hidden startup, book, template library, presentation, Dock and dialog checks passed.');
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
