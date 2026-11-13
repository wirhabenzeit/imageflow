import { exportAction, testBook, popupAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';

// #46: a template without facing pages renders, checks and exports page by page, and a template that also offers a
// facing format reports the mismatch after a format switch.
const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
const work = await mkdtemp(join(build, 'single-pages-'));
const project = join(work, 'calendar.imageflow');
const template = `import { defineTemplate, mm, printFormat, Spread } from 'imageflow';
import './style.css';

export default defineTemplate({
  id: 'calendar-smoke', version: '1', contract: 1,
  formats: {
    calendar: printFormat({ label: 'Calendar · A4', trim: { width: mm(210), height: mm(297) }, facingPages: false,
      bleed: { all: mm(3), left: mm(5) }, safe: mm(10), pageCount: { min: 3, max: 3, step: 1 } }),
    book: printFormat({ label: 'Book', trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10),
      pageCount: { min: 2, max: 40, step: 2 } }),
  },
  defaultFormat: 'calendar',
  spreads: {
    cover: { label: 'Cover', span: 'page', parameters: { title: { type: 'string', label: 'Title', default: 'Year' } },
      render: (ctx) => <Spread>
        <div style={{ ...ctx.geometry.css(ctx.geometry.page('bleed')), background: '#ff00ff' }} />
        <ctx.Text parameter="title" as="h1" rect={ctx.geometry.inset(ctx.geometry.page('safe'), { bottom: 200 })} />
        <p data-page={ctx.page.number} style={ctx.geometry.css({ ...ctx.geometry.page('safe'), y: 200, height: 20 })}>Page {ctx.page.number}</p>
      </Spread> },
    month: { label: 'Month', span: 'page', boxes: { photo: { type: 'photo', label: 'Photo' } },
      render: (ctx) => <Spread>
        <ctx.PhotoBox id="photo" rect={ctx.geometry.page('safe')} />
        <p data-page={ctx.page.number} style={ctx.geometry.css({ ...ctx.geometry.page('safe'), y: 250, height: 20 })}>Page {ctx.page.number}</p>
      </Spread> },
  },
});
`;

await mkdir(join(project, 'template'), { recursive: true });
await mkdir(join(project, 'photos'), { recursive: true });
await writeFile(join(project, 'template', 'index.tsx'), template);
await writeFile(join(project, 'photos.json'), '{}');
// Print preflight accepts only fonts the template bundles.
await writeFile(join(project, 'template', 'style.css'), "@font-face { font-family: Calendar; src: url('./calendar.woff2'); }\n" +
  '.if-sheet { font: 12pt Calendar; } .if-sheet h1 { font-weight: 400; }\n');
await copyFile(join(root, 'sample', 'starter', 'template', 'fonts', 'source-serif-4-latin-400-normal.woff2'), join(project, 'template', 'calendar.woff2'));
await writeFile(join(project, 'project.json'), JSON.stringify({
  schemaVersion: 1, title: 'Calendar', template: { id: 'calendar-smoke', version: '1' }, format: 'calendar',
  spreads: [{ id: 'front', definition: 'cover' }, { id: 'jan', definition: 'month' }, { id: 'feb', definition: 'month' }],
}));

const points = (millimetres) => millimetres * 72 / 25.4;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.5, message + ': ' + actual + ' ≉ ' + expected);
let app;
try {
  app = await _electron.launch({ executablePath: electron, args: [join(build, 'desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 15000 });
  const w = await testBook(app, project, false);
  w.setDefaultTimeout(30000);
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  const frame = w.frameLocator(ready);
  const renderStatus = () => frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  const check = async (request = {}) => {
    const result = await w.evaluate(async ({ ready, request }) => {
      const id = new URL(document.querySelector(ready).src).pathname.split('/').at(-1);
      return window.imageflow.checkBook(id, request);
    }, { ready, request });
    assert.ok('value' in result, result.error);
    return result.value;
  };
  const saveTo = (filePath) => app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
  const exported = async (name, file, expected) => {
    await saveTo(file);
    await exportAction(w, name);
    await w.waitForFunction((expected) => document.querySelector('.status-error') ||
      (document.querySelector('.status')?.textContent ?? '').startsWith(expected), expected, { timeout: 90000 });
    assert.match(await w.locator('.status').textContent(), new RegExp('^' + expected));
    return PDFDocument.load(await readFile(file));
  };

  // Canvas and thumbnails: one page per unit, numbered 1…n.
  await w.locator(ready).waitFor();
  const status = await renderStatus();
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.errors, [], JSON.stringify(status.errors));
  assert.equal(status.pages, 3);
  assert.deepEqual(status.units.map(({ side, spread }) => side + ':' + spread), ['page:front', 'page:jan', 'page:feb']);
  assert.deepEqual(await frame.locator('[data-page]').evaluateAll((nodes) => nodes.map((node) => node.dataset.page)), ['1', '2', '3']);
  const sheet = await frame.locator('.if-sheet').first().boundingBox();
  assert.ok(Math.abs(sheet.width / sheet.height - 218 / 303) < 0.01, JSON.stringify(sheet));
  await w.locator('iframe.book-frame-thumbs[data-current][data-ready]').waitFor();
  assert.deepEqual(await w.locator('.spread-thumb .pages').allTextContents(), ['1', '2', '3']);

  // Book check previews address pages, with the bleed on all four sides.
  const page = await check({ preview: { target: { page: 2 }, maxEdge: 400 } });
  assert.equal(page.state, 'ready', JSON.stringify(page.diagnostics));
  assert.deepEqual([page.image.side, page.image.page, page.image.widthMm, page.image.heightMm], ['page', { number: 2 }, 210, 297]);
  const bleed = await check({ preview: { target: { spread: 'front' }, bounds: 'bleed', maxEdge: 400 } });
  assert.deepEqual([bleed.image.side, bleed.image.widthMm, bleed.image.heightMm], ['page', 218, 303]);
  const sideless = await check({ preview: { target: { spread: 'front', side: 'left' } } });
  assert.equal(sideless.diagnostics[0].code, 'preview-target-not-found');
  const sheetPreview = await check({ preview: { target: { spreads: ['front', 'jan', 'feb'] }, maxEdge: 600 } });
  assert.deepEqual(sheetPreview.image.cells.map(({ side, page }) => side + page.number), ['page1', 'page2', 'page3']);

  // The layout picker offers only page layouts.
  await w.locator('.spread-thumb').nth(1).click();
  await w.locator('iframe.book-frame-layouts[data-current][data-ready]').waitFor();
  assert.deepEqual(await w.locator('.layout-option').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))), ['Cover', 'Month']);

  // Adding inserts a page layout after the selected page; Undo removes it again.
  const add = w.getByRole('button', { name: 'Add', exact: true });
  assert.equal(await add.isDisabled(), false);
  await add.click();
  await w.waitForFunction(() => document.querySelectorAll('.spread-thumb').length === 4);
  assert.deepEqual(JSON.parse(await readFile(join(project, 'project.json'), 'utf8')).spreads.map(({ definition }) => definition), ['cover', 'month', 'cover', 'month']);
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelectorAll('.spread-thumb').length === 3);
  await w.locator(ready).waitFor();

  // Print export: one PDF page per unit, the trim box inset by the bleed on each edge.
  const print = await exported('Export print PDF', join(work, 'calendar.pdf'), 'Print PDF saved');
  assert.equal(print.getPageCount(), 3);
  for (const pdfPage of print.getPages()) {
    const media = pdfPage.getMediaBox(), trim = pdfPage.getTrimBox();
    near(media.width, points(218), 'page width'); near(media.height, points(303), 'page height');
    near(trim.x, points(5), 'trim left'); near(trim.y, points(3), 'trim bottom');
    near(trim.width, points(210), 'trim width'); near(trim.height, points(297), 'trim height');
  }

  // Switching to the facing format keeps the book but reports every page layout, and blocks print export.
  await w.locator('.template-controls > summary').click();
  const before = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await w.getByRole('combobox', { name: 'Format' }).selectOption('book');
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, before);
  const facing = await renderStatus();
  assert.equal(facing.state, 'ready');
  assert.deepEqual(facing.errors.filter(({ code }) => code === 'page-sequence').map(({ message }) => message), [
    'Spread 1 uses a single-page layout, but Book has facing pages. Switch it to a spread layout.',
    'Spread 2 uses a single-page layout, but Book has facing pages. Switch it to a spread layout.',
    'Spread 3 uses a single-page layout, but Book has facing pages. Switch it to a spread layout.',
  ]);
  const nativeExport = await popupAction(app, w, w.locator('.export-menu .action-menu-trigger'));
  assert.equal(nativeExport.find(({ label }) => label === 'Export for Print…').enabled, false);
  const proof = await exported('Export proof PDF', join(work, 'proof.pdf'), 'Proof PDF saved');
  assert.equal(proof.getPageCount(), 6);
  assert.equal(JSON.parse(await readFile(join(project, 'project.json'), 'utf8')).spreads[1].definition, 'month');
  console.log('ImageFlow single pages passed.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
