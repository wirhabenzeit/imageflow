import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

// A deliberately slow map makes redraws observable without depending on internet access or a WebGL driver.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/layout-picture-cache-'));
const book = join(work, 'Book.imageflow');
await copySample(join(root, 'sample', 'starter'), book);
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
      if (!window.__holdThumbs || event.source !== candidate?.contentWindow || event.origin !== 'imageflow://thumbs') return;
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
        { ...props, output: 'raster', draw: (target) => drawMap(props.inputs, target) });
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
  assert.deepEqual(startup.network, ['https://tiles.openfreemap.org', 'https://tiles.mapterhorn.com'], 'The book starts with approved network access');
  const layouts = () => page.frameLocator('iframe.book-frame-layouts[data-current]');
  const ready = async (spread) => {
    await page.waitForFunction((spread) => {
      const frame = document.querySelector('iframe.book-frame-layouts[data-current][data-ready]');
      return frame && new URL(frame.src).searchParams.get('spread') === spread;
    }, spread);
    await layouts().locator('[data-spread="map"] [data-rendered="ready"]').waitFor();
    // Every map layout's preview has drawn (and so is cached) before the next step moves on.
    await layouts().locator('.if-rendered-image[data-rendered="pending"]').first().waitFor({ state: 'detached' });
  };
  const draws = () => layouts().locator('body').evaluate(() => window.__mapDraws ?? 0);
  // The starter's full-spread and single-page maps each produce their own cached picture.
  const mapLayouts = 2;
  await page.locator('.spread-thumb[data-spread="arriving"]').click();
  await ready('arriving');
  assert.equal(await draws(), mapLayouts, 'The initial thumbnails are drawn once per map layout');
  for (const spread of ['settlements', 'last-notes', 'arriving', 'settlements']) {
    await page.locator('.spread-thumb[data-spread="' + spread + '"]').click();
    await ready(spread);
    assert.equal(await draws(), 0, 'Switching to ' + spread + ' reuses the map picture without drawing');
  }
  // Back to the spread before while its previews are still kept beneath (A → B → A within their moment): they show
  // again at once, not hidden behind B's until the frame kept beneath is released and reloads.
  await page.evaluate(() => {
    window.__retired = false;
    new MutationObserver(() => { if (document.querySelector('iframe.book-frame-layouts.book-frame-retiring')) window.__retired = true; })
      .observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  });
  const shownPreviews = (spread, timeout = 10_000) => page.waitForFunction((spread) => {
    const frame = document.querySelector('iframe.book-frame-layouts:not(.book-frame-pending)');
    return frame && new URL(frame.src).searchParams.get('spread') === spread;
  }, spread, { timeout });
  await page.locator('.spread-thumb[data-spread="arriving"]').click();
  await shownPreviews('arriving');
  await page.locator('.spread-thumb[data-spread="settlements"]').click();
  assert.equal(await page.evaluate(() => window.__retired), true, 'The previous previews were kept beneath');
  await shownPreviews('settlements', 400);
  await page.waitForTimeout(800);
  await shownPreviews('settlements');
  await ready('settlements');
  const manifest = join(book, 'project.json');
  const project = JSON.parse(await readFile(manifest, 'utf8'));
  const spread = project.spreads.find(({ id }) => id === 'settlements');
  spread.elements ??= {};
  spread.elements.map = { params: { longitude: 10 } };
  const old = await page.locator('iframe.book-frame-layouts[data-current]').getAttribute('src');
  await writeFile(manifest, JSON.stringify(project));
  await page.waitForFunction((old) => document.querySelector('iframe.book-frame-layouts[data-current][data-ready]')?.getAttribute('src') !== old, old);
  await ready('settlements');
  // The map layouts are not this spread's own, so their previews show the map last drawn in each, without drawing.
  assert.equal(await draws(), 0, 'Changed map settings borrow the last map drawn in each layout');
  const color = await layouts().locator('[data-spread="map"] .if-rendered-image img').evaluate((image) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  });
  // The cached copy is WebP, so its colour may be a step off.
  assert.ok([64, 96, 160].every((value, i) => Math.abs(color[i] - value) <= 3), 'The borrowed map is the one last drawn for the layout: ' + color);
  await page.locator('.spread-thumb[data-spread="arriving"]').click(); await ready('arriving');
  assert.equal(await draws(), 0, 'The previous map view remains cached');
  const previous = await page.locator('iframe.book-frame-layouts[data-current]').getAttribute('src');
  await writeFile(mapFile, await readFile(mapFile, 'utf8') + '\n// Template changed\n');
  await page.waitForFunction((old) => document.querySelector('iframe.book-frame-layouts[data-current][data-ready]')?.getAttribute('src') !== old, previous);
  await ready('arriving');
  assert.equal(await draws(), mapLayouts, 'Changed code in the map file draws its pictures again');

  // An actual map on page Y must survive editing a different page X in the sidebar's whole-book frame.
  const thumbnails = () => page.frameLocator('iframe.book-frame-thumbs[data-current]');
  const thumbUrl = () => page.locator('iframe.book-frame-thumbs[data-current]').getAttribute('data-revision');
  const nextThumbs = (old) => page.waitForFunction((old) => {
    const frame = document.querySelector('iframe.book-frame-thumbs[data-current][data-ready]');
    return frame && frame.getAttribute('data-revision') !== old;
  }, old);
  const mapPage = '[data-spread="water"] [data-rendered]';
  const mapBook = JSON.parse(await readFile(manifest, 'utf8'));
  const water = mapBook.spreads.find(({ id }) => id === 'water');
  water.definition = 'map';
  delete water.split;
  const settings = page.locator('.document-settings');
  if (!await settings.getAttribute('open')) await settings.locator('summary').click();
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
  await page.getByRole('checkbox', { name: 'Page numbers', exact: true }).uncheck();
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
  // A replacement draws the pictures of the spreads on screen before it shows, and every other one once it is ready.
  // With the map's thumbnail scrolled out of sight, the sidebar's replacement draws it after it shows.
  const scrolled = await page.locator('iframe.book-frame-thumbs[data-current]').evaluate((frame) => {
    let view = frame.parentElement;
    while (view && view.scrollHeight <= view.clientHeight) view = view.parentElement;
    view.scrollTop = view.scrollHeight;
    return view.scrollTop;
  });
  assert.ok(scrolled > 0, 'the sidebar scrolls');
  const beforeScrolledEdit = await thumbUrl();
  await page.getByRole('checkbox', { name: 'Page numbers', exact: true }).check();
  await page.waitForFunction((before) => { const frame = document.querySelector('iframe.book-frame-thumbs[data-current][data-ready]'); return !!frame && frame.dataset.revision !== before; }, beforeScrolledEdit);
  await thumbnails().locator(mapPage + '[data-rendered="ready"]').waitFor({ timeout: 30_000 });
  console.log('Picture cache passed: layout navigation, sidebar map stability through unrelated edits, input and template invalidation.');
} catch (error) { console.error('Picture requests:', pictures); throw error; }
finally { await closeApp(app); await rm(work, { recursive: true, force: true }); }
