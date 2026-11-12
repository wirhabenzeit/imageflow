import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { exportAction, menuAction, testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'spread-order-'));
const project = join(work, 'Book.imageflow');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project, true);
  const thumb = (id) => w.locator('.spread-thumb[data-spread="' + id + '"]');
  const scroll = w.locator('.thumbs-scroll');
  const undo = w.getByRole('button', { name: 'Undo', exact: true });
  const ready = () => w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  const saved = (text) => w.waitForFunction((text) => document.querySelector('.status')?.textContent === text, text);
  const initial = (await w.evaluate(() => window.imageflow.currentProject())).value.project.spreads;
  const order = async () => (await read()).spreads.map(({ id }) => id);
  const ids = initial.map(({ id }) => id);
  await ready();
  await w.locator('iframe.book-frame-thumbs[data-current][data-ready]').waitFor();
  assert.equal(await thumb('title').getAttribute('draggable'), 'false');
  assert.equal(await thumb('closing').getAttribute('draggable'), 'false');

  // A real native drag, through Chromium's data transfer. One Undo restores the entire book and selection.
  await thumb('arriving').click();
  await thumb('headlands').scrollIntoViewIfNeeded();
  const box = await thumb('headlands').boundingBox();
  await thumb('arriving').dragTo(thumb('headlands'), { targetPosition: { x: box.width / 2, y: box.height - 8 } });
  await saved('Spread moved to pages 4–5');
  assert.deepEqual(await order(), [ids[0], ids[2], ids[1], ...ids.slice(3)]);
  assert.deepEqual((await read()).spreads[2], initial[1], 'content moves with the spread');
  await ready();
  assert.equal(await thumb('arriving').getAttribute('aria-current'), 'page');
  await w.waitForFunction(() => {
    const sheet = document.querySelector('.sheet-selection')?.getBoundingClientRect();
    const canvas = document.querySelector('.canvas')?.getBoundingClientRect();
    return sheet && canvas && sheet.top >= canvas.top && sheet.bottom <= canvas.bottom;
  });
  await undo.click();
  await saved('Edit undone');
  assert.deepEqual(await order(), ids);
  assert.equal(await undo.isDisabled(), true, 'the drag creates exactly one history entry');
  assert.equal(await thumb('arriving').getAttribute('aria-current'), 'page');
  await ready();

  // Controlled drag events let the test inspect insertion indicators and hold a pointer still at either edge.
  console.log('Native drag, selection, reveal and Undo passed.');
  const start = async (id) => {
    const dataTransfer = await w.evaluateHandle(() => new DataTransfer());
    await thumb(id).dispatchEvent('dragstart', { dataTransfer });
    assert.deepEqual(await dataTransfer.evaluate((data) => [...data.types]), ['application/x-imageflow-spread']);
    return dataTransfer;
  };
  const over = async (dataTransfer, id, bottom = false) => {
    await thumb(id).scrollIntoViewIfNeeded();
    const rect = await thumb(id).boundingBox();
    const point = { clientX: rect.x + rect.width / 2, clientY: rect.y + (bottom ? rect.height - 4 : 4), dataTransfer };
    await scroll.dispatchEvent('dragover', point);
    return point;
  };
  let dataTransfer = await start('arriving');
  let point = await over(dataTransfer, 'arriving');
  assert.equal(await w.locator('.spread-insertion').count(), 0, 'dropping in place has no indicator');
  await scroll.dispatchEvent('drop', point);
  assert.equal(await undo.isDisabled(), true);

  dataTransfer = await start('arriving');
  point = await over(dataTransfer, 'title');
  assert.equal(await w.locator('.spread-insertion').count(), 0, 'cannot insert ahead of the single right page');
  await scroll.dispatchEvent('drop', point);
  assert.deepEqual(await order(), ids);
  assert.equal(await undo.isDisabled(), true);

  dataTransfer = await start('arriving');
  point = await over(dataTransfer, 'settlements', true);
  await w.locator('.spread-insertion').waitFor();
  await w.screenshot({ path: join(root, '.build', 'spread-insertion.png') });
  await thumb('arriving').dispatchEvent('dragend');
  assert.equal(await w.locator('.spread-insertion').count(), 0, 'cancellation clears the indicator');
  assert.equal(await undo.isDisabled(), true);

  // Scroll without further dragover events. Dropping at the bottom of the list cannot pass the closing page.
  console.log('Indicators, no-op, disallowed targets and cancellation passed.');
  await scroll.evaluate((node) => { node.scrollTop = 0; });
  dataTransfer = await start('arriving');
  const bounds = await scroll.boundingBox();
  const bottom = { dataTransfer, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height - 8 };
  await scroll.dispatchEvent('dragover', bottom);
  await w.waitForFunction(() => document.querySelector('.thumbs-scroll').scrollTop > 250);
  await w.waitForFunction(() => {
    const node = document.querySelector('.thumbs-scroll');
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  assert.equal(await w.locator('.spread-insertion').count(), 0);
  await scroll.dispatchEvent('drop', bottom);
  assert.deepEqual(await order(), ids);

  // The reverse direction also scrolls while still. A long-distance drop lands before the chosen thumbnail.
  dataTransfer = await start('last-notes');
  await scroll.dispatchEvent('dragover', { dataTransfer, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + 8 });
  await w.waitForFunction(() => document.querySelector('.thumbs-scroll').scrollTop === 0);
  point = await over(dataTransfer, 'arriving');
  await w.locator('.spread-insertion').waitFor();
  await scroll.dispatchEvent('drop', point);
  await saved('Spread moved to pages 2–3');
  assert.deepEqual(await order(), [ids[0], 'last-notes', ...ids.slice(1, -2), 'closing']);
  assert.equal(await thumb('last-notes').getAttribute('aria-current'), 'page');
  await undo.click();
  await saved('Edit undone');
  assert.deepEqual(await order(), ids);
  assert.equal(await undo.isDisabled(), true);
  await ready();

  // Moving a focused thumbnail uses the same path, even when a different spread is selected.
  console.log('Auto-scroll in both directions and long-distance drop passed.');
  await thumb('arriving').focus();
  await w.keyboard.press('Alt+Meta+ArrowDown');
  await saved('Spread moved to pages 4–5');
  assert.equal(await thumb('arriving').evaluate((node) => node === document.activeElement), true);
  assert.equal(await thumb('arriving').getAttribute('aria-current'), 'page');
  await undo.click();
  await saved('Edit undone');
  await ready();

  // A spread is not a photo/Markdown assignment, and source drags are not sidebar reorders.
  dataTransfer = await start('arriving');
  await w.locator('.canvas').dispatchEvent('drop', { dataTransfer, clientX: 700, clientY: 300 });
  assert.deepEqual(await order(), ids);
  assert.equal(await undo.isDisabled(), true);
  for (const mime of ['application/x-imageflow-photo', 'application/x-imageflow-text']) {
    const source = await w.evaluateHandle((mime) => { const data = new DataTransfer(); data.setData(mime, 'segla'); return data; }, mime);
    await scroll.dispatchEvent('dragover', { dataTransfer: source, clientX: bounds.x + 50, clientY: bounds.y + 100 });
    await scroll.dispatchEvent('drop', { dataTransfer: source });
    assert.equal(await w.locator('.spread-insertion').count(), 0);
    assert.equal(await undo.isDisabled(), true);
    await source.dispose();
  }

  // Hold the export's file picker open to check the busy state without racing a fast export.
  console.log('Keyboard and drag-type isolation passed.');
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = () => new Promise((resolve) => { globalThis.finishExport = () => resolve({ canceled: true }); });
  });
  await exportAction(w, 'Export proof PDF');
  await w.locator('.export-progress').waitFor();
  assert.equal(await thumb('arriving').getAttribute('draggable'), 'false');
  assert.equal(await w.getByRole('button', { name: 'Move spread down' }).isDisabled(), true);
  await app.evaluate(async () => { while (!globalThis.finishExport) await new Promise((resolve) => setTimeout(resolve, 10)); });
  await app.evaluate(() => globalThis.finishExport());
  await w.locator('.export-progress').waitFor({ state: 'detached' });
  assert.equal(await thumb('arriving').getAttribute('draggable'), 'true');

  const sample = await menuAction(app, 'Open Sample Project');
  await sample.locator('iframe.book-frame-thumbs[data-current][data-ready]').waitFor();
  assert.equal(await sample.locator('.spread-thumb[draggable="true"]').count(), 0, 'read-only books cannot drag');
  console.log('ImageFlow spread reordering passed.');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await app.evaluate(() => globalThis.finishExport?.()).catch(() => {});
  await app.close();
  await rm(work, { recursive: true, force: true });
}
