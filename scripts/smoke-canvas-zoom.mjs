import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { canvasArtworkBounds, menuAction, testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'canvas-zoom-'));
const folder = join(work, 'Zoom.imageflow');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const page = await testBook(app, folder, true);
  const canvas = page.locator('main.canvas');
  const stage = canvas.locator('.stage');
  await canvas.locator('.book-frame-book[data-current][data-ready]').waitFor();
  const frame = page.frameLocator('.canvas .book-frame-book[data-current][data-ready]');
  const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const state = () => canvas.evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop, width: node.clientWidth,
    stage: node.querySelector('.stage').getBoundingClientRect().width, overflow: getComputedStyle(node).overflowX }));
  const fit = async () => { await page.getByRole('button', { name: 'Return to Fit', exact: true }).click(); await settled(); };
  const deviceScale = await page.evaluate(() => window.devicePixelRatio);
  const manifests = await Promise.all(['project.json', 'photos.json'].map(name => readFile(join(folder, name), 'utf8')));
  await canvas.evaluate(node => {
    const stage = node.querySelector('.stage');
    node.scrollTop = stage.offsetTop + stage.querySelectorAll('.sheet-label')[1].offsetTop + 26 - 60;
  });
  await settled();
  const original = await state();
  assert.equal(original.overflow, 'hidden');
  await page.getByRole('button', { name: 'Zoom book in', exact: true }).click();
  await page.waitForFunction(width => Math.abs(document.querySelector('.canvas .stage').getBoundingClientRect().width / width - 1.2) < .01, original.stage);
  await settled();
  assert.equal(await page.locator('.canvas-zoom-value').textContent(), '120%');
  await fit();
  await page.waitForFunction(top => Math.abs(document.querySelector('main.canvas').scrollTop - top) < 3, original.top);
  assert.equal((await state()).left, 0);

  // A native ctrl-wheel pinch keeps the point under the pointer fixed as the page changes size.
  const paper = frame.locator('.if-sheet').nth(1);
  await paper.waitFor();
  const paperSelector = await paper.evaluate(node => '[data-spread=' + JSON.stringify(node.closest('[data-spread]').dataset.spread) + '] .if-sheet');
  const paperOnScreen = () => canvasArtworkBounds(page, paperSelector);
  const before = await paperOnScreen();
  const bounds = await canvas.boundingBox();
  const point = { x: bounds.x + bounds.width * .55, y: Math.max(bounds.y + 80, Math.min(bounds.y + bounds.height - 80, before.y + before.height * .3)) };
  const fraction = { x: (point.x - before.x) / before.width, y: (point.y - before.y) / before.height };
  // Gentle pinches must leave Fit too; a snap threshold must not swallow small deltas.
  await stage.dispatchEvent('wheel', { ctrlKey: true, deltaY: -.5, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true });
  await page.waitForFunction(() => document.querySelector('.canvas-zoom-value').textContent !== 'Fit');
  await fit();
  const frameWidth = () => canvas.locator('iframe[data-current]').evaluate(node => node.clientWidth);
  const fittedWidth = await frameWidth();
  // Send several wheel events in each frame to model a real trackpad pinch, including closely spaced events.
  const sendPinch = (delta, steps) => stage.evaluate(async (node, { delta, steps, point }) => {
    const samples = [];
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < 3; j++) node.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: delta / steps / 3,
        clientX: point.x, clientY: point.y, bubbles: true, cancelable: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = node.closest('.canvas');
      const sheet = node.querySelectorAll('.sheet-label')[1];
      const sheetY = Number.parseFloat(sheet.style.top) + 26;
      samples.push({ width: node.getBoundingClientRect().width, frameWidth: node.querySelector('iframe[data-current]').clientWidth,
        sheetY: sheetY + node.getBoundingClientRect().top, scrollTop: canvas.scrollTop });
    }
    return samples;
  }, { delta, steps, point });
  const samples = await sendPinch(-Math.log(2) / .01, 22);
  assert.ok(samples.every(sample => sample.frameWidth === fittedWidth), 'Pinching does not resize the book frame');
  assert.ok(samples.every((sample, i) => i === 0 || sample.width >= samples[i - 1].width), 'Zoom progresses without reversing');
  assert.ok(samples.every(sample => Math.abs(sample.sheetY + before.height * (sample.width / original.stage) * fraction.y - point.y) < 3),
    'The same position stays under the pointer throughout the pinch');
  await page.waitForFunction(width => Math.abs(document.querySelector('.canvas .stage').getBoundingClientRect().width / width - 2) < .01, original.stage);
  await settled();
  const after = await paperOnScreen();
  assert.ok(Math.abs(after.x + after.width * fraction.x - point.x) < 3, 'Pinch retains the horizontal pointer anchor');
  assert.ok(Math.abs(after.y + after.height * fraction.y - point.y) < 3, 'Pinch retains the vertical pointer anchor');

  // Space-drag pans the viewport without opening an editor or moving a photo.
  const beforePan = await state();
  await canvas.focus();
  await page.keyboard.down('Space');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x - 100, point.y - 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const afterPan = await state();
  assert.ok(afterPan.left > beforePan.left + 50, 'Space-drag pans horizontally');
  assert.ok(afterPan.top > beforePan.top + 30, 'Space-drag pans vertically');
  assert.equal(await page.locator('.crop-editor, .edit-popover').count(), 0);
  // Pinching back through 100% keeps moving locally, even after navigating elsewhere while enlarged.
  await canvas.evaluate(node => { node.scrollTop += 600; });
  const crossing = await sendPinch(Math.log(2 / .99) / .01, 22);
  assert.ok(crossing.at(-1).width < original.stage, 'The pinch continues below Fit');
  assert.ok(Math.abs(crossing.at(-1).scrollTop - original.top) > 80, 'Crossing Fit does not jump back to the original reading position');
  await fit();
  await page.waitForFunction(top => Math.abs(document.querySelector('main.canvas').scrollTop - top) < 3, original.top);
  assert.equal((await state()).left, 0);
  assert.equal((await state()).overflow, 'hidden');
  // Ordinary wheel input keeps the fitted view locked horizontally and scrolls vertically.
  const locked = await state();
  await canvas.hover();
  await page.mouse.wheel(150, 80);
  await page.waitForFunction(top => document.querySelector('main.canvas').scrollTop > top + 20, locked.top);
  assert.equal((await state()).left, 0);

  await menuAction(app, 'Zoom Out');
  await page.waitForFunction(() => document.querySelector('.canvas-zoom-value').textContent === '83%');
  assert.ok((await state()).stage < original.stage);
  await canvas.focus(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.canvas-zoom-value').textContent === 'Fit');
  await menuAction(app, 'Zoom In');
  await page.waitForFunction(() => document.querySelector('.canvas-zoom-value').textContent === '120%');
  await menuAction(app, 'Zoom to Fit');
  await page.waitForFunction(() => document.querySelector('.canvas-zoom-value').textContent === 'Fit');
  // Grid layouts retain their fitted width and scale relative to that width too.
  await menuAction(app, 'Grid');
  await page.waitForSelector('.canvas-grid');
  await settled();
  const grid = await state();
  await page.getByRole('button', { name: 'Zoom book in', exact: true }).click();
  await page.waitForFunction(width => Math.abs(document.querySelector('.canvas .stage').getBoundingClientRect().width / width - 1.2) < .01, grid.stage);
  await page.screenshot({ path: join(root, '.build/canvas-zoom-preview.png') });
  // Escape works immediately after using a zoom button, without refocusing the paper.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.canvas-zoom-value').textContent === 'Fit');
  assert.deepEqual(await Promise.all(['project.json', 'photos.json'].map(name => readFile(join(folder, name), 'utf8'))), manifests);
  assert.equal(await page.evaluate(() => window.devicePixelRatio), deviceScale, 'Canvas zoom does not zoom the application chrome');
  console.log('Canvas fit, relative zoom, pointer pinch, Space-drag, exact Fit restoration and menu commands passed.');
} finally { await app.close(); await rm(work, { recursive: true, force: true }); }
