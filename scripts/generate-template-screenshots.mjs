import { execFile } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { exportAction, testBook } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

// Documentation artwork is separate from the New Book picker previews. Render current
// sample books through the real Book check, using disposable copies and an isolated profile.
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { output: { type: 'string', default: 'docs/images' } } });
const output = resolve(root, values.output);
// Parent processes (including agent clients) may run Electron in Node mode.
const { ELECTRON_RUN_AS_NODE: _nodeMode, ...environment } = process.env;
const execute = promisify(execFile);
// Poppler rasterizes the exported PDF, so documentation reflects print artwork
// and does not depend on hidden-window compositor timing.
await execute('pdftoppm', ['-v']).catch(() => { throw new Error('Install Poppler first (on macOS: brew install poppler).'); });
await mkdir(join(root, '.build'), { recursive: true });
const work = await mkdtemp(join(root, '.build/template-screenshots-'));
let app;
const generated = [];

async function renderSample(folder, name, params = {}) {
  const copy = join(work, name + '.imageflow');
  await copySample(join(root, 'sample', folder), copy);
  const file = join(copy, 'project.json');
  const project = JSON.parse(await readFile(file, 'utf8'));
  project.params = { ...project.params, ...params };
  await writeFile(file, JSON.stringify(project));
  const page = await testBook(app, copy);
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  const current = await page.evaluate(() => window.imageflow.currentProject());
  assert.ok(current.value, JSON.stringify(current));
  const checked = await page.evaluate((id) => window.imageflow.checkBook(id, {}), current.value.id);
  assert.ok(checked.value?.render, JSON.stringify(checked));
  const failures = checked.value.diagnostics.filter(({ severity }) => severity === 'error');
  assert.equal(failures.length, 0, `${name}: ${JSON.stringify(failures)}`);
  const pdfFile = join(work, name + '.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdfFile);
  await exportAction(page);
  await page.waitForFunction(() => document.querySelector('.status-error') ||
    document.querySelector('.status')?.textContent?.startsWith('PDF saved'), undefined, { timeout: 180000 });
  assert.match(await page.locator('.status').textContent(), /^PDF saved/);
  const pdf = await PDFDocument.load(await readFile(pdfFile));
  const units = checked.value.render.units;
  assert.equal(pdf.getPageCount(), units.length, 'Every printed page must be present');
  // Crop away bleed using each PDF page's own TrimBox, including the single book ends.
  for (const printed of pdf.getPages()) {
    const box = printed.getTrimBox();
    printed.setCropBox(box.x, box.y, box.width, box.height);
  }
  await writeFile(pdfFile, await pdf.save());
  const prefix = join(work, name + '-page');
  await execute('pdftoppm', ['-png', '-cropbox', '-scale-to', '1200', pdfFile, prefix], { timeout: 120000 });
  const digits = String(units.length).length;
  const pictures = [];
  for (const spread of project.spreads) {
    const pages = [];
    const page = {};
    for (const [index, unit] of units.entries()) {
      if (unit.spread !== spread.id) continue;
      const bytes = await readFile(prefix + '-' + String(index + 1).padStart(digits, '0') + '.png');
      const size = await sharp(bytes).metadata();
      pages.push({ bytes, width: size.width, height: size.height });
      page[unit.side === 'page' ? 'number' : unit.side] = index + 1;
    }
    assert.ok(pages.length, 'Missing printed spread: ' + spread.id);
    const width = pages.reduce((sum, image) => sum + image.width, 0), height = Math.max(...pages.map((image) => image.height));
    let left = 0;
    const composite = pages.map((image) => {
      const position = { input: image.bytes, left, top: 0 }; left += image.width; return position;
    });
    const bytes = await sharp({ create: { width, height, channels: 3, background: '#fff' } }).composite(composite).png().toBuffer();
    pictures.push({ page, width, height, bytes });
    console.log(`Rendered ${name}: ${spread.id}`);
  }
  return pictures;
}

async function sheet(pictures, name, aspect) {
  const columns = 3, gap = 16, width = 1800;
  const cellWidth = Math.floor((width - (columns + 1) * gap) / columns);
  const cellHeight = Math.round(cellWidth / aspect);
  const height = Math.ceil(pictures.length / columns) * (cellHeight + gap) + gap;
  const composite = [];
  for (const [index, picture] of pictures.entries()) {
    const { data, info } = await sharp(picture.bytes).resize(cellWidth, cellHeight, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
    // A facing book's opening/closing page occupies its actual side in the sheet.
    const inset = picture.page?.right && !picture.page?.left ? cellWidth - info.width
      : picture.page?.left && !picture.page?.right ? 0 : Math.round((cellWidth - info.width) / 2);
    composite.push({ input: data, left: gap + index % columns * (cellWidth + gap) + inset,
      top: gap + Math.floor(index / columns) * (cellHeight + gap) + Math.round((cellHeight - info.height) / 2) });
  }
  await sharp({ create: { width, height, channels: 3, background: '#dededb' } })
    .composite(composite).jpeg({ quality: 90, mozjpeg: true }).toFile(join(work, name));
  generated.push(name);
}

try {
  app = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...environment, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 30000 });
  for (const theme of ['light', 'dark']) {
    const pictures = await renderSample('starter', 'photobook-' + theme, { theme });
    // Facing spreads are twice the width of one square photobook page.
    await sheet(pictures, `photobook-starter-${theme}.jpg`, 2);
  }
  const calendar = await renderSample('calendar', 'calendar');
  await sheet(calendar, 'calendar-starter.jpg', calendar[0].width / calendar[0].height);
  await writeFile(join(work, 'calendar-month.png'), calendar[1].bytes);
  generated.push('calendar-month.png');
  // Don't replace any documented images until every sample has rendered successfully.
  await mkdir(output, { recursive: true });
  for (const name of generated) await cp(join(work, name), join(output, name + '.tmp'));
  for (const name of generated) await rename(join(output, name + '.tmp'), join(output, name));
  console.log(`Wrote ${generated.length} documentation images to ${output}`);
} finally {
  try { await app?.close(); }
  finally { await rm(work, { recursive: true, force: true }); }
}
