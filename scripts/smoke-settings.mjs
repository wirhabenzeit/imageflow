import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'settings-'));
const profile = join(work, 'profile');
const settingsURL = 'imageflow://editor/settings';
let app;
async function launch() {
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ colorScheme: null });
  await page.locator('.start-window').waitFor();
  return page;
}
async function openSettings() {
  const existing = app.windows().find((page) => page.url() === settingsURL);
  const created = existing ? undefined : app.waitForEvent('window');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []).find((item) => item.label === 'Settings…').click());
  const page = existing ?? await created;
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole('main', { name: 'Settings', exact: true }).waitFor();
  await page.waitForFunction(() => !!document.querySelector('input[name="appearance"]:checked')).catch(async (error) => {
    console.error(await page.locator('body').innerText(), await page.evaluate(() => window.imageflow.getSettings()));
    throw error;
  });
  return page;
}
async function closeWindow(page) {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((owner) => owner.webContents.getURL() === url).close(), page.url());
  await closed;
}
async function checkAppearance(page, source) {
  await page.waitForFunction(async (appearance) => (await window.imageflow.getSettings()).value?.appearance === appearance, source);
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), source);
  const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await page.waitForFunction((dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark &&
    getComputedStyle(document.querySelector('.studio')).backgroundColor === (dark ? 'rgb(37, 37, 37)' : 'rgb(245, 245, 245)'), dark);
}
try {
  let page = await launch();
  assert.deepEqual(await page.evaluate(() => window.imageflow.getSettings()), { value: { appearance: 'system' } });
  await checkAppearance(page, 'system');
  const accelerator = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []).find((item) => item.label === 'Settings…')?.accelerator);
  assert.equal(accelerator, 'CmdOrCtrl+,');
  let settings = await openSettings();
  assert.equal(await settings.getByRole('radio', { name: 'System', exact: true }).isChecked(), true);
  const native = await app.evaluate(({ BrowserWindow }, url) => {
    const owner = BrowserWindow.getAllWindows().find((owner) => owner.webContents.getURL() === url);
    return { title: owner.getTitle(), modal: owner.isModal(), parent: !!owner.getParentWindow(), resizable: owner.isResizable() };
  }, settingsURL);
  assert.deepEqual(native, { title: 'Settings', modal: false, parent: false, resizable: false });
  assert.equal(await openSettings(), settings, 'Settings reuses its existing window.');
  assert.equal(app.windows().filter((page) => page.url() === settingsURL).length, 1);
  assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true }).count(), 0);
  await settings.getByRole('radio', { name: 'Dark', exact: true }).check();
  await checkAppearance(page, 'dark');
  await checkAppearance(settings, 'dark');
  await settings.screenshot({ path: join(root, '.build', 'settings-dark.png') });
  await settings.getByRole('radio', { name: 'Light', exact: true }).check();
  await checkAppearance(page, 'light');
  await checkAppearance(settings, 'light');
  await settings.screenshot({ path: join(root, '.build', 'settings-light.png') });
  await settings.getByRole('radio', { name: 'Light', exact: true }).focus();
  await settings.keyboard.press('ArrowRight');
  await checkAppearance(page, 'dark');
  await checkAppearance(settings, 'dark');

  // Book controls remain usable while Settings is open, and Settings cannot perform project operations.
  const book = join(work, 'Book.imageflow');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, book);
  page = await testBook(app, book, true);
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  // The photo grid's Gap is a spread setting the page does not show, so it is in the sidebar.
  await page.locator('.spread-thumb').nth(3).click();
  const gap = page.getByRole('spinbutton', { name: 'Gap', exact: true });
  await gap.fill('9');
  await gap.press('Tab');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'Gap updated');
  for (let i = 0; i < 50 && JSON.parse(await readFile(join(book, 'project.json'), 'utf8')).spreads[3].params.gutter !== 9; i++) await page.waitForTimeout(100);
  assert.equal(JSON.parse(await readFile(join(book, 'project.json'), 'utf8')).spreads[3].params.gutter, 9);
  assert.equal(settings.isClosed(), false);
  assert.ok((await settings.evaluate(() => window.imageflow.openProject('sample'))).error);

  // A settings update from the editor also refreshes the separate window's selected option.
  await page.evaluate(() => window.imageflow.updateSettings({ appearance: 'light' }));
  await settings.waitForFunction(() => document.querySelector('input[value="light"]').checked);
  await checkAppearance(settings, 'light');
  await settings.getByRole('radio', { name: 'Dark', exact: true }).check();
  await checkAppearance(page, 'dark');
  const file = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.deepEqual(JSON.parse(await readFile(join(file, 'settings.json'), 'utf8')), { appearance: 'dark' });
  for (const patch of [{ appearance: 'sepia' }, { appearance: null }, { unrelated: true }, null]) {
    const result = await settings.evaluate((patch) => window.imageflow.updateSettings(patch), patch);
    assert.ok(result.error);
  }
  await checkAppearance(page, 'dark');
  await closeWindow(settings);
  assert.equal(page.isClosed(), false, 'Closing Settings leaves the book window open.');
  settings = await openSettings();
  assert.equal(await settings.getByRole('radio', { name: 'Dark', exact: true }).isChecked(), true);
  await app.close();

  page = await launch();
  await checkAppearance(page, 'dark');
  settings = await openSettings();
  await settings.getByRole('radio', { name: 'System', exact: true }).check();
  await checkAppearance(page, 'system');
  await app.close();
  page = await launch();
  await checkAppearance(page, 'system');
  settings = await openSettings();
  await closeWindow(page);
  assert.equal(settings.isClosed(), false, 'Settings remains independent of the book window.');
  assert.equal(await openSettings(), settings);
  await settings.getByRole('radio', { name: 'Dark', exact: true }).check();
  await checkAppearance(settings, 'dark');
  await settings.getByRole('radio', { name: 'System', exact: true }).check();
  await checkAppearance(settings, 'system');
  console.log('Settings smoke passed: independent native window, singleton/reopen/close behavior, usable book, synchronized appearance, validation and persisted Dark/System after relaunch.');
} finally { await app?.close(); await rm(work, { recursive: true, force: true }); }
