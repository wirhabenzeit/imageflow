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
try {
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
  console.log('Layout picture cache passed: reuse across pages and sessions, changed inputs and template invalidation.');
} finally { await app.close(); await rm(work, { recursive: true, force: true }); }
