import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';
// Arrow keys on the canvas select the neighbouring spread: up/down in the vertical layout, all four in a grid.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'spread-arrows-'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const until = async (check, message) => { for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)); } assert.ok(await check(), message); };
try {
  const page = await testBook(app, join(work, 'Arrows.imageflow'), true);
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  const ids = await page.locator('.spread-thumb').evaluateAll((thumbs) => thumbs.map((thumb) => thumb.dataset.spread));
  const selected = () => page.locator('.spread-thumb[aria-current="page"]').evaluate((thumb) => thumb.dataset.spread);
  const expect = async (index, message) => until(async () => await selected() === ids[index], message + ': expected spread ' + index);
  const press = async (key) => { await page.locator('main.canvas').focus(); await page.keyboard.press(key); };
  await page.locator('.spread-thumb').nth(1).click();
  await expect(1, 'thumbnail click');
  await press('ArrowDown'); await expect(2, 'vertical down');
  await press('ArrowUp'); await press('ArrowUp'); await expect(0, 'vertical up');
  const expectSinglePageOutline = async (index, side) => {
    const id = ids[index];
    await page.locator('.sheet-label[data-canvas-spread="' + id + '"]').scrollIntoViewIfNeeded();
    const frame = page.frameLocator('.canvas .book-frame-book[data-current][data-ready]');
    const paper = await frame.locator('[data-spread="' + id + '"] .if-sheet').boundingBox();
    const selection = page.locator('.sheet-selection');
    const keyboardOutline = await selection.boundingBox();
    assert.ok(Math.abs(keyboardOutline.width * 2 - paper.width) < 2, 'Single end selects only its printable page');
    assert.ok(Math.abs(keyboardOutline.x - paper.x - (side === 'right' ? paper.width / 2 : 0)) < 2);
    await page.mouse.click(paper.x + paper.width * (side === 'right' ? .8 : .2), paper.y + 5);
    const mouseOutline = await selection.boundingBox();
    assert.ok(Math.abs(mouseOutline.width - keyboardOutline.width) < 2, 'Mouse and keyboard outlines have the same width');
    assert.ok(Math.abs(mouseOutline.x - keyboardOutline.x) < 2, 'Mouse and keyboard outlines select the same half');
    assert.equal(await page.locator('.sheet-label.selected .sheet-layout-mode').getAttribute('aria-label'), 'Single page');
  };
  await expectSinglePageOutline(0, 'right');
  await page.locator('.spread-thumb').nth(ids.length - 2).click();
  await press('ArrowDown'); await expect(ids.length - 1, 'vertical down to closing page');
  await expectSinglePageOutline(ids.length - 1, 'left');
  await page.locator('.spread-thumb').nth(0).click();
  await press('ArrowRight'); await press('ArrowLeft'); await expect(0, 'vertical layout ignores left and right');
  const window = await app.browserWindow(page).then((handle) => handle.evaluate((window) => window.id));
  const command = (id) => app.evaluate(({ Menu, BrowserWindow }, [id, window]) => { const item = Menu.getApplicationMenu().getMenuItemById(id); item.click(item, BrowserWindow.fromId(window)); }, [id, window]);
  await command('layout-grid');
  await until(() => page.locator('main.canvas-grid').count(), 'grid layout');
  await command('grid-columns-3');
  await press('ArrowRight'); await expect(1, 'grid right');
  await press('ArrowDown'); await expect(4, 'grid down a row');
  await press('ArrowLeft'); await expect(3, 'grid left');
  await press('ArrowUp'); await expect(0, 'grid up a row');
  console.log('Spread arrow keys passed.');
} finally {
  await closeApp(app);
}
