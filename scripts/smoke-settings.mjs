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
  // Record the real presentation path while keeping test Settings windows offscreen.
  await app.evaluate(({ app }) => {
    globalThis.settingsSizing = [];
    app.on('browser-window-created', (_event, owner) => {
      const resize = owner.setContentSize.bind(owner), show = owner.show.bind(owner), focus = owner.focus.bind(owner);
      owner.setContentSize = (width, height, animate) => {
        if (owner.getTitle() === 'Settings') globalThis.settingsSizing.push({ id: owner.id, kind: 'resize', height, animate });
        resize(width, height, animate);
      };
      owner.show = () => {
        if (owner.getTitle() === 'Settings') globalThis.settingsSizing.push({ id: owner.id, kind: 'show', height: owner.getContentSize()[1] });
        else show();
      };
      owner.focus = () => { if (owner.getTitle() !== 'Settings') focus(); };
    });
  });
  return page;
}
async function openSettings(command = 'Settings…') {
  const existing = app.windows().find((page) => page.url() === settingsURL);
  const created = existing ? undefined : app.waitForEvent('window', {
    predicate: (page) => page.waitForURL(settingsURL).then(() => true, () => false),
  });
  await app.evaluate(({ Menu }, command) => {
    delete process.env.IMAGEFLOW_HIDE_WINDOW;
    Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []).find((item) => item.label === command).click();
  }, command);
  const page = existing ?? await created;
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole('main', { name: 'Settings', exact: true }).waitFor();
  if (command === 'Settings…') await page.locator('input[name="appearance"]:checked').waitFor();
  else await page.getByRole('tab', { name: 'Agents', selected: true }).waitFor();
  await page.waitForFunction(() => innerHeight === Math.min(760, Math.max(120, Math.ceil(document.querySelector('.settings-window > div').getBoundingClientRect().height))));
  const height = await page.evaluate(() => innerHeight);
  const ownerId = await (await app.browserWindow(page)).evaluate((owner) => owner.id);
  // A sized DOM can be ready before Electron's ready-to-show event arrives on a slower runner.
  const events = await app.evaluate((_electron, id) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const poll = () => {
      const events = globalThis.settingsSizing.filter((event) => event.id === id);
      if (events.some((event) => event.kind === 'show')) return resolve(events);
      if (Date.now() >= deadline) return reject(new Error('Settings was not shown after painting and sizing'));
      setTimeout(poll, 20);
    };
    poll();
  }), ownerId);
  const firstShow = events.findIndex((event) => event.kind === 'show');
  assert.ok(firstShow >= 0, 'Settings is shown after it has painted and been sized');
  if (!existing) {
    assert.equal(events[firstShow].height, height, 'The first visible size already fits the selected pane');
    assert.ok(events.slice(0, firstShow).every((event) => event.animate === false), 'Initial sizing never animates');
    assert.ok(events.slice(firstShow + 1).every((event) => event.kind !== 'resize'), 'Opening does not resize the visible window');
  }
  await app.evaluate(() => { process.env.IMAGEFLOW_HIDE_WINDOW = '1'; });
  return page;
}
async function closeWindow(page) {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((owner) => owner.webContents.getURL() === url).close(), page.url());
  await closed;
}
async function checkAppearance(page, source) {
  await page.waitForFunction(async (appearance) => (await window.imageflow.getSettings()).value?.appearance === appearance, source);
  // Reading the persisted setting can beat the update handler applying it to nativeTheme.
  const applied = await app.evaluate(({ nativeTheme }, source) => new Promise((resolve) => {
    const deadline = Date.now() + 20000;
    const poll = () => {
      if (nativeTheme.themeSource === source || Date.now() >= deadline) return resolve(nativeTheme.themeSource);
      setTimeout(poll, 20);
    };
    poll();
  }), source);
  assert.equal(applied, source);
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
  const generalHeight = await settings.evaluate(() => innerHeight);
  await settings.getByRole('tab', { name: 'Agents' }).click();
  await settings.waitForFunction((height) => innerHeight > height, generalHeight);
  await closeWindow(settings);
  settings = await openSettings('Agent Connections…');
  assert.ok(await settings.evaluate(() => innerHeight) > generalHeight, 'Direct Agents opens at its larger size');
  await closeWindow(settings);
  settings = await openSettings();
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
