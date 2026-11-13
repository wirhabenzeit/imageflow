import { testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// Declared editor network access (ADR 0006): a template lists origins, the book asks once, and only element editor
// frames may then reach the allowed origins. Requests are judged by the frame's content security policy, so the
// test hosts need not exist: a policy violation names the request, a permitted request just fails to connect.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'editor-network-'));
const folder = join(work, 'book.imageflow');
await mkdir(join(folder, 'template'), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import { defineTemplate, mm, p, Spread, Element } from 'imageflow';
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
export default defineTemplate({ id: 'network-test', version: '1', contract: 1, requires: ['editor-network'],
  network: ['https://tiles.allowed.invalid'],
  format: { label: 'Square', trim: { width: mm(150), height: mm(150) },
    bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) }, safe: { top: mm(8), bottom: mm(8), outside: mm(8), binding: mm(8) },
    structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 100, step: 2 } },
    output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' } },
  spreads: { main: { label: 'Map', elements: { map: { label: 'Map', parameters: { zoom: p.number({ label: 'Zoom', default: 1, min: 1, max: 5 }) },
    editor: { label: 'Edit map', parameters: ['zoom'], component: NetworkEditor } } },
    render: () => <Spread><Element id="map" style={{ position: 'absolute', left: '20mm', top: '20mm', width: '100mm', height: '50mm' }}>Map</Element></Spread> } } });
`);
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Network', template: { id: 'network-test', version: '1' },
  spreads: [{ id: 'one', definition: 'main' }] }));
await writeFile(join(folder, 'photos.json'), '{}');

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, folder);
  w.setDefaultTimeout(30000);
  // The consent dialog answers as told and counts how often it was shown, with what.
  const answer = (response) => app.evaluate(({ dialog }, response) => {
    globalThis.networkPrompts = [];
    dialog.showMessageBox = async (_owner, options) => { globalThis.networkPrompts.push(options.detail); return { response }; };
  }, response);
  const prompts = () => app.evaluate(() => globalThis.networkPrompts);
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

  // Not Now: the editor still opens, offline; it asks again next time.
  await answer(1);
  assert.equal(await blocked(), 'other.invalid,tiles.allowed.invalid');
  const asked = await prompts();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /https:\/\/tiles\.allowed\.invalid/);

  // Allow: the declared origin is reachable from the editor; undeclared ones stay blocked.
  await answer(0);
  assert.equal(await blocked(), 'other.invalid');
  assert.equal((await prompts()).length, 1);

  // The approval is remembered for this book.
  await answer(1);
  assert.equal(await blocked(), 'other.invalid');
  assert.deepEqual(await prompts(), []);
  console.log('ImageFlow editor network passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
