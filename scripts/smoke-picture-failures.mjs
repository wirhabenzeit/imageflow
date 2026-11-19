import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

// A map drawn as two layered pictures (shaded relief under the map's lines) that both fail after an edit: on screen,
// the pictures drawn before stay under the messages, and the two messages are stacked where they can be read instead
// of printed over each other. The drawing is replaced in the browser, so no internet access or WebGL is needed.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/picture-failures-'));
const book = join(work, 'Book.imageflow');
await copySample(join(root, 'sample', 'starter'), book);
const manifest = join(book, 'project.json');
const project = JSON.parse(await readFile(manifest, 'utf8'));
const spread = project.spreads.find(({ id }) => id === 'arriving');
spread.definition = 'map';
delete spread.split;
await writeFile(manifest, JSON.stringify(project, null, 2));

const drawing = `
const failing = (inputs) => inputs.longitude === 10;
async function drawRelief(target, inputs) {
  await new Promise(resolve => setTimeout(resolve, 100));
  if (failing(inputs)) throw new Error('elevation tiles are unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(target.width * target.pixelRatio);
  canvas.height = Math.ceil(target.height * target.pixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4060a0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}
async function drawLines(target, inputs) {
  await new Promise(resolve => setTimeout(resolve, 100));
  if (failing(inputs)) throw new Error('map tiles are unavailable');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + target.width + ' ' + target.height + '"><path class="probe-line" d="M0 0L' +
    target.width + ' ' + target.height + '" stroke="#a04020" stroke-width="4"/></svg>';
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
        h(original, { ...props, key: 'relief', label: 'Shaded terrain', output: 'raster', draw: (target) => drawRelief(target, props.inputs) }),
        h(original, { ...props, key: 'map', label: 'Map', output: 'vector', draw: (target) => drawLines(target, props.inputs) }));
      const template = await import(${JSON.stringify(originalUrl)});
      export default template.default;
    ` });
  });
  const page = await testBook(app, book);
  const bookFrame = () => page.frameLocator('iframe.book-frame-book[data-current][data-ready]');
  const pictures = () => bookFrame().locator('[data-spread="arriving"] .if-rendered-image');
  await pictures().nth(1).and(bookFrame().locator('[data-rendered="ready"]')).waitFor({ timeout: 60000 });
  await pictures().nth(0).and(bookFrame().locator('[data-rendered="ready"]')).waitFor({ timeout: 60000 });

  const before = await page.locator('iframe.book-frame-book[data-current]').getAttribute('data-revision');
  const changed = JSON.parse(await readFile(manifest, 'utf8'));
  const arriving = changed.spreads.find(({ id }) => id === 'arriving');
  arriving.elements = { ...arriving.elements, map: { ...arriving.elements?.map, params: { ...arriving.elements?.map?.params, longitude: 10 } } };
  await writeFile(manifest, JSON.stringify(changed));
  await page.waitForFunction((before) => {
    const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('data-revision') !== before;
  }, before);
  await bookFrame().locator('[data-spread="arriving"] .if-rendered-image[data-rendered="failed"]').nth(1).waitFor({ timeout: 60000 });

  const state = await pictures().evaluateAll((nodes) => nodes.map((node) => {
    const label = getComputedStyle(node, '::after');
    const image = node.querySelector(':scope > img'), vector = node.querySelector(':scope > div');
    return { label: node.dataset.renderedLabel, rendered: node.dataset.rendered, title: node.title,
      line: node.style.getPropertyValue('--if-failure-line'), lines: node.style.getPropertyValue('--if-failure-lines'),
      transform: label.transform, background: label.backgroundColor,
      shown: image.style.display === 'block' || (vector.style.display === 'block' && !!vector.querySelector('.probe-line')) };
  }));
  const [relief, map] = state;
  assert.equal(relief.rendered, 'failed');
  assert.equal(map.rendered, 'failed');
  assert.match(relief.title, /^Shaded terrain could not be rendered: elevation tiles are unavailable/);
  assert.match(map.title, /^Map could not be rendered: map tiles are unavailable/);
  assert.deepEqual([relief.line, relief.lines, map.line, map.lines], ['0', '2', '1', '2'], 'The two failures are numbered as one stack');
  assert.notEqual(relief.transform, map.transform, 'Their messages sit on separate lines: ' + JSON.stringify(state));
  assert.notEqual(relief.background, 'rgba(0, 0, 0, 0)', 'A message has a backing that keeps it legible over a map');
  assert.ok(relief.shown && map.shown, 'The pictures drawn before stay under the messages on screen: ' + JSON.stringify(state));
  console.log('Picture failures: the last pictures stay, and layered failures stack their messages.');
} finally {
  await app.close().catch(() => {});
  await rm(work, { recursive: true, force: true });
}
