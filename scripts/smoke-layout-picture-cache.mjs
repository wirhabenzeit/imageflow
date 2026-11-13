import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';

// A deliberately slow map makes redraws observable without depending on internet access or a WebGL driver.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/layout-picture-cache-'));
const book = join(work, 'Book.imageflow');
await cp(join(root, 'sample/starter'), book, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
const mapFile = join(book, 'template/map.tsx');
const drawing = `async function drawMap(view, target) {
  window.__mapDraws = (window.__mapDraws ?? 0) + 1;
  (window.__mapDrawDetails ??= []).push({ view, width: target.width, height: target.height, ratio: target.pixelRatio });
  await new Promise(resolve => setTimeout(resolve, 500));
  target.signal.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(target.width * target.pixelRatio);
  canvas.height = Math.ceil(target.height * target.pixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = view.longitude === 10 ? '#008040' : '#4060a0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}
\n`;
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const pictures = [];
try {
  await app.context().addInitScript(() => {
    if (location.hostname !== 'editor' || location.pathname !== '/') return;
    window.__holdThumbs = false;
    window.__thumbMessages = [];
    window.addEventListener('message', (event) => {
      const candidate = document.querySelector('iframe.book-frame-thumbs[data-current]');
      if (!window.__holdThumbs || event.source !== candidate?.contentWindow || event.origin !== 'imageflow://render') return;
      event.stopImmediatePropagation();
      window.__thumbMessages.push({ data: event.data, origin: event.origin, source: event.source });
    });
  });
  // Leave the copied template unchanged: its hash must match the trusted built-in template, so startup grants
  // its network origins after activating the document. Replacing only draw() in the browser keeps that path real.
  await app.context().route('**/template/template.js', async (route) => {
    const originalUrl = route.request().url() + '?original=1';
    const body = drawing + `
      const original = window.ImageFlowRuntime.RenderedImage;
      window.ImageFlowRuntime.RenderedImage = (props) => window.ImageFlowReact.createElement(original,
        { ...props, draw: (target) => drawMap(props.inputs, target) });
      const template = await import(${JSON.stringify(originalUrl)});
      export default template.default;
    `;
    await route.fulfill({ contentType: 'text/javascript', body });
  });
  const page = await testBook(app, book);
  page.on('response', (response) => {
    if (!response.url().includes('/picture/')) return;
    pictures.push({ method: response.request().method(), status: response.status(), url: response.url() });
  });
  const startup = (await page.evaluate(() => window.imageflow.currentProject())).value;
  assert.deepEqual(startup.network, ['https://tiles.openfreemap.org'], 'The book starts with approved network access');
  const layouts = () => page.frameLocator('iframe.book-frame-layouts[data-current]');
  const ready = async (spread) => {
    await page.waitForFunction((spread) => {
      const frame = document.querySelector('iframe.book-frame-layouts[data-current][data-ready]');
      return frame && new URL(frame.src).searchParams.get('spread') === spread;
    }, spread);
    await layouts().locator('[data-spread="map"] [data-rendered="ready"]').waitFor();
  };
  const draws = () => layouts().locator('body').evaluate(() => window.__mapDraws ?? 0);
  await page.locator('.spread-thumb[data-spread="arriving"]').click();
  await ready('arriving');
  assert.equal(await draws(), 1, 'The initial thumbnail is drawn once');
  for (const spread of ['settlements', 'last-notes', 'arriving', 'settlements']) {
    await page.locator('.spread-thumb[data-spread="' + spread + '"]').click();
    await ready(spread);
    assert.equal(await draws(), 0, 'Switching to ' + spread + ' reuses the map picture without drawing');
  }
  const manifest = join(book, 'project.json');
  const project = JSON.parse(await readFile(manifest, 'utf8'));
  const spread = project.spreads.find(({ id }) => id === 'settlements');
  spread.elements ??= {};
  spread.elements.map = { params: { longitude: 10 } };
  const old = await page.locator('iframe.book-frame-layouts[data-current]').getAttribute('src');
  await writeFile(manifest, JSON.stringify(project));
  await page.waitForFunction((old) => document.querySelector('iframe.book-frame-layouts[data-current][data-ready]')?.getAttribute('src') !== old, old);
  await ready('settlements');
  assert.equal(await draws(), 1, 'Changed map settings draw a fresh thumbnail');
  const color = await layouts().locator('[data-spread="map"] .if-rendered-image img').evaluate((image) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  });
  assert.deepEqual(color, [0, 128, 64, 255], 'The fresh map shows its updated coordinates');
  await page.locator('.spread-thumb[data-spread="arriving"]').click(); await ready('arriving');
  assert.equal(await draws(), 0, 'The previous map view remains cached separately');
  await page.locator('.spread-thumb[data-spread="settlements"]').click(); await ready('settlements');
  assert.equal(await draws(), 0, 'The changed map view is also reusable');
  const previous = await page.locator('iframe.book-frame-layouts[data-current]').getAttribute('src');
  await writeFile(mapFile, await readFile(mapFile, 'utf8') + '\n// Template changed\n');
  await page.waitForFunction((old) => document.querySelector('iframe.book-frame-layouts[data-current][data-ready]')?.getAttribute('src') !== old, previous);
  await ready('settlements');
  assert.equal(await draws(), 1, 'Changed template code invalidates cached pictures');

  // An actual map on page Y must survive editing a different page X in the sidebar's whole-book frame.
  const thumbnails = () => page.frameLocator('iframe.book-frame-thumbs[data-current]');
  const thumbUrl = () => page.locator('iframe.book-frame-thumbs[data-current]').getAttribute('src');
  const nextThumbs = (old) => page.waitForFunction((old) => {
    const frame = document.querySelector('iframe.book-frame-thumbs[data-current][data-ready]');
    return frame && frame.getAttribute('src') !== old;
  }, old);
  const mapPage = '[data-spread="water"] [data-rendered]';
  const mapBook = JSON.parse(await readFile(manifest, 'utf8'));
  mapBook.spreads.find(({ id }) => id === 'water').definition = 'map';
  const beforeMap = await thumbUrl();
  await writeFile(manifest, JSON.stringify(mapBook));
  await nextThumbs(beforeMap);
  await thumbnails().locator(mapPage + '[data-rendered="ready"]').waitFor();
  const firstMap = await thumbnails().locator('body').evaluate(() => window.__mapDrawDetails);

  // Hold promotion at the exact ready message, so a cached map painted only after promotion cannot pass.
  await page.evaluate(() => {
    window.__holdThumbs = true;
    window.__thumbMessages = [];
  });
  const beforeEdit = await thumbUrl();
  await page.getByRole('spinbutton', { name: 'Gap', exact: true }).fill('7');
  await page.getByRole('spinbutton', { name: 'Gap', exact: true }).press('Enter');
  await page.waitForFunction(() => window.__thumbMessages.some(({ data }) => data.state === 'ready'));
  assert.notEqual(await thumbUrl(), beforeEdit, 'Inspect the replacement frame, not the previous sidebar');
  assert.equal(await page.locator('iframe.book-frame-thumbs[data-current]').getAttribute('data-ready'), null,
    'The replacement is still held before promotion');
  assert.equal(await thumbnails().locator('body').evaluate(() => window.__mapDraws ?? 0), 0,
    'An edit on another page does not redraw the sidebar map: ' + JSON.stringify({ firstMap,
      replacement: await thumbnails().locator('body').evaluate(() => window.__mapDrawDetails) }));
  assert.equal(await thumbnails().locator(mapPage).getAttribute('data-rendered'), 'ready',
    'The cached map is restored before the replacement sidebar frame is promoted');
  assert.equal(await thumbnails().locator(mapPage + ' img').evaluate((image) => getComputedStyle(image).display), 'block');
  assert.equal(await page.locator('iframe.book-frame-thumbs[data-current]').evaluate((frame) => getComputedStyle(frame).zIndex), '0',
    'The pending frame cannot tint the displayed map');
  assert.equal(await page.locator('iframe.book-frame-thumbs:not([aria-hidden="true"])').evaluate((frame) => getComputedStyle(frame).zIndex), '1');
  await page.evaluate(() => {
    window.__holdThumbs = false;
    for (const message of window.__thumbMessages) window.dispatchEvent(new MessageEvent('message', message));
    window.__thumbMessages = [];
  });
  await page.locator('iframe.book-frame-thumbs[data-current][data-ready]').waitFor();
  console.log('Picture cache passed: layout navigation, sidebar map stability through unrelated edits, input and template invalidation.');
} catch (error) { console.error('Picture requests:', pictures); throw error; }
finally { await app.close(); await rm(work, { recursive: true, force: true }); }
