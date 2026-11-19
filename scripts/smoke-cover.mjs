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
import { closeApp, testBook, undoBook } from './ui-actions.mjs';

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
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const window = await testBook(app, folder);
  await window.locator(ready).waitFor();
  await window.getByRole('radio', { name: 'Cover', exact: true }).click();
  await window.locator(coverReady + '[data-width-mm="623"]').waitFor();
  assert.equal(await window.getByRole('group', { name: 'Spreads', exact: true }).count(), 0);
  const picker = window.getByLabel('Cover layout', { exact: true });
  await picker.selectOption('wrapPhoto');
  const heading = window.getByRole('textbox', { name: 'Cover title', exact: true });
  await heading.fill('A physical cover');
  await heading.press('Tab');
  const artwork = window.frameLocator(coverReady + ' iframe').locator('[data-edit="title"]');
  await artwork.filter({ hasText: 'A physical cover' }).waitFor();
  assert.equal((await readProject()).schemaVersion, 3);
  assert.equal((await readProject()).cover.params.title, 'A physical cover');
  const photos = JSON.parse(await readFile(join(folder, 'photos.json'), 'utf8'));
  const photo = Object.keys(photos)[0];
  await window.getByRole('combobox', { name: 'Choose photo for Cover photo' }).selectOption(photo);
  await window.frameLocator(coverReady + ' iframe').locator('[data-box="hero"] img').waitFor();
  assert.equal((await readProject()).cover.boxes.hero.photo, photo);
  await window.getByRole('button', { name: 'Guides', exact: true }).click();
  assert.equal(await window.locator('.cover-guides .gutter-guide').count(), 2);

  let destination = 0;
  async function exportPdf(name, pageCount, width, height, trimWidth, trimHeight) {
    const filePath = join(work, 'proof-' + destination++ + '.pdf');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, filePath);
    await window.getByRole('button', { name, exact: true }).click();
    await window.waitForFunction(() => document.querySelector('.status-bar .status')?.textContent.includes('PDF saved.'));
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
  await window.getByRole('radio', { name: 'Cover', exact: true }).click();

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
  await window.frameLocator(coverReady + ' iframe').locator('[data-edit="frontFlapText"]').filter({ hasText: 'Front flap proof' }).waitFor();
  await commit(operations, 'blurb-52');
  const at52 = await getCover();
  assert.equal(at52.interiorPages, 52);
  assert.equal(points(at52.geometry.regions.frontFlap.width), 280);
  await window.locator(coverReady).waitFor();
  await exportPdf('Export Cover PDF…', 1, 2377, 882, 2359, 864);

  await commit([{ op: 'select_format', format: 'landscape' }], 'landscape');
  await window.getByRole('radiogroup', { name: 'Book view', exact: true }).waitFor({ state: 'detached' });
  await window.getByRole('button', { name: 'Export PDF…', exact: true }).waitFor();
  assert.equal((await readProject()).cover.params.title, 'A physical cover');
  await undoBook(window);
  await window.getByRole('radio', { name: 'Cover', exact: true }).click();
  await window.frameLocator(coverReady + ' iframe').locator('[data-edit="title"]').filter({ hasText: 'A physical cover' }).waitFor();

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
