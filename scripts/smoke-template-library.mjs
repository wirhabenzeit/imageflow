import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// The template library: import from Settings, live updates in an open New Book picker, removal, a failed import,
// creating books from a library template and from the built-in starter without its sample, and Save Template to Library.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'template-library-'));
const library = join(work, 'Templates');
const travel = join(work, 'travel');
const broken = join(work, 'broken');
await cp(join(root, 'sample/starter/template'), travel, { recursive: true });
const source = await readFile(join(travel, 'index.tsx'), 'utf8');
const retitled = (version) => source.replace("id: 'imageflow-starter',", "id: 'travel',").replace(/version: '[^']+',/, `version: '${version}',`)
  .replace("label: 'Photobook',", "label: 'Travel journal',");
await writeFile(join(travel, 'index.tsx'), retitled('1.0.0'));
await cp(join(root, 'sample/starter/template'), broken, { recursive: true });
await writeFile(join(broken, 'index.tsx'), source.replace('spreads: ({ spread }) => ({', 'spreads: ({ spread }) => ({ broken: 1,'));

const settingsURL = 'imageflow://editor/settings';
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_TEMPLATES: library } });
const choose = (paths) => app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, paths);
const answer = (response) => app.evaluate(({ dialog }, response) => {
  globalThis.messages = [];
  dialog.showMessageBox = async (...args) => { globalThis.messages.push(args.at(-1)); return { response }; };
}, response);
const saveAs = (filePath) => app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
// Hidden render windows come and go while templates are checked, so windows are found by URL.
async function windowAt(url, known = new Set()) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const page = app.windows().find((page) => !known.has(page) && page.url() === url);
    if (page) { page.setDefaultTimeout(30000); return page; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('No window at ' + url);
}
const menu = (label) => app.evaluate(({ Menu }, label) => Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? [])
  .find((item) => item.label === label).click(), label);
try {
  const start = await app.firstWindow();
  start.setDefaultTimeout(30000);
  await start.locator('.start-window').waitFor();

  // An open New Book picker follows changes made in Settings.
  const created = start.evaluate(() => window.imageflow.openProject('new'));
  const picker = await windowAt('imageflow://editor/new');
  await picker.getByRole('heading', { name: 'Choose a template' }).waitFor();
  await picker.getByRole('radio', { name: /Photobook/ }).waitFor();
  assert.equal(await picker.getByRole('radio').count(), 1);

  await menu('Manage Templates…');
  const settings = await windowAt(settingsURL);
  const list = settings.getByRole('list', { name: 'Templates' });
  await list.getByText('Photobook').waitFor();
  assert.equal(await settings.getByRole('tab', { name: 'Templates' }).getAttribute('aria-selected'), 'true');

  await choose([travel, broken]);
  await settings.getByRole('button', { name: 'Import…' }).click();
  await settings.getByText('Travel journal 1.0.0 was added to the library.').waitFor();
  await settings.getByText(/could not be imported/).waitFor();
  await list.getByText('Travel journal', { exact: true }).waitFor();
  assert.deepEqual(await readdir(library), ['travel'], 'a failed import leaves nothing in the library');
  await picker.getByRole('radio', { name: /Travel journal/ }).waitFor();

  // Export a library entry to share it: the file holds the template's files.
  const shared = join(work, 'Travel journal.imageflow-template');
  await saveAs(shared);
  await settings.getByRole('button', { name: 'Export Travel journal' }).click();
  await settings.getByText('Exported to ' + shared + '.').waitFor();
  const archive = await readFile(shared);
  assert.equal(archive.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(archive.includes('index.tsx'));

  // Removal asks first, then the template disappears from the picker too.
  await answer(1);
  await settings.getByRole('button', { name: 'Move Travel journal to the Trash' }).click();
  await settings.waitForFunction(() => globalThis.document.querySelector('.template-settings button:not(:disabled)'));
  assert.deepEqual(await readdir(library), ['travel'], 'Cancel keeps the template');
  await answer(0);
  await settings.getByRole('button', { name: 'Move Travel journal to the Trash' }).click();
  await settings.getByText('Moved to the Trash. Books made from it are not affected.').waitFor();
  await picker.getByRole('radio', { name: /Travel journal/ }).waitFor({ state: 'detached' });
  assert.deepEqual(await readdir(library).catch(() => []), []);

  // Import the shared file from the picker itself, then create a book from it: the template's opening spreads, no content.
  await choose([shared]);
  await picker.getByRole('button', { name: 'Import Templates…' }).click();
  await picker.getByRole('radio', { name: /Travel journal/ }).check();
  assert.equal(await picker.getByRole('checkbox').count(), 0, 'only a template with a sample book offers it');
  await picker.getByText('The book starts with 3 spreads from the template.').waitFor();
  const book = join(work, 'Journey.imageflow');
  await saveAs(book);
  await picker.getByRole('button', { name: 'Continue…' }).click();
  assert.deepEqual(await created, { value: null });
  const project = JSON.parse(await readFile(join(book, 'project.json'), 'utf8'));
  assert.equal(project.title, 'Journey');
  assert.equal(project.template.id, 'travel');
  assert.equal(project.template.version, '1.0.0');
  assert.match(project.template.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(project.spreads.map(({ definition }) => definition), ['title', 'story', 'closing']);
  assert.deepEqual(JSON.parse(await readFile(join(book, 'photos.json'), 'utf8')), {});
  for (const folder of ['photos', 'texts', 'files']) assert.ok((await stat(join(book, folder))).isDirectory());
  await assert.rejects(stat(join(book, 'template', 'library.json')));
  assert.equal(await readFile(join(book, 'template', 'index.tsx'), 'utf8'), retitled('1.0.0'));
  const editor = await windowAt('imageflow://editor/');
  await editor.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  assert.equal(await editor.locator('.spread-thumb').count(), 3);

  // Export Template… writes the book's own template.
  const fromBook = join(work, 'From book.imageflow-template');
  await saveAs(fromBook);
  await editor.bringToFront();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'imageflow://editor/').focus());
  await menu('Export Template…');
  for (let start = Date.now(); !(await stat(fromBook).catch(() => undefined)) && Date.now() - start < 10000;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await readFile(fromBook), archive, 'the book has the same template, so the same file');

  // Save Template to Library: the unchanged template is already there; a new version replaces it.
  await answer(0);
  await menu('Save Template to Library');
  await app.evaluate(() => new Promise((resolve) => { const wait = () => globalThis.messages.length ? resolve() : setTimeout(wait, 50); wait(); }));
  assert.equal((await app.evaluate(() => globalThis.messages))[0].message, 'Travel journal 1.0.0 is already in the library.');
  await writeFile(join(book, 'template', 'index.tsx'), retitled('1.1.0'));
  await answer(0);
  await menu('Save Template to Library');
  await app.evaluate(() => new Promise((resolve) => { const wait = () => globalThis.messages.length ? resolve() : setTimeout(wait, 50); wait(); }));
  assert.equal((await app.evaluate(() => globalThis.messages))[0].message, 'Travel journal 1.1.0 replaced the earlier version in the library.');
  await list.getByText('1.1.0').waitFor();

  // Removing the library entry never affects the book.
  await answer(0);
  await settings.getByRole('button', { name: 'Move Travel journal to the Trash' }).click();
  await settings.getByText('Moved to the Trash. Books made from it are not affected.').waitFor();
  await editor.evaluate(() => window.imageflow.openProject('reload'));
  await editor.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  assert.equal(await editor.locator('.spread-thumb').count(), 3);

  // The built-in starter without its sample book: the template's opening spreads and no photos.
  const second = editor.evaluate(() => window.imageflow.openProject('new'));
  const modal = await windowAt('imageflow://editor/new', new Set([picker]));
  await modal.getByRole('radio', { name: /Photobook/ }).check();
  await modal.getByRole('checkbox', { name: 'Include sample photos, texts and spreads' }).uncheck();
  const plain = join(work, 'Plain.imageflow');
  await saveAs(plain);
  await modal.getByRole('button', { name: 'Continue…' }).click();
  assert.deepEqual(await second, { value: null });
  const starter = JSON.parse(await readFile(join(plain, 'project.json'), 'utf8'));
  assert.equal(starter.template.id, 'imageflow-starter');
  assert.deepEqual(starter.spreads.map(({ definition }) => definition), ['title', 'story', 'closing']);
  assert.deepEqual(JSON.parse(await readFile(join(plain, 'photos.json'), 'utf8')), {});

  // Opening a template file from Finder imports it.
  await answer(0);
  await app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault() {} }, path), shared);
  await app.evaluate(() => new Promise((resolve) => { const wait = () => globalThis.messages.length ? resolve() : setTimeout(wait, 50); wait(); }));
  assert.equal((await app.evaluate(() => globalThis.messages))[0].message, 'Travel journal 1.0.0 was added to the library.');
  await list.getByText('Travel journal', { exact: true }).waitFor();
  console.log('Template library smoke test passed.');
} finally {
  await app.close();
}
