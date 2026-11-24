// The Start window as the library (#283), in the app, with two "Macs" (two profiles) on one folder backend: the
// desktop syncs a book; the laptop's Start window lists it as a book only on the remote, loads its title as the row
// shows, and Download makes a trusted copy where its save panel says; the laptop deletes it from sync, which
// asks first; the desktop's Start window then shows the book as removed from sync, with Keep Here Only and Sync Again,
// and Sync Again makes it a new book on the remote while the deleted one stays deleted.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, testBook, waitForPage } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/library-smoke-')));
const backend = join(work, 'Sync');
const book = join(work, 'Desktop', 'Field Notes.imageflow');
const downloads = join(work, 'Laptop Books');
await mkdir(backend);
await mkdir(downloads);
await mkdir(join(work, 'Desktop'));
const stderr = [];

/** A "Mac": its own profile, set up for the one folder backend (written as a settings file, as tests and development do). */
async function launch(name) {
  const profile = join(work, name);
  await mkdir(profile, { recursive: true });
  const settings = join(profile, 'settings.json');
  const saved = JSON.parse(await readFile(settings, 'utf8').catch(() => '{}'));
  await writeFile(settings, JSON.stringify({ ...saved, sync: { kind: 'folder', path: backend } }));
  const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  app.process().stderr.on('data', (bytes) => stderr.push(String(bytes)));
  // Questions are answered by their message; anything else takes the default button.
  await app.evaluate(({ dialog }) => {
    globalThis.prompts = [];
    globalThis.answers = {};
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.prompts.push(options.message);
      const answer = globalThis.answers[options.message];
      return { response: answer === undefined ? options.defaultId ?? 0 : options.buttons.indexOf(answer), checkboxChecked: false };
    };
  });
  return app;
}
const answer = (app, message, button) => app.evaluate((_, { message, button }) => { globalThis.answers[message] = button; }, { message, button });
const asked = (app) => app.evaluate(() => globalThis.prompts);
async function startWindow(app) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const page = app.windows().find((page) => page.url() === 'imageflow://editor/start');
    if (page) { page.setDefaultTimeout(30000); await page.waitForFunction(() => !!window.imageflow); return page; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The Start window did not open.');
}
async function nextEditor(app, before) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const page = app.windows().find((page) => !before.has(page) && page.url() === 'imageflow://editor/');
    if (page) { page.setDefaultTimeout(30000); await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor(); return page; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('No book opened.');
}
const statusIs = (page, state) => waitForPage(page, (state) => document.querySelector('.sync-status')?.getAttribute('data-state') === state, state);
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
/** What a book holds on the remote, as top-level names, with any hidden leftovers named so a failure shows them. */
const keys = async (bookId) => {
  const names = [];
  for (const name of await readdir(join(backend, 'books', bookId))) {
    if (name.startsWith('.')) continue;
    const inner = await readdir(join(backend, 'books', bookId, name)).catch(() => undefined);
    names.push(inner && !inner.some((child) => !child.startsWith('.')) ? name + ' (only ' + inner.join(', ') + ')' : name);
  }
  return names.sort();
};

let app;
try {
  // The desktop: a book from elsewhere, trusted once by Start Syncing, syncs.
  app = await launch('Desktop Profile');
  let editor = await testBook(app, book, true);
  await answer(app, 'Trust this book and sync it?', 'Trust and Sync');
  assert.deepEqual(await editor.evaluate(() => window.imageflow.syncAction('start')), { value: undefined });
  await statusIs(editor, 'in-sync');
  const bookId = (await current(editor)).project.bookId;
  assert.ok(bookId);
  // Its originals go up after the commit; the desktop quits once they have.
  for (let attempt = 0; !(await readdir(join(backend, 'books', bookId, 'originals')).catch(() => [])).some((name) => !name.startsWith('.')) ||
      await editor.locator('.sync-status[data-uploading]').count(); attempt++) {
    assert.ok(attempt < 600, 'the originals upload after the commit');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await closeApp(app);

  // The laptop: the book is only on the remote. Its row shows the title once it is in view, and Download makes a copy.
  app = await launch('Laptop Profile');
  let start = await startWindow(app);
  const row = start.locator('li.library-remote[data-book="' + bookId + '"]');
  await row.waitFor();
  await row.locator('strong', { hasText: 'Field Notes' }).waitFor();
  assert.match(await row.textContent(), /In Sync · changed/);
  const before = new Set(app.windows());
  // Its save panel names the book; the user picks the folder (#303).
  await app.evaluate(({ dialog }, folder) => { dialog.showSaveDialog = async (_owner, { defaultPath }) => ({ canceled: false, filePath: folder + '/' + defaultPath }); }, downloads);
  await row.getByRole('button', { name: 'Download…', exact: true }).click();
  editor = await nextEditor(app, before);
  assert.equal((await current(editor)).project.bookId, bookId);
  await statusIs(editor, 'in-sync');
  assert.deepEqual(await readdir(downloads), ['Field Notes.imageflow'], 'the copy is where the panel said');
  assert.equal((await asked(app)).includes('Trust this book and sync it?'), false, 'a downloaded book is trusted');
  await editor.close();
  start = await startWindow(app);
  // Now on this Mac: one row, synced, and no row for the remote copy.
  const local = start.locator('li[data-book="' + bookId + '"]');
  await waitForPage(start, (id) => document.querySelectorAll('li[data-book="' + id + '"]').length === 1 && document.querySelector('li[data-book="' + id + '"]')?.getAttribute('data-state') === 'synced', bookId);
  assert.match(await local.textContent(), /Synced/);
  // Delete from Sync asks, and Cancel changes nothing; Delete removes it from the remote and leaves the copy here.
  const question = 'Delete “Field Notes” from sync?';
  await answer(app, question, 'Cancel');
  assert.deepEqual(await start.evaluate((id) => window.imageflow.libraryAction({ action: 'delete', bookId: id }), bookId), { value: null });
  assert.ok((await asked(app)).includes(question));
  assert.ok((await keys(bookId)).includes('snapshots'));
  await answer(app, question, 'Delete from Sync');
  assert.deepEqual(await start.evaluate((id) => window.imageflow.libraryAction({ action: 'delete', bookId: id }), bookId), { value: null });
  assert.deepEqual(await keys(bookId), ['deleted.json']);
  await waitForPage(start, (id) => document.querySelector('li[data-book="' + id + '"]')?.getAttribute('data-state') === 'not-syncing', bookId);
  await closeApp(app);

  // The desktop again: its book shows as removed from sync, and Sync Again makes it a new book.
  app = await launch('Desktop Profile');
  start = await startWindow(app);
  const removed = start.locator('li[data-book="' + bookId + '"]');
  await waitForPage(start, (id) => document.querySelector('li[data-book="' + id + '"]')?.getAttribute('data-state') === 'removed', bookId);
  assert.match(await removed.textContent(), /Removed from sync/);
  await removed.getByRole('button', { name: 'Keep Here Only' }).waitFor();
  const opened = new Set(app.windows());
  await removed.getByRole('button', { name: 'Sync Again' }).click();
  editor = await nextEditor(app, opened);
  await statusIs(editor, 'in-sync');
  const again = (await current(editor)).project.bookId;
  assert.notEqual(again, bookId);
  assert.deepEqual(await keys(bookId), ['deleted.json'], 'the deleted book stays deleted');
  assert.ok((await keys(again)).includes('snapshots'));
  await closeApp(app);
  app = undefined;
  console.log('The library smoke passed: a book only on the remote, Download, Delete from Sync with its question, and Removed from sync with Sync Again.');
} catch (error) { console.error(stderr.join('\n')); throw error; }
finally { if (app) await closeApp(app); await rm(work, { recursive: true, force: true }); }
