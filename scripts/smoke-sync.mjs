// Manual sync through the Mac's sync backend (#251, #280), end to end in the app with the development flag: the folder
// backend chosen in Settings, Start Syncing, Open Synced Book (an untrusted copy on "another Mac"), a normal sync that
// reloads the editor, a sync that fails after its pull and still reloads it, the tip chooser with five tips including
// Cancel, the network question after a pulled template change in a trusted book, and a changed backend, which asks
// once before a synced book starts a new history there. Both "Macs" are windows of one app with one backend.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { closeApp, testBook, waitForPage } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/sync-smoke-')));
const desktopBook = join(work, 'Desktop', 'Sync Book.imageflow');
const laptopBook = join(work, 'Laptop', 'Sync Book.imageflow');
const folder = join(work, 'Sync Folder');
const otherFolder = join(work, 'Other Sync Folder');
await mkdir(join(work, 'Desktop'));
await mkdir(join(work, 'Laptop'));
await mkdir(folder);
await mkdir(otherFolder);
const trustQuestion = 'Trust this book’s template?';
const tipQuestion = 'This book was changed on two Macs.';
const elsewhereQuestion = 'This book last synced somewhere else.';

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_SYNC: '1' } });
const stderr = [];
app.process().stderr.on('data', (bytes) => stderr.push(String(bytes)));
const windowId = (page) => app.browserWindow(page).then((window) => window.evaluate((window) => window.id));
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
const ready = async (page) => {
  page.setDefaultTimeout(30000);
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
};
const setCaption = (page, id, text) => page.evaluate(async ({ id, text }) => {
  const { value } = await window.imageflow.currentProject();
  value.photoIndex[id].caption = text;
  return window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
}, { id, text });
const captionIs = (page, id, text) => waitForPage(page, async ({ id, text }) => (await window.imageflow.currentProject()).value?.photoIndex[id]?.caption === text, { id, text });
// Sync from an editor, waiting out the moments a watcher reload or save holds the book.
async function sync(page, action = 'sync') {
  for (let attempt = 0; ; attempt++) {
    const result = await page.evaluate((action) => window.imageflow.syncAction(action), action);
    if (!('error' in result) || !/finishing another operation/.test(result.error) || attempt > 100) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const syncState = (page) => page.locator('.sync-status').getAttribute('data-state');
const statusIs = (page, state) => waitForPage(page, (state) => document.querySelector('.sync-status')?.getAttribute('data-state') === state, state);
const prompts = () => app.evaluate(() => globalThis.syncPrompts);
async function waitForPrompt(match, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = (await prompts()).find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('No question matched: ' + JSON.stringify(await prompts()));
}
const answer = (message, response) => app.evaluate((_, { message, response }) => { globalThis.syncAnswers[message] = response; }, { message, response });
const choosePaths = (paths) => app.evaluate((_, paths) => { globalThis.syncPaths = paths; }, paths);
const menuEnabled = (id) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id)?.enabled, id);
const timesAsked = async (message, window) => (await prompts()).filter((prompt) => prompt.message === message && prompt.window === window).length;
const snapshots = async (bookId) => join(folder, 'books', bookId, 'snapshots');
async function tips(bookId) {
  const directory = await snapshots(bookId);
  const headers = await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
  const parents = new Set(headers.flatMap((header) => header.parents));
  return headers.filter((header) => !parents.has(header.commitId));
}

try {
  // The desktop's book is its own: its template differs from the built-in one, so it asks once and is trusted.
  await copySample(join(root, 'sample/starter'), desktopBook);
  const index = join(desktopBook, 'template', 'index.tsx');
  await writeFile(index, (await readFile(index, 'utf8')) + '\n// This Mac’s own template.\n');
  await app.evaluate(({ dialog }) => {
    globalThis.syncPrompts = [];
    globalThis.syncAnswers = {};
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.syncPrompts.push({ message: options.message, detail: options.detail, buttons: options.buttons, cancelId: options.cancelId, window: args.length > 1 ? args[0].id : undefined });
      const response = globalThis.syncAnswers[options.message];
      return { response: response === 'cancel' ? options.cancelId : response ?? 0, checkboxChecked: false };
    };
  });
  const desktop = await testBook(app, desktopBook);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.syncPaths.open] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.syncPaths.save });
  });
  await ready(desktop);
  const desktopWindow = await windowId(desktop);
  await waitForPrompt((prompt) => prompt.message === trustQuestion && prompt.window === desktopWindow);
  assert.equal(await desktop.locator('.sync-status').count(), 0, 'a book that does not sync shows no status');
  assert.equal(await menuEnabled('sync-setup'), true, 'without a backend, File → Sync offers Set Up Sync…');
  assert.equal(await menuEnabled('sync-start'), false);

  // The backend is the Mac's: one folder, chosen in Settings. Then Start Syncing pushes the book, with no question.
  await choosePaths({ open: folder });
  const configured = await desktop.evaluate(() => window.imageflow.chooseSyncFolder());
  assert.deepEqual(configured.value?.sync, { kind: 'folder', path: folder });
  for (let attempt = 0; !await menuEnabled('sync-start'); attempt++) {
    assert.ok(attempt < 400, 'a configured backend offers Start Syncing');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await menuEnabled('sync-setup'), false);
  assert.deepEqual(await sync(desktop, 'start'), { value: undefined });
  await statusIs(desktop, 'in-sync');
  assert.equal(await desktop.locator('.sync-status').getAttribute('title').then((title) => title.includes('Sync Folder')), true, 'the status names the backend');
  const bookId = (await current(desktop)).project.bookId;
  assert.ok(bookId, 'the first sync gave the book its lineage ID');
  assert.equal((await tips(bookId)).length, 1);

  // Open Synced Book on the "laptop": it lists the configured backend, and makes an untrusted copy, which asks before
  // reaching the template's sites.
  await answer(trustQuestion, 1);
  await choosePaths({ open: '/nonexistent', save: laptopBook });
  const beforeLaptop = new Set(app.windows());
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('open-sync-folder').click());
  let laptop;
  for (let attempt = 0; !(laptop = app.windows().find((page) => !beforeLaptop.has(page) && page.url() === 'imageflow://editor/')); attempt++) {
    assert.ok(attempt < 400, 'Open Synced Book opens the new book');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await ready(laptop);
  const laptopWindow = await windowId(laptop);
  await waitForPrompt((prompt) => prompt.message === trustQuestion && prompt.window === laptopWindow);
  assert.equal((await current(laptop)).project.bookId, bookId);
  await statusIs(laptop, 'in-sync');
  // Owned originals download in the background after Open Synced Book (the default), and the book then shows them.
  for (let attempt = 0; (await current(laptop)).sources['photo:shore'].state !== 'available'; attempt++) {
    assert.ok(attempt < 400, 'owned originals download after Open Synced Book');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stat(join(laptopBook, (await current(laptop)).photoIndex.shore.path));

  // A normal sync: the laptop pushes a caption, the desktop pulls it and its editor reloads.
  assert.ok((await setCaption(laptop, 'shore', 'From the laptop')).value);
  await statusIs(laptop, 'ahead');
  assert.deepEqual(await sync(laptop), { value: undefined });
  await statusIs(laptop, 'in-sync');
  assert.deepEqual(await sync(desktop), { value: undefined });
  await captionIs(desktop, 'shore', 'From the laptop');
  await statusIs(desktop, 'in-sync');

  // A pulled template change in a trusted book: the sites it newly declares are asked about all the same.
  const laptopIndex = join(laptopBook, 'template', 'index.tsx');
  const laptopTemplate = await readFile(laptopIndex, 'utf8');
  assert.ok(laptopTemplate.includes('network: [mapOrigin, elevationOrigin]'));
  await writeFile(laptopIndex, laptopTemplate.replace('network: [mapOrigin, elevationOrigin]', "network: [mapOrigin, elevationOrigin, 'https://sync-smoke.example.org']"));
  assert.deepEqual(await sync(laptop), { value: undefined });
  await answer(trustQuestion, 0);
  assert.deepEqual(await sync(desktop), { value: undefined });
  const asked = await waitForPrompt((prompt) => prompt.message === trustQuestion && prompt.window === desktopWindow && prompt.detail.includes('sync-smoke.example.org'));
  assert.ok(asked, 'the trusted desktop asks about the site the pulled template added');

  // A sync that fails after its pull: the desktop's original changed here, so after taking the laptop's caption it
  // pushes its new facts, which the sync folder refuses. The editor still shows what was pulled.
  const shore = join(desktopBook, 'photos', 'shore.jpg');
  const replacement = join(work, 'shore.jpg');
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#884422' } }).jpeg().toFile(replacement);
  await rename(replacement, shore);
  assert.ok((await setCaption(laptop, 'segla', 'Laptop again')).value);
  assert.deepEqual(await sync(laptop), { value: undefined });
  const directory = await snapshots(bookId);
  await chmod(directory, 0o555);
  let failed;
  try { failed = await sync(desktop); } finally { await chmod(directory, 0o755); }
  assert.match(failed.error ?? '', /EACCES|permission denied/i, 'the push was refused: ' + JSON.stringify(failed));
  await captionIs(desktop, 'segla', 'Laptop again');
  assert.equal((await tips(bookId)).length, 1, 'nothing half-written reached the sync folder');

  // Five tips: the chooser shows four and Cancel, and Cancel continues with none of them.
  const [tip] = await tips(bookId);
  for (let index = 1; index <= 4; index++) {
    const sibling = { ...tip, commitId: randomUUID(), createdAt: new Date(Date.parse(tip.createdAt) + index * 1000).toISOString() };
    await writeFile(join(directory, sibling.commitId + '.json'), JSON.stringify(sibling));
  }
  assert.equal((await tips(bookId)).length, 5);
  await answer(tipQuestion, 'cancel');
  assert.deepEqual(await sync(desktop), { value: undefined });
  const chooser = await waitForPrompt((prompt) => prompt.message === tipQuestion && prompt.window === desktopWindow);
  assert.equal(chooser.buttons.length, 5);
  assert.equal(chooser.cancelId, 4);
  assert.equal(chooser.buttons[4], 'Cancel');
  assert.match(chooser.detail, /1 older version is not shown/);
  assert.equal((await tips(bookId)).length, 5, 'Cancel leaves the fork open');
  await statusIs(desktop, 'diverged');
  await answer(tipQuestion, 0);
  assert.deepEqual(await sync(desktop), { value: undefined });
  const [closing, ...more] = await tips(bookId);
  assert.equal(more.length, 0);
  assert.equal(closing.parents.length, 5, 'the chosen version closes the fork');
  await statusIs(desktop, 'in-sync');
  assert.equal(await syncState(desktop), 'in-sync');
  assert.deepEqual((await readdir(join(work, 'Desktop'))).filter((name) => name.includes('(Conflict')), [], 'this Mac’s version was on the remote: no copy');

  // Another backend: each synced book asks once whether it starts a new history there, and pushes nothing by itself.
  await answer(elsewhereQuestion, 1);
  await choosePaths({ open: otherFolder });
  assert.deepEqual((await desktop.evaluate(() => window.imageflow.chooseSyncFolder())).value?.sync, { kind: 'folder', path: otherFolder });
  await waitForPrompt((prompt) => prompt.message === elsewhereQuestion && prompt.window === desktopWindow);
  await waitForPrompt((prompt) => prompt.message === elsewhereQuestion && prompt.window === laptopWindow);
  await waitForPage(desktop, () => !document.querySelector('.sync-status'));
  for (let attempt = 0; !await menuEnabled('sync-start'); attempt++) {
    assert.ok(attempt < 400, 'a declined book offers Start Syncing');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual((await readdir(otherFolder)).filter((name) => name === 'books'), [], 'nothing was pushed');
  // Declining is remembered: looking at the backend again (turned off and on) does not ask again.
  assert.deepEqual((await desktop.evaluate(() => window.imageflow.updateSettings({ sync: undefined }))).value?.sync, undefined);
  await choosePaths({ open: otherFolder });
  await desktop.evaluate(() => window.imageflow.chooseSyncFolder());
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(await timesAsked(elsewhereQuestion, desktopWindow), 1, 'the desktop asked once');
  assert.equal(await timesAsked(elsewhereQuestion, laptopWindow), 1, 'the laptop asked once');
  // Start Syncing asks again, and accepting starts the book's history on the other backend.
  await answer(elsewhereQuestion, 0);
  assert.deepEqual(await sync(desktop, 'start'), { value: undefined });
  assert.equal(await timesAsked(elsewhereQuestion, desktopWindow), 2);
  await statusIs(desktop, 'in-sync');
  const otherTips = await readdir(join(otherFolder, 'books', bookId, 'snapshots'));
  assert.equal(otherTips.filter((name) => name.endsWith('.json')).length, 1, 'a new history on the other backend');
  assert.ok(JSON.parse(await readFile(join(otherFolder, 'remote.json'), 'utf8')).remoteId, 'the backend has its identity');
  console.log('The folder backend in Settings, Start Syncing, Open Synced Book, reloads after sync and after a failed push, the five-tip chooser, the pulled-template network question and a changed backend passed.');
} catch (error) { console.error(stderr.join('\n')); throw error; }
finally { await closeApp(app); await rm(work, { recursive: true, force: true }); }
