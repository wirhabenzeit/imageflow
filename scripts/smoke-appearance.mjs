import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { testBook, menuAction, exportAction, agentSettings, closeSettings, popupAction } from './ui-actions.mjs';

// Change app settings only inside this isolated profile, never the user's macOS preference.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'appearance-'));
const book = join(work, 'Book.imageflow');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  let w = await app.firstWindow();
  w.setDefaultTimeout(25000);
  await w.emulateMedia({ colorScheme: null });
  await app.evaluate(({ BrowserWindow, dialog }, filePath) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, book);
  async function appearance(mode) {
    const result = await w.evaluate((appearance) => window.imageflow.updateSettings({ appearance }), mode);
    assert.equal(result.value?.appearance, mode);
    assert.equal(result.value?.importMode, 'copy');
    await w.waitForFunction((mode) => matchMedia('(prefers-color-scheme: dark)').matches === (mode === 'dark') &&
      getComputedStyle(document.querySelector('.studio')).backgroundColor === (mode === 'dark' ? 'rgb(37, 37, 37)' : 'rgb(245, 245, 245)'), mode).catch(async (error) => {
      console.log(await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors })));
      console.log(await w.evaluate(() => ({ dark: matchMedia('(prefers-color-scheme: dark)').matches, background: getComputedStyle(document.querySelector('.studio')).backgroundColor, surface: getComputedStyle(document.querySelector('.studio')).getPropertyValue('--panel-surface') })));
      throw error;
    });
  }
  await w.locator('.start-window').waitFor();
  await appearance('dark');
  assert.equal(await w.getByRole('button', { name: 'Open…', exact: true }).isEnabled(), true);
  await w.screenshot({ path: join(root, '.build', 'appearance-welcome-dark.png') });
  await appearance('light');
  w = await testBook(app, book, true);
  const ready = () => w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await ready();
  await w.locator('.spread-thumb').nth(1).click();
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const sheet = frame.locator('[data-spread="arriving"] .if-sheet');
  await w.waitForTimeout(400);
  await w.locator('.canvas').evaluate((node) => { node.scrollTo({ top: Math.round(node.scrollTop), behavior: 'instant' }); });
  await w.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sheet.locator('img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  const captureArtwork = async () => w.screenshot({ clip: await sheet.boundingBox(), timeout: 10000 });
  const lightArtwork = await captureArtwork();
  const frameURL = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  const lightGeometry = await sheet.boundingBox();
  await appearance('dark');
  assert.equal(await w.locator('iframe.book-frame-book[data-current]').getAttribute('src'), frameURL, 'Appearance must not reload the book or lose selection.');
  assert.equal(await frame.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await sheet.evaluate((node) => getComputedStyle(node).colorScheme), 'light only');
  assert.deepEqual(await sheet.boundingBox(), lightGeometry, 'Appearance must not change artwork geometry.');
  assert.ok((await captureArtwork()).equals(lightArtwork), 'Every artwork pixel is unchanged in dark mode.');
  // Preview gutters must leave host labels visible. Ignore the artwork's soft shadow above them.
  await w.locator('iframe.book-frame-thumbs[data-current][data-ready]').waitFor();
  await w.locator('iframe.book-frame-layouts[data-current][data-ready]').waitFor();
  const labels = [w.locator('.spread-thumb[aria-current="page"] .spread-thumb-label'), w.locator('.layout-option[aria-checked="true"] .layout-option-label')];
  for (const [index, label] of labels.entries()) {
    const clip = await label.boundingBox();
    const visible = await w.screenshot({ clip });
    await w.locator('.book-frame').evaluateAll((nodes) => nodes.forEach((node) => { node.style.visibility = 'hidden'; }));
    const unobscured = await w.screenshot({ clip });
    await w.locator('.book-frame').evaluateAll((nodes) => nodes.forEach((node) => { node.style.removeProperty('visibility'); }));
    const textPixels = (buffer) => sharp(buffer).greyscale().threshold(140).raw().toBuffer();
    const matches = (await textPixels(visible)).equals(await textPixels(unobscured));
    if (!matches) {
      await writeFile(join(root, '.build', `appearance-label-${index}.png`), visible);
      await writeFile(join(root, '.build', `appearance-label-${index}-unobscured.png`), unobscured);
    }
    assert.ok(matches, 'Preview frames must leave the labels visible.');
  }
  // Native controls, fields, menus, and secondary text should stay legible.
  const contrast = await w.evaluate(() => {
    const lum = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    return ['.project-panel', '.inspector'].map((selector) => {
      const parent = document.querySelector(selector);
      const text = getComputedStyle(parent.querySelector('.muted, .field-name'));
      return ratio(lum(text.color), lum(getComputedStyle(parent).backgroundColor));
    });
  });
  assert.ok(contrast.every((value) => value >= 4.5), JSON.stringify(contrast));
  const nativeExport = await popupAction(app, w, w.locator('.export-menu .action-menu-trigger'));
  assert.deepEqual(nativeExport.map(({ label }) => label), ['Export for Print…', 'Export PDF…']);
  const nativeImport = await popupAction(app, w, w.locator('.source-import .action-menu-trigger'));
  assert.ok(nativeImport.some(({ label }) => label === 'Import folder…'));
  // The sidebar's list of the spread's boxes opens a placed photo selected, with its crop toolbar.
  await ready();
  await w.locator('.inspector .content-item:has(img)').first().click();
  await w.locator('.crop-toolbar').waitFor();
  assert.equal(await w.locator('.crop-toolbar').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(53, 53, 53)');
  await w.screenshot({ path: join(root, '.build', 'appearance-crop-dark.png') });
  await w.getByRole('button', { name: 'Done', exact: true }).click();
  const heading = await frame.locator('[data-spread="arriving"] [data-edit="heading"]').boundingBox();
  await w.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2);
  await w.locator('.edit-popover').waitFor();
  await w.waitForTimeout(150);
  assert.equal(await w.locator('.edit-popover textarea').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(36, 36, 36)');
  await w.screenshot({ path: join(root, '.build', 'appearance-popover-dark.png') });
  await w.keyboard.press('Escape');
  await w.locator('.source-photo').first().dblclick();
  await w.getByRole('dialog', { name: /Quick Look/ }).waitFor();
  await w.waitForTimeout(180);
  await w.screenshot({ path: join(root, '.build', 'appearance-quicklook-dark.png') });
  await w.getByRole('button', { name: 'Close Quick Look' }).click();
  const agents = await agentSettings(app);
  assert.equal(await agents.locator('.settings-window').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(37, 37, 37)');
  await agents.getByText('Claude Code and other agents').click();
  await agents.screenshot({ path: join(root, '.build', 'appearance-agents-dark.png') });
  await closeSettings(app);
  // An open template editor follows appearance changes without discarding its uncommitted draft.
  async function calendar() {
    await w.locator('[data-spread="march"].spread-thumb').click();
    await ready();
    await w.locator('.inspector').getByRole('button', { name: 'Edit Calendar grid', exact: true }).click();
    const editor = w.frameLocator('.element-editor-frame');
    await editor.getByRole('button', { name: '14', exact: true }).waitFor();
    await w.waitForFunction(() => !document.querySelector('.element-editor .ee-status.muted'));
    return editor;
  }
  const editor = await calendar();
  assert.equal(await editor.locator('html').evaluate((node) => getComputedStyle(node).colorScheme), 'light dark');
  assert.equal(await editor.locator('[data-imageflow-appearance]').count(), 0, 'Custom editors follow the system without an opt-in.');
  await editor.getByRole('button', { name: '1', exact: true }).press('Space');
  await editor.getByRole('button', { name: '1', exact: true, pressed: true }).waitFor();
  const month = await editor.locator('h3').textContent();
  await w.waitForTimeout(200);
  await w.screenshot({ path: join(root, '.build', 'appearance-calendar-dark.png') });
  assert.equal(await editor.locator('#root').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(37, 37, 37)');
  await appearance('light');
  await editor.locator('#root').evaluate((node) => new Promise((resolve) => requestAnimationFrame(() => resolve(getComputedStyle(node).backgroundColor))));
  assert.equal(await editor.locator('h3').textContent(), month);
  assert.match(await editor.getByRole('button', { name: '1', exact: true }).getAttribute('class'), /marked/);
  assert.equal(await editor.locator('#root').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(245, 245, 245)');
  await w.getByRole('dialog', { name: 'Edit calendar' }).getByRole('button', { name: 'Close', exact: true }).click();
  await appearance('dark');
  await w.locator('[data-spread="road"].spread-thumb').click();
  await ready();
  await w.locator('.inspector').getByRole('button', { name: 'Edit Route map', exact: true }).click();
  await w.frameLocator('.element-editor-frame').locator('.route-editor-frame svg').waitFor();
  await w.waitForTimeout(200);
  await w.screenshot({ path: join(root, '.build', 'appearance-route-dark.png') });
  await w.getByRole('dialog', { name: 'Edit route' }).getByRole('button', { name: 'Close', exact: true }).click();
  // Real proof exports, including flowed text, rasterize identically in both appearances.
  const proofBook = join(work, 'whitewall.imageflow');
  await cp(join(root, 'sample/whitewall'), proofBook, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
  w = await testBook(app, proofBook);
  await w.locator('.project-identity strong').getByText('whitewall', { exact: true }).waitFor();
  await ready();
  const rasters = [];
  for (const mode of ['light', 'dark']) {
    await appearance(mode);
    const pdf = join(work, mode + '.pdf');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
    await exportAction(w, 'Export proof PDF');
    await w.waitForFunction(() => /^Proof PDF saved/.test(document.querySelector('.status').textContent));
    rasters.push(execFileSync('pdftoppm', ['-r', '30', pdf]));
  }
  assert.ok(rasters[1].equals(rasters[0]), 'Proof artwork and text must be identical in both appearances.');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(940, 650));
  await w.waitForFunction(() => innerWidth === 940);
  assert.equal(await w.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await w.screenshot({ path: join(root, '.build', 'appearance-minimum-dark.png') });
  console.log('Appearance smoke passed: live native theme, editor controls/dialogs, automatic template appearance, preserved drafts, pixel-identical book and proof output.');
} catch (error) { console.error('Appearance check failed', error); throw error; } finally { await app.close(); await rm(work, { recursive: true, force: true }); }
