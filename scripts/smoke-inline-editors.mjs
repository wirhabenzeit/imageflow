import { testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// #102: inline element editors. The starter's map is framed on the page, in the map's own place, and the wall
// calendar's days are marked by clicking them on the page. Checks placement, that dragging, zooming, toolbar
// controls, scrolling and resizing keep the same live editor, that the artwork hides only while the editor shows,
// saving, closing and Undo. The map server is replaced by a local style, so this runs offline.
// `--screenshots <folder>` also saves screenshots there.
const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
await mkdir(build, { recursive: true });
const flag = process.argv.indexOf('--screenshots');
const screenshots = flag >= 0 ? process.argv[flag + 1] : undefined;
if (screenshots) await mkdir(screenshots, { recursive: true });
const work = await mkdtemp(join(build, 'inline-editors-'));
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message + ': ' + actual + ' ≉ ' + expected);
const sameBox = (a, b, message) => { for (const key of ['x', 'y', 'width', 'height']) near(a[key], b[key], 2, message + ' ' + key); };
// Waits for an overlay to follow its target after the page moved, then checks they match.
async function follows(overlay, target, message) {
  for (let i = 0; i < 50; i++) {
    const [a, b] = [await overlay.boundingBox(), await target.boundingBox()];
    if (a && b && ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 2)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  sameBox(await overlay.boundingBox(), await target.boundingBox(), message);
}

// A book from the photobook starter with a Map spread after the title page, showing the sample GPX track.
const book = join(work, 'Map.imageflow');
await cp(join(root, 'sample', 'starter'), book, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
const projectFile = join(book, 'project.json');
const project = JSON.parse(await readFile(projectFile, 'utf8'));
project.spreads.splice(1, 0, { id: 'route', definition: 'map', params: { mapTitle: 'Senja' }, boxes: {},
  elements: { map: { params: { track: 'senja-road', longitude: 17.4, latitude: 69.3, zoom: 9 } } } });
await writeFile(projectFile, JSON.stringify(project, null, 2) + '\n');
const saved = async () => JSON.parse(await readFile(projectFile, 'utf8')).spreads.find(({ id }) => id === 'route').elements.map.params;

const calendar = join(work, 'Calendar.imageflow');
await cp(join(root, 'sample', 'calendar'), calendar, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
const marked = async () => JSON.parse(await readFile(join(calendar, 'project.json'), 'utf8')).params.markedDates ?? '';

let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(build, 'desktop'), '--user-data-dir=' + join(work, 'profile'), ...(process.platform === 'linux' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
    // The window stays shown: clicks into a scaled editor frame are hit-tested by the compositor, which a hidden
    // window does not run, so they would miss the calendar's day buttons.
    env: process.env, timeout: 15000 });
  // OpenFreeMap, offline: every style is a plain coloured background, which MapLibre draws without tiles.
  await app.evaluate(({ dialog, net, session }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    // `styleDelay` slows the map server down; `styleServed` is when it last answered.
    globalThis.styleDelay = 0;
    session.defaultSession.protocol.handle('https', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'tiles.openfreemap.org') return net.fetch(request, { bypassCustomProtocolHandlers: true });
      if (globalThis.styleDelay) await new Promise((resolve) => setTimeout(resolve, globalThis.styleDelay));
      globalThis.styleServed = Date.now();
      const colours = { liberty: '#bcd6c2', bright: '#d8c9a7', positron: '#e3e3e3' };
      const style = url.pathname.split('/').at(-1);
      return Response.json({ version: 8, name: style, sources: {},
        layers: [{ id: 'land', type: 'background', paint: { 'background-color': colours[style] ?? '#888' } }] },
      { headers: { 'access-control-allow-origin': '*' } });
    });
  });

  // ── The map ──
  let w = await testBook(app, book, false);
  w.setDefaultTimeout(30000);
  await w.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  let page = w.frameLocator(ready);
  await w.locator(ready).waitFor();
  const map = page.locator('[data-element="map"]');
  await map.scrollIntoViewIfNeeded();
  // The page's map has been drawn from the local style, so the preview and editor use the same server.
  await page.locator('.map-image img').waitFor({ state: 'attached' });
  const mapBox = await map.boundingBox();
  // Clicking the map opens its editor on the page, in the map's own rectangle: no panel. With a slow map server, the
  // printed map stays until the editor's map has its style: the editor appears drawn.
  await app.evaluate(() => { globalThis.styleDelay = 1500; globalThis.styleServed = 0; });
  await w.mouse.click(mapBox.x + mapBox.width * .7, mapBox.y + mapBox.height * .6);
  const editor = w.locator('.inline-editor.showing');
  await editor.waitFor();
  const shownAt = Date.now();
  const served = await app.evaluate(() => { globalThis.styleDelay = 0; return globalThis.styleServed; });
  assert.ok(served > 0 && served <= shownAt, 'the editor appears only after its map has loaded: ' + JSON.stringify({ served, shownAt }));
  assert.equal(await w.locator('.element-editor').count(), 0, 'no editor panel');
  sameBox(await editor.boundingBox(), await map.boundingBox(), 'editor over the map');
  // The page hides its own map artwork while the editor shows, so nothing is drawn twice.
  await page.locator('[data-element="map"][data-if-editing]').waitFor({ state: 'attached' });
  // Only the editing view changes: the sidebar thumbnails keep drawing the map.
  assert.equal(await w.frameLocator('iframe.book-frame-thumbs[data-current]').locator('[data-if-editing]').count(), 0);
  const inline = w.frameLocator('iframe.inline-editor-frame');
  await inline.locator('.map-editor-inline .maplibregl-canvas').waitFor();
  // The title over the map stays in view, drawn by the editor.
  assert.equal(await inline.locator('.map-title-overlay').textContent(), 'Senja');
  // In the page's own type: the same font, size, colour and spacing as the printed title.
  const titleStyle = (node) => { const style = getComputedStyle(node); return [style.font, style.color, style.letterSpacing, style.backgroundColor].join(' | '); };
  assert.equal(await inline.locator('.map-title-overlay').evaluate(titleStyle), await page.locator('.map-title').evaluate(titleStyle), 'the title is styled as printed');
  // The frame has the map's printed size; the page's zoom scales it.
  const printed = await inline.locator('body').evaluate(() => ({ width: innerWidth, height: innerHeight,
    scale: Number(getComputedStyle(document.querySelector('.if-editor')).getPropertyValue('--if-inline-scale')) }));
  near(printed.width * printed.scale, mapBox.width, 2, 'printed width × scale');
  assert.ok(printed.scale < 1, 'the page is shown smaller than print: ' + printed.scale);
  // Marks this editor instance: a remount would lose it.
  await inline.locator('body').evaluate(() => { window.mounted = 'first'; });
  const instance = () => inline.locator('body').evaluate(() => window.mounted);
  if (screenshots) await w.screenshot({ path: join(screenshots, 'map-inline.png') });

  // Dragging pans the map and saves the view; the editor survives the book redrawing after each save.
  const before = await saved();
  const box = await editor.boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (let i = 0; i < 2; i++) {
    await w.mouse.move(centre.x, centre.y);
    await w.mouse.down();
    for (let step = 1; step <= 8; step++) await w.mouse.move(centre.x - step * 15, centre.y - step * 6);
    await w.mouse.up();
    await w.waitForFunction(() => new Promise((resolve) => setTimeout(() => resolve(true), 400)));
  }
  await w.waitForFunction(async () => true);
  let after;
  for (let i = 0; i < 50 && !(after && after.longitude > before.longitude); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    after = await saved();
  }
  assert.ok(after.longitude > before.longitude, 'dragging left moves east: ' + JSON.stringify([before, after]));
  assert.ok(after.latitude < before.latitude, 'dragging up moves south');
  assert.equal(after.zoom, before.zoom, 'dragging keeps the zoom');
  // Both drags have saved before the wheel, so the view it zooms from is the last one.
  for (let settled = 0; settled < 3;) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const now = await saved();
    settled = JSON.stringify(now) === JSON.stringify(after) ? settled + 1 : 0;
    after = now;
  }
  // Wheel zooms in place.
  await w.mouse.move(centre.x, centre.y);
  let zoomed;
  for (let i = 0; i < 50 && !(zoomed && zoomed.zoom > after.zoom); i++) {
    if (i % 15 === 0) await w.mouse.wheel(0, -400);
    await new Promise((resolve) => setTimeout(resolve, 200));
    zoomed = await saved();
  }
  assert.ok(zoomed.zoom > after.zoom, 'the wheel zooms in: ' + JSON.stringify([after, zoomed]));
  // The book redrew with the saved view while the same editor kept its camera.
  await w.locator(ready).waitFor();
  assert.equal(await instance(), 'first', 'the editor was not remounted by saving');
  const camera = await inline.locator('body').evaluate(() => document.querySelector('.maplibregl-canvas') !== null);
  assert.ok(camera);
  // The page's other map settings are in the toolbar; changing one keeps the same editor and its view.
  const toolbar = w.getByRole('toolbar', { name: 'Edit map' });
  await toolbar.getByRole('radiogroup', { name: 'Map style' }).getByRole('radio', { name: 'Bright' }).click();
  for (let i = 0; i < 50 && (await saved()).style !== 'bright'; i++) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await saved()).style, 'bright');
  assert.equal(await instance(), 'first', 'a toolbar control keeps the editor');
  const view = await saved();
  assert.equal(view.longitude, zoomed.longitude, 'the style change kept the view');

  // Scrolling and resizing move and scale the same editor with the page.
  await w.setViewportSize({ width: 1200, height: 900 }).catch(() => {});
  await w.waitForFunction(() => {
    const frame = document.querySelector('.inline-editor.showing')?.getBoundingClientRect();
    return frame && frame.width < 1100;
  });
  page = w.frameLocator(ready);
  await follows(editor, page.locator('[data-element="map"]'), 'editor over the resized map');
  await w.locator('main.canvas').evaluate((canvas) => canvas.scrollBy(0, 120));
  await follows(editor, page.locator('[data-element="map"]'), 'editor over the scrolled map');
  assert.equal(await instance(), 'first', 'resizing and scrolling keep the editor');

  // Done closes it; the page shows its own map again, drawn with the saved view.
  await toolbar.getByRole('button', { name: 'Done' }).click();
  await w.locator('.inline-editor').waitFor({ state: 'detached' });
  await page.locator('[data-element="map"]:not([data-if-editing])').waitFor({ state: 'attached' });
  assert.deepEqual(await saved(), view, 'closing saves nothing else');
  // Undo steps back through the parameter edits, as before.
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  for (let i = 0; i < 50 && ((await saved()).style ?? 'liberty') !== 'liberty'; i++) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await saved()).style ?? 'liberty', 'liberty', 'Undo reverts the last change');


  // ── The calendar ──
  await w.close();
  w = await testBook(app, calendar, false);
  w.setDefaultTimeout(30000);
  await w.setViewportSize({ width: 1500, height: 1000 }).catch(() => {});
  page = w.frameLocator(ready);
  await w.locator(ready).waitFor();
  const january = page.locator('.month').first();
  const days = january.locator('.days');
  await days.scrollIntoViewIfNeeded();
  const original = await marked();
  // One click on a day opens the days on the page and marks that day, even when the page scrolls before they show.
  const tenth = await january.locator('.days li').nth(9).boundingBox();
  await w.mouse.click(tenth.x + tenth.width / 2, tenth.y + tenth.height / 2);
  await w.mouse.wheel(0, tenth.height * 5);
  const dayEditor = w.locator('.inline-editor.showing');
  await dayEditor.waitFor();
  assert.equal(await w.locator('.element-editor').count(), 0, 'no editor panel');
  await follows(dayEditor, days, 'day picker over the days');
  await january.locator('.days[data-if-editing]').waitFor({ state: 'attached' });
  const picker = w.frameLocator('iframe.inline-editor-frame');
  // Playwright does not apply the frame's scale to boxes inside it, so days are clicked where the page draws them.
  const day = (n) => picker.locator('.days-on-page li').nth(n - 1).locator('button');
  const pageDay = (n) => january.locator('.days li').nth(n - 1);
  const click = async (n, modifier) => {
    const row = await pageDay(n).boundingBox();
    // Hover until the picker's button is under the pointer: the scaled frame takes input once the compositor has it.
    for (let i = 0; i < 40 && !(await day(n).evaluate((node) => node.matches(':hover'))); i++) {
      await w.mouse.move(row.x + row.width / 2 + (i % 2), row.y + row.height / 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (modifier) await w.keyboard.down(modifier);
    await w.mouse.click(row.x + row.width / 2, row.y + row.height / 2);
    if (modifier) await w.keyboard.up(modifier);
  };
  await day(10).waitFor();
  // The picker is the page's days: same rows, same place.
  const pickerBox = await dayEditor.boundingBox();
  const scale = await picker.locator('.if-editor').evaluate((node) => Number(getComputedStyle(node).getPropertyValue('--if-inline-scale')));
  const rows = await picker.locator('.days-on-page li').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
  for (const n of [1, 10, 31]) {
    const row = await pageDay(n).boundingBox();
    near(pickerBox.y + rows[n - 1].y * scale, row.y, 1.5, 'day ' + n + ' top');
    near(rows[n - 1].height * scale, row.height, 1.5, 'day ' + n + ' height');
  }
  for (let i = 0; i < 50 && !(await marked()).includes('2027-01-10'); i++) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok((await marked()).includes('2027-01-10'), 'the click that opened the days marks the date once');
  await picker.locator('li.marked button[aria-pressed="true"]').filter({ hasText: /^10/ }).waitFor();
  await click(11, 'Alt');
  for (let i = 0; i < 50 && !(await marked()).includes('11.01'); i++) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok((await marked()).includes('11.01'), '⌥-click marks it every year');
  await picker.locator('li.yearly').filter({ hasText: /^11/ }).waitFor();
  // A plain click never changes a yearly mark.
  await click(11);
  await w.waitForTimeout(400);
  assert.ok((await marked()).includes('11.01'));
  await click(10);
  for (let i = 0; i < 50 && (await marked()).includes('2027-01-10'); i++) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!(await marked()).includes('2027-01-10'), 'a second click unmarks it');
  assert.equal(await w.locator('.inline-editor.showing').count(), 1, 'the same picker stays open');
  if (screenshots) await w.screenshot({ path: join(screenshots, 'calendar-inline.png') });
  // Escape closes; the page's days show the saved marks again.
  await w.keyboard.press('Escape');
  await w.locator('.inline-editor').waitFor({ state: 'detached' });
  await january.locator('.days:not([data-if-editing])').waitFor({ state: 'attached' });
  await january.locator('.days li').nth(10).and(page.locator('.marked')).waitFor();
  assert.ok(!/\bmarked\b/.test(await january.locator('.days li').nth(9).getAttribute('class') ?? ''), 'day 10 is unmarked');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  for (let i = 0; i < 50 && (await marked()) !== original; i++) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await marked(), original, 'Undo restores the marked days');
  console.log('ImageFlow inline editors passed.');
} finally {
  await app?.close().catch(() => {});
  if (!screenshots) await rm(work, { recursive: true, force: true });
}
