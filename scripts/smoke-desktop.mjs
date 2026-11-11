import { menuAction, exportAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
await mkdir(build, { recursive: true });
const runDir = await mkdtemp(join(build, 'smoke-'));
const output = join(runDir, 'whitewall-proof.pdf');
const packaged = process.argv.includes('--packaged');

function printCheck(binary, args) {
  try {
    return execFileSync(binary, args);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Install Poppler to run the desktop proof checks.');
    throw error;
  }
}

function checkProof(pdf, previewLines) {
  const pages = pdf.getPages();
  assert.equal(pages.length, 2);
  const points = (mm) => mm * 72 / 25.4;
  const gross = { x: 0, y: 0, width: points(293), height: points(296) };
  for (const [index, page] of pages.entries()) {
    assert.deepEqual(page.getMediaBox(), gross);
    assert.deepEqual(page.getCropBox(), gross);
    assert.deepEqual(page.getBleedBox(), gross);
    const trim = page.getTrimBox();
    assert.ok(Math.abs(trim.width - points(290)) < 1e-6);
    assert.ok(Math.abs(trim.height - points(290)) < 1e-6);
    assert.equal(trim.x, points(index === 0 ? 3 : 0));
    assert.equal(trim.y, points(3));
  }

  const text = printCheck('pdftotext', ['-f', '2', '-l', '2', '-layout', output, '-']).toString()
    .split('\n').map((line) => line.trim()).filter(Boolean);
  const start = text.indexOf(previewLines[0]);
  assert.notEqual(start, -1);
  assert.deepEqual(text.slice(start, start + previewLines.length), previewLines);

  // Correct page boxes alone do not catch Chromium shrinking the artwork.
  const raster = printCheck('pdftoppm', ['-f', '1', '-l', '1', '-r', '30', output]);
  const header = /^P6\n(\d+) (\d+)\n255\n/.exec(raster.subarray(0, 64).toString());
  assert.ok(header, 'Expected a colour proof raster.');
  const [, width, height] = header.map(Number);
  const pixel = (x, y) => header[0].length + 3 * (Math.floor(y * height) * width + Math.floor(x * width));
  for (const [x, y] of [[0.98, 0.5], [0.5, 0.98]]) {
    const offset = pixel(x, y);
    assert.ok(raster.subarray(offset, offset + 3).some((channel) => channel < 245), 'The photo must reach the bleed.');
  }
}

let instance;
try {
  instance = await _electron.launch({
    executablePath: packaged
      ? join(root, 'out', 'ImageFlow-darwin-' + process.arch, 'ImageFlow.app', 'Contents', 'MacOS', 'ImageFlow')
      : electronPath,
    args: [...(packaged ? [] : [join(build, 'desktop')]), '--user-data-dir=' + join(runDir, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' },
    timeout: 15000,
  });
  const window = await instance.firstWindow();
  window.setDefaultTimeout(15000);
  const status = window.locator('.status');
  const expectStatus = async (message) => {
    await window.waitForFunction((message) => /status-error/.test(document.querySelector('.status')?.className ?? '')
      || document.querySelector('.status')?.textContent === message, message);
    assert.equal(await status.textContent(), message);
  };

  await window.getByRole('button', { name: 'Try the Senja sample' }).click();
  await expectStatus('Project preview · Proof export');
  await window.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]'));
  const previewLines = await window.frameLocator('iframe.book-frame-book[data-current]').locator('[data-box="story"]').evaluate((box) => {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const lines = new Map();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const y = Math.round(range.getBoundingClientRect().y);
        lines.set(y, (lines.get(y) ?? '') + node.data[i]);
      }
    }
    return [...lines.values()].map((line) => line.trim()).filter(Boolean);
  });
  assert.ok(previewLines.length > 1);

  // Use the real IPC and exporter while giving the native dialog a deterministic destination.
  await instance.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, output);
  await exportAction(window, 'Export proof PDF');
  // The two-page sample is shorter than its format allows; proof export reports that error and keeps it in Book check.
  await expectStatus('Proof PDF saved. 1 error in Book check.');
  assert.match(await window.locator('.book-check-toggle').textContent(), /Book check · 1 error/);
  checkProof(await PDFDocument.load(await readFile(output)), previewLines);

  const project = join(runDir, 'project');
  await mkdir(project);
  await writeFile(join(project, 'project.json'), '{"schemaVersion":0}');
  await writeFile(join(project, 'photos.json'), '{}');
  await instance.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await menuAction(instance, 'Open project…');
  await window.locator('.status-error').waitFor();
  assert.match(await status.textContent(), /project\.json.*schemaVersion/);
  assert.equal(await window.locator('.project-identity strong').textContent(), 'Senja · Field Notes');

  await instance.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, join(root, 'sample', 'whitewall'));
  await menuAction(instance, 'Open project…');
  await window.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]'));
  await menuAction(instance, 'Reload');
  await window.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]'));
  console.log('ImageFlow desktop smoke test passed.');
} finally {
  await instance?.close();
  await rm(runDir, { recursive: true, force: true });
}
