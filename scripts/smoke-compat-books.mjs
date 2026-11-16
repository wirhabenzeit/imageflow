import { exportAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';

// #77: the compatibility books in tests/compat/books/ open in the current app without render errors or warnings, keep
// their format, page count and trim size (tests/compat/expected.json), export a print PDF with one trimmed page per
// book page, and are not rewritten by any of it. A book in a newer book format is refused with
// a request to update ImageFlow and left unchanged. See tests/compat/README.md.
const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
const books = join(root, 'tests', 'compat', 'books');
const expected = JSON.parse(await readFile(join(root, 'tests', 'compat', 'expected.json'), 'utf8'));
const work = await mkdtemp(join(build, 'compat-books-'));

async function contents(folder) {
  const files = {};
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (path !== join(folder, '.imageflow')) await walk(path); }
      else files[relative(folder, path).split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  };
  await walk(folder);
  return files;
}
const points = ({ value, unit }) => unit === 'mm' ? value * 72 / 25.4 : unit === 'in' ? value * 72 : value;
const near = (actual, wanted, message) => assert.ok(Math.abs(actual - wanted) < 0.5, message + ': ' + actual + ' ≉ ' + wanted);

let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(build, 'desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 15000 });
  for (const name of Object.keys(expected)) {
    const want = expected[name];
    const folder = join(work, name + '.imageflow');
    await cp(join(books, name), folder, { recursive: true });
    const before = await contents(folder);
    const w = await testBook(app, folder);
    w.setDefaultTimeout(60000);
    const ready = 'iframe.book-frame-book[data-current][data-ready]';
    await w.locator(ready).waitFor();
    const status = await w.frameLocator(ready).locator('body').evaluate(() => window.imageflowRenderStatus);
    assert.equal(status.state, 'ready', name);
    assert.deepEqual(status.errors, [], name + ': ' + JSON.stringify(status.errors));
    assert.deepEqual(status.warnings ?? [], [], name + ': ' + JSON.stringify(status.warnings));
    assert.equal(status.pages, want.pages, name + ' page count');
    assert.equal(status.template.formatId, want.format, name + ' format');
    const trim = [points(status.template.format.trim.width), points(status.template.format.trim.height)];
    near(trim[0], want.trimPoints[0], name + ' trim width');
    near(trim[1], want.trimPoints[1], name + ' trim height');

    const file = join(work, name + '.pdf');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, file);
    const saved = 'PDF saved';
    await exportAction(w);
    await w.waitForFunction((saved) => document.querySelector('.status-error') ||
      (document.querySelector('.status')?.textContent ?? '').startsWith(saved), saved, { timeout: 180000 });
    assert.match(await w.locator('.status').textContent(), new RegExp('^' + saved), name);
    const pdf = await PDFDocument.load(await readFile(file));
    assert.equal(pdf.getPageCount(), want.pages, name + ' PDF pages');
    for (const [index, page] of pdf.getPages().entries()) {
      const box = page.getTrimBox();
      near(box.width, trim[0], name + ' page ' + (index + 1) + ' trim width');
      near(box.height, trim[1], name + ' page ' + (index + 1) + ' trim height');
    }
    assert.deepEqual(await contents(folder), before, name + ' was changed by opening and exporting it');
    await w.close();
    console.log('Compatibility book ' + name + ': ' + status.pages + ' pages, ' + pdf.getPageCount() + ' PDF pages.');
  }

  // A book saved by a newer ImageFlow is refused with a request to update, and left as it was.
  const newer = join(work, 'newer.imageflow');
  const first = Object.keys(expected)[0];
  await cp(join(books, first), newer, { recursive: true });
  const project = JSON.parse(await readFile(join(newer, 'project.json'), 'utf8'));
  // The compatibility books are format 1, which is not the newest format this app reads, so use one far beyond it.
  await writeFile(join(newer, 'project.json'), JSON.stringify({ ...project, schemaVersion: 99 }, null, 2) + '\n');
  const before = await contents(newer);
  await assert.rejects(testBook(app, newer), /newer version of ImageFlow.*Update ImageFlow/s);
  assert.deepEqual(await contents(newer), before);
  console.log('ImageFlow compatibility book smoke test passed.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
