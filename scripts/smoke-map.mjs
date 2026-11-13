import { exportAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';

// The starter's Map layout end to end (ADR 0006), against a stubbed map server in the app's session: editing in the
// map editor, the live preview, the Book check waiting for slow tiles, a change of view while maps are drawing, a
// change of format, export at print resolution into the PDF, and a failing tile server, which the check reports and
// print export refuses instead of printing a blank or partial map. Each style's tiles have their own colour, so a
// picture shows which view it was drawn from and whether its tiles arrived.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'map-'));
const folder = join(work, 'Map book.imageflow');
const output = join(work, 'proof.pdf');
const colours = { liberty: '#dc2828', bright: '#283cdc', positron: '#808080' };
const tiles = Object.fromEntries(await Promise.all(Object.entries(colours).map(async ([style, background]) =>
  [style, (await sharp({ create: { width: 256, height: 256, channels: 3, background } }).png().toBuffer()).toString('base64')])));
// The style a picture shows, from its centre pixel; 'background' when it was taken before its tiles arrived.
const named = ([r, g, b]) => r > 150 && g < 90 ? 'liberty' : b > 150 && r < 90 ? 'bright' : Math.abs(r - 128) < 20 && Math.abs(g - 128) < 20 ? 'positron'
  : g > r && g > b ? 'background' : 'unknown ' + [r, g, b].join(',');

// Software WebGL, so the test runs on machines without a GPU.
const app = await _electron.launch({ executablePath: electron, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  await app.evaluate(({ session }, tiles) => {
    globalThis.mapServer = { status: 200, tileStatus: 200, delay: 0, styles: [], tiles: 0 };
    const server = globalThis.mapServer;
    session.defaultSession.protocol.handle('https', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'tiles.openfreemap.org') return new Response('unexpected host', { status: 404 });
      if (server.delay) await new Promise((resolve) => setTimeout(resolve, server.delay));
      if (server.status !== 200) return new Response('unavailable', { status: server.status });
      const style = /^\/styles\/(\w+)$/.exec(url.pathname)?.[1];
      if (style && tiles[style]) {
        server.styles.push(style);
        return Response.json({ version: 8, sources: { tiles: { type: 'raster', tileSize: 256, maxzoom: 14,
          tiles: ['https://tiles.openfreemap.org/tiles/' + style + '/{z}/{x}/{y}.png'] } },
        layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#3a7f5a' } }, { id: 'tiles', type: 'raster', source: 'tiles' }] });
      }
      const tile = /^\/tiles\/(\w+)\/\d+\/\d+\/\d+\.png$/.exec(url.pathname)?.[1];
      if (tile && tiles[tile]) {
        server.tiles++;
        if (server.tileStatus !== 200) return new Response('unavailable', { status: server.tileStatus });
        return new Response(Buffer.from(tiles[tile], 'base64'), { headers: { 'content-type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    });
  }, tiles);
  const server = () => app.evaluate(() => globalThis.mapServer);
  const configure = (changes) => app.evaluate((_electron, changes) => Object.assign(globalThis.mapServer, changes), changes);

  // The sample book with two map spreads before the closing page, framed on the sample's GPX track.
  await testBook(app, folder, true).then((page) => page.close());
  const file = join(folder, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  const map = (id, style) => ({ id, definition: 'map', elements: { map: { params: { track: 'senja-road', style, longitude: 17.6, latitude: 69.3, zoom: 8 } } } });
  project.spreads.splice(project.spreads.length - 1, 0, map('map-a', 'liberty'), map('map-b', 'positron'));
  await writeFile(file, JSON.stringify(project, null, 2) + '\n');
  const w = await testBook(app, folder);
  w.setDefaultTimeout(60000);
  if (process.env.DEBUG_SMOKE) w.on('console', (m) => console.log('console:', m.type(), m.text().slice(0, 300)));
  const current = 'iframe.book-frame-book[data-current][data-ready]';
  await w.locator(current).waitFor();
  const frame = w.frameLocator(current);

  // A map once it has been drawn: its box and picture size, and the style its centre shows.
  const drawn = async (spread) => {
    const picture = frame.locator('[data-spread="' + spread + '"] [data-element="map"] .if-rendered-image');
    await picture.scrollIntoViewIfNeeded();
    await picture.and(frame.locator('[data-rendered="ready"]')).waitFor({ timeout: 60000 })
      .catch(async (error) => { throw new Error(spread + ' did not render: ' + await picture.getAttribute('title') + ' ' + error.message); });
    return picture.evaluate((node) => {
      const img = node.querySelector('img');
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      return { width: node.offsetWidth, height: node.offsetHeight, natural: img.naturalWidth, naturalHeight: img.naturalHeight,
        centre: [...context.getImageData(img.naturalWidth >> 1, img.naturalHeight >> 1, 1, 1).data.slice(0, 3)] };
    });
  };
  // The Book check of the current book, as the app runs it before export.
  const check = () => w.evaluate(async () => {
    for (let i = 0; i < 600; i++) {
      const frames = [...document.querySelectorAll('iframe.book-frame-book[data-ready]:not([aria-hidden="true"])')];
      const id = new URL(frames.at(-1).src).pathname.split('/').at(-1);
      const result = await window.imageflow.checkBook(id, {});
      if (result.value) return result.value.diagnostics.map((d) => d.code + ': ' + d.message);
      if (!/finishing another operation|project changed/.test(result.error)) throw new Error(result.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  const savedStyle = async (spread) => JSON.parse(await readFile(file, 'utf8')).spreads.find(({ id }) => id === spread).elements.map.params.style;

  // The built-in template is trusted for its declared map server, so nothing asks, and the page draws both maps with
  // their tiles, at the screen's density.
  const a = await drawn('map-a');
  assert.ok(a.natural >= a.width * 0.98 && a.naturalHeight >= a.height * 0.98, JSON.stringify(a));
  assert.equal(named(a.centre), 'liberty');
  assert.equal(named((await drawn('map-b')).centre), 'positron');

  // Editing: choosing a style in the map editor saves it, and the page draws the new view.
  const box = await frame.locator('[data-spread="map-a"] [data-element="map"]').boundingBox();
  await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const dialog = w.getByRole('dialog', { name: 'Edit map' });
  await dialog.waitFor();
  const editor = w.frameLocator('iframe.element-editor-frame');
  // Chooses a style in the map editor and waits until the editor shows it chosen. The hidden test window can drop
  // the first clicks into a newly opened frame, so a click that did not arrive is repeated.
  const choose = async (name) => {
    const radio = editor.getByRole('radio', { name });
    for (let i = 0; i < 10; i++) {
      await radio.click();
      if (await radio.and(editor.locator('[aria-checked="true"]')).waitFor({ timeout: 1000 }).then(() => true, () => false)) return;
    }
    throw new Error('The map editor did not choose ' + name + '.');
  };
  await choose('Bright');
  for (let i = 0; i < 100 && await savedStyle('map-a') !== 'bright'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await savedStyle('map-a'), 'bright');
  for (let i = 0; i < 100 && named((await drawn('map-a')).centre) !== 'bright'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(named((await drawn('map-a')).centre), 'bright');

  // A change of view while the maps are still drawing on a slow server: the earlier drawing is cancelled and never
  // replaces the newer one, even when it finishes later.
  await configure({ delay: 800 });
  await choose('Positron');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await choose('Liberty');
  for (let i = 0; i < 100 && await savedStyle('map-a') !== 'liberty'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  for (let i = 0; i < 200 && named((await drawn('map-a')).centre) !== 'liberty'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(named((await drawn('map-a')).centre), 'liberty', 'a cancelled drawing does not replace the newer one');

  // The Book check waits for both maps on the slow server and finds them drawn; drawing is declared work, not an
  // impure render.
  const found = await check();
  assert.ok(!found.some((line) => /^(rendered-image-failed|render-impure)/.test(line)), found.join('\n'));

  // A change of format draws the maps again at their new size.
  await configure({ delay: 0 });
  const square = await drawn('map-a');
  const before = await w.locator(current).getAttribute('src');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), format: 'landscape' }, null, 2) + '\n');
  await w.waitForFunction((src) => {
    const node = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return node && node.getAttribute('src') !== src;
  }, before);
  const landscape = await drawn('map-a');
  assert.notEqual(landscape.width / landscape.height, square.width / square.height, 'the format changed the box');
  assert.ok(landscape.natural >= landscape.width * 0.98 && landscape.naturalHeight >= landscape.height * 0.98, JSON.stringify(landscape));
  assert.equal(named(landscape.centre), 'liberty');

  // Export waits for both maps on a slow server, draws them again at 250 ppi across the spread's 3 mm bleed, and
  // puts them in the PDF.
  await configure({ delay: 500 });
  const styles = (await server()).styles.length;
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, output);
  await exportAction(w, 'Export proof PDF');
  await w.waitForFunction(() => document.querySelector('.status-error') ||
    document.querySelector('.status')?.textContent?.startsWith('Proof PDF saved'), null, { timeout: 240000 });
  assert.match(await w.locator('.status').first().textContent(), /^Proof PDF saved\./);
  assert.ok((await server()).styles.length >= styles + 2, 'export loads both maps again');
  const pdf = (await readFile(output)).toString('latin1');
  const widths = [...pdf.matchAll(/\/Width (\d+)/g)].map(([, width]) => Number(width));
  const expected = landscape.width / 96 * 250;
  assert.ok(widths.filter((width) => width >= expected * 0.95).length >= 2, 'two map images of about ' + Math.round(expected) + ' px: ' + widths.join(', '));

  // When tiles fail to load, the check reports each map, and print export refuses the book; no page is printed with a
  // blank or partial map.
  await configure({ delay: 0, tileStatus: 500 });
  const failed = await check();
  assert.equal(failed.filter((line) => /^rendered-image-failed: Map could not be rendered/.test(line)).length, 2, failed.join('\n'));
  const printed = await w.evaluate(async () => {
    const frames = [...document.querySelectorAll('iframe.book-frame-book[data-ready]:not([aria-hidden="true"])')];
    return window.imageflow.exportBook(new URL(frames.at(-1).src).pathname.split('/').at(-1), 'print');
  });
  assert.match(printed.error ?? '', /Map could not be rendered/, JSON.stringify(printed));
  console.log('ImageFlow map passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
