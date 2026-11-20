import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';

// The bottom panel's Assets tab: every asset of the book as a plain list with its system document icon.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/asset-panel-'));
const folder = join(work, 'Panel.imageflow');
for (const dir of ['template', 'photos', 'texts', 'files']) await mkdir(join(folder, dir), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,printFormat,box,Spread} from 'imageflow';
export default defineTemplate({id:'panel',version:'1',contract:1,format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:100,step:2}}),
spreads:{story:{label:'Story',boxes:{hero:box.photo('Hero')},render:ctx=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')}/></Spread>}}});`);
await writeFile(join(folder, 'texts/Story.md'), '# A short story\n\nA paragraph.');
await writeFile(join(folder, 'files/data.csv'), 'a,b\n1,2\n');
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Panel', template: { id: 'panel', version: '1' }, texts: { text: 'texts/Story.md' },
  files: { data: 'files/data.csv' }, spreads: [{ id: 'one', definition: 'story', boxes: { hero: { photo: 'one' } } }] }));
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#709fb0' } }).jpeg().toFile(join(folder, 'photos/one.jpg'));
await writeFile(join(folder, 'photos.json'), JSON.stringify({ one: { path: 'photos/one.jpg', title: 'One' }, gone: { path: 'photos/Gone.jpg', title: 'Gone' } }));

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const until = async (check, message = 'Operation completed') => { for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)); } assert.ok(await check(), message); };
try {
  const page = await testBook(app, folder);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  const tabs = page.locator('.sources-bar [role="tab"]');
  // Photos and texts have their own tabs; Assets holds the other assets, the book's files.
  assert.deepEqual(await tabs.allTextContents(), ['Photos 2', 'Texts 1', 'Assets 1']);
  await tabs.nth(2).click();
  await page.locator('.source-manager-embedded .asset-row').first().waitFor();
  assert.equal(await page.locator('.sources-bar [role="tab"][aria-selected="true"]').textContent(), 'Assets 1');
  const rows = page.locator('.source-manager-embedded .asset-row');
  assert.equal(await rows.count(), 1);
  assert.equal(await page.locator('.source-manager-embedded .asset-row[data-source="file:data"]').count(), 1);
  // No previews or photo tools: the list is plain and its picture is the file type's icon.
  assert.equal(await page.locator('.source-manager-embedded .new-markdown', { hasText: 'New Text' }).count(), 0);
  assert.equal(await page.locator('.source-manager-embedded .photo-view-menu').count(), 0);
  assert.equal(await rows.first().getAttribute('draggable'), 'true', 'a file can be dragged onto a file setting (F-028)');
  if (process.platform === 'darwin') {
    await until(async () => await page.locator('.asset-icon img').count() === 1, 'Document icon loaded');
    const [source] = await page.locator('.asset-icon img').evaluateAll((nodes) => nodes.map((node) => node.src));
    assert.ok(source.startsWith('data:image/png'), 'The icon is a system image');
  }
  assert.equal(await page.locator('.asset-icon img[src^="imageflow"]').count(), 0);
  // This template declares no file parameter, so there is nothing to import.
  assert.equal(await page.getByRole('button', { name: 'Import…' }).isDisabled(), true);
  // Search narrows the list.
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('story');
  await until(async () => await rows.count() === 0);
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('data');
  await until(async () => await rows.count() === 1);
  await page.screenshot({ path: join(work, 'assets-tab.png') });
  // Rename… edits the name in its row (F-027); a file is chosen in a spread's settings, which the menu says (F-027).
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function ({ callback }) {
      const walk = (menu) => menu.items.flatMap((item) => [item, ...item.submenu ? walk(item.submenu) : []]);
      globalThis.lastContext = walk(this).map(({ id, label, enabled }) => ({ id, label, enabled }));
      walk(this).find((item) => item.id === 'asset-rename')?.click();
      callback?.();
    };
  });
  await rows.first().click({ button: 'right' });
  const context = await app.evaluate(() => globalThis.lastContext);
  assert.ok(context.some(({ id, enabled }) => id === 'asset-place-file' && !enabled), JSON.stringify(context));
  assert.ok(!context.some(({ id }) => id === 'asset-place'));
  const field = page.getByRole('textbox', { name: 'New name for data.csv' });
  await field.waitFor();
  assert.equal(await field.evaluate((input) => input.value.slice(input.selectionStart, input.selectionEnd)), 'data', 'the name without its extension is selected');
  await page.keyboard.type('Söng Kul');
  await page.keyboard.press('Space');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('');
  await page.locator('.source-manager-embedded .asset-row strong', { hasText: 'Söng Kul.csv' }).waitFor({ timeout: 5000 }).catch(async (error) => {
    console.error('Rename failed:', JSON.stringify({ rows: await rows.allTextContents(), alerts: await page.locator('[role="alert"], [role="status"]').allTextContents() }));
    throw error;
  });
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(folder, 'project.json'), 'utf8'));
  assert.equal(manifest.files.data, 'files/Söng Kul.csv');
  await until(async () => await rows.count() === 1);
  // An unassigned file is removed at once. A book without files and file parameters has no Assets tab, so the strip
  // returns to photos.
  await rows.first().click();
  await page.keyboard.press('Delete');
  await until(async () => await tabs.count() === 2);
  assert.deepEqual(await tabs.allTextContents(), ['Photos 2', 'Texts 1']);
  await page.locator('.source-items-photo').waitFor();
  assert.deepEqual(errors, []);
  console.log('Assets tab passed:', work);
} finally { await closeApp(app); }
