import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, nextPresentation, testBook } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

// Presentation must reuse the maps the book view drew, and show all of each: a map drawn as a large raster layer
// (shaded relief, larger than a PNG the cache once refused) under a vector layer with the borders and labels. The
// drawing is replaced in the browser, so the test needs no internet access or WebGL driver.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/presentation-pictures-'));
const book = join(work, 'Book.imageflow');
await copySample(join(root, 'sample', 'starter'), book);
const manifest = join(book, 'project.json');
const project = JSON.parse(await readFile(manifest, 'utf8'));
for (const id of ['arriving', 'headlands']) {
  const spread = project.spreads.find((spread) => spread.id === id);
  spread.definition = 'map';
  delete spread.split;
}
await writeFile(manifest, JSON.stringify(project, null, 2));

const drawing = `
const counted = (label) => { (window.__draws ??= {})[label] = (window.__draws[label] ?? 0) + 1; };
async function drawRelief(target) {
  counted('Relief');
  await new Promise(resolve => setTimeout(resolve, 300));
  target.signal.throwIfAborted();
  const canvas = document.createElement('canvas');
  // At least Retina resolution on any screen: as large as real shaded relief, more than 8 MB as PNG.
  const scale = Math.max(target.pixelRatio, 2);
  canvas.width = Math.ceil(target.width * scale);
  canvas.height = Math.ceil(target.height * scale);
  const ctx = canvas.getContext('2d');
  // Faint noise over grey compresses about as badly as shaded relief does.
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  let seed = 7;
  for (let i = 0; i < pixels.data.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    pixels.data[i] = (i & 3) === 3 ? 255 : 120 + ((seed >>> 16) & 15);
  }
  ctx.putImageData(pixels, 0, 0);
  window.__reliefPng = await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob.size), 'image/png'));
  return canvas;
}
async function drawBorders(target) {
  counted('Map');
  await new Promise(resolve => setTimeout(resolve, 300));
  target.signal.throwIfAborted();
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + target.width + ' ' + target.height + '">' +
    '<clipPath id="land"><rect width="' + target.width + '" height="' + target.height + '"/></clipPath>' +
    '<path class="probe-border" clip-path="url(#land)" d="M0 0L' + target.width + ' ' + target.height + '" stroke="#a04020" stroke-width="4"/></svg>';
}
`;
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  // The copied template is unchanged, so its hash keeps the built-in template's network approval.
  await app.context().route('**/template/template.js', async (route) => {
    const originalUrl = route.request().url() + '?original=1';
    await route.fulfill({ contentType: 'text/javascript', body: drawing + `
      const original = window.ImageFlowRuntime.RenderedImage;
      const h = window.ImageFlowReact.createElement;
      window.ImageFlowRuntime.RenderedImage = (props) => h(window.ImageFlowReact.Fragment, null,
        h(original, { ...props, key: 'relief', label: 'Relief', output: 'raster', draw: drawRelief }),
        h(original, { ...props, key: 'map', label: 'Map', output: 'vector', draw: drawBorders }));
      const template = await import(${JSON.stringify(originalUrl)});
      export default template.default;
    ` });
  });
  const page = await testBook(app, book);
  const bookFrame = page.frameLocator('iframe.book-frame-book[data-current][data-ready]');
  for (const id of ['arriving', 'headlands']) {
    await bookFrame.locator('[data-spread="' + id + '"] .if-rendered-image[data-rendered="ready"]').nth(1).waitFor({ timeout: 60000 });
  }
  await page.waitForTimeout(1500);
  const png = await bookFrame.locator('body').evaluate(() => window.__reliefPng);
  assert.ok(png > 8 * 1024 * 1024, 'The relief is larger than the 8 MB the cache once refused: ' + png);

  const present = async () => {
    const opened = nextPresentation(app);
    assert.ok('value' in await page.evaluate(() => window.imageflow.startPresentation('arriving')));
    const presentation = await opened;
    await presentation.locator('.book-frame-present[data-current][data-ready]').waitFor({ timeout: 60000 });
    const frame = presentation.frameLocator('.book-frame-present[data-current]');
    // The neighbours start drawing (or restoring) once the current spread is shown.
    await frame.locator('.if-present-crop').nth(2).waitFor({ state: 'attached', timeout: 30000 });
    await frame.locator('body').evaluate(() => new Promise((resolve) => {
      const check = () => document.querySelector('.if-rendered-image[data-rendered="pending"]') ? setTimeout(check, 100) : resolve();
      check();
    }));
    return { presentation, frame };
  };
  const vectorsShown = (frame) => frame.locator('body').evaluate(() => [...document.querySelectorAll('.if-present-crop')].map((crop) => {
    const maps = [...crop.querySelectorAll('.if-rendered-image[data-rendered-label="Map"]')];
    return { maps: maps.length, drawn: maps.filter((map) => map.querySelector(':scope > div > svg .probe-border')).length,
      visible: crop.style.visibility !== 'hidden' };
  }));
  const close = async (presentation) => {
    const closed = presentation.waitForEvent('close');
    await (await app.browserWindow(presentation)).evaluate((window) => window.close());
    await closed;
  };

  for (const round of ['first', 'second']) {
    const { presentation, frame } = await present();
    const draws = await frame.locator('body').evaluate(() => window.__draws ?? {});
    assert.deepEqual(draws, {}, 'The ' + round + ' presentation reuses every map picture the book view drew: ' + JSON.stringify(draws));
    const crops = await vectorsShown(frame);
    assert.ok(crops.some(({ maps, visible }) => maps && visible), 'The current spread shows a map');
    assert.ok(crops.filter(({ maps }) => maps).length >= 2, 'A neighbouring map spread is prepared');
    for (const crop of crops) assert.equal(crop.drawn, crop.maps, 'Every presentation copy shows its vector layer: ' + JSON.stringify(crops));
    const ids = await frame.locator('.if-present-crop .probe-border').evaluateAll((paths) => paths.map((path) => path.getAttribute('clip-path')));
    assert.equal(new Set(ids).size, ids.length, 'Each copy of a vector picture references its own clip path');
    await presentation.keyboard.press('ArrowRight');
    await frame.locator('body').evaluate(() => new Promise((resolve) => {
      const check = () => [...document.querySelectorAll('.if-present-crop')].some((crop) => crop.style.visibility !== 'hidden' &&
        crop.querySelector('.if-rendered-image[data-rendered-label="Map"]')) && !document.querySelector('.if-rendered-image[data-rendered="pending"]')
        ? resolve() : setTimeout(check, 100);
      check();
    }));
    const after = await vectorsShown(frame);
    assert.ok(after.some(({ maps, drawn, visible }) => visible && maps && drawn === maps), 'The next map spread shows its borders: ' + JSON.stringify(after));
    await close(presentation);
  }
  console.log('Presentation pictures: maps are reused from the cache and show their vector layers.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
