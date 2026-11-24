// Automatic sync (#284), end to end in the app with the folder backend (`IMAGEFLOW_SYNC_FOLDER=1`) and a short idle wait
// (`IMAGEFLOW_SYNC_IDLE_MS`, honoured only by a development build): an edit on one copy goes up by itself once the book is
// idle, and the other copy takes it when its window comes to the front, without a click; a pull waits while a Markdown
// editor of the book is open and runs once it closed; an edit during an automatic push (slowed down here with
// `IMAGEFLOW_SYNC_TEST_SLOW_MS`) is kept without an error and goes up afterwards; and a book pushes what changed when it
// closes. The two "Macs" are
// two windows of one app with one backend: the book and its download from the Start window.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, testBook, waitForPage } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/sync-auto-smoke-')));
const desktopBook = join(work, 'Desktop', 'Auto Book.imageflow');
const folder = join(work, 'Sync Folder');
await mkdir(join(work, 'Desktop'));
await mkdir(join(work, 'Laptop'));
await mkdir(folder);
await mkdir(join(work, 'profile'));
// The backend is set up already, and no book waits to be chosen: books that sync here sync by themselves.
await writeFile(join(work, 'profile', 'settings.json'), JSON.stringify({ sync: { kind: 'folder', path: folder } }));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_SYNC_FOLDER: '1', IMAGEFLOW_SYNC_IDLE_MS: '1500', IMAGEFLOW_SYNC_TEST_SLOW_MS: '1500' } });
const stderr = [];
app.process().stderr.on('data', (bytes) => stderr.push(String(bytes)));
const until = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
};
const windowId = (page) => app.browserWindow(page).then((window) => window.evaluate((window) => window.id));
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
const ready = (page) => page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor({ timeout: 30000 });
const setCaption = async (page, id, text) => {
  for (let attempt = 0; ; attempt++) {
    const saved = await page.evaluate(async ({ id, text }) => {
      const { value } = await window.imageflow.currentProject();
      value.photoIndex[id].caption = text;
      return window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
    }, { id, text });
    if (saved.value) return;
    assert.ok(attempt < 100 && /finishing another operation|changed/.test(saved.error ?? ''), 'the save: ' + JSON.stringify(saved));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const caption = async (page, id) => (await current(page))?.photoIndex[id]?.caption;
const statusIs = (page, state) => waitForPage(page, (state) => document.querySelector('.sync-status')?.getAttribute('data-state') === state, state);
// Hidden windows never take the focus natively: the window's focus event is sent as macOS would send it.
const focus = (page) => windowId(page).then((id) => app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id).emit('focus'); }, id));
const tips = async (bookId) => {
  const directory = join(folder, 'books', bookId, 'snapshots');
  const headers = await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
  const parents = new Set(headers.flatMap((header) => header.parents));
  return headers.filter((header) => !parents.has(header.commitId));
};

try {
  // The desktop's book is its own: its template differs from the built-in one, so it asks once and is trusted.
  await copySample(join(root, 'sample/starter'), desktopBook);
  const index = join(desktopBook, 'template', 'index.tsx');
  await writeFile(index, (await readFile(index, 'utf8')) + '\n// This Mac’s own template.\n');
  await app.evaluate(({ dialog }) => {
    globalThis.syncPrompts = [];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.syncPrompts.push(options.message);
      return { response: 0, checkboxChecked: false };
    };
  });
  const desktop = await testBook(app, desktopBook);
  await ready(desktop);
  for (let attempt = 0; ; attempt++) {
    const started = await desktop.evaluate(() => window.imageflow.syncAction('start'));
    if (!('error' in started)) break;
    assert.ok(attempt < 100 && /finishing another operation|not trusted/.test(started.error), JSON.stringify(started));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await statusIs(desktop, 'in-sync');
  const bookId = (await current(desktop)).project.bookId;

  // The laptop downloads the book from the Start window, which asks where.
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, join(work, 'Laptop', 'Laptop Book.imageflow'));
  const start = app.windows().find((page) => page.url() === 'imageflow://editor/start');
  const before = new Set(app.windows());
  assert.deepEqual(await start.evaluate((id) => window.imageflow.libraryAction({ action: 'download', bookId: id }), bookId), { value: null });
  let laptop;
  await until(() => (laptop = app.windows().find((page) => !before.has(page) && page.url() === 'imageflow://editor/')), 'Download opens the book');
  await ready(laptop);
  await statusIs(laptop, 'in-sync');

  // Edit on the desktop: it pushes by itself once idle. The laptop comes to the front and fast-forwards, no click.
  const first = (await tips(bookId))[0].commitId;
  await setCaption(desktop, 'shore', 'Edited on the desktop');
  await until(async () => (await tips(bookId))[0]?.commitId !== first, 'the desktop pushed by itself after its idle wait');
  await statusIs(desktop, 'in-sync');
  await until(async () => { await focus(laptop); return await caption(laptop, 'shore') === 'Edited on the desktop'; }, 'the laptop fast-forwarded when it came to the front');
  await statusIs(laptop, 'in-sync');

  // A Markdown editor of the book is open on the laptop: a pull would reset its Undo, so it waits until it closes.
  for (let attempt = 0; ; attempt++) {
    const opened = await laptop.evaluate(() => window.imageflow.showMarkdown({ id: 'arrival' }));
    if (!opened.code) { assert.ok('value' in opened, opened.error); break; }
    assert.ok(attempt < 50, 'the Markdown editor opens');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let markdown;
  await until(() => (markdown = app.windows().find((page) => page.url() === 'imageflow://editor/markdown')), 'the Markdown editor opens');
  const pushedBefore = (await tips(bookId))[0].commitId;
  await setCaption(desktop, 'shore', 'While the laptop edits text');
  await until(async () => (await tips(bookId))[0]?.commitId !== pushedBefore, 'the desktop pushed again');
  await until(async () => { await focus(laptop); return await laptop.evaluate(() => document.querySelector('.sync-status')?.getAttribute('data-state') === 'behind'); },
    'the laptop sees the change');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(await caption(laptop, 'shore'), 'Edited on the desktop', 'no pull while the Markdown editor is open');
  await app.browserWindow(markdown).then((window) => window.evaluate((window) => window.close()));
  await until(async () => await caption(laptop, 'shore') === 'While the laptop edits text', 'the pull ran once the editor closed');

  // An editor that opens after an automatic pull began, and before it is applied (the 1.5 s it waits here), holds it back
  // just the same: the pull is asked again as it is applied.
  const pushedAgain = (await tips(bookId))[0].commitId;
  await setCaption(desktop, 'shore', 'While the laptop begins to edit');
  await until(async () => (await tips(bookId))[0]?.commitId !== pushedAgain, 'the desktop pushed once more');
  await until(async () => { await focus(laptop); return await laptop.evaluate(() => document.querySelector('.sync-status')?.getAttribute('data-state') === 'syncing'); }, 'the laptop begins to pull');
  const editing = (textEditing) => laptop.evaluate((textEditing) => window.imageflow.setBookMenuState({ document: true, enabled: {}, editing: false, textEditing, writable: true, busy: false,
    saving: false, undo: null, redo: null, checking: false, checkProblems: 0 }), textEditing);
  await editing(true);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal(await caption(laptop, 'shore'), 'While the laptop edits text', 'nothing is pulled under an editor that opened meanwhile');
  await editing(false);
  await until(async () => await caption(laptop, 'shore') === 'While the laptop begins to edit', 'the pull ran once that editor closed');

  // An edit while the desktop pushes by itself (each automatic sync waits 1.5 s at its start here, as a slow remote
  // would): the edit is neither refused nor lost. It stops the push, and the push follows once the book is idle again.
  const pushedEarlier = (await tips(bookId))[0].commitId;
  const saveOnce = (text) => desktop.evaluate(async (text) => {
    const { value } = await window.imageflow.currentProject();
    value.photoIndex.segla.caption = text;
    return window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
  }, text);
  assert.ok((await saveOnce('Before the push')).value);
  await waitForPage(desktop, () => document.querySelector('.sync-status')?.getAttribute('data-state') === 'syncing', undefined, { timeout: 15000 });
  const during = await saveOnce('During the push');
  assert.ok(during.value, 'the edit during the automatic push: ' + JSON.stringify(during.error));
  assert.equal(await caption(desktop, 'segla'), 'During the push', 'the edit is kept');
  assert.equal((await tips(bookId))[0].commitId, pushedEarlier, 'the push it interrupted sent nothing');
  await until(async () => (await tips(bookId))[0]?.commitId !== pushedEarlier && await desktop.evaluate(() => document.querySelector('.sync-status')?.getAttribute('data-state') === 'in-sync'),
    'the edit went up once the book was idle again');
  await until(async () => { await focus(laptop); return await caption(laptop, 'segla') === 'During the push'; }, 'the laptop has the edit');

  // Closing pushes: the laptop edits and closes at once, before its idle wait; the desktop then takes the edit.
  const laptopTips = (await tips(bookId)).map(({ commitId }) => commitId);
  await setCaption(laptop, 'shore', 'Pushed as the laptop closed');
  await app.browserWindow(laptop).then((window) => window.evaluate((window) => window.close()));
  await until(async () => (await tips(bookId)).some(({ commitId }) => !laptopTips.includes(commitId)), 'the laptop pushed as it closed', 15000);
  assert.equal((await tips(bookId)).length, 1);
  await until(async () => { await focus(desktop); return await caption(desktop, 'shore') === 'Pushed as the laptop closed'; }, 'the desktop took the edit');
  assert.deepEqual((await readdir(join(work, 'Desktop'))).filter((name) => name.includes('(Conflict')), [], 'nothing was kept both');
  assert.deepEqual(stderr.filter((line) => /Uncaught|unhandled/i.test(line)), []);
  console.log('Automatic sync smoke passed');
} finally {
  await closeApp(app);
}
