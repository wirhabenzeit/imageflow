import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { testBook } from './ui-actions.mjs';

// Template pictures in New Book (#117): the calendar's own preview image, cropped to its format; renders of opening
// spreads saved on disk, so a second launch shows them on first paint; a render made when a template is imported; and
// the Book check warning for a preview image of the wrong shape.
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
const exists = (path) => stat(path).then(() => true, () => false);
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

  // The photobook has no image of its own: its opening spread is rendered once and saved with the app's caches.
  const photobook = (await entries(picker)).find(({ id }) => id === 'imageflow-starter');
  assert.equal(photobook.image, undefined);
  const saved = join(profile, 'Cache', 'template-previews', photobook.hash + '.jpg');
  await until(() => exists(saved), 'the saved photobook render');
  assert.equal((await sharp(saved).metadata()).width, 320);

  // Importing a template renders it at once and keeps the render beside it in the library.
  const travel = join(work, 'travel');
  await cp(join(root, 'sample/calendar/template'), travel, { recursive: true });
  const source = await readFile(join(travel, 'index.tsx'), 'utf8');
  await writeFile(join(travel, 'index.tsx'), source.replace("id: 'imageflow-calendar',", "id: 'travel-calendar',").replace("label: 'Wall calendar',", "label: 'Travel calendar',"));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const imported = await picker.evaluate((path) => window.imageflow.importTemplates([path]), travel);
  assert.equal(imported.value?.[0]?.status, 'imported', JSON.stringify(imported));
  await until(async () => (await readdir(join(library, 'travel-calendar')).catch(() => [])).some((name) => /^preview-[0-9a-f]{64}\.jpg$/.test(name)),
    'the render of the imported template');
  await app.close();

  // After a restart, New Book shows the saved render on first paint, without rendering again.
  app = await launch();
  ({ picker } = await newBook(app));
  const rendered = picker.getByRole('option', { name: /Photobook/ }).locator('img');
  await rendered.waitFor();
  assert.match(await rendered.getAttribute('src'), /\/template-picture\/[0-9a-f]{64}\/render$/);
  await until(() => rendered.evaluate((image) => image.complete && image.naturalWidth > 0), 'the saved render');
  await app.close();

  // A damaged saved render is made again rather than leaving an empty tile.
  await writeFile(saved, 'not a picture');
  app = await launch();
  ({ picker } = await newBook(app));
  const remade = picker.getByRole('option', { name: /Photobook/ }).locator('img');
  await until(() => remade.evaluate((image) => image.src.startsWith('data:') && image.complete && image.naturalWidth > 0).catch(() => false), 'the render made again');
  await until(async () => (await sharp(saved).metadata().catch(() => ({}))).width === 320, 'the saved render replaced');
  await app.close();

  // A preview image of another shape is a Book check warning; a missing one too.
  app = await launch();
  await app.firstWindow();
  const book = join(work, 'Calendar.imageflow');
  await cp(join(root, 'sample/calendar'), book, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
  await writeFile(join(book, 'template', 'preview.jpg'), await sharp({ create: { width: 400, height: 400, channels: 3, background: '#335' } }).jpeg().toBuffer());
  const page = await testBook(app, book);
  const frame = 'iframe.book-frame-book[data-ready]';
  await page.locator(frame).first().waitFor();
  const id = new URL(await page.locator(frame).first().getAttribute('src')).pathname.split('/').at(-1);
  const codes = async () => {
    const result = await page.evaluate((id) => window.imageflow.checkBook(id, {}), id);
    assert.ok(result.value, JSON.stringify(result.error));
    return result.value.diagnostics.filter(({ code }) => code?.startsWith('template-preview'));
  };
  const [aspect] = await codes();
  assert.equal(aspect.code, 'template-preview-aspect');
  assert.equal(aspect.severity, 'warning');
  assert.match(aspect.message, /400 × 400 pixels/);
  assert.match(aspect.suggestion, /1200 × \d+ pixels/);
  await writeFile(join(book, 'template', 'preview.jpg'), 'not an image');
  await until(async () => (await codes())[0]?.code === 'template-preview-invalid', 'the invalid preview warning');
  console.log('Template previews passed.');
} catch (error) {
  console.error('Template previews failed:', error);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
