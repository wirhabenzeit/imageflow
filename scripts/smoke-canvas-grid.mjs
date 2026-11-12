import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

// Grid mode of the canvas (#52): spreads fill rows column by column and the canvas scrolls sideways. Checks the
// geometry, menu state, sidebar reveal, in-view highlight, lazy photos, sideways wheel scrolling, editing a box, and
// that the layout is remembered for the book.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'canvas-grid-'));
const profile = join(work, 'profile');
const book = join(work, 'Book.imageflow');
let app;
let first = true;
async function launch() {
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  let w = await app.firstWindow();
  w.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await w.locator('.start-window').waitFor();
  w = await testBook(app, book, first);
  first = false;
  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  // Reveals jump instead of scrolling smoothly, which a hidden test window may throttle.
  await w.emulateMedia({ colorScheme: null, reducedMotion: 'reduce' });
  return w;
}
const checked = () => app.evaluate(({ Menu }) => Object.fromEntries(['layout-vertical', 'layout-grid', 'grid-rows-1', 'grid-rows-2', 'grid-rows-3', 'grid-rows-4']
  .map((id) => [id, Menu.getApplicationMenu().getMenuItemById(id).checked])));
// Rows menu items sit in the Grid Rows submenu, which menuAction does not search.
async function chooseRows(w, rows) {
  const id = await app.browserWindow(w).then((window) => window.evaluate((window) => window.id));
  await app.evaluate(({ Menu, BrowserWindow }, { rows, id }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('grid-rows-' + rows);
    item.click(item, BrowserWindow.fromId(id));
  }, { rows, id });
}

try {
  let w = await launch();
  let frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const sheets = () => frame.locator('.if-spread-container').evaluateAll((nodes) => nodes.map((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { spread: node.dataset.spread ?? node.querySelector('[data-spread]')?.dataset.spread, x, y, width, height };
  }));
  const canvas = () => w.locator('.canvas').evaluate((node) => ({ scrollLeft: node.scrollLeft, scrollTop: node.scrollTop,
    clientWidth: node.clientWidth, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight }));
  // Waits for a smooth reveal to finish: the canvas has stopped scrolling.
  const scrolled = () => w.waitForFunction(() => {
    const canvas = document.querySelector('.canvas');
    const state = (window.__scrolls ??= []);
    state.push(canvas.scrollLeft + ',' + canvas.scrollTop);
    if (state.length > 5) state.shift();
    const settled = state.length === 5 && state.every((value) => value === state[0]);
    if (settled) window.__scrolls = [];
    return settled;
  }, null, { polling: 100 });
  const gridRows = async (rows) => {
    await frame.locator('.if-book.if-grid').waitFor();
    await w.waitForFunction((rows) => document.querySelector('.canvas.canvas-grid') &&
      document.querySelector('.layout-toggle')?.value === 'grid-rows-' + rows, rows);
    await frame.locator('.if-book').evaluate((node, rows) => new Promise((resolve) => {
      const check = () => node.style.getPropertyValue('--if-rows') === String(rows) ? resolve() : requestAnimationFrame(check);
      check();
    }), rows);
    // The frame fills the canvas height and is as wide as the stage once the grid has settled.
    await w.waitForFunction(() => {
      const canvas = document.querySelector('.canvas');
      const frame = document.querySelector('iframe.book-frame-book[data-current]');
      const stage = document.querySelector('.stage');
      return frame.clientHeight === canvas.clientHeight && Math.abs(frame.offsetWidth - stage.offsetWidth) < 1;
    });
    await w.waitForTimeout(200);
  };

  // Vertical by default.
  assert.equal(await w.locator('.layout-toggle').inputValue(), 'layout-vertical');
  assert.deepEqual(await checked(), { 'layout-vertical': true, 'layout-grid': false, 'grid-rows-1': false, 'grid-rows-2': true, 'grid-rows-3': false, 'grid-rows-4': false });
  assert.equal(await frame.locator('.if-book.if-grid').count(), 0);

  // Grid from the View menu: two rows, filled column by column, sized to the canvas height, scrolling sideways.
  await menuAction(app, 'Grid');
  await gridRows(2);
  assert.deepEqual(await checked(), { 'layout-vertical': false, 'layout-grid': true, 'grid-rows-1': false, 'grid-rows-2': true, 'grid-rows-3': false, 'grid-rows-4': false });
  let view = await canvas();
  assert.ok(view.scrollWidth > view.clientWidth + 100, 'The grid scrolls sideways');
  assert.ok(view.scrollHeight <= view.clientHeight + 1, 'The grid does not scroll vertically');
  let rects = await sheets();
  assert.equal(rects.length, 15);
  assert.ok(Math.abs(rects[0].x - rects[1].x) < 1 && rects[1].y > rects[0].y + rects[0].height, 'Spreads fill a column top to bottom');
  assert.ok(rects[2].x > rects[0].x + rects[0].width && Math.abs(rects[2].y - rects[0].y) < 1, 'The next column continues to the right');
  const rowHeight = (view.clientHeight - 2 * 32 - 40) / 2;
  // The frame re-fits after it takes the canvas height; poll until it has.
  for (let tries = 0; tries < 50 && !rects.every(({ height }) => Math.abs(height - rowHeight) < 2); tries++) {
    await w.waitForTimeout(100);
    rects = await sheets();
  }
  assert.ok(rects.every(({ height }) => Math.abs(height - rowHeight) < 2), 'Each spread is one row tall: ' + rects[0].height + ' vs ' + rowHeight);
  // Overlays follow the frame geometry: the selection outline matches the first sheet.
  const selection = await w.locator('.sheet-selection').boundingBox();
  const sheet = await frame.locator('.if-spread-container').first().boundingBox();
  assert.ok(Math.abs(selection.x - sheet.x) < 2 && Math.abs(selection.width - sheet.width) < 2);

  // Three rows from the canvas control, then from the menu's rows submenu.
  await w.locator('.layout-toggle').selectOption('grid-rows-3');
  await gridRows(3);
  rects = await sheets();
  assert.ok(Math.abs(rects[0].x - rects[2].x) < 1 && rects[3].x > rects[0].x, 'Three spreads per column');
  await chooseRows(w, 4);
  await gridRows(4);
  assert.equal((await checked())['grid-rows-4'], true);
  await chooseRows(w, 1);
  await gridRows(1);
  rects = await sheets();
  view = await canvas();
  assert.ok(rects.every(({ y }) => Math.abs(y - rects[0].y) < 1), 'One row is a filmstrip');
  assert.ok(rects.every(({ width }) => width <= view.clientWidth - 64 + 1), 'A spread is never wider than the canvas');

  // Selecting a spread in the sidebar reveals it sideways, and the in-view highlight follows the visible columns.
  await w.locator('.spread-thumb[data-spread="may"]').click();
  await w.waitForFunction(() => document.querySelector('.canvas').scrollLeft > 0);
  await scrolled();
  view = await canvas();
  assert.equal(view.scrollTop, 0);
  const may = await frame.locator('[data-spread="may"]').first().boundingBox();
  const bounds = await w.locator('.canvas').boundingBox();
  assert.ok(may.x >= bounds.x - 1 && may.x + may.width <= bounds.x + bounds.width + 1, 'The selected spread is on screen');
  await w.locator('.spread-thumb[data-spread="may"].in-view').waitFor({ timeout: 5000 }).catch(async () => {
    throw new Error('In view: ' + JSON.stringify(await w.locator('.spread-thumb.in-view').evaluateAll((nodes) => nodes.map((node) => node.dataset.spread))));
  });
  assert.equal(await w.locator('.spread-thumb[data-spread="title"].in-view').count(), 0);
  // Photos load for the visible columns and not for spreads far to the left.
  await frame.locator('[data-spread="may"] img[data-src][src]').first().waitFor();
  assert.equal(await frame.locator('[data-spread="arriving"] img[data-src][src]').count(), 0);

  // A vertical wheel gesture scrolls the grid sideways.
  const before = (await canvas()).scrollLeft;
  await w.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await w.mouse.wheel(0, -400);
  await w.waitForFunction((before) => document.querySelector('.canvas').scrollLeft < before - 100, before);

  // Editing works the same: clicking a photo selects it for cropping, and a marked text opens its editor.
  await w.locator('.spread-thumb[data-spread="water"]').click();
  await scrolled();
  const photo = await frame.locator('[data-spread="water"] [data-box="hero"]').boundingBox();
  await w.mouse.click(photo.x + photo.width / 2, photo.y + photo.height / 2);
  await w.locator('.crop-editor').waitFor();
  const crop = await w.locator('.crop-window').boundingBox();
  assert.ok(Math.abs(crop.x - photo.x) < 3 && Math.abs(crop.width - photo.width) < 3, 'The crop editor sits on the photo');
  await w.keyboard.press('Escape');
  await w.locator('.spread-thumb[data-spread="title"]').click();
  await w.waitForFunction(() => document.querySelector('.canvas').scrollLeft === 0);
  await scrolled();
  const heading = await frame.locator('[data-spread="title"] [data-edit="heading"]').boundingBox();
  await w.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
  await w.locator('.edit-target').waitFor();
  await w.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2);
  const popover = w.getByRole('dialog', { name: 'Edit Heading' });
  await popover.waitFor();
  await popover.getByRole('textbox', { name: 'Heading' }).fill('Grid heading');
  await popover.getByRole('textbox', { name: 'Heading' }).press('Meta+Enter');
  await popover.waitFor({ state: 'detached' });
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Heading updated');
  const saved = JSON.parse(await readFile(join(book, 'project.json'), 'utf8'));
  assert.equal(saved.spreads[0].params.heading, 'Grid heading');
  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await gridRows(1);
  assert.equal(await frame.locator('[data-spread="title"] h1').textContent(), 'Grid heading');

  // The layout is remembered for the book.
  await app.close();
  w = await launch();
  frame = w.frameLocator('iframe.book-frame-book[data-current]');
  await gridRows(1);
  assert.deepEqual(await checked(), { 'layout-vertical': false, 'layout-grid': true, 'grid-rows-1': true, 'grid-rows-2': false, 'grid-rows-3': false, 'grid-rows-4': false });

  // Back to one column.
  await menuAction(app, 'Vertical');
  await w.locator('.canvas:not(.canvas-grid)').waitFor();
  await frame.locator('.if-book:not(.if-grid)').waitFor();
  await w.waitForFunction(() => {
    const canvas = document.querySelector('.canvas');
    return canvas.scrollWidth <= canvas.clientWidth + 1 && canvas.scrollHeight > canvas.clientHeight * 3;
  });
  assert.deepEqual(await checked(), { 'layout-vertical': true, 'layout-grid': false, 'grid-rows-1': true, 'grid-rows-2': false, 'grid-rows-3': false, 'grid-rows-4': false });
  console.log('Canvas grid smoke passed: geometry, rows, menu state, reveal, in-view, lazy photos, wheel, editing and persistence.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
