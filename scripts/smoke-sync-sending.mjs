// A long first sync does not hold the book (the first iCloud sync of a book of 1210 photos kept every agent out for over
// half an hour): while it sends its previews (a wait here, `IMAGEFLOW_SYNC_TEST_SENDING_MS`), agents read and save
// through MCP, the editor saves, the status shows how far it is, and Stop Syncing, withdrawing the trust and closing the
// book end it, without an error and without turning sync on again. What was saved meanwhile is in the commit the sync
// makes. While it then holds the book (`IMAGEFLOW_SYNC_TEST_SLOW_MS`), the status says so and Stop Syncing is not offered.
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
const work = await realpath(await mkdtemp(join(root, '.build/sync-sending-smoke-')));
const bookFolder = join(work, 'Desktop', 'Large Book.imageflow');
const folder = join(work, 'Sync Folder');
const profile = join(work, 'profile');
for (const path of [join(work, 'Desktop'), folder, profile]) await mkdir(path);
await writeFile(join(profile, 'settings.json'), JSON.stringify({ agentAccess: true, syncAutomatically: false, sync: { kind: 'folder', path: folder } }));
// Long enough for the agent's calls on a slow CI runner, which takes more than 12 s for them.
const sendingMs = 30_000;
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1', IMAGEFLOW_SYNC_FOLDER: '1', IMAGEFLOW_SYNC_TEST_SENDING_MS: String(sendingMs), IMAGEFLOW_SYNC_TEST_SLOW_MS: '3000' } });
const stderr = [];
app.process().stderr.on('data', (bytes) => stderr.push(String(bytes)));
const client = new Client({ name: 'ImageFlow sync test', version: '1.0.0' });
const call = async (name, args = {}) => {
  const from = Date.now();
  const { structuredContent } = await client.callTool({ name, arguments: args }, { timeout: 20000 });
  assert.ok(!structuredContent.error, name + ': ' + JSON.stringify(structuredContent.error));
  return { ...structuredContent, took: Date.now() - from };
};
const commits = async () => (await readdir(join(folder, 'books'), { recursive: true }).catch(() => [])).filter((name) => name.includes('snapshots/') && name.endsWith('.json'));
const menuItem = (id) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).enabled, id);
// As the menu does: an error then reaches the window, or the Start window when the book's is gone.
const choose = (page, id) => app.browserWindow(page).then((window) => window.evaluate((window, id) => { const { Menu } = process.mainModule.require('electron'); Menu.getApplicationMenu().getMenuItemById(id).click(undefined, window, undefined); }, id));
const record = async () => { for (const name of await readdir(join(profile, 'persistence'))) { const state = await readFile(join(profile, 'persistence', name, 'sync', 'sync.json'), 'utf8').catch(() => undefined); if (state) return JSON.parse(state); } return {}; };
const syncing = (page, state) => waitForPage(page, (state) => document.querySelector('.sync-status')?.getAttribute('data-state') === state, state, { timeout: 40000 });

try {
  await copySample(join(root, 'sample/starter'), bookFolder);
  const index = join(bookFolder, 'template', 'index.tsx');
  await writeFile(index, (await readFile(index, 'utf8')) + '\n// This Mac’s own template.\n');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const page = await testBook(app, bookFolder);
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor({ timeout: 30000 });
  // A lineage ID, as every saved book has: a first sync otherwise gives it one, which reloads the book.
  const saved = await page.evaluate(async () => {
    const { value } = await window.imageflow.currentProject();
    value.project.title = 'Large Book';
    return window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
  });
  assert.ok(saved.value, JSON.stringify(saved));

  await page.evaluate(() => { void window.imageflow.syncAction('start'); });
  await syncing(page, 'syncing');
  const started = Date.now();

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  await client.connect(new StdioClientTransport({ command: electron, args: [join(root, '.build/desktop/mcp-bridge.cjs'), '--connection', join(profile, 'mcp-connection.json')], env, stderr: 'pipe' }));
  const listed = await call('list_projects');
  const project = listed.projects[0].project ?? listed.projects[0].handle;
  const context = await call('get_authoring_context', { project });
  const agent = await call('apply_project_changes', { project, expectedRevision: context.revision, idempotencyKey: 'during-sync', label: 'Title', operations: [{ op: 'set_title', title: 'Saved by an agent' }] });
  assert.equal(await page.evaluate(() => document.querySelector('.sync-status')?.getAttribute('data-state')), 'syncing', 'the sync still sends');
  assert.equal((await commits()).length, 0, 'nothing is committed yet');
  assert.ok(Date.now() - started < sendingMs);
  console.log('While the sync sent: list_projects ' + listed.took + ' ms, get_authoring_context ' + context.took + ' ms, apply_project_changes ' + agent.took + ' ms');
  const edited = await page.evaluate(async () => {
    const { value } = await window.imageflow.currentProject();
    value.photoIndex.segla.caption = 'Saved in the editor';
    return window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
  });
  assert.ok(edited.value, 'the editor saves meanwhile: ' + JSON.stringify(edited.error));
  assert.match(await page.locator('.sync-status').innerText(), /Syncing \d+ of \d+/);

  // Sent: while the sync holds the book, no progress is shown and Stop Syncing is not offered.
  assert.equal(await menuItem('sync-stop'), true, 'Stop Syncing is offered while it sends');
  await waitForPage(page, () => document.querySelector('.sync-status')?.textContent === 'Syncing…', undefined, { timeout: sendingMs + 10_000 });
  assert.equal(await menuItem('sync-stop'), false, 'and not while the book is held');
  await syncing(page, 'in-sync');
  const [commit] = await commits();
  const header = JSON.parse(await readFile(join(folder, 'books', commit), 'utf8'));
  assert.equal(header.title, 'Saved by an agent', 'the commit has what was saved meanwhile');

  // Stop Syncing ends a sync that sends, also one the user asked for.
  await page.evaluate(async () => {
    const { value } = await window.imageflow.currentProject();
    value.photoIndex.segla.caption = 'Not synced';
    await window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
  });
  await page.evaluate(() => { void window.imageflow.syncAction('sync').then((result) => { window.stopped = result; }); });
  await syncing(page, 'syncing');
  const stopping = Date.now();
  await page.evaluate(() => window.imageflow.syncAction('stop'));
  await waitForPage(page, () => window.stopped && document.querySelector('.sync-status')?.getAttribute('data-state') !== 'syncing', undefined, { timeout: 8000 });
  assert.ok(Date.now() - stopping < 8000);
  assert.ok(!('error' in await page.evaluate(() => window.stopped)), 'stopping is no error');
  assert.equal((await commits()).length, 1, 'the stopped sync committed nothing');
  assert.equal((await record()).enabled, false, 'and did not turn sync on again');

  // So does withdrawing the trust: an untrusted book never syncs.
  await page.evaluate(() => { window.stopped = undefined; void window.imageflow.syncAction('start').then((result) => { window.stopped = result; }); });
  await syncing(page, 'syncing');
  await choose(page, 'stop-trusting-book');
  await waitForPage(page, () => window.stopped && document.querySelector('.sync-status')?.getAttribute('data-state') !== 'syncing', undefined, { timeout: 9000 });
  assert.ok(!('error' in await page.evaluate(() => window.stopped)), JSON.stringify(await page.evaluate(() => window.stopped)));
  assert.equal((await commits()).length, 1, 'nothing of the untrusted book was committed');
  assert.equal((await record()).enabled, false);

  // Closing the book ends one too, which is no error. One would be reported in the Start window it opens, so none is open.
  await app.evaluate(({ app, BrowserWindow }) => {
    globalThis.sentToWindows = [];
    app.on('web-contents-created', (_event, contents) => {
      const send = contents.send.bind(contents);
      contents.send = (...args) => { globalThis.sentToWindows.push(JSON.stringify(args)); return send(...args); };
    });
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL() === 'imageflow://editor/start') window.destroy();
  });
  await choose(page, 'sync-start');
  await syncing(page, 'syncing');
  const closing = Date.now();
  const closed = page.waitForEvent('close', { timeout: 9000 });
  await app.browserWindow(page).then((window) => window.evaluate((window) => window.close()));
  await closed;
  assert.ok(Date.now() - closing < 9000, 'closing does not wait for the sync');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const sent = await app.evaluate(() => globalThis.sentToWindows);
  assert.deepEqual(sent.filter((message) => /closed before it finished syncing|book is closing/.test(message)), [], 'closing is no error');
  assert.deepEqual(stderr.filter((line) => /Uncaught|unhandled/i.test(line)), []);
  console.log('Sync sending smoke passed');
} finally {
  await client.close().catch(() => {});
  await closeApp(app);
}
