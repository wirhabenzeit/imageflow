import { testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// Declared network access (ADR 0006): a template lists origins, the book asks when it first renders and when an
// element editor opens, and once allowed, its editor, preview and check frames may reach those origins and no
// others. A <RenderedImage> that needs them fails the Book check until they are allowed. Requests are judged by the
// frame's content security policy, so the test hosts need not exist: a policy violation names the request, a
// permitted request just fails to connect.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'editor-network-'));
const folder = join(work, 'book.imageflow');
await mkdir(join(folder, 'template'), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import { defineTemplate, mm, p, Spread, Element, RenderedImage } from 'imageflow';
// Requests one declared and one undeclared origin and lists the requests the policy blocked.
function NetworkEditor() {
  const [blocked, setBlocked] = React.useState(null);
  React.useEffect(() => {
    const seen = new Set();
    document.addEventListener('securitypolicyviolation', (event) => seen.add(new URL(event.blockedURI).host));
    Promise.allSettled(['https://tiles.allowed.invalid/style.json', 'https://other.invalid/data.json'].map((url) => fetch(url)))
      .then(() => setTimeout(() => setBlocked([...seen].sort().join(',') || 'none'), 200));
  }, []);
  return <p className="blocked">{blocked ?? 'pending'}</p>;
}
import React from 'react';
// Draws a small picture after requesting both origins; fails when the declared one is blocked.
async function drawChecked({ width, height, pixelRatio }) {
  const seen = new Set();
  const listener = (event) => seen.add(new URL(event.blockedURI).host);
  document.addEventListener('securitypolicyviolation', listener);
  await Promise.allSettled(['https://tiles.allowed.invalid/tile.png', 'https://other.invalid/tile.png'].map((url) => fetch(url)));
  await new Promise((resolve) => setTimeout(resolve, 200));
  document.removeEventListener('securitypolicyviolation', listener);
  document.body.dataset.blocked = [...seen].sort().join(',') || 'none';
  if (seen.has('tiles.allowed.invalid')) throw new Error('tiles.allowed.invalid is not allowed');
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * pixelRatio); canvas.height = Math.ceil(height * pixelRatio);
  canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}
export default defineTemplate({ id: 'network-test', version: '1', contract: 1, requires: ['editor-network', 'rendered-images'],
  network: ['https://tiles.allowed.invalid'],
  format: { label: 'Square', trim: { width: mm(150), height: mm(150) },
    bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) }, safe: { top: mm(8), bottom: mm(8), outside: mm(8), binding: mm(8) },
    structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 100, step: 2 } },
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } },
  spreads: { main: { label: 'Map', elements: { map: { label: 'Map', parameters: { zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: 5 }) },
    editor: { label: 'Edit map', parameters: ['zoom'], component: NetworkEditor } } },
    render: () => <Spread><Element id="map" style={{ position: 'absolute', left: '20mm', top: '20mm', width: '100mm', height: '50mm' }}>
      <RenderedImage label="Tiles" inputs={{}} draw={drawChecked} style={{ position: 'absolute', inset: 0 }} />
    </Element></Spread> } } });
`);
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Network', template: { id: 'network-test', version: '1' },
  spreads: [{ id: 'one', definition: 'main' }] }));
await writeFile(join(folder, 'photos.json'), '{}');

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  // The consent dialog answers as told and counts how often it was shown, with what.
  const answer = (response) => app.evaluate(({ dialog }, response) => {
    globalThis.networkPrompts = [];
    dialog.showMessageBox = async (_owner, options) => { globalThis.networkPrompts.push(options.detail); return { response }; };
  }, response);
  const prompts = () => app.evaluate(() => globalThis.networkPrompts);
  await answer(1);
  const w = await testBook(app, folder);
  w.setDefaultTimeout(30000);
  // The hosts the book frame's picture found blocked, once it has tried.
  const pageBlocked = async () => {
    const book = w.frameLocator('iframe.book-frame-book[data-current][data-ready]').locator('body[data-blocked]');
    await book.waitFor({ state: 'attached' });
    return book.getAttribute('data-blocked');
  };
  // The Book check of the current book, as the app runs it before export.
  const checkErrors = () => w.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const frames = [...document.querySelectorAll('iframe.book-frame-book[data-ready]:not([aria-hidden="true"])')];
      const id = new URL(frames.at(-1).src).pathname.split('/').at(-1);
      const result = await window.imageflow.checkBook(id, {});
      if (result.value) return result.value.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code + ': ' + d.message);
      if (!/finishing another operation|project changed/.test(result.error)) throw new Error(result.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const dialog = w.getByRole('dialog', { name: 'Edit map' });
  const blocked = async () => {
    const map = await frame.locator('[data-element="map"]').boundingBox();
    await w.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
    await dialog.waitFor();
    const text = w.frameLocator('iframe.element-editor-frame').locator('.blocked:not(:text("pending"))');
    await text.waitFor();
    const result = await text.textContent();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    return result;
  };
  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();

  // The book asks when it first renders. Not Now: the page's picture cannot reach the declared origin, so the Book
  // check reports it and export would stop.
  for (let i = 0; i < 100 && !(await prompts()).length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const asked = await prompts();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /https:\/\/tiles\.allowed\.invalid/);
  assert.equal(await pageBlocked(), 'other.invalid,tiles.allowed.invalid');
  const offline = await checkErrors();
  assert.ok(offline.some((error) => /^rendered-image-failed: Tiles could not be rendered: tiles\.allowed\.invalid is not allowed/.test(error)), offline.join('\n'));
  assert.ok(!offline.some((error) => error.startsWith('render-impure')), 'declared rendering work is not impure');

  // The editor still opens, offline; it asks again.
  await answer(1);
  assert.equal(await blocked(), 'other.invalid,tiles.allowed.invalid');
  assert.equal((await prompts()).length, 1);

  // Allow: the declared origin is reachable from the editor, the page and the Book check; undeclared ones stay blocked.
  await answer(0);
  assert.equal(await blocked(), 'other.invalid');
  assert.equal((await prompts()).length, 1);
  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  for (let i = 0; i < 100 && await pageBlocked().catch(() => '') !== 'other.invalid'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await pageBlocked(), 'other.invalid');
  assert.deepEqual(await checkErrors(), []);

  // The approval is remembered for this book.
  await answer(1);
  assert.equal(await blocked(), 'other.invalid');
  assert.deepEqual(await prompts(), []);

  // The approval belongs to this version of the template: changing its files renders the book offline and asks again.
  await answer(1);
  const frameBefore = await w.locator('iframe.book-frame-book[data-current][data-ready]').getAttribute('src');
  await writeFile(join(folder, 'template/index.tsx'), (await readFile(join(folder, 'template/index.tsx'), 'utf8')) + '// changed\n');
  await w.waitForFunction((src) => {
    const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('src') !== src;
  }, frameBefore);
  for (let i = 0; i < 100 && !(await prompts()).length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await prompts()).length, 1);
  assert.equal(await pageBlocked(), 'other.invalid,tiles.allowed.invalid');
  console.log('ImageFlow editor network passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
