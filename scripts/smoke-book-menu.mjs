import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'book-menu-'));
const book = join(work, 'Book.imageflow');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const read = async () => JSON.parse(await readFile(join(book, 'project.json'), 'utf8'));
const state = (id) => app.evaluate(({ Menu }, id) => {
  const item = Menu.getApplicationMenu().getMenuItemById(id);
  return { enabled: item.enabled, checked: item.checked, accelerator: item.accelerator, label: item.label };
}, id);
const until = async (check) => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.ok(await check());
};
try {
  await (await app.firstWindow()).locator('.start-window').waitFor();
  const bookItems = await app.evaluate(({ Menu }) => {
    const menus = Menu.getApplicationMenu().items;
    if (!menus.some((item) => item.label === 'Book')) throw new Error('Book menu missing');
    return menus.find((item) => item.label === 'Book').submenu.items.filter((item) => item.type !== 'separator').map((item) => ({ label: item.label, enabled: item.enabled }));
  });
  assert.ok(bookItems.every((item) => !item.enabled), 'Book actions are disabled in the start window');
  const parents = await app.evaluate(({ Menu }) => Object.fromEntries(Menu.getApplicationMenu().items.flatMap((parent) =>
    (parent.submenu?.items ?? []).filter((item) => item.id).map((item) => [item.id, parent.label]))));
  assert.equal(parents['import-photos'], 'Book');
  assert.equal(parents.reload, 'Book');
  assert.equal(parents.export, 'File');
  const w = await testBook(app, book, true);
  const ready = () => w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await ready();
  await w.locator('.spread-thumb[data-spread="arriving"]').click();
  await until(async () => (await state('duplicate-spread')).enabled);
  const original = await read();
  await menuAction(app, 'Duplicate Spread');
  await until(async () => (await read()).spreads.length === original.spreads.length + 1);
  await ready();
  const copied = await read();
  const duplicate = copied.spreads[2].id;
  assert.notEqual(duplicate, original.spreads[1].id);
  assert.deepEqual(copied.spreads[2].boxes, Object.fromEntries(Object.entries(original.spreads[1].boxes).map(([id, box]) => [id, { ...box, params: box.params ?? {} }])));
  await until(async () => (await state('move-spread-down')).enabled);
  await menuAction(app, 'Move Spread Down');
  await until(async () => (await read()).spreads[3].id === duplicate);
  await ready();
  await menuAction(app, 'Move Spread Up');
  await until(async () => (await read()).spreads[2].id === duplicate);
  await ready();
  await menuAction(app, 'Delete Spread');
  await until(async () => (await read()).spreads.length === original.spreads.length);
  await ready();
  await menuAction(app, 'Undo Book Edit');
  await until(async () => (await read()).spreads.some(({ id }) => id === duplicate));
  await ready();
  await menuAction(app, 'Add Spread');
  await until(async () => (await read()).spreads.length === original.spreads.length + 2);
  await ready();
  for (const [id, shortcut] of [['duplicate-spread', 'CmdOrCtrl+D'], ['delete-spread', 'CmdOrCtrl+Backspace'], ['move-spread-up', 'Alt+CmdOrCtrl+Up']]) {
    assert.equal((await state(id)).accelerator, shortcut);
  }
  await menuAction(app, 'Hide Sidebar');
  await menuAction(app, 'Book Settings…');
  await w.locator('.document-settings[open]').waitFor();
  assert.equal(await w.getByRole('button', { name: 'Toggle project panel' }).getAttribute('aria-pressed'), 'true');
  const title = w.getByRole('textbox', { name: 'Book title', exact: true });
  await title.focus();
  await until(async () => !(await state('delete-spread')).enabled && !(await state('duplicate-spread')).enabled);
  const count = (await read()).spreads.length;
  await w.keyboard.press('Meta+d');
  await w.keyboard.press('Alt+Meta+ArrowDown');
  // Even an already queued command must respect the active field.
  await menuAction(app, 'Delete Spread');
  await w.waitForTimeout(150);
  assert.equal((await read()).spreads.length, count);
  await w.locator('.spread-thumb').nth(1).click();
  await until(async () => (await state('delete-spread')).enabled);
  const formats = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('book-format').submenu.items.map((item) => ({ id: item.id, checked: item.checked })));
  assert.ok(formats.length > 1);
  const other = formats.find((item) => !item.checked);
  const previousFormat = (await read()).format;
  const ownerId = await (await app.browserWindow(w)).evaluate((window) => window.id);
  await app.evaluate(({ Menu, BrowserWindow }, { id, ownerId }) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id); item.click(item, BrowserWindow.fromId(ownerId));
  }, { id: other.id, ownerId });
  await until(async () => (await read()).format === other.id.slice('book-format:'.length));
  await ready();
  assert.equal((await state(other.id)).checked, true);
  await menuAction(app, 'Undo Book Edit');
  await until(async () => (await read()).format === previousFormat);
  await ready();
  await menuAction(app, 'Show Book Check');
  await w.getByRole('dialog', { name: 'Book check', exact: true }).waitFor();
  await w.keyboard.press('Escape');
  const sample = await menuAction(app, 'Open Sample Project');
  await sample.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await until(async () => !(await state('duplicate-spread')).enabled && !(await state('import-photos')).enabled);
  assert.equal((await state('book-settings')).enabled, true);
  console.log('Book menu passed: grouping, command behavior, Undo, format selection, typing guards, settings, checks and read-only state.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
