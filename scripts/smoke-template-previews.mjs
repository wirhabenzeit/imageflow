import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { closeApp, testBook } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

// Template pictures in New Book (#117): the built-in templates' own preview images, cropped to their format; a render
// of the opening spread made when a template without an image is imported, saved on disk so a second launch shows it
// on first paint; and the Book check warning for a preview image of the wrong shape.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'template-previews-smoke-'));
const library = join(work, 'Templates');
const profile = join(work, 'profile');
const launch = () => _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_TEMPLATES: library } });
const until = async (check, what) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ' + what);
};
async function newBook(app) {
  const start = await app.firstWindow();
  start.setDefaultTimeout(30000);
  await start.locator('.start-window').waitFor();
  void start.evaluate(() => window.imageflow.openProject('new')).catch(() => {});
  let picker;
  await until(() => (picker = app.windows().find((page) => page.url() === 'imageflow://editor/new')), 'New Book');
  picker.setDefaultTimeout(30000);
  await picker.getByRole('option', { name: /Wall calendar/ }).waitFor();
  return { start, picker };
}
const entries = (page) => page.evaluate(async () => (await window.imageflow.library()).value);

let app = await launch();
try {
  let { picker } = await newBook(app);
  // The calendar shows its own image, cropped to fill the shape of its default format rather than letterboxed.
  const calendar = (await entries(picker)).find(({ id }) => id === 'imageflow-calendar');
  assert.equal(calendar.image, true);
  const cover = picker.getByRole('option', { name: /Wall calendar/ }).locator('img');
  await cover.waitFor();
  assert.equal(await cover.getAttribute('class'), 'template-cover');
  assert.match(await cover.getAttribute('src'), /^imageflow:\/\/editor\/template-picture\/[0-9a-f]{64}\/image$/);
  await until(() => cover.evaluate((image) => image.complete && image.naturalWidth > 0), 'the calendar preview image');
  const box = await cover.boundingBox();
  assert.ok(Math.abs(box.width / box.height - calendar.aspect) < 0.03, 'the tile has the format\'s shape: ' + box.width + ' × ' + box.height);

  // So does the photobook, with its title photo instead of a render of its typographic title page.
  const photobook = (await entries(picker)).find(({ id }) => id === 'imageflow-starter');
  assert.equal(photobook.image, true);
  const photobookCover = picker.getByRole('option', { name: /Photobook/ }).locator('img');
  await photobookCover.waitFor();
  assert.match(await photobookCover.getAttribute('src'), /^imageflow:\/\/editor\/template-picture\/[0-9a-f]{64}\/image$/);

  // Importing a template without an image renders its opening spread at once and keeps the render beside it in the
  // library: here the photobook without its preview (or map sites, so nothing waits for permission).
  const travel = join(work, 'travel');
  await cp(join(root, 'sample/starter/template'), travel, { recursive: true });
  const source = await readFile(join(travel, 'index.tsx'), 'utf8');
  const plain = source.replace("id: 'imageflow-starter',", "id: 'travel-book',").replace("label: 'Photobook',", "label: 'Travel book',")
    .replace("  preview: './preview.jpg',\n", '').replace('  network: [mapOrigin, elevationOrigin],\n', '');
  assert.ok(!plain.includes('preview:') && !plain.includes('network:'));
  await writeFile(join(travel, 'index.tsx'), plain);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const imported = await picker.evaluate((path) => window.imageflow.importTemplates([path]), travel);
  assert.equal(imported.value?.[0]?.status, 'imported', JSON.stringify(imported));
  const renderFile = async () => (await readdir(join(library, 'travel-book')).catch(() => [])).find((name) => /^preview-[0-9a-f]{64}\.jpg$/.test(name));
  await until(renderFile, 'the render of the imported template');
  const saved = join(library, 'travel-book', await renderFile());
  const renderWidth = (await sharp(saved).metadata()).width;
  assert.ok(renderWidth > 0);
  await app.close();

  // After a restart, New Book shows the saved render on first paint, without rendering again.
  app = await launch();
  ({ picker } = await newBook(app));
  const rendered = picker.getByRole('option', { name: /Travel book/ }).locator('img');
  await rendered.waitFor();
  assert.match(await rendered.getAttribute('src'), /\/template-picture\/[0-9a-f]{64}\/render$/);
  await until(() => rendered.evaluate((image) => image.complete && image.naturalWidth > 0), 'the saved render');
  await app.close();

  // A damaged saved render is made again rather than leaving an empty tile.
  await writeFile(saved, 'not a picture');
  app = await launch();
  ({ picker } = await newBook(app));
  const remade = picker.getByRole('option', { name: /Travel book/ }).locator('img');
  await until(() => remade.evaluate((image) => image.src.startsWith('data:') && image.complete && image.naturalWidth > 0).catch(() => false), 'the render made again');
  await until(async () => (await sharp(saved).metadata().catch(() => ({}))).width === renderWidth, 'the saved render replaced');
  await app.close();

  // A preview image of another shape is a Book check warning; a missing one too.
  app = await launch();
  await app.firstWindow();
  const book = join(work, 'Calendar.imageflow');
  await copySample(join(root, 'sample', 'calendar'), book);
  await writeFile(join(book, 'template', 'preview.jpg'), await sharp({ create: { width: 400, height: 400, channels: 3, background: '#335' } }).jpeg().toBuffer());
  const page = await testBook(app, book);
  const frame = 'iframe.book-frame-book[data-ready]';
  await page.locator(frame).first().waitFor();
  // The book as it is now.
  const codes = async () => {
    const result = await page.evaluate(async () => window.imageflow.checkBook((await window.imageflow.currentProject()).value.id, {}));
    assert.ok(result.value, JSON.stringify(result.error));
    return result.value.diagnostics.filter(({ code }) => code?.startsWith('template-preview'));
  };
  const [aspect] = await codes();
  assert.equal(aspect.code, 'template-preview-aspect');
  assert.equal(aspect.severity, 'warning');
  assert.match(aspect.message, /400 × 400 pixels/);
  assert.match(aspect.suggestion, /1200 × \d+ pixels/);
  await writeFile(join(book, 'template', 'preview.jpg'), 'not an image');
  // The changed template reloads the book; a check of a revision replaced meanwhile is tried again.
  await until(async () => (await codes().catch(() => []))[0]?.code === 'template-preview-invalid', 'the invalid preview warning');
  console.log('Template previews passed.');
} catch (error) {
  console.error('Template previews failed:', error);
  process.exitCode = 1;
} finally {
  await closeApp(app);
}
