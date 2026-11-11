import { testBook, menuAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// The starter's physical geometry in both formats: every absolutely positioned node of every sample spread, in
// millimetres from the sheet's outer bleed corner. Refactoring the starter must keep it, so the recorded baseline
// is the acceptance check for template helpers. IMAGEFLOW_UPDATE_GEOMETRY=1 records a new baseline.
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = join(root, 'tests', 'fixtures', 'starter-geometry.json');
const work = await mkdtemp(join(root, '.build', 'geometry-'));

async function measure(format) {
  const project = join(work, format + '.imageflow');
  await cp(join(root, 'sample', 'starter'), project, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
  const manifest = JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
  await writeFile(join(project, 'project.json'), JSON.stringify({ ...manifest, format }, null, 2));
  const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile-' + format)],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  try {
    const w = await testBook(app, project, false);
    w.setDefaultTimeout(30000);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);

    const frame = w.frameLocator('iframe.book-frame-book[data-current][data-ready]');
    await frame.locator('.if-sheet').first().waitFor();
    const status = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
    assert.equal(status.state, 'ready');
    assert.equal(status.template.formatId, format);
    const width = status.template.format.trim.width.value * 2 + status.template.format.bleed.outside.value * 2;
    return await frame.locator('body').evaluate((body, spreadWidth) => {
      const round = (value) => Math.round(value * 100) / 100;
      return Object.fromEntries([...body.querySelectorAll('[data-spread]')].map((container) => {
        const sheet = container.querySelector('.if-sheet');
        const outer = sheet.getBoundingClientRect();
        const scale = spreadWidth / outer.width;
        const nodes = [...sheet.querySelectorAll('*')].filter((node) => getComputedStyle(node).position === 'absolute');
        return [container.dataset.spread, nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          const owner = node.dataset.box ?? node.dataset.element;
          return [node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).join('.') : '') +
            (owner ? '#' + owner : ''), round((rect.left - outer.left) * scale), round((rect.top - outer.top) * scale),
          round(rect.width * scale), round(rect.height * scale)];
        })];
      }));
    }, width);
  } finally {
    await app.close();
  }
}

try {
  const measured = { square: await measure('square'), landscape: await measure('landscape') };
  if (process.env.IMAGEFLOW_UPDATE_GEOMETRY === '1') {
    await writeFile(baseline, JSON.stringify(measured, null, 1) + '\n');
    console.log('Recorded the starter geometry baseline.');
  } else {
    const expected = JSON.parse(await readFile(baseline, 'utf8'));
    for (const [format, spreads] of Object.entries(expected)) {
      for (const [spread, nodes] of Object.entries(spreads)) {
        const actual = measured[format][spread];
        assert.equal(actual?.length, nodes.length, format + ' ' + spread + ' renders ' + actual?.length + ' positioned nodes, expected ' + nodes.length);
        nodes.forEach(([name, ...box], i) => {
          const [actualName, ...actualBox] = actual[i];
          assert.equal(actualName, name, format + ' ' + spread + ' node ' + i);
          assert.ok(box.every((value, k) => Math.abs(value - actualBox[k]) <= .05),
            format + ' ' + spread + ' ' + name + ' moved: ' + JSON.stringify(box) + ' → ' + JSON.stringify(actualBox));
        });
      }
    }
    console.log('ImageFlow starter geometry passed.');
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
