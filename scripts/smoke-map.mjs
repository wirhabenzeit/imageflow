import { exportAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// The starter's Map layout end to end (ADR 0006): the page draws the map live with MapLibre, the Book check waits
// for it, export draws it again at the format's target resolution into the PDF, and a map server that fails makes
// the check report the map instead of printing a page without it. The map server is stubbed in the app's session:
// the style is a single coloured background, so no tiles are needed.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'map-'));
const folder = join(work, 'Map book.imageflow');
const output = join(work, 'proof.pdf');

// Software WebGL, so the test runs on machines without a GPU.
const app = await _electron.launch({ executablePath: electron, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  await app.evaluate(({ session }) => {
    globalThis.mapServer = { status: 200, styles: 0 };
    session.defaultSession.protocol.handle('https', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'tiles.openfreemap.org') return new Response('unexpected host', { status: 404 });
      if (globalThis.mapServer.status !== 200) return new Response('unavailable', { status: globalThis.mapServer.status });
      if (!url.pathname.startsWith('/styles/')) return new Response('not found', { status: 404 });
      globalThis.mapServer.styles++;
      return Response.json({ version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#3a7f5a' } }] });
    });
  });
  const server = () => app.evaluate(() => globalThis.mapServer);
  const setStatus = (status) => app.evaluate((_electron, status) => { globalThis.mapServer.status = status; }, status);

  // The sample book with a map spread before the closing page, framed on the sample's GPX track.
  await testBook(app, folder, true).then((page) => page.close());
  const file = join(folder, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.spreads.splice(project.spreads.length - 1, 0, { id: 'map-spread', definition: 'map',
    elements: { map: { params: { track: 'senja-road', longitude: 17.6, latitude: 69.3, zoom: 8 } } } });
  await writeFile(file, JSON.stringify(project, null, 2) + '\n');
  const w = await testBook(app, folder);
  w.setDefaultTimeout(60000);
  if (process.env.DEBUG_SMOKE) w.on('console', (m) => console.log('console:', m.type(), m.text().slice(0, 300)));
  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();

  // The built-in template is trusted for its declared map server, so nothing asks, and the page draws the map.
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const picture = frame.locator('[data-spread="map-spread"] [data-element="map"] .if-rendered-image');
  await picture.scrollIntoViewIfNeeded();
  await frame.locator('[data-spread="map-spread"] .if-rendered-image[data-rendered="ready"]').waitFor({ timeout: 60000 })
    .catch(async (error) => { throw new Error('The preview map did not render: ' + await picture.getAttribute('title') + ' ' + error.message); });
  const preview = await picture.evaluate((node) => ({ width: node.offsetWidth, natural: node.querySelector('img').naturalWidth }));
  assert.ok(preview.natural >= preview.width * 0.99, JSON.stringify(preview));
  assert.ok((await server()).styles >= 1);

  // The Book check waits for the map and finds it drawn; drawing it is declared work, not an impure render.
  const check = () => w.evaluate(async () => {
    for (let i = 0; i < 300; i++) {
      const frames = [...document.querySelectorAll('iframe.book-frame-book[data-ready]:not([aria-hidden="true"])')];
      const id = new URL(frames.at(-1).src).pathname.split('/').at(-1);
      const result = await window.imageflow.checkBook(id, {});
      if (result.value) return result.value.diagnostics.map((d) => d.code + ': ' + d.message);
      if (!/finishing another operation|project changed/.test(result.error)) throw new Error(result.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  const found = await check();
  assert.ok(!found.some((line) => /^(rendered-image-failed|render-impure)/.test(line)), found.join('\n'));

  // Export draws the map again, at 250 ppi across the spread's 3 mm bleed, and puts that picture in the PDF.
  const before = (await server()).styles;
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, output);
  await exportAction(w, 'Export proof PDF');
  await w.waitForFunction(() => document.querySelector('.status-error') ||
    document.querySelector('.status')?.textContent?.startsWith('Proof PDF saved'), null, { timeout: 180000 });
  assert.match(await w.locator('.status').first().textContent(), /^Proof PDF saved\./);
  assert.ok((await server()).styles > before, 'export loads the map again');
  const pdf = (await readFile(output)).toString('latin1');
  const widths = [...pdf.matchAll(/\/Width (\d+)/g)].map(([, width]) => Number(width));
  const expected = preview.width / 96 * 250;
  assert.ok(widths.some((width) => width >= expected * 0.95), 'a map image of about ' + Math.round(expected) + ' px: ' + widths.join(', '));

  // When the map server fails, the check reports the map; the page is never printed without it.
  await setStatus(503);
  const failed = await check();
  assert.ok(failed.some((line) => /^rendered-image-failed: Map could not be rendered/.test(line)), failed.join('\n'));
  console.log('ImageFlow map passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
