import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { menuAction } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'workspace-'));
const profile = join(work, 'profile');
let app;
let first = true;
async function launch() {
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const w = await app.firstWindow();
  w.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, join(work, 'Book'));
  await menuAction(app, first ? 'New project…' : 'Open project…');
  first = false;
  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  return w;
}
try {
  let w = await launch();
  const canvas = () => w.locator('.canvas').boundingBox();
  const settle = () => w.locator('.workspace').evaluate(async (node) => {
    node.getBoundingClientRect();
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  const before = await canvas();
  await w.getByRole('button', { name: 'Toggle project panel', exact: true }).click();
  assert.equal(await w.getByRole('complementary', { name: 'Project', exact: true }).count(), 0);
  const widths = await w.locator('.canvas').evaluate(async (node) => {
    const widths = [];
    for (let frame = 0; frame < 16; frame++) { await new Promise(requestAnimationFrame); widths.push(node.clientWidth); }
    return widths;
  });
  assert.ok(new Set(widths).size > 2, 'Panel collapse animates through intermediate canvas widths');
  await settle();
  assert.ok((await canvas()).width > before.width + 200);
  await menuAction(app, 'Toggle Inspector');
  await settle();
  assert.ok((await canvas()).width > before.width + 450);
  await menuAction(app, 'Toggle Project Panel');
  await w.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  await settle();
  const left = w.getByRole('separator', { name: 'Resize project panel' });
  await left.focus();
  await w.keyboard.press('ArrowRight');
  assert.equal(await left.getAttribute('aria-valuenow'), '242');
  await settle();
  const handle = await left.boundingBox();
  await w.mouse.move(handle.x + 3, handle.y + 100);
  await w.mouse.down();
  await w.mouse.move(handle.x + 63, handle.y + 100, { steps: 5 });
  await w.mouse.up();
  assert.equal(await left.getAttribute('aria-valuenow'), '302');
  const right = w.getByRole('separator', { name: 'Resize Inspector' });
  await right.focus();
  await w.keyboard.press('ArrowLeft');
  assert.equal(await right.getAttribute('aria-valuenow'), '286');
  // Hover descriptions and long status messages must not move the canvas.
  await w.locator('.spread-thumb').nth(1).click();
  await settle();
  const stable = await canvas();
  await w.getByRole('radio', { name: 'Photo grid', exact: true }).hover();
  assert.deepEqual(await canvas(), stable);
  await w.locator('.status').evaluate((node) => { node.textContent = 'A long status message '.repeat(80); });
  assert.deepEqual(await canvas(), stable);
  // Both book geometry and overlay hit targets follow panel resizing.
  const sheet = await w.frameLocator('iframe.book-frame-book[data-current]').locator('[data-spread="arriving"] .if-sheet').boundingBox();
  await w.waitForFunction((width) => Math.abs(document.querySelector('.sheet-selection').getBoundingClientRect().width - width) < 2, sheet.width);
  await w.waitForTimeout(350); // Let the selection's smooth reveal finish before a coordinate click.
  const photo = await w.locator('.book-frame-book[data-current]').contentFrame().locator('[data-spread="arriving"] [data-box="hero"]').boundingBox();
  await w.mouse.click(photo.x + photo.width / 2, photo.y + photo.height / 2);
  await w.locator('.crop-editor').waitFor();
  await w.keyboard.press('Escape');
  await w.locator('.status').evaluate((node) => { node.textContent = 'Project preview · Proof export'; });
  await w.screenshot({ path: join(root, '.build', 'workspace.png') });
  await w.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  await app.close();
  w = await launch();
  assert.equal(await w.getByRole('button', { name: 'Toggle Inspector', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await w.getByRole('separator', { name: 'Resize project panel' }).getAttribute('aria-valuenow'), '302');
  await menuAction(app, 'Toggle Inspector');
  const restored = w.getByRole('separator', { name: 'Resize Inspector' });
  assert.equal(await restored.getAttribute('aria-valuenow'), '286');
  await settle();
  await restored.dblclick();
  assert.equal(await restored.getAttribute('aria-valuenow'), '276');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(940, 650));
  await settle();
  assert.equal(await w.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await w.emulateMedia({ reducedMotion: 'reduce' });
  await w.getByRole('button', { name: 'Toggle Inspector', exact: true }).click();
  assert.equal(await w.locator('.workspace').evaluate((node) => getComputedStyle(node).transitionDuration), '0s');
  console.log('Workspace smoke passed: collapse, menus, drag/keyboard resize, persistence, stable canvas, geometry and narrow window.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
