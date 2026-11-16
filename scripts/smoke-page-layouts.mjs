import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { copySample } from '../desktop/sample-book.mjs';
import { closeApp, exportAction, menuAction, testBook } from './ui-actions.mjs';

// ADR 0009 phase 3: one sheet, two independently editable pages and a blank facing page, through the real app.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'page-layouts-'));
const folder = join(work, 'Pages.imageflow');
let app;
try {
  await copySample(join(root, 'sample/starter'), folder);
  await writeFile(join(folder, 'template/index.tsx'), `import { defineTemplate, mm, p, Page, Spread, printFormat } from 'imageflow';
import './styles.css';
import type { RenderContext } from 'imageflow';
const full = (ctx: RenderContext) => <Spread style={{ fontFamily: 'Field Serif' }}><ctx.Text parameter="heading" rect={ctx.geometry.page('left', 'safe')} /></Spread>;
const settings = { hidden: p.boolean({ label: 'Spread-only option', default: false }), heading: p.string({ label: 'Heading', default: '' }) };
export default defineTemplate({ id: 'page-smoke', version: '1', contract: 1,
  format: printFormat({ label: 'Pages', trim: { width: mm(100), height: mm(100) }, bleed: { all: mm(3), binding: mm(0) },
    safe: mm(8), ends: 'inside-covers', pageCount: { min: 4, max: 4, step: 2 } }),
  layoutFamilies: { full: { label: 'Full layouts', picker: { component: ({ variants, current, choose }) => <div>{variants.map(variant => <button key={variant.id} type="button" aria-pressed={current === variant.id} onClick={() => choose(variant.id)}>{variant.label}</button>)}</div> } } },
  spreads: ({ spread, page }) => ({ full: spread({ label: 'Full', family: 'full', variant: { kind: 'full' }, parameters: settings, render: full }),
    other: spread({ label: 'Other', family: 'full', variant: { kind: 'other' }, parameters: settings, render: full }),
    text: page({ label: 'Text', parameters: { heading: p.string({ label: 'Heading', default: '' }) },
      render: ctx => <Page style={{ fontFamily: 'Field Serif' }}>
        <ctx.Text parameter="heading" rect={ctx.geometry.page('safe')} />
      </Page> }) }) });`);
  const page = (heading) => ({ definition: 'text', params: { heading }, boxes: {}, elements: {} });
  const sheet = (id, pages) => ({ id, definition: 'full', split: true, params: {}, boxes: {}, elements: {}, pages });
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 2, title: 'Pages', template: { id: 'page-smoke', version: '1' },
    spreads: [sheet('pair', { left: page('Left'), right: page('Right') }), sheet('blank', { left: page('Alone') })] }));
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const w = await testBook(app, folder);
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  await w.waitForSelector(ready, { state: 'attached' });
  const frame = w.frameLocator(ready);
  const status = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.deepEqual(status.errors, []);
  assert.equal(status.pages, 4);
  assert.equal(await frame.locator('.if-sheet').count(), 2);
  assert.equal(await frame.locator('[data-if-page]').count(), 4);
  assert.equal(await frame.locator('[data-spread="pair"] [data-if-page="left"] [data-edit="heading"]').textContent(), 'Left');
  assert.equal(await frame.locator('[data-spread="pair"] [data-if-page="right"] [data-edit="heading"]').textContent(), 'Right');
  assert.equal(await frame.locator('[data-spread="blank"] [data-if-page="right"] .if-page').count(), 0);
  const inspector = w.getByRole('complementary', { name: 'Inspector', exact: true });
  assert.match(await inspector.getByRole('note').textContent(), /shown as pages/);
  assert.equal(await inspector.getByRole('checkbox', { name: 'Spread-only option', exact: true }).isDisabled(), true);
  assert.equal(await inspector.getByRole('region', { name: 'On this spread' }).count(), 0);
  const remembered = inspector.getByRole('radio', { name: 'Full layouts', exact: true });
  assert.equal(await remembered.getAttribute('aria-checked'), 'false');
  // The normal page popover edits only the clicked side.
  const text = frame.locator('[data-spread="pair"] [data-if-page="right"] [data-edit="heading"]');
  const box = await text.boundingBox();
  assert.ok(box);
  await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const input = w.locator('.edit-popover').getByRole('textbox', { name: 'Heading', exact: true });
  const beforeSave = await w.locator(ready).getAttribute('src');
  await input.fill('Edited right');
  await input.press('Enter');
  await w.keyboard.press('Escape');
  await w.waitForFunction((before) => {
    const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('src') !== before;
  }, beforeSave);
  const saved = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
  assert.equal(saved.spreads[0].pages.right.params.heading, 'Edited right');
  assert.equal(saved.spreads[0].pages.left.params.heading, 'Left');
  assert.deepEqual(saved.spreads[0].params, {});
  const pdfPath = join(work, 'Pages.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdfPath);
  await exportAction(w);
  await w.waitForFunction(() => document.querySelector('.status-error') || (document.querySelector('.status')?.textContent ?? '').startsWith('PDF saved'), null, { timeout: 120000 });
  assert.match(await w.locator('.status').textContent(), /^PDF saved/);
  assert.equal((await PDFDocument.load(await readFile(pdfPath))).getPageCount(), 4);
  const rerendered = async (action) => {
    const before = await w.locator(ready).getAttribute('src');
    await action();
    await w.waitForFunction((before) => {
      const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return frame && frame.getAttribute('src') !== before;
    }, before);
  };
  // The remembered spread layout is selectable and merges instead of being marked current.
  await rerendered(() => remembered.click());
  let merged = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
  assert.equal(merged.spreads[0].split, undefined);
  assert.equal(merged.spreads[0].params.heading, 'Left');
  assert.equal(await inspector.getByRole('checkbox', { name: 'Spread-only option', exact: true }).isDisabled(), false);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.match(await inspector.getByRole('note').textContent(), /shown as pages/);
  // The family's custom picker also allows its remembered variant to merge.
  const family = inspector.frameLocator('iframe.element-editor-frame');
  await family.getByRole('button', { name: 'Full', exact: true }).waitFor();
  assert.equal(await family.getByRole('button', { name: 'Full', exact: true }).getAttribute('aria-pressed'), 'false');
  await rerendered(() => family.getByRole('button', { name: 'Full', exact: true }).click());
  merged = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
  assert.equal(merged.spreads[0].split, undefined);
  assert.equal(merged.spreads[0].params.heading, 'Left');
  console.log('Page layouts: independent editing, disabled hidden Inspector controls, remembered-layout/family merging, and four-page PDF passed.');
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
