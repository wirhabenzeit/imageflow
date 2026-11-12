import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/documents-smoke-')));
const first = join(work, 'First.imageflow');
const second = join(work, 'Second.imageflow');
const duplicate = join(work, 'Duplicate.imageflow');
const profile = join(work, 'profile');
const errors = [];
let client;
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + profile], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
app.process().stderr.on('data', (data) => errors.push(String(data)));
await app.evaluate(({ app }) => {
  globalThis.reviewCoverRenders = 0;
  app.on('browser-window-created', (_event, window) => window.webContents.on('did-finish-load', () => {
    if (window.webContents.getURL().includes('/render/')) globalThis.reviewCoverRenders++;
  }));
});
function watch(page) { page.setDefaultTimeout(25000); page.on('pageerror', (error) => errors.push(error.message)); }
async function ready(page) { watch(page); await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor(); }
async function current(page) { return (await page.evaluate(() => window.imageflow.currentProject())).value; }
async function launchAction(page, action) {
  const before = new Set(app.windows());
  const result = await page.evaluate((action) => window.imageflow.openProject(action), action);
  assert.ok(!result.error, result.error);
  const editor = app.windows().find((page) => !before.has(page) && page.url() === 'imageflow://editor/');
  assert.ok(editor, 'New/Open creates another editor');
  await ready(editor);
  return editor;
}
async function save(page, title) {
  const before = await current(page);
  const files = { project: before.project, photoIndex: before.photoIndex };
  files.project.title = title;
  const result = await page.evaluate(({ id, files }) => window.imageflow.saveProject(id, files, 'Rename book'), { id: before.id, files });
  assert.ok(result.value, JSON.stringify(result));
  // Native saves normally return directly to the editor; publish through Reload for this IPC-driven fixture.
  await page.evaluate(() => window.imageflow.openProject('reload'));
  await page.reload();
  await ready(page);
  return result.value;
}
try {
  const start = await app.firstWindow();
  watch(start);
  await start.getByRole('heading', { name: 'ImageFlow', exact: true }).waitFor();
  assert.equal(start.url(), 'imageflow://editor/start');
  await start.screenshot({ path: join(root, '.build/documents-start.png') });
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, first);
  const pickerPromise = app.waitForEvent('window');
  await start.getByRole('button', { name: 'New Book…', exact: true }).click();
  const picker = await pickerPromise;
  watch(picker);
  await picker.getByRole('heading', { name: 'Choose a starter' }).waitFor();
  await picker.screenshot({ path: join(root, '.build/documents-starter.png') });
  await picker.getByRole('button', { name: 'Continue…' }).click();
  let one;
  for (let attempt = 0; attempt < 250; attempt++) {
    one = app.windows().find((page) => page.url() === 'imageflow://editor/');
    if (one) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(one);
  await ready(one);
  assert.equal((await current(one)).project.title, 'First');
  await assert.rejects(stat(join(first, '.imageflow/photos')), { code: 'ENOENT' });
  await one.screenshot({ path: join(root, '.build/documents-editor.png') });
  await start.waitForFunction(async () => (await window.imageflow.recentDocuments()).value.some((book) => !!book.cover));
  const initialCovers = await app.evaluate(() => globalThis.reviewCoverRenders);
  await save(one, 'Cover update pending');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(await app.evaluate(() => globalThis.reviewCoverRenders), initialCovers, 'Editing does not render a cover in the background');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'imageflow://editor/').emit('blur'));
  for (let attempt = 0; await app.evaluate(() => globalThis.reviewCoverRenders) === initialCovers; attempt++) {
    assert.ok(attempt < 150, 'Losing focus refreshes the pending cover');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await one.evaluate(async () => {
    const { value } = await window.imageflow.currentProject();
    await window.imageflow.history(value.id, 'undo');
  });
  await one.reload(); await ready(one);
  await cp(first, second, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, second);
  const two = await launchAction(one, 'open');
  assert.notEqual((await current(one)).handle, (await current(two)).handle);
  assert.equal((await current(one)).project.title, 'First');
  await save(one, 'First edited');
  await save(two, 'Second edited');
  const firstState = await current(one);
  const secondState = await current(two);
  const wrongWindow = await one.evaluate(({ id, files }) => window.imageflow.saveProject(id, files), { id: secondState.id, files: { project: secondState.project, photoIndex: secondState.photoIndex } });
  assert.ok(wrongWindow.error, 'A window cannot write another book');
  const undone = await one.evaluate((id) => window.imageflow.history(id, 'undo'), firstState.id);
  assert.equal(undone.value.project.title, 'First');
  assert.equal((await current(two)).project.title, 'Second edited');
  const alias = join(work, 'Alias.imageflow');
  await symlink(first, alias);
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, alias);
  const windowsBefore = app.windows().filter((page) => page.url() === 'imageflow://editor/').length;
  assert.ok(!(await two.evaluate(() => window.imageflow.openProject('open'))).error);
  assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/').length, windowsBefore);
  // Finder duplication during an open session must be an independent writer, including a copied live lock.
  await cp(first, duplicate, { recursive: true });
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, duplicate);
  const copy = await launchAction(two, 'open');
  assert.notEqual((await current(copy)).handle, (await current(one)).handle);
  // External edits and undo histories stay scoped to the document.
  const text = join(second, 'texts/arrival.md');
  await writeFile(text, '# Changed externally\n\nA second-window source.\n');
  await two.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('reloaded'));
  assert.equal((await current(two)).texts.arrival, '# Changed externally\n\nA second-window source.\n');
  assert.equal((await current(one)).project.title, 'First');
  const checked = await Promise.all([one, two].map((page) => page.evaluate(async () => {
    const { value } = await window.imageflow.currentProject();
    return window.imageflow.checkBook(value.id, {});
  })));
  assert.ok(checked.every((result) => result.value?.state === 'ready'), JSON.stringify(checked));
  const connection = await two.evaluate(() => window.imageflow.mcpSettings(true));
  assert.ok(connection.value?.enabled);
  client = new Client({ name: 'Multiple-book workflow test', version: '1' });
  await client.connect(new StdioClientTransport({ ...connection.value.launch, stderr: 'pipe' }));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const data = response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === 'text').text);
    return { response, data };
  };
  const listed = (await call('list_projects')).data.projects;
  assert.equal(listed.length, 3);
  const firstHandle = (await current(one)).handle;
  const secondHandle = (await current(two)).handle;
  const inspections = await Promise.all([firstHandle, secondHandle].map((project) => call('inspect_book', { project, view: 'summary' })));
  assert.equal(inspections[0].data.title, 'First');
  assert.equal(inspections[1].data.title, 'Second edited');
  await one.close();
  for (let attempt = 0; await stat(join(first, '.imageflow/writer.lock')).catch(() => false); attempt++) {
    assert.ok(attempt < 200, 'Book close releases its writer');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok((await two.evaluate(() => window.imageflow.mcpSettings())).value.enabled, 'Closing one book keeps the app agent connection');
  assert.equal((await call('inspect_book', { project: firstHandle, view: 'summary' })).response.isError, true);
  assert.equal((await call('inspect_book', { project: secondHandle, view: 'summary' })).data.title, 'Second edited');
  await client.close();
  client = undefined;
  await save(two, 'Still working');
  await copy.close();
  await two.close();
  const chooser = app.windows().find((page) => page.url() === 'imageflow://editor/start');
  watch(chooser);
  await chooser.getByRole('heading', { name: 'Recent books' }).waitFor();
  const recent = await chooser.evaluate(() => window.imageflow.recentDocuments());
  assert.equal(recent.value.length, 3);
  assert.ok(recent.value.some((book) => book.title === 'Still working'));
  await chooser.locator('.recent-cover img').first().waitFor();
  await chooser.screenshot({ path: join(root, '.build/documents-recents.png') });
  // A restore at the same path has a new inode, but still opens directly from Recents.
  const secondRecent = recent.value.find((book) => book.path === second);
  const backup = join(work, 'Before restore.imageflow');
  await rename(second, backup);
  await cp(backup, second, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
  assert.notEqual((await stat(backup)).ino, (await stat(second)).ino);
  assert.equal((await chooser.evaluate(() => window.imageflow.recentDocuments())).value.find((book) => book.path === second).available, true);
  const beforeRestore = new Set(app.windows());
  const restored = await chooser.evaluate((id) => window.imageflow.recentDocument(id, 'open'), secondRecent.id);
  assert.ok(!restored.error, JSON.stringify(restored));
  const reopened = app.windows().find((page) => !beforeRestore.has(page) && page.url() === 'imageflow://editor/');
  await ready(reopened);
  assert.equal((await current(reopened)).project.title, 'Still working');
  assert.equal((await chooser.evaluate(() => window.imageflow.recentDocuments())).value.find((book) => book.path === second).id, secondRecent.id);
  await reopened.close();
  const moved = join(work, 'Moved.imageflow');
  await rename(second, moved);
  await chooser.reload();
  await chooser.getByRole('button', { name: 'Locate…' }).waitFor();
  const missing = (await chooser.evaluate(() => window.imageflow.recentDocuments())).value.find((book) => book.path === second);
  assert.equal(missing.available, false);
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, moved);
  const beforeLocate = new Set(app.windows());
  assert.ok(!(await chooser.evaluate((id) => window.imageflow.recentDocument(id, 'locate'), missing.id)).error);
  const located = app.windows().find((page) => !beforeLocate.has(page) && page.url() === 'imageflow://editor/');
  await ready(located);
  assert.equal((await current(located)).project.title, 'Still working');
  await located.close();
  const finalChooser = app.windows().find((page) => page.url() === 'imageflow://editor/start');
  watch(finalChooser);
  const restoredRecents = (await finalChooser.evaluate(() => window.imageflow.recentDocuments())).value;
  assert.equal(restoredRecents.filter((book) => book.id === missing.id).length, 1);
  assert.equal(restoredRecents.find((book) => book.id === missing.id).path, moved);
  assert.ok(!(await finalChooser.evaluate((id) => window.imageflow.recentDocument(id, 'remove'), missing.id)).error);
  await stat(moved);
  assert.equal(errors.filter((message) => /TypeError|ReferenceError|Uncaught/.test(message)).length, 0, errors.join('\n'));
  console.log('ImageFlow package creation, independent windows, duplicate identity, autosave, undo, external edits, recents and recovery passed.');
} finally {
  await client?.close();
  await app.close();
  await rm(work, { recursive: true, force: true });
}
