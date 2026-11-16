import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'panel-hover-'));
const env = { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env });
try {
  const page = await testBook(app, join(work, 'Panels.imageflow'), true);
  await page.locator('.book-frame-book[data-current][data-ready]').waitFor();
  await page.evaluate(() => {
    window.panelWrites = [];
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'imageflow.workspace.v1') window.panelWrites.push(JSON.parse(value)); return write.call(this, key, value); };
  });
  const divider = page.getByRole('separator', { name: 'Resize project panel' });
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width / 2 + i * 4, box.y + box.height / 2);
  assert.equal(await page.evaluate(() => window.panelWrites.length), 0, 'no persistence during drag');
  await page.mouse.up();
  await page.waitForFunction(() => window.panelWrites.length === 1);
  const size = Number(await divider.getAttribute('aria-valuenow'));
  assert.equal(await page.evaluate(() => window.panelWrites[0].left), size);
  await divider.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.panelWrites.length === 2);
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), size + 10);
  await page.keyboard.press('Home');
  await page.waitForFunction(() => window.panelWrites.length === 3);
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), 232);
  // data-current marks the newest frame, which may still be loading behind the shown one; hover a rendered one.
  await page.waitForSelector('.book-frame-book[data-current][data-ready]', { state: 'attached', timeout: 30000 });
  const sheet = page.frameLocator('.book-frame-book[data-current]').locator('.if-spread-container[data-spread]').nth(2);
  await sheet.scrollIntoViewIfNeeded();
  const bounds = await sheet.boundingBox(); const id = await sheet.getAttribute('data-spread');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 12);
  await page.locator('.sheet-hover[data-canvas-spread="' + id + '"]').waitFor();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + 12);
  await page.locator('.sheet-selection[data-canvas-spread="' + id + '"]').waitFor();
  assert.equal(await page.locator('.sheet-hover').count(), 0);
  await page.mouse.move(5, 5);
  assert.equal(await page.locator('.sheet-hover').count(), 0);
  console.log('Panel persistence, keyboard sizing, canvas hover and selection passed.');
} finally { await app.close(); }
