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
const project = join(work, 'Draft Photobook');
const pdf = join(work, 'print.pdf');
const packaged = process.argv.includes('--packaged');
const read = async (file = 'project.json') => JSON.parse(await readFile(join(project, file), 'utf8'));
let app;
try {
  app = await _electron.launch({
    executablePath: packaged ? join(root, 'out', 'ImageFlow-darwin-' + process.arch, 'ImageFlow.app', 'Contents/MacOS/ImageFlow') : electron,
    args: [...(packaged ? [] : [join(root, '.build/desktop')]), '--user-data-dir=' + join(work, 'profile')],
  });
  const window = await app.firstWindow();
  window.setDefaultTimeout(15000);
  const button = (name) => window.getByRole('button', { name, exact: true });
  const preview = () => window.frameLocator('iframe');
  const status = () => window.locator('.status').textContent();
  const chooseSave = (filePath) => app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, filePath);
  async function ready() {
    await window.waitForFunction(() => document.querySelector('iframe') &&
      (!document.querySelector('.preview-message') || document.querySelector('.status-error')));
    const value = await preview().locator('body').evaluate(() => window.imageflowRenderStatus);
    assert.equal(value?.state, 'ready', value?.message ?? await status());
    return value;
  }
  async function changed(action) {
    const before = await window.locator('iframe').getAttribute('src');
    await action();
    await window.waitForFunction((url) => document.querySelector('iframe')?.getAttribute('src') !== url ||
      document.querySelector('.status-error'), before);
    return ready();
  }
  async function saveState(action, expected) {
    await changed(action);
    assert.ok(expected(await read()));
  }
  async function dropFile(file, selector) {
    const bounds = await preview().locator('.if-fit ' + selector).boundingBox();
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
  await button('New project…').click();
  const starter = await ready();
  assert.deepEqual(starter.errors, []);
  assert.equal(starter.pages, 28);
  assert.deepEqual(starter.flow['turning:body'], { part: 2, parts: 3, title: 'arrival.md' });
  assert.equal((await read()).title, 'Draft Photobook');

  await chooseSave(pdf);
  await button('Export print PDF').click();
  await window.waitForFunction(() => document.querySelector('.status-error') || document.querySelector('.status')?.textContent === 'Print PDF saved.', null, { timeout: 45000 });
  assert.equal(await status(), 'Print PDF saved.');
  const pages = (await PDFDocument.load(await readFile(pdf))).getPages();
  assert.equal(pages.length, 28);
  assert.equal(pages[0].getTrimBox().x, 0);
  assert.ok(pages.at(-1).getTrimBox().x > 0);

  const title = window.getByLabel('Book title');
  await saveState(async () => { await title.fill('My first book'); await title.blur(); }, (data) => data.title === 'My first book');
  await saveState(() => button('Undo').click(), (data) => data.title === 'Draft Photobook');
  await saveState(() => button('Redo').click(), (data) => data.title === 'My first book');
  await saveState(() => window.getByLabel('Page numbers').uncheck(), (data) => data.params.showPageNumbers === false);

  await changed(() => window.getByRole('button', { name: 'Photo and story 2–3' }).click());
  const photo = join(root, 'sample/starter/photos/shore.jpg');
  const markdown = join(work, 'drop.md');
  await writeFile(markdown, 'A small story imported through the canvas.\n');
  await changed(() => dropFile(photo, '[data-box="hero"]'));
  const photoId = (await read()).spreads[1].boxes.hero.photo;
  assert.match(photoId, /^ph-/);
  assert.ok((await read('photos.json'))[photoId]);
  const caption = window.getByLabel('Caption', { exact: true });
  await changed(async () => { await caption.fill('Imported coast'); await caption.blur(); });
  assert.equal((await read('photos.json'))[photoId].caption, 'Imported coast');
  await changed(() => button('Undo').click());
  assert.equal((await read('photos.json'))[photoId].caption, undefined);
  await changed(() => dropFile(markdown, '[data-box="body"]'));
  const textId = (await read()).spreads[1].boxes.body.text;
  assert.match(textId, /^tx-/);
  assert.match(await preview().locator('.if-fit [data-box="body"]').textContent(), /imported through the canvas/);
  await changed(async () => {
    const file = (await read()).texts[textId];
    await writeFile(join(project, file), 'The file was edited outside ImageFlow.\n');
  });
  assert.match(await preview().locator('.if-fit [data-box="body"]').textContent(), /edited outside ImageFlow/);
  await changed(async () => {
    const path = join(project, 'template/styles.css');
    const css = await readFile(path, 'utf8');
    await writeFile(path, css + '\n.field-book .reading { color: rgb(12, 40, 80); }\n');
  });
  assert.equal(await preview().locator('.if-fit [data-box="body"]').evaluate((el) => getComputedStyle(el).color), 'rgb(12, 40, 80)');

  await saveState(() => window.getByLabel('Layout', { exact: true }).selectOption('panorama'), (data) =>
    data.spreads[1].definition === 'panorama' && data.spreads[1].boxes.hero.photo === photoId && data.spreads[1].archive.story.boxes.body.text === textId);
  await saveState(() => window.getByLabel('Layout', { exact: true }).selectOption('story'), (data) =>
    data.spreads[1].boxes.body.text === textId);

  await saveState(() => button('Duplicate').click(), (data) => data.spreads.length === 16);
  await saveState(() => window.getByRole('button', { name: 'Move spread down' }).click(), (data) => data.spreads[2].id === 'headlands');
  await saveState(() => button('Delete').click(), (data) => data.spreads.length === 15);
  await saveState(() => button('Add').click(), (data) => data.spreads.length === 16);

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await changed(() => button('Open project…').click());
  assert.equal(await window.locator('h1').textContent(), 'My first book');
  assert.equal((await read()).spreads.length, 16);
  if (!packaged) await checkFlow(app, root);
  console.log('ImageFlow draft workflow passed' + (packaged ? ' (packaged).' : '.'));
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
