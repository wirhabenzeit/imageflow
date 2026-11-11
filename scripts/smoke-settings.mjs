import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { menuAction } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'settings-'));
const profile = join(work, 'profile');
let app;
async function launch() {
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ colorScheme: null });
  await page.locator('.welcome').waitFor();
  return page;
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
  await menuAction(app, 'Settings…');
  let settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  assert.equal(await settings.getByRole('radio', { name: 'System', exact: true }).isChecked(), true);
  await menuAction(app, 'Settings…'); // Reopening an already open dialog is harmless.
  await settings.getByRole('radio', { name: 'Dark', exact: true }).check();
  await page.waitForFunction(() => document.querySelector('input[name="appearance"][value="dark"]').checked);
  await checkAppearance(page, 'dark');
  await page.screenshot({ path: join(root, '.build', 'settings-dark.png') });
  await settings.getByRole('radio', { name: 'Light', exact: true }).check();
  await page.waitForFunction(() => document.querySelector('input[name="appearance"][value="light"]').checked);
  await checkAppearance(page, 'light');
  await page.screenshot({ path: join(root, '.build', 'settings-light.png') });
  // Native radio navigation and Escape work without custom keyboard handling.
  await settings.getByRole('radio', { name: 'Light', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('input[name="appearance"][value="dark"]').checked);
  await checkAppearance(page, 'dark');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  await menuAction(app, 'Settings…');
  assert.equal(await settings.getByRole('radio', { name: 'Dark', exact: true }).isChecked(), true);
  const file = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.deepEqual(JSON.parse(await readFile(join(file, 'settings.json'), 'utf8')), { appearance: 'dark' });
  // Invalid messages cannot change native appearance or overwrite the stored choice.
  for (const patch of [{ appearance: 'sepia' }, { appearance: null }, { unrelated: true }, null]) {
    const result = await page.evaluate((patch) => window.imageflow.updateSettings(patch), patch);
    assert.ok(result.error);
  }
  await checkAppearance(page, 'dark');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  await app.close();
  page = await launch();
  await checkAppearance(page, 'dark');
  assert.deepEqual(await page.evaluate(() => window.imageflow.getSettings()), { value: { appearance: 'dark' } });
  await menuAction(app, 'Settings…');
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: 'System', exact: true }).check();
  await page.waitForFunction(() => document.querySelector('input[name="appearance"][value="system"]').checked);
  await checkAppearance(page, 'system');
  await app.close();
  page = await launch();
  await checkAppearance(page, 'system');
  assert.deepEqual(await page.evaluate(() => window.imageflow.getSettings()), { value: { appearance: 'system' } });
  console.log('Settings smoke passed: native menu/shortcut, appearance choices, keyboard/close behavior, validation and persisted Dark/System after relaunch.');
} finally { await app?.close(); await rm(work, { recursive: true, force: true }); }
