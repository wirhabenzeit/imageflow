import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

// Grid mode of the canvas (#52): spreads fill each row left to right and the canvas scrolls vertically. Checks the
// geometry, menu state, sidebar reveal, lazy photos, vertical wheel scrolling, editing a box, and
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
const checked = () => app.evaluate(({ Menu }) => Object.fromEntries(['layout-vertical', 'layout-grid', 'grid-columns-1', 'grid-columns-2', 'grid-columns-3', 'grid-columns-4']
  .map((id) => [id, Menu.getApplicationMenu().getMenuItemById(id).checked])));
// Column menu items sit in the Grid Columns submenu, which menuAction does not search.
async function chooseColumns(w, columns) {
  const id = await app.browserWindow(w).then((window) => window.evaluate((window) => window.id));
  await app.evaluate(({ Menu, BrowserWindow }, { columns, id }) => {
    const item = Menu.getApplicationMenu().getMenuItemById('grid-columns-' + columns);
    item.click(item, BrowserWindow.fromId(id));
  }, { columns, id });
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
  const gridColumns = async (columns) => {
    await frame.locator('.if-book.if-grid').waitFor();
    await w.locator('.canvas.canvas-grid').waitFor();
    await frame.locator('.if-book').evaluate((node, columns) => new Promise((resolve) => {
      const check = () => node.style.getPropertyValue('--if-columns') === String(columns) ? resolve() : requestAnimationFrame(check);
      check();
    }), columns);
    // The frame fills the canvas width and the stage follows its full content height.
    await w.waitForFunction(() => {
      const canvas = document.querySelector('.canvas');
      const frame = document.querySelector('iframe.book-frame-book[data-current]');
      const stage = document.querySelector('.stage');
      return frame.offsetWidth === canvas.clientWidth && Math.abs(frame.offsetHeight - stage.offsetHeight) < 1;
    });
    await w.waitForTimeout(200);
  };

  // Vertical by default.
  assert.equal(await w.locator('.canvas-controls, .layout-toggle, .guides-toggle').count(), 0);
  assert.equal(await w.locator('.guides').count(), 0);
  await menuAction(app, 'Show Guides');
  await w.locator('.guides').first().waitFor();
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('guides').checked), true);
  await menuAction(app, 'Show Guides');
  await w.locator('.guides').first().waitFor({ state: 'detached' });
  assert.deepEqual(await checked(), { 'layout-vertical': true, 'layout-grid': false, 'grid-columns-1': false, 'grid-columns-2': true, 'grid-columns-3': false, 'grid-columns-4': false });
  assert.equal(await frame.locator('.if-book.if-grid').count(), 0);

  // Grid from the View menu: two columns, filled row by row, sized to the canvas width, scrolling vertically.
  await menuAction(app, 'Grid');
  await gridColumns(2);
  assert.deepEqual(await checked(), { 'layout-vertical': false, 'layout-grid': true, 'grid-columns-1': false, 'grid-columns-2': true, 'grid-columns-3': false, 'grid-columns-4': false });
  let view = await canvas();
  assert.ok(view.scrollHeight > view.clientHeight + 100, 'The grid scrolls vertically');
  assert.ok(view.scrollWidth <= view.clientWidth + 1, 'The grid does not scroll sideways');
  let rects = await sheets();
  assert.equal(rects.length, 15);
  assert.ok(Math.abs(rects[0].y - rects[1].y) < 1 && rects[1].x > rects[0].x + rects[0].width, 'Spreads fill a row left to right');
  assert.ok(rects[2].y > rects[0].y + rects[0].height && Math.abs(rects[2].x - rects[0].x) < 1, 'The next row continues below');
  const columnWidth = (view.clientWidth - 2 * 32 - 40) / 2;
  assert.ok(rects.every(({ width }) => Math.abs(width - columnWidth) < 2), 'Each spread fits one column: ' + rects[0].width + ' vs ' + columnWidth);
  // Overlays follow the frame geometry: the selection outline matches the first sheet.
  const selection = await w.locator('.sheet-selection').boundingBox();
  const sheet = await frame.locator('.if-spread-container').first().boundingBox();
  assert.ok(Math.abs(selection.x - sheet.x) < 2 && Math.abs(selection.width - sheet.width) < 2);

  // Change the column count through the View menu's columns submenu.
  await chooseColumns(w, 3);
  await gridColumns(3);
  rects = await sheets();
  assert.ok(Math.abs(rects[0].y - rects[2].y) < 1 && rects[3].y > rects[0].y, 'Three spreads per row');
  await chooseColumns(w, 4);
  await gridColumns(4);
  assert.equal((await checked())['grid-columns-4'], true);
  await chooseColumns(w, 1);
  await gridColumns(1);
  rects = await sheets();
  view = await canvas();
  assert.ok(rects.every(({ x }) => Math.abs(x - rects[0].x) < 1), 'One column stacks spreads vertically');
  assert.ok(rects.every(({ width }) => width <= view.clientWidth - 64 + 1), 'A spread is never wider than the canvas');

  // Selecting a spread in the sidebar reveals it vertically and keeps its selection highlight.
  await w.locator('.spread-thumb[data-spread="may"]').click();
  await w.waitForFunction(() => document.querySelector('.canvas').scrollTop > 0);
  await scrolled();
  view = await canvas();
  assert.equal(view.scrollLeft, 0);
  const may = await frame.locator('[data-spread="may"]').first().boundingBox();
  const bounds = await w.locator('.canvas').boundingBox();
  assert.ok(may.y >= bounds.y - 1 && may.y + may.height <= bounds.y + bounds.height + 1, 'The selected spread is on screen');
  assert.equal(await w.locator('.spread-thumb[data-spread="may"]').getAttribute('aria-current'), 'page');
  // Photos load for the visible rows and not for spreads far above.
  await frame.locator('[data-spread="may"] img[data-src][src]').first().waitFor();
  assert.equal(await frame.locator('[data-spread="arriving"] img[data-src][src]').count(), 0);

  // A vertical wheel gesture scrolls the grid vertically.
  const before = (await canvas()).scrollTop;
  await w.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await w.mouse.wheel(0, -400);
  await w.waitForFunction((before) => document.querySelector('.canvas').scrollTop < before - 100, before);

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
  await w.waitForFunction(() => document.querySelector('.canvas').scrollTop === 0);
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
  await gridColumns(1);
  assert.equal(await frame.locator('[data-spread="title"] h1').textContent(), 'Grid heading');

  // An editor for a target near the canvas's bottom edge stays inside the visible canvas.
  await chooseColumns(w, 2);
  await gridColumns(2);
  const quiet = frame.locator('[data-spread="quiet"] [data-edit~="heading"]').first();
  const edge = await w.locator('.canvas').boundingBox();
  const headingY = await quiet.evaluate((node) => node.getBoundingClientRect().top);
  const frameY = await w.locator('iframe.book-frame-book[data-current]').evaluate((node) => node.getBoundingClientRect().top + node.parentElement.parentElement.scrollTop);
  // Scroll so the heading starts 10 px before the canvas's bottom edge.
  await w.locator('.canvas').evaluate((node, top) => { node.scrollTop = top; }, frameY + headingY - (edge.y + edge.height - 10));
  await scrolled();
  const partial = await quiet.boundingBox();
  assert.ok(partial.y < edge.y + edge.height && partial.y + partial.height > edge.y + edge.height, 'The heading is cut off by the canvas edge');
  await w.mouse.click(partial.x + 30, partial.y + 3);
  const edgePopover = w.getByRole('dialog', { name: 'Edit Heading' });
  await edgePopover.waitFor();
  await w.waitForTimeout(100);
  const placed = await edgePopover.boundingBox();
  assert.ok(placed.y >= edge.y - 1 && placed.y + placed.height <= edge.y + edge.height + 1 &&
    placed.x >= edge.x - 1 && placed.x + placed.width <= edge.x + edge.width + 1, 'The editor is inside the visible canvas: ' + JSON.stringify({ placed, edge }));
  await edgePopover.getByRole('textbox', { name: 'Heading' }).press('Escape');
  await edgePopover.waitFor({ state: 'detached' });
  await chooseColumns(w, 1);
  await gridColumns(1);

  // The layout is remembered for the book.
  await app.close();
  w = await launch();
  frame = w.frameLocator('iframe.book-frame-book[data-current]');
  await gridColumns(1);
  assert.deepEqual(await checked(), { 'layout-vertical': false, 'layout-grid': true, 'grid-columns-1': true, 'grid-columns-2': false, 'grid-columns-3': false, 'grid-columns-4': false });

  // Back to Vertical from two columns: the selected spread stays on screen.
  await chooseColumns(w, 2);
  await gridColumns(2);
  await w.locator('.spread-thumb[data-spread="twilight"]').click();
  await scrolled();
  await menuAction(app, 'Vertical');
  await w.locator('.canvas:not(.canvas-grid)').waitFor();
  await frame.locator('.if-book:not(.if-grid)').waitFor();
  await w.waitForFunction(() => {
    const canvas = document.querySelector('.canvas');
    return canvas.scrollWidth <= canvas.clientWidth + 1 && canvas.scrollHeight > canvas.clientHeight * 3;
  });
  assert.deepEqual(await checked(), { 'layout-vertical': true, 'layout-grid': false, 'grid-columns-1': false, 'grid-columns-2': true, 'grid-columns-3': false, 'grid-columns-4': false });
  await scrolled();
  const twilight = await frame.locator('[data-spread="twilight"]').first().boundingBox();
  const column = await w.locator('.canvas').boundingBox();
  assert.ok(twilight.y >= column.y - 1 && twilight.y + twilight.height <= column.y + column.height + 1,
    'The selected spread is on screen after switching to Vertical: ' + JSON.stringify({ twilight, column }));
  console.log('Canvas grid smoke passed: geometry, columns, menu state, reveal, lazy photos, wheel, editing and persistence.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
