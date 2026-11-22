import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';
import { copySample } from '../desktop/sample-book.mjs';
import { closeApp, popupAction, testBook, undoBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'cover-'));
const folder = join(work, 'Cover.imageflow');
const projectFile = join(folder, 'project.json');
const readProject = async () => JSON.parse(await readFile(projectFile, 'utf8'));
const ready = '.canvas iframe.book-frame-book[data-current][data-ready]';
const coverReady = '.cover-preview-sheet[data-ready]';
const points = (mm) => Math.round(mm * 72 / 25.4 * 100) / 100;
let app, client;

try {
  await copySample(join(root, 'sample/starter'), folder);
  const project = await readProject();
  const page = (id, definition) => ({ id, definition, params: {}, boxes: {}, elements: {} });
  project.spreads = [page('start', 'title'), ...Array.from({ length: 15 }, (_, i) => page('spread-' + i, 'panorama')),
    page('end', 'credits')];
  await writeFile(projectFile, JSON.stringify(project));
  const templateFile = join(folder, 'template/index.tsx');
  const template = await readFile(templateFile, 'utf8');
  const withLegacyLimit = template.replace('blurbJacket: blurb.format,',
    'blurbJacket: { ...blurb.format, output: { ...blurb.format.output, maximumFileSize: { pages: 500_000_000, cover: 1024 } } },');
  assert.notEqual(withLegacyLimit, template);
  await writeFile(templateFile, withLegacyLimit);
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const window = await testBook(app, folder);
  await window.locator(ready).waitFor();

  const connection = await window.evaluate(() => window.imageflow.mcpSettings(true));
  client = new Client({ name: 'Cover smoke', version: '1' });
  await client.connect(new StdioClientTransport({ ...connection.value.launch, stderr: 'pipe' }));
  async function call(name, args = {}, error = false) {
    const result = await client.callTool({ name, arguments: args }, { timeout: 110000 });
    const data = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.equal(!!result.isError, error, JSON.stringify(data));
    return { data, result };
  }
  const handle = (await call('list_projects')).data.projects.find((item) => item.folder === folder).project;
  const plain = (await call('check_book', { project: handle })).data;
  assert.equal(plain.render.cover, undefined);
  assert.ok(plain.diagnostics.every(({ location }) => !location?.cover));

  await window.getByRole('radio', { name: 'Cover', exact: true }).click();
  await window.locator(coverReady + '[data-width-mm="623"]').waitFor();
  assert.equal(await window.getByRole('group', { name: 'Spreads', exact: true }).count(), 0);
  const picker = window.getByLabel('Cover layout', { exact: true });
  await picker.selectOption('wrapPhoto');
  const heading = window.getByRole('textbox', { name: 'Cover title', exact: true });
  await window.frameLocator(coverReady + ' iframe[data-ready]').locator('[data-box="hero"]').waitFor();
  await window.evaluate(() => {
    const sheet = document.querySelector('.cover-preview-sheet');
    const transitions = [];
    const observer = new MutationObserver(() => {
      const pending = sheet.querySelector('iframe[data-current]:not([data-ready])');
      if (!pending) return;
      const shown = sheet.querySelector('iframe[data-ready]:not(.book-frame-pending)');
      transitions.push(!!shown && getComputedStyle(shown).visibility === 'visible');
    });
    observer.observe(sheet, { childList: true, subtree: true, attributes: true });
    window.coverTransitions = () => { observer.disconnect(); return transitions; };
  });
  await heading.fill('A physical cover');
  await heading.press('Tab');
  const artwork = window.frameLocator(coverReady + ' iframe[data-ready]').locator('[data-edit="title"]');
  await artwork.filter({ hasText: 'A physical cover' }).waitFor();
  const transitions = await window.evaluate(() => window.coverTransitions());
  assert.ok(transitions.length > 0 && transitions.every(Boolean), 'A ready cover stays visible while the replacement loads.');
  assert.equal((await readProject()).schemaVersion, 3);
  assert.equal((await readProject()).cover.params.title, 'A physical cover');
  await window.locator('.book-check-toggle').click();
  await window.locator('.book-check-heading').filter({ hasText: 'This cover' }).waitFor();
  await window.locator('.book-check-panel .issue-current').filter({ hasText: 'Cover photo is empty.' }).waitFor();
  await window.locator('.book-check-list:not(.book-check-stale)').waitFor();
  await window.keyboard.press('Escape');
  const photos = JSON.parse(await readFile(join(folder, 'photos.json'), 'utf8'));
  const photo = Object.keys(photos)[0];
  await window.getByRole('combobox', { name: 'Choose photo for Cover photo' }).selectOption(photo);
  await window.getByRole('combobox', { name: 'Replace photo in Cover photo' }).waitFor();
  await window.frameLocator(coverReady + ' iframe[data-ready]').locator('[data-box="hero"] img').waitFor();
  assert.equal((await readProject()).cover.boxes.hero.photo, photo);
  await window.getByRole('button', { name: 'Guides', exact: true }).click();
  assert.equal(await window.locator('.cover-guides .gutter-guide').count(), 2);

  let destination = 0;
  async function exportPdf(name, pageCount, width, height, trimWidth, trimHeight, expectLegacyLimit = false) {
    const filePath = join(work, 'proof-' + destination++ + '.pdf');
    await app.evaluate(({ dialog }, filePath) => {
      globalThis.coverExportDetails = [];
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      dialog.showMessageBox = async (_, options) => {
        globalThis.coverExportDetails.push(options.detail ?? '');
        return { response: 1 };
      };
    }, filePath);
    // A name clicks the export icon, which exports the shown view; a function exports another way, such as the menu.
    if (typeof name === 'function') await name(); else await window.getByRole('button', { name, exact: true }).click();
    await window.waitForFunction(() => document.querySelector('.status-bar .status')?.textContent.includes('PDF saved.'));
    // The status may still say so from the export before: this one has saved once its file is there.
    for (let wait = Date.now(); !await readFile(filePath).then(() => true, () => false); await new Promise((resolve) => setTimeout(resolve, 100))) {
      if (Date.now() - wait > 60000) throw new Error('No PDF was saved at ' + filePath);
    }
    await window.waitForFunction(() => document.querySelector('.status-bar .status')?.textContent.includes('PDF saved.'));
    assert.equal((await app.evaluate(() => globalThis.coverExportDetails)).some((detail) => /the format allows 0 MB/.test(detail)), expectLegacyLimit);
    const pdf = await PDFDocument.load(await readFile(filePath));
    assert.equal(pdf.getPageCount(), pageCount);
    const first = pdf.getPage(0);
    for (const box of [first.getMediaBox(), first.getBleedBox()]) {
      assert.equal(Math.round(box.width * 100) / 100, width);
      assert.equal(Math.round(box.height * 100) / 100, height);
    }
    assert.equal(Math.round(first.getTrimBox().width * 100) / 100, trimWidth);
    assert.equal(Math.round(first.getTrimBox().height * 100) / 100, trimHeight);
  }
  await exportPdf('Export Cover PDF…', 1, points(623), points(316), points(603), points(296));

  const sources = async () => (await call('inspect_book', { project: handle, view: 'sources' })).data.items;
  assert.ok((await sources()).find(({ id }) => id === photo).usage.some(({ cover }) => cover));
  const interior = (await call('check_book', { project: handle, preview: { target: { spread: 'start' }, maxEdge: 256 } })).data;
  assert.equal(interior.render.cover, undefined);
  assert.ok(interior.diagnostics.every(({ location }) => !location?.cover));
  const checked = (await call('check_book', { project: handle, cover: true })).data;
  assert.equal(checked.render.cover.status, 'ready');
  assert.equal(checked.render.counts.units, 0);
  const context = (await call('get_authoring_context', { project: handle })).data;
  assert.ok(context.template.coverFormats.blurbJacket);
  const operations = [{ op: 'insert_spread', after: 'spread-14', definition: 'panorama', ref: 'more' }];
  const draft = (await call('check_book', { project: handle, expectedRevision: context.revision, draft: { operations },
    preview: { target: { cover: true, box: 'hero' }, maxEdge: 256 }, inspect: { cover: true, box: 'hero' } })).data;
  assert.equal(draft.image.cover, true, JSON.stringify(draft));
  assert.equal(draft.image.interiorPages, 34);
  assert.equal(draft.image.previewPages, 28);
  assert.equal(draft.render.inspection.items[0].cover, true);
  assert.equal((await readProject()).spreads.length, 17);
  const synthetic = (await call('check_book', { project: handle,
    fixtures: { cover: { layout: 'wrapPhoto', format: 'blurbJacket', pages: 51 }, cases: ['empty'] } })).data;
  assert.equal(synthetic.fixtures.cover.interiorPages, 51);
  assert.equal(synthetic.fixtures.coverage.rendered, 1);
  assert.ok(synthetic.fixtures.diagnostics.some(({ code }) => code === 'cover-page-count'));
  assert.equal((await readProject()).cover.params.title, 'A physical cover');

  const commit = async (operations, key) => {
    const current = (await call('inspect_book', { project: handle, view: 'summary' })).data;
    const result = (await call('apply_project_changes', { project: handle, expectedRevision: current.revision,
      idempotencyKey: key, label: 'Cover smoke ' + key, operations })).data;
    assert.equal(result.committed, true, JSON.stringify(result));
    return result;
  };
  await commit([...operations, { op: 'insert_spread', after: '$more', definition: 'panorama' }], 'whitewall-36');
  await window.locator(coverReady + '[data-width-mm="624.5"]').waitFor();
  await window.getByRole('radio', { name: 'Content', exact: true }).click();
  await exportPdf('Export Content PDF…', 36, points(293), points(296), points(290), points(290));
  // The menu beside the export icon exports the other PDF: it shows the cover, then exports it once checked.
  await exportPdf(() => popupAction(app, window, window.locator('.export-menu .action-menu-trigger'), 'Export Cover PDF…'),
    1, points(624.5), points(316), points(604.5), points(296));
  assert.equal(await window.getByRole('radio', { name: 'Cover', exact: true }).isChecked(), true, 'the cover is shown while it exports');

  const blurb = await commit([{ op: 'select_format', format: 'blurbJacket' },
    ...Array.from({ length: 7 }, () => ({ op: 'insert_spread', after: 'spread-14', definition: 'panorama' })),
    { op: 'set_parameter', scope: 'cover', key: 'backFlapText', value: 'Back flap proof' },
    { op: 'set_parameter', scope: 'cover', key: 'frontFlapText', value: 'Front flap proof' },
    { op: 'set_crop', cover: true, box: 'hero', centerX: .5, centerY: .5, zoom: 1.25 }], 'blurb-50');
  assert.equal(blurb.affectedCover, true);
  const getCover = async () => (await call('inspect_book', { project: handle, view: 'cover' })).data.cover;
  const at50 = await getCover();
  assert.equal(at50.interiorPages, 50);
  assert.equal(at50.artwork.boxes.hero.crops.wrapPhoto.zoom, 1.25);
  assert.equal(points(at50.geometry.regions.backFlap.width), 284);
  await window.frameLocator(coverReady + ' iframe[data-ready]').locator('[data-edit="frontFlapText"]').filter({ hasText: 'Front flap proof' }).waitFor();
  await commit(operations, 'blurb-52');
  const at52 = await getCover();
  assert.equal(at52.interiorPages, 52);
  assert.equal(points(at52.geometry.regions.frontFlap.width), 280);
  await window.locator(coverReady).waitFor();
  await exportPdf('Export Cover PDF…', 1, 2377, 882, 2359, 864, true);

  await commit([{ op: 'select_format', format: 'landscape' }], 'landscape');
  await window.getByRole('radiogroup', { name: 'Book view', exact: true }).waitFor({ state: 'detached' });
  await window.getByRole('button', { name: 'Export PDF…', exact: true }).waitFor();
  assert.equal((await readProject()).cover.params.title, 'A physical cover');
  const retained = await getCover();
  assert.equal(retained.status, 'unavailable');
  assert.equal(retained.artwork.params.title, 'A physical cover');
  assert.ok((await sources()).find(({ id }) => id === photo).usage.every(({ cover }) => !cover));
  await undoBook(window);
  await window.getByRole('radio', { name: 'Cover', exact: true }).click();
  await window.frameLocator(coverReady + ' iframe[data-ready]').locator('[data-edit="title"]').filter({ hasText: 'A physical cover' }).waitFor();

  const calendar = join(work, 'Calendar.imageflow');
  await copySample(join(root, 'sample/calendar'), calendar);
  const calendarWindow = await testBook(app, calendar);
  await calendarWindow.locator(ready).waitFor();
  assert.equal(await calendarWindow.getByRole('radiogroup', { name: 'Book view', exact: true }).count(), 0);
  const calendarProject = (await call('list_projects')).data.projects.find((item) => item.folder === calendar).project;
  const unavailable = await call('check_book', { project: calendarProject, preview: { target: { cover: true } } }, true);
  assert.ok(unavailable.data.diagnostics.some(({ code }) => code === 'cover-unavailable'));
  console.log('Cover editing, PDF geometry, MCP draft and saved edits, format switching, Undo, and calendar opt-out passed.');
} finally {
  await client?.close();
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
