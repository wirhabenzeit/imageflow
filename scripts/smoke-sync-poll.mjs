// A synced book open in the background takes another Mac's changes by itself (API-025), end to end in the app with the
// folder backend and a short look interval (`IMAGEFLOW_SYNC_POLL_MS`, honoured only by a development build): the laptop's
// window never comes to the front, yet it takes what the desktop sent. An agent sees the sync state in list_projects and
// the inspect_book summary; the pull ends the agent's Undo step and says so (`history.reset`, LOG-089); and a write to a
// book whose changes cannot be taken now (a Markdown editor is open) carries a warning. Two "Macs" are two windows of
// one app with one backend: the book and its download from the Start window.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { _electron } from 'playwright-core';
import { closeApp, testBook, waitForPage } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/sync-poll-smoke-')));
const desktopBook = join(work, 'Desktop', 'Poll Book.imageflow');
const laptopBook = join(work, 'Laptop', 'Laptop Book.imageflow');
const folder = join(work, 'Sync Folder');
const profile = join(work, 'profile');
for (const path of [join(work, 'Desktop'), join(work, 'Laptop'), folder, profile]) await mkdir(path);
await writeFile(join(profile, 'settings.json'), JSON.stringify({ agentAccess: true, sync: { kind: 'folder', path: folder } }));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_SYNC_FOLDER: '1', IMAGEFLOW_SYNC_IDLE_MS: '1500', IMAGEFLOW_SYNC_POLL_MS: '2000' } });
const stderr = [];
app.process().stderr.on('data', (bytes) => stderr.push(String(bytes)));
const client = new Client({ name: 'ImageFlow sync poll test', version: '1.0.0' });
const call = async (name, args = {}) => {
  const { structuredContent } = await client.callTool({ name, arguments: args }, { timeout: 30000 });
  assert.ok(!structuredContent.error, name + ': ' + JSON.stringify(structuredContent.error));
  return structuredContent;
};
const until = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
};
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
const state = (page) => page.evaluate(() => document.querySelector('.sync-status')?.getAttribute('data-state'));
const statusIs = (page, value) => waitForPage(page, (value) => document.querySelector('.sync-status')?.getAttribute('data-state') === value, value);
const tips = async (bookId) => {
  const directory = join(folder, 'books', bookId, 'snapshots');
  const headers = await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
  const parents = new Set(headers.flatMap((header) => header.parents));
  return headers.filter((header) => !parents.has(header.commitId));
};
const pushed = async (bookId, before) => until(async () => (await tips(bookId))[0]?.commitId !== before, 'a push by itself');
const laptopEntry = async () => (await call('list_projects')).projects.find((entry) => entry.folder === laptopBook);

try {
  // The desktop's book has its own template, so it asks once (answered here) and is trusted.
  await copySample(join(root, 'sample/starter'), desktopBook);
  const index = join(desktopBook, 'template', 'index.tsx');
  await writeFile(index, (await readFile(index, 'utf8')) + '\n// This Mac’s own template.\n');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
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
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, laptopBook);
  const start = app.windows().find((page) => page.url() === 'imageflow://editor/start');
  const before = new Set(app.windows());
  assert.deepEqual(await start.evaluate((id) => window.imageflow.libraryAction({ action: 'download', bookId: id }), bookId), { value: null });
  let laptop;
  await until(() => (laptop = app.windows().find((page) => !before.has(page) && page.url() === 'imageflow://editor/')), 'Download opens the book');
  await ready(laptop);
  await statusIs(laptop, 'in-sync');

  await client.connect(new StdioClientTransport({ command: electron, args: [join(root, '.build/desktop/mcp-bridge.cjs'), '--connection', join(profile, 'mcp-connection.json')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' }));
  const entry = await laptopEntry();
  assert.equal(entry.sync.state, 'in-sync');
  assert.equal(entry.sync.automatic, true);
  assert.ok(entry.sync.checked, 'when the remote was read');

  // An agent edits the laptop's copy: one Undo step, which goes up by itself; the desktop takes it on focus.
  const first = (await tips(bookId))[0].commitId;
  const summary = await call('inspect_book', { project: entry.project, view: 'summary' });
  assert.equal(summary.sync.state, 'in-sync');
  const saved = await call('apply_project_changes', { project: entry.project, expectedRevision: summary.revision, idempotencyKey: 'agent-title', label: 'Agent title',
    operations: [{ op: 'set_title', title: 'Titled by an agent' }] });
  assert.equal(saved.committed, true);
  assert.equal(saved.sync, undefined, 'nothing to say about sync');
  assert.equal(saved.history.undo, 'Agent title');
  await pushed(bookId, first);
  await until(async () => { const windowId = await app.browserWindow(desktop).then((window) => window.evaluate((window) => window.id));
    await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id).emit('focus'); }, windowId);
    return (await current(desktop)).project.title === 'Titled by an agent'; }, 'the desktop took the agent’s edit');

  // The desktop edits; the laptop, never brought to the front, takes it within a look interval.
  const second = (await tips(bookId))[0].commitId;
  await setCaption(desktop, 'shore', 'Edited on the desktop');
  await pushed(bookId, second);
  await until(async () => await caption(laptop, 'shore') === 'Edited on the desktop', 'the laptop took the change without a focus', 20000);
  await statusIs(laptop, 'in-sync');
  // The pull ended the agent's Undo step, whose snapshot would also undo the desktop's change, and says so.
  await until(async () => (await laptopEntry()).history.reset === 'sync-pull', 'the history says the pull reset it');
  const pulled = await laptopEntry();
  assert.equal(pulled.history.undo, undefined);
  assert.equal(pulled.sync.state, 'in-sync');
  assert.ok(pulled.sync.lastPull, 'when the laptop last pulled');

  // A Markdown editor holds the pull back: the laptop has changes to fetch, which an agent sees, and a write warns.
  for (let attempt = 0; ; attempt++) {
    const opened = await laptop.evaluate(() => window.imageflow.showMarkdown({ id: 'arrival' }));
    if (!opened.code) { assert.ok('value' in opened, opened.error); break; }
    assert.ok(attempt < 50, 'the Markdown editor opens');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let markdown;
  await until(() => (markdown = app.windows().find((page) => page.url() === 'imageflow://editor/markdown')), 'the Markdown editor opens');
  const third = (await tips(bookId))[0].commitId;
  await setCaption(desktop, 'shore', 'While the laptop edits text');
  await pushed(bookId, third);
  await until(async () => await state(laptop) === 'behind', 'a look finds the change', 20000);
  const behind = await laptopEntry();
  assert.equal(behind.sync.state, 'to-fetch');
  // A batch that changes nothing, so the laptop's copy is not changed on two Macs.
  const warned = await call('apply_project_changes', { project: behind.project, expectedRevision: behind.revision, idempotencyKey: 'same-title', label: 'Same title',
    operations: [{ op: 'set_title', title: 'Titled by an agent' }] });
  assert.match(warned.sync?.warning ?? '', /changes to fetch from another Mac\. ImageFlow could not take them now/, JSON.stringify(warned.sync));
  assert.equal(await caption(laptop, 'shore'), 'Edited on the desktop', 'nothing was pulled under the editor');
  await app.browserWindow(markdown).then((window) => window.evaluate((window) => window.close()));
  await until(async () => await caption(laptop, 'shore') === 'While the laptop edits text', 'the pull ran once the editor closed');
  assert.deepEqual((await readdir(join(work, 'Laptop'))).filter((name) => name.includes('(Conflict')), [], 'nothing was kept both');
  assert.deepEqual(stderr.filter((line) => /Uncaught|unhandled/i.test(line)), []);
  console.log('Periodic sync and agent sync state smoke passed');
} finally {
  await client.close().catch(() => {});
  await closeApp(app);
}
