import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { copySample } from '../desktop/sample-book.mjs';
import { closeApp, menuAction, testBook } from './ui-actions.mjs';

// The shipped starter, rather than a synthetic page template: real pictures, text flow, folios and export.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'starter-pages-'));
const folder = join(work, 'Starter Pages.imageflow');
const screenshot = '/tmp/imageflow-starter-pages.png';
const manual = join(root, '.build', 'testing', 'Starter Pages.imageflow');
let app;
try {
  await copySample(join(root, 'sample/starter'), folder);
  const readBook = async () => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8'));
  let original = await readBook();
  assert.equal(original.schemaVersion, 2);
  const split = original.spreads.filter(sheet => sheet.split);
  assert.equal(split.length, 11, 'All independent page combinations, including contents, use page pairs');
  let arrival = original.spreads.find(sheet => sheet.id === 'arriving');
  assert.ok(arrival?.split);
  const textSide = ['left', 'right'].find(side => arrival.pages[side]?.boxes?.body?.text);
  const photoSide = ['left', 'right'].find(side => arrival.pages[side]?.boxes?.hero?.photo);
  assert.ok(textSide && photoSide && textSide !== photoSide);
  app = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const w = await testBook(app, folder);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'imageflow://editor/')?.setContentSize(1440, 1000));
  const ready = 'iframe.book-frame-book[data-current][data-ready]';
  await w.locator(ready).waitFor({ state: 'attached' });
  const frame = w.frameLocator(ready);
  const inspector = w.getByRole('complementary', { name: 'Inspector', exact: true });
  const status = () => frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  const initial = await status();
  original = (await w.evaluate(async () => window.imageflow.currentProject())).value.project;
  arrival = original.spreads.find(sheet => sheet.id === 'arriving');
  assert.equal(initial.state, 'ready', JSON.stringify(initial));
  assert.deepEqual(initial.errors, [], 'The unedited starter has no Book check errors: ' + JSON.stringify(initial.errors));
  assert.equal(initial.pages, 32);
  assert.deepEqual(Object.entries(initial.template.spreads).filter(([, layout]) => layout.span === 'spread').map(([id]) => id).sort(),
    ['map', 'opener', 'panorama'], 'Only designs that cross the fold remain spread templates');
  for (const id of ['contents', 'mapPage', 'pictures']) {
    assert.equal(initial.template.spreads[id].span, 'page', id + ' is independently reusable on either page');
  }
  const contentsPagePair = original.spreads.find(sheet => sheet.id === 'contents');
  assert.equal(contentsPagePair.pages.left.definition, 'photo');
  assert.equal(contentsPagePair.pages.right.definition, 'contents');
  assert.ok(await frame.locator('[data-spread="contents"] [data-if-page="right"] .contents li').count() > 0,
    'The page-local contents design still lists the book anchors');
  for (const sheet of original.spreads) {
    assert.ok(initial.template.spreads[sheet.definition], 'The sheet has a declared remembered layout: ' + sheet.id);
    for (const state of Object.values(sheet.pages ?? {})) if (state.definition) {
      assert.ok(initial.template.spreads[state.definition], 'The page has a declared layout: ' + state.definition);
    }
  }
  assert.equal(await frame.locator('[data-if-page]').count(), split.length * 2);
  for (const sheet of split) for (const side of ['left', 'right']) {
    const state = sheet.pages[side];
    if (!state?.definition) continue;
    assert.equal(initial.template.spreads[state.definition].span, 'page');
    assert.equal(await frame.locator('[data-spread="' + sheet.id + '"] [data-if-page="' + side + '"] .if-page').count(), 1);
  }
  assert.ok(initial.anchors.some(anchor => anchor.spread === 'arriving' && anchor.side === textSide), 'Story anchor belongs to its text page');
  const pictureText = await frame.locator('[data-spread="closing"]').innerText();
  assert.match(pictureText, /Pictures/);
  assert.match(pictureText, /Page/);
  assert.ok(initial.flow['arriving:' + textSide + ':body'], 'The starter text flow has a page-scoped key');

  console.log('Starter warnings: ' + JSON.stringify(initial.warnings));
  assert.deepEqual(initial.warnings, [], 'The unedited starter has no Book check warnings');
  console.log('Starter render passed: 32 pages, 11 split sheets, three genuine spread designs, clean findings, anchors and picture list.');
  const rerendered = async action => {
    const before = await w.locator(ready).getAttribute('src');
    await action();
    await w.waitForFunction(before => {
      const current = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return current && current.getAttribute('src') !== before;
    }, before);
  };
  const selectSide = async (id, side) => {
    await w.locator('.sheet-label[data-canvas-spread="' + id + '"]').scrollIntoViewIfNeeded();
    const bounds = await frame.locator('[data-spread="' + id + '"] .if-sheet').boundingBox();
    assert.ok(bounds);
    await w.mouse.click(bounds.x + bounds.width * (side === 'left' ? .2 : .8), bounds.y + 4);
    await inspector.locator('details > summary').first().filter({ hasText: 'Templates' }).waitFor();
  };
  // A shared full-spread photo still requires selecting the opposite page before opening its editor.
  const beforePageSelection = await readBook();
  await selectSide('headlands', 'left');
  const panorama = await frame.locator('[data-spread="headlands"] [data-box="hero"]').boundingBox();
  assert.ok(panorama);
  for (const side of ['right', 'left']) {
    const x = panorama.x + panorama.width * (side === 'left' ? .25 : .75), y = panorama.y + panorama.height * .5;
    await w.mouse.click(x, y);
    await w.locator('.active-spread-page[data-page="' + side + '"]').waitFor();
    assert.equal(await w.locator('.crop-editor, .edit-popover, .element-editor').count(), 0,
      'Clicking the opposite half selects it without editing the shared image');
    await w.mouse.click(x, y);
    await w.locator('.crop-editor').waitFor();
    await w.keyboard.press('Escape');
    await w.locator('.crop-editor').waitFor({ state: 'detached' });
  }
  assert.deepEqual(await readBook(), beforePageSelection, 'Selection and opening crop mode do not change the book');
  console.log('Full-spread photo: changing halves selects first; the next click edits.');
  await selectSide('arriving', textSide);
  const editHeading = inspector.getByRole('button', { name: 'Edit Heading', exact: true });
  await editHeading.click();
  const heading = w.locator('.edit-popover').getByRole('textbox', { name: 'Heading', exact: true });
  await heading.waitFor();
  await rerendered(async () => { await heading.fill('Testing the page editor'); await heading.press('Tab'); });
  await w.keyboard.press('Escape');
  const editedArrival = (await readBook()).spreads.find(sheet => sheet.id === 'arriving');
  assert.equal(editedArrival.pages[textSide].params.heading, 'Testing the page editor');
  assert.deepEqual(editedArrival.pages[photoSide], arrival.pages[photoSide]);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads.find(sheet => sheet.id === 'arriving'), arrival);

  console.log('Page heading edit and Undo passed.');
  await selectSide('arriving', photoSide);
  const photoDefinition = initial.template.spreads[arrival.pages[photoSide].definition];
  await inspector.getByRole('button', { name: 'Edit ' + photoDefinition.boxes.hero.label, exact: true }).click();
  await w.locator('.crop-editor').waitFor();
  await rerendered(() => w.getByRole('button', { name: 'Zoom in', exact: true }).click());
  const cropArrival = (await readBook()).spreads.find(sheet => sheet.id === 'arriving');
  assert.ok(cropArrival.pages[photoSide].boxes.hero.crops?.[arrival.pages[photoSide].definition]?.zoom > 1);
  assert.deepEqual(cropArrival.pages[textSide], arrival.pages[textSide]);
  await w.keyboard.press('Escape');
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads.find(sheet => sheet.id === 'arriving'), arrival);

  await selectSide('arriving', textSide);
  await rerendered(() => menuAction(app, 'Swap Pages'));
  const swapped = (await readBook()).spreads.find(sheet => sheet.id === 'arriving');
  assert.deepEqual(swapped.pages.left, arrival.pages.right);
  assert.deepEqual(swapped.pages.right, arrival.pages.left);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads.find(sheet => sheet.id === 'arriving'), arrival);

  console.log('Page crop, swap and Undo passed.');
  // A real page family's variants update one state and leave the facing page byte-for-byte intact.
  const gridSheet = original.spreads.find(sheet => sheet.split && ['left', 'right'].some(side =>
    initial.template.spreads[sheet.pages[side]?.definition]?.family === 'pageGrid'));
  assert.ok(gridSheet, 'The sample shows the page-grid family');
  const gridSide = ['left', 'right'].find(side => initial.template.spreads[gridSheet.pages[side]?.definition]?.family === 'pageGrid');
  await selectSide(gridSheet.id, gridSide);
  const picker = inspector.frameLocator('iframe.element-editor-frame');
  await picker.getByRole('radio', { name: '3 × 3', exact: true }).waitFor();
  const variant = gridSheet.pages[gridSide].definition === 'gridPage9' ? '2 × 2' : '3 × 3';
  await rerendered(() => picker.getByRole('radio', { name: variant, exact: true }).click());
  const changedGrid = (await readBook()).spreads.find(sheet => sheet.id === gridSheet.id);
  assert.notEqual(changedGrid.pages[gridSide].definition, gridSheet.pages[gridSide].definition);
  assert.deepEqual(changedGrid.pages[gridSide === 'left' ? 'right' : 'left'], gridSheet.pages[gridSide === 'left' ? 'right' : 'left']);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads.find(sheet => sheet.id === gridSheet.id), gridSheet);

  console.log('Page grid family and Undo passed.');
  // Genuine spread designs remain available to merge page pairs and Undo restores both page states.
  await selectSide('arriving', photoSide);
  await rerendered(() => inspector.getByRole('radio', { name: 'Panorama', exact: true }).click());
  assert.equal((await readBook()).spreads.find(sheet => sheet.id === 'arriving').split, undefined);
  await rerendered(() => menuAction(app, 'Undo Book Edit'));
  assert.deepEqual((await readBook()).spreads.find(sheet => sheet.id === 'arriving'), arrival);

  console.log('Merge and Undo passed.');
  for (const format of ['square', 'landscape']) {
    if (format === 'landscape') {
      const settings = w.locator('.document-settings');
      if (!await settings.getAttribute('open')) await settings.locator('summary').click();
      await rerendered(() => settings.getByRole('combobox').first().selectOption(format));
    }
    const current = await status();
    assert.equal(current.template.formatId, format);
    console.log(format + ' warnings: ' + JSON.stringify(current.warnings));
    assert.deepEqual(current.warnings, [], format + ' Book check warnings');
    assert.deepEqual(current.errors, [], format + ' errors: ' + JSON.stringify(current.errors));
    const output = join(work, 'Starter-' + format + '.pdf');
    await app.evaluate(({ dialog }, output) => {
      globalThis.starterExportPrompts = [];
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
      dialog.showMessageBox = async (_owner, options) => { globalThis.starterExportPrompts.push(options); return { response: 0 }; };
    }, output);
    const exported = await w.evaluate(async () => {
      const { value } = await window.imageflow.currentProject();
      return window.imageflow.exportBook(value.id);
    });
    assert.ok(exported.value, JSON.stringify(exported));
    assert.deepEqual(exported.value.errors, [], format + ' PDF findings');
    assert.equal((await app.evaluate(() => globalThis.starterExportPrompts)).length, 0, 'Valid starter export needs no override');
    assert.equal((await PDFDocument.load(await readFile(output))).getPageCount(), 32);
    console.log(format + ' 32-page clean PDF passed.');
  }

  await selectSide('arriving', textSide);
  await w.screenshot({ path: screenshot });
  const savedBeforeClose = await readBook();
  await closeApp(app);
  app = undefined;
  app = await _electron.launch({ executablePath: electron,
    args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const reopened = await testBook(app, folder);
  await reopened.locator(ready).waitFor({ state: 'attached' });
  const reopenedStatus = await reopened.frameLocator(ready).locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(reopenedStatus.state, 'ready', JSON.stringify(reopenedStatus));
  assert.equal(reopenedStatus.pages, 32);
  console.log('Reopened warnings: ' + JSON.stringify(reopenedStatus.warnings));
  assert.deepEqual(reopenedStatus.errors, []);
  assert.deepEqual(reopenedStatus.warnings, []);
  assert.deepEqual(await readBook(), savedBeforeClose, 'Closing and reopening preserves all page states exactly');
  console.log('Save, close and reopen preserves the schema-2 book and clean 32-page render.');
  await mkdir(join(root, '.build', 'testing'), { recursive: true });
  const manualExists = await access(manual).then(() => true, () => false);
  if (!manualExists) await copySample(join(root, 'sample/starter'), manual);
  console.log('Starter pages passed: real page pairs, anchors/picture list, page text/crop/family edits, swap/merge with Undo, square/landscape checks and 32-page PDFs.');
  console.log('Manual book: ' + manual);
  console.log('Screenshot: ' + screenshot);
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
