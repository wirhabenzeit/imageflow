import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'reorder-motion-'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const page = await testBook(app, join(work, 'Reorder.imageflow'), true);
  const ready = () => page.waitForFunction(() => ['book', 'thumbs'].every(view =>
    document.querySelector('.book-frame-' + view + '[data-current][data-ready]:not(.book-frame-pending)')));
  await ready();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Record every painted host frame, including the interval while a candidate loads.
  await page.evaluate(() => {
    window.reorderSamples = [];
    const sample = () => {
      const frames = ['book', 'thumbs'].map(view => document.querySelector('.book-frame-' + view + ':not(.book-frame-pending)'));
      window.reorderSamples.push({ revisions: frames.map(frame => frame?.src.split('?')[0]),
        labels: [...document.querySelectorAll('.sheet-label')].map(node => ({ id: node.dataset.canvasSpread, text: node.textContent, top: node.style.top })),
        motions: document.getAnimations().filter(a => a.effect?.target?.matches('[data-canvas-spread]')).map(a => ({ id: a.effect.target.dataset.canvasSpread, start: a.startTime })) });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const labels = () => page.locator('.sheet-label').evaluateAll(nodes => nodes.map(node => node.dataset.canvasSpread));
  const initial = await labels();
  await page.locator('.spread-thumb').nth(1).click();
  async function move(action) {
    const before = await page.locator('.book-frame-book[data-current]').getAttribute('src');
    await menuAction(app, action);
    await page.waitForFunction(before => document.querySelector('.book-frame-book[data-current]')?.getAttribute('src') !== before, before);
    await ready();
    await page.waitForFunction(() => !document.getAnimations().some(a => a.effect?.target?.matches('[data-canvas-spread]')));
    const host = await labels();
    for (const view of ['book', 'thumbs']) {
      const frame = await page.locator('.book-frame-' + view + '[data-current]').elementHandle().then(node => node.contentFrame());
      assert.deepEqual(await frame.locator('.if-spread-container[data-spread]').evaluateAll(nodes => nodes.map(node => node.dataset.spread)), host);
    }
    return host;
  }
  const moved = await move('Move Spread Down');
  assert.notDeepEqual(moved, initial);
  assert.deepEqual(await move('Undo Book Edit'), initial);
  assert.deepEqual(await move('Redo Book Edit'), moved);
  await menuAction(app, 'Move Spread Down');
  await menuAction(app, 'Move Spread Down');
  await ready();
  await move('Undo Book Edit');
  const samples = await page.evaluate(() => window.reorderSamples);
  assert.ok(samples.some(sample => sample.motions.length >= 2), 'canvas labels and overlays animate');
  assert.ok(samples.every(sample => sample.revisions[0] === sample.revisions[1]), 'canvas and sidebar publish the same revision on every painted frame');
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].revisions[0] === samples[i - 1].revisions[0]) assert.deepEqual(samples[i].labels, samples[i - 1].labels, 'labels stay with displayed artwork while rendering');
  }
  await menuAction(app, 'Grid');
  await page.waitForFunction(() => document.querySelector('main.canvas-grid'));
  await move('Move Spread Down');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { window.reorderSamples = []; });
  await move('Undo Book Edit');
  assert.ok((await page.evaluate(() => window.reorderSamples)).every(sample => !sample.motions.length), 'Reduce Motion suppresses sliding');
  const beforeDrag = await page.locator('.book-frame-book[data-current]').getAttribute('src');
  await page.locator('.spread-thumb').nth(1).dragTo(page.locator('.spread-thumb').nth(3));
  await page.waitForFunction(before => document.querySelector('.book-frame-book[data-current]')?.getAttribute('src') !== before, beforeDrag);
  await ready();
  await move('Undo Book Edit');
  console.log('Canvas reorder, synchronized replacement, Undo/Redo, rapid moves and Reduce Motion passed.');
} finally { await app.close(); }
