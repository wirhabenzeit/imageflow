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
    if (!menus.some((item) => item.label === 'Templates')) throw new Error('Template library menu missing');
    return menus.find((item) => item.label === 'Book').submenu.items.filter((item) => item.type !== 'separator').map((item) => ({ label: item.label, enabled: item.enabled }));
  });
  assert.ok(bookItems.every((item) => !item.enabled), 'Book actions are disabled in the start window');
  const parents = await app.evaluate(({ Menu }) => Object.fromEntries(Menu.getApplicationMenu().items.flatMap((parent) =>
    (parent.submenu?.items ?? []).filter((item) => item.id).map((item) => [item.id, parent.label]))));
  assert.equal(parents['import-photos'], undefined, 'Imports live in a nested File submenu');
  assert.equal(parents.reload, undefined, 'Reload lives under File → Revert To');
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
  for (const [id, shortcut] of [['duplicate-spread', 'CmdOrCtrl+D'], ['delete-spread', 'Backspace'], ['move-spread-up', 'Alt+CmdOrCtrl+Up']]) {
    assert.equal((await state(id)).accelerator, shortcut);
  }
  assert.equal(await w.locator('.project-identity strong').textContent(), 'Book');
  assert.equal(await w.getByLabel('Book title', { exact: true }).count(), 0);
  assert.equal(await app.evaluate(({ Menu }) => !!Menu.getApplicationMenu().getMenuItemById('book-settings')), false);
  assert.equal(await app.evaluate(({ Menu }) => !!Menu.getApplicationMenu().getMenuItemById('edit-template')), false);
  await w.locator('.template-controls > summary').click();
  await w.locator('.template-controls').getByLabel('Page numbers').waitFor();
  const format = w.locator('.template-controls').getByRole('combobox', { name: 'Format' });
  await format.focus();
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
  const options = await format.locator('option').evaluateAll((items) => items.map((item) => item.value));
  const previousFormat = await format.inputValue();
  const previousStoredFormat = (await read()).format;
  const other = options.find((id) => id !== previousFormat);
  await format.selectOption(other);
  await until(async () => (await read()).format === other);
  await w.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  await until(async () => await w.getByRole('button', { name: 'Undo', exact: true }).isEnabled());
  await ready();
  assert.equal(await format.inputValue(), other);
  await format.blur();
  await until(async () => (await state('undo')).enabled);
  await menuAction(app, 'Undo Book Edit');
  await until(async () => (await read()).format === previousStoredFormat);
  await ready();
  await menuAction(app, 'Show Book Check');
  await w.getByRole('dialog', { name: 'Book check', exact: true }).waitFor();
  await w.keyboard.press('Escape');
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.some((parent) => parent.submenu?.items.some((item) => item.label === 'Explore a Sample'))), false);
  assert.equal((await state('undo')).label.startsWith('Undo '), true);
  assert.equal((await state('grid-columns')).enabled, false);
  assert.equal((await state('export')).accelerator, 'CmdOrCtrl+E');
  assert.equal((await state('print')).accelerator, 'CmdOrCtrl+Shift+E');
  console.log('Book menu passed: grouping, command behavior, Undo, format selection, typing guards, settings, checks and read-only state.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
