import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/ui-polish-'));
let book = join(work, 'Book.imageflow');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const until = async (check, message) => {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
  assert.ok(await check(), message);
};
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
const command = async (page, id) => {
  await until(() => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id)?.enabled, id), 'Command becomes available: ' + id);
  const window = await app.browserWindow(page);
  const owner = await window.evaluate((window) => window.id);
  await app.evaluate(({ Menu, BrowserWindow }, { owner, id }) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id);
    if (!item?.enabled) throw new Error('Disabled command: ' + id);
    item.click(item, BrowserWindow.fromId(owner));
  }, { owner, id });
};
try {
  const page = await testBook(app, book, true);
  const ready = () => page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await ready();
  // Native text Undo must leave the book's history and stored content intact.
  await page.locator('.source-photo[data-id="segla"]').click();
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  const originalTitle = await title.inputValue();
  const beforeTyping = await current(page);
  await title.focus(); await title.press('End'); await page.keyboard.insertText(' typing');
  await until(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('native-undo').visible), 'Text fields use native Undo');
  await page.keyboard.press(modifier + '+z');
  assert.equal(await title.inputValue(), originalTitle);
  assert.deepEqual((await current(page)).history, beforeTyping.history);
  assert.equal((await current(page)).photoIndex.segla.title, beforeTyping.photoIndex.segla.title);
  const spreadCount = (await current(page)).project.spreads.length;
  await page.locator('.source-photo[data-id="segla"]').press('Escape');
  assert.equal(await page.getByRole('dialog', { name: /Quick Look/ }).count(), 0, 'Escape does not open Quick Look');
  await page.locator('.source-photo[data-id="segla"]').press('Space');
  await page.getByRole('dialog', { name: /Quick Look/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: /Quick Look/ }).waitFor({ state: 'detached' });
  await title.focus(); await title.press('End'); await page.keyboard.insertText('X'); await title.press('Backspace');
  assert.equal(await title.inputValue(), originalTitle);
  assert.equal((await current(page)).project.spreads.length, spreadCount, 'Typing Backspace cannot delete a spread');
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('delete-spread').registerAccelerator), false, 'The Delete shortcut is displayed without intercepting text fields');
  await page.locator('.spread-thumb').first().click();
  // The unshifted zoom alias targets the book, and Delete remains local to a spread selection.
  await page.locator('.canvas').focus();
  const width = await page.locator('.stage').evaluate((node) => node.getBoundingClientRect().width);
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('zoom-in-equals').accelerator), 'CmdOrCtrl+=');
  await command(page, 'zoom-in-equals');
  await until(async () => await page.locator('.stage').evaluate((node) => node.getBoundingClientRect().width) > width + 1, 'Zoom In alias reaches the book');
  await command(page, 'zoom-fit');
  await page.locator('.spread-thumb[data-spread="march"]').click();
  await ready();
  await page.locator('.inspector').getByRole('button', { name: 'Edit Calendar grid', exact: true }).click();
  const editorTitle = page.frameLocator('.element-editor-frame').getByRole('textbox', { name: 'Calendar title', exact: true });
  await editorTitle.fill('AB'); await editorTitle.press('End'); await editorTitle.press('Backspace');
  assert.equal(await editorTitle.inputValue(), 'A', 'Backspace edits text inside the custom editor');
  assert.equal((await current(page)).project.spreads.length, spreadCount);
  await editorTitle.press('Escape');
  await page.locator('.element-editor-frame').waitFor({ state: 'detached' });
  await page.locator('.spread-thumb[data-spread="march"]').focus();
  await page.keyboard.press('Backspace');
  await until(async () => (await current(page)).project.spreads.length === spreadCount - 1, 'Backspace deletes the focused spread');
  await command(page, 'undo');
  await until(async () => (await current(page)).project.spreads.length === spreadCount, 'The spread deletion is undoable');
  await ready();

  await menuAction(app, 'Assets…');
  await until(() => app.windows().some((page) => page.url() === 'imageflow://editor/assets'));
  const assets = app.windows().find((page) => page.url() === 'imageflow://editor/assets');
  assets.setDefaultTimeout(20000);
  const rows = assets.getByRole('listbox', { name: 'Assets' }).getByRole('option');
  await rows.first().waitFor();
  const total = await rows.count();
  await rows.nth(0).click(); await rows.nth(2).click({ modifiers: ['Shift'] });
  assert.equal(await rows.and(assets.locator('[aria-selected="true"]')).count(), 3);
  await assets.keyboard.press(modifier + '+a');
  assert.equal(await rows.and(assets.locator('[aria-selected="true"]')).count(), total);
  await assets.keyboard.press('Home');
  assert.equal(await rows.and(assets.locator('[aria-selected="true"]')).count(), 1);
  const firstKey = await rows.first().getAttribute('data-source');
  await assets.keyboard.press('Space');
  await assets.getByRole('dialog', { name: /Quick Look/ }).waitFor();
  await assets.getByRole('searchbox', { name: 'Search assets' }).click();
  await assets.getByRole('dialog', { name: /Quick Look/ }).waitFor({ state: 'detached' });
  assert.equal(await assets.getByRole('searchbox', { name: 'Search assets' }).evaluate((node) => document.activeElement === node), true, 'Outside click also activates the control underneath');
  await rows.first().click();
  const originalCount = Object.keys((await current(assets)).photoIndex).length;
  await assets.keyboard.press('Backspace');
  await until(async () => Object.keys((await current(assets)).photoIndex).length === originalCount - 1, 'Delete removes one asset');
  await until(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('undo').label === 'Undo Remove assets'));
  await command(assets, 'undo');
  await until(async () => Object.keys((await current(assets)).photoIndex).length === originalCount, 'Undo from Assets restores its source');
  await assets.locator('[data-source="' + firstKey + '"]').waitFor();
  await command(assets, 'redo');
  await until(async () => Object.keys((await current(assets)).photoIndex).length === originalCount - 1, 'Redo removes the source again');
  await command(assets, 'undo');
  await until(async () => Object.keys((await current(assets)).photoIndex).length === originalCount);
  await assets.close(); await ready();

  // A move keeps this session, identity, represented filename and writer lock.
  const beforeMove = await current(page);
  const renamed = join(work, 'Renamed.imageflow');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, renamed);
  await command(page, 'rename-book');
  await until(async () => (await current(page)).folder === 'Renamed.imageflow', 'Rename updates the live document');
  book = renamed;
  assert.equal((await current(page)).handle, beforeMove.handle);
  await page.locator('.project-identity .document-title', { hasText: 'Renamed' }).waitFor();
  const destination = join(work, 'Moved'); await mkdir(destination);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, destination);
  await command(page, 'move-book');
  book = join(destination, 'Renamed.imageflow');
  await until(async () => (await (await app.browserWindow(page)).evaluate((window) => window.getRepresentedFilename())) === book, 'Move updates the live document');
  assert.equal((await current(page)).handle, beforeMove.handle);
  await stat(join(book, '.imageflow/writer.lock'));
  assert.deepEqual(JSON.parse(await readFile(join(book, 'photos.json'), 'utf8')), beforeMove.photoIndex);
  await ready();

  const beforeRevert = await current(page);
  const files = { project: structuredClone(beforeRevert.project), photoIndex: beforeRevert.photoIndex };
  files.project.title = 'Changed after opening';
  const saved = await page.evaluate(({ id, files }) => window.imageflow.saveProject(id, files, 'Change title'), { id: beforeRevert.id, files });
  assert.ok(saved.value, JSON.stringify(saved));
  await page.evaluate(() => window.imageflow.openProject('reload')); await page.reload(); await ready();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await command(page, 'revert-opened');
  await until(async () => (await current(page)).project.title === 'Book', 'Last Opened restores opening content');
  await until(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('undo').label === 'Undo Revert to Last Opened'));
  await command(page, 'undo');
  await until(async () => (await current(page)).project.title === 'Changed after opening', 'Revert can be undone');
  console.log('UI polish passed: text Undo and Backspace, local spread Delete, zoom alias, asset selection and Undo/Redo, Quick Look, Rename, Move and Last Opened.');
} catch (error) {
  console.error('UI diagnostic:', await Promise.all(app.windows().filter((page) => page.url() === 'imageflow://editor/').map(async (page) => ({ status: await page.locator('.status').innerText(), book: await current(page) }))));
  throw error;
} finally { await app.close(); await rm(work, { recursive: true, force: true }); }
