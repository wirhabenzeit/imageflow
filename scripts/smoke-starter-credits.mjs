import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { copySample } from '../desktop/sample-book.mjs';
import { closeApp, testBook } from './ui-actions.mjs';

// Test actual starter credit declarations and printed markup, without depending on tile services.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'starter-credits-'));
let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const base = ['Map data © OpenStreetMap contributors', 'Map tiles © OpenFreeMap © OpenMapTiles'];
  for (const [name, styles, expected] of [
    ['no-maps', [], []],
    ['repeated-base-maps', ['paper', 'paper', 'paper'], base],
    ['mixed-resources', ['paper', 'lines', 'paper'], [...base, 'Elevation © Mapterhorn']],
  ]) {
    const folder = join(work, name + '.imageflow');
    await copySample(join(root, 'sample/starter'), folder);
    const source = join(folder, 'template/map.tsx');
    const map = await readFile(source, 'utf8');
    const start = map.indexOf('async function drawMap('), end = map.indexOf('\n}\n', start) + 3;
    assert.ok(start >= 0 && end > start);
    await writeFile(source, map.slice(0, start) + 'async function drawMap() { return \'<svg viewBox="0 0 100 100"></svg>\'; }\n' + map.slice(end));
    const file = join(folder, 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8'));
    // Keep a complete valid 28-page book with map uses on both independent pages and full spreads.
    const opening = project.spreads[0], closing = project.spreads.at(-1);
    const sheets = Array.from({ length: 13 }, (_, i) => ({ id: 'sheet' + i, definition: 'panorama' }));
    if (styles.length) {
      sheets[0] = { id: 'pair', definition: 'mapPage', split: true, pages: {
        left: { definition: 'mapPage', elements: { map: { params: { style: styles[0] } } } },
        right: { definition: 'mapPage', elements: { map: { params: { style: styles[1] } } } },
      } };
      sheets[1] = { id: 'full-map', definition: 'map', elements: { map: { params: { style: styles[2] } } } };
    }
    project.spreads = [opening, ...sheets, closing];
    await writeFile(file, JSON.stringify(project));
    const window = await testBook(app, folder);
    const ready = 'iframe.book-frame-book[data-current][data-ready]';
    await window.locator(ready).waitFor({ state: 'attached' });
    const frame = window.frameLocator(ready);
    const status = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
    assert.equal(status.state, 'ready', JSON.stringify(status));
    assert.ok(![...status.errors, ...status.warnings].some(issue => issue.code.startsWith('credit-')), JSON.stringify(status));
    const printed = frame.locator('.book-credits');
    assert.equal(await printed.count(), expected.length ? 1 : 0);
    if (expected.length) {
      assert.equal(await printed.textContent(), expected.join(' · '));
      assert.deepEqual((await printed.getAttribute('data-credits')).split(' '),
        expected.length === 3 ? ['openstreetmap', 'openfreemap', 'mapterhorn'] : ['openstreetmap', 'openfreemap']);
    }
  }
  console.log('Starter credits: actual resource use, deduplication, conditional terrain, no page ranges, one attribution, and no-maps case passed.');
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
