import { packagedMacExecutable } from './mac-paths.mjs';
import { copySpreadStarter, testBook, menuAction, exportAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';
import { checkFlow } from './check-flow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'draft-'));
const project = join(work, 'Draft Photobook.imageflow');
const pdf = join(work, 'print.pdf');
const packaged = process.argv.includes('--packaged');
const read = async (file = 'project.json') => JSON.parse(await readFile(join(project, file), 'utf8'));
let app;
try {
  app = await _electron.launch({
    executablePath: packaged ? packagedMacExecutable(root) : electron,
    args: [...(packaged ? [] : [join(root, '.build/desktop')]), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' },
  });
  await copySpreadStarter(project);
  await app.evaluate(({ dialog }) => {
    const show = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (...args) => args.at(-1)?.message === 'Trust this book’s template?'
      ? Promise.resolve({ response: 0, checkboxChecked: false }) : show(...args);
  });
  const window = await testBook(app, project);
  window.setDefaultTimeout(15000);
  const button = (name) => window.getByRole('button', { name, exact: true });
  const frame = 'iframe.book-frame-book[data-current]';
  const preview = () => window.frameLocator(frame);
  const status = () => window.locator('.status').textContent();
  const chooseSave = (filePath) => app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, filePath);
  async function ready() {
    // A render can take longer than the default 15 s on a hosted Mac, most of all the first one, which prepares
    // previews of the full-size sample photos (the packaged release check timed out here).
    await window.waitForFunction((frame) => document.querySelector(frame + '[data-ready]') || document.querySelector('.status-error'), frame, { timeout: 60000 });
    // Trust approval can replace the current frame between the readiness message and this read.
    const value = await window.frameLocator(frame + '[data-ready]').locator('body').evaluate(() => window.imageflowRenderStatus);
    assert.equal(value?.state, 'ready', value?.message ?? await status());
    return value;
  }
  async function changed(action) {
    const before = await window.locator(frame).getAttribute('src');
    await action();
    await window.waitForFunction(({ frame, url }) => document.querySelector(frame)?.getAttribute('src') !== url ||
      document.querySelector('.status-error'), { frame, url: before });
    return ready();
  }
  async function saveState(action, expected) {
    await changed(action);
    assert.ok(expected(await read()));
  }
  async function dropFile(file, selector) {
    const bounds = await preview().locator('[data-spread="arriving"] ' + selector).boundingBox();
    assert.ok(bounds);
    await window.evaluate(() => {
      if (document.querySelector('#fixture-file')) return;
      const input = document.createElement('input');
      input.id = 'fixture-file';
      input.type = 'file';
      input.hidden = true;
      document.body.append(input);
    });
    await window.locator('#fixture-file').setInputFiles(file);
    await window.evaluate(({ x, y }) => {
      const data = new DataTransfer();
      data.items.add(document.querySelector('#fixture-file').files[0]);
      document.querySelector('main').dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data,
      }));
    }, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  }

  await chooseSave(project);

  const starter = await ready();
  assert.deepEqual(starter.errors, []);
  assert.equal(starter.pages, 32);
  assert.deepEqual(starter.flow['turning:body'], { part: 2, parts: 2, title: 'arrival.md' });
  assert.equal((await read()).title, 'Draft Photobook');
  await window.waitForFunction(() => /Book check · (No issues|\d)/.test(document.querySelector('.book-check-toggle')?.getAttribute('title') ?? '') &&
    !document.querySelector('.book-check-stale'));
  const bookCheck = await preview().locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(bookCheck?.state, 'ready');
  assert.deepEqual(bookCheck.errors, []);
  assert.deepEqual(bookCheck.warnings, [], bookCheck.warnings.map(({ where, message }) => where + ' · ' + message).join('\n'));

  await chooseSave(pdf);
  await exportAction(window);
  await window.waitForFunction(() => document.querySelector('.status-error') || document.querySelector('.status')?.textContent === 'PDF saved.', null, { timeout: 45000 });
  assert.equal(await status(), 'PDF saved.');
  const pages = (await PDFDocument.load(await readFile(pdf))).getPages();
  assert.equal(pages.length, 32);
  assert.equal(pages[0].getTrimBox().x, 0);
  assert.ok(pages.at(-1).getTrimBox().x > 0);

  await window.locator('.template-controls > summary').click();
  const oldTheme = (await read()).params.theme;
  await saveState(() => window.getByRole('radio', { name: 'Dark', exact: true }).click(), (data) => data.params.theme === 'dark');
  await saveState(() => button('Undo').click(), (data) => data.params.theme === oldTheme);
  await saveState(() => button('Redo').click(), (data) => data.params.theme === 'dark');
  await saveState(() => window.getByRole('checkbox', { name: 'Page numbers', exact: true }).uncheck(), (data) => data.params.showPageNumbers === false);

  await window.getByRole('button', { name: 'Pages 6–7 · Photo and story' }).click();
  await window.locator('[data-spread="arriving"][aria-current="page"]').waitFor();
  const photo = join(root, 'sample/shared/photos/shore.jpg');
  const markdown = join(work, 'drop.md');
  await writeFile(markdown, 'A small story imported through the canvas.\n');
  await changed(() => dropFile(photo, '[data-box="hero"]'));
  // Importing adds a library source before the separate placement save completes.
  await window.waitForFunction(async () => /^ph-/.test((await window.imageflow.currentProject()).value.project.spreads[3].boxes.hero.photo ?? ''));
  await ready();
  const photoId = (await read()).spreads[3].boxes.hero.photo;
  assert.match(photoId, /^ph-/);
  assert.ok((await read('photos.json'))[photoId]);
  // Selecting a source shows its Inspector instead of the spread's.
  await window.locator('.source-item[data-id="' + photoId + '"]').click();
  await window.locator('.source-inspector').waitFor();
  assert.equal(await window.getByRole('radiogroup', { name: 'Layout' }).count(), 0);
  const caption = window.getByLabel('Caption', { exact: true });
  await changed(async () => { await caption.fill('Imported coast'); await caption.blur(); });
  assert.equal((await read('photos.json'))[photoId].caption, 'Imported coast');
  await changed(() => button('Undo').click());
  assert.equal((await read('photos.json'))[photoId].caption, undefined);
  await changed(() => dropFile(markdown, '[data-box="body"]'));
  await window.waitForFunction(async () => /^tx-/.test((await window.imageflow.currentProject()).value.project.spreads[3].boxes.body.text ?? ''));
  await ready();
  const textId = (await read()).spreads[3].boxes.body.text;
  assert.match(textId, /^tx-/);
  assert.match(await preview().locator('[data-spread="arriving"] [data-box="body"]').textContent(), /imported through the canvas/);
  await changed(async () => {
    const file = (await read()).texts[textId];
    await writeFile(join(project, file), 'The file was edited outside ImageFlow.\n');
  });
  assert.match(await preview().locator('[data-spread="arriving"] [data-box="body"]').textContent(), /edited outside ImageFlow/);
  await changed(async () => {
    const path = join(project, 'template/styles.css');
    const css = await readFile(path, 'utf8');
    await writeFile(path, css + '\n.field-book .reading { color: rgb(12, 40, 80); }\n');
  });
  assert.equal(await preview().locator('[data-spread="arriving"] [data-box="body"]').evaluate((el) => getComputedStyle(el).color), 'rgb(12, 40, 80)');

  await saveState(() => window.getByRole('radio', { name: 'Panorama', exact: true }).click(), (data) =>
    data.spreads[3].definition === 'panorama' && data.spreads[3].boxes.hero.photo === photoId && data.spreads[3].boxes.body.text === textId);
  await saveState(() => window.getByRole('radio', { name: 'Photo and story', exact: true }).click(), (data) =>
    data.spreads[3].boxes.body.text === textId);

  await window.locator('.spread-thumb[aria-current="page"]').focus();
  await saveState(() => menuAction(app, 'Duplicate Spread'), (data) => data.spreads.length === 18);
  await saveState(() => menuAction(app, 'Move Spread Down'), (data) => data.spreads[4].id === 'headlands');
  await saveState(() => menuAction(app, 'Delete Spread'), (data) => data.spreads.length === 17);
  await saveState(() => button('Add').click(), (data) => data.spreads.length === 18);

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await menuAction(app, 'Open project…');
  await ready();
  assert.equal(await (await app.browserWindow(window)).evaluate((window) => window.getTitle()), 'Draft Photobook');
  assert.equal((await read()).spreads.length, 18);
  if (!packaged) await checkFlow(app, root);
  console.log('ImageFlow draft workflow passed' + (packaged ? ' (packaged).' : '.'));
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
