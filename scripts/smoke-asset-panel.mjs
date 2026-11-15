import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';

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
  assert.deepEqual(await tabs.allTextContents(), ['Photos 2', 'Texts 1', 'Assets 4']);
  await tabs.nth(2).click();
  await page.locator('.source-manager-embedded .asset-row').first().waitFor();
  assert.equal(await page.locator('.sources-bar [role="tab"][aria-selected="true"]').textContent(), 'Assets 4');
  const rows = page.locator('.source-manager-embedded .asset-row');
  assert.equal(await rows.count(), 4);
  // No previews: the picture of a photo row is its file type's icon, not the photo itself.
  const icons = await page.locator('.asset-icon img').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src')));
  if (process.platform === 'darwin') {
    await until(async () => await page.locator('.asset-icon img').count() === 4, 'Document icons loaded');
    const sources = await page.locator('.asset-icon img').evaluateAll((nodes) => nodes.map((node) => node.src));
    assert.ok(sources.every((src) => src.startsWith('data:image/png')), 'Icons are system images');
    assert.ok(!sources.some((src) => src.includes('/photo/')), 'No photo previews');
    assert.notEqual(new Set(sources).size, 1, 'Types have their own icons');
  } else assert.ok(icons.length <= 4);
  assert.equal(await page.locator('.asset-icon img[src^="imageflow"]').count(), 0);
  // Search narrows the list; opening a Quick Look keeps working from the list.
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('story');
  await until(async () => await rows.count() === 1);
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('');
  await page.locator('.asset-row[data-source="photo:one"]').click();
  await page.keyboard.press('Space');
  await page.locator('dialog.quicklook[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(work, 'assets-tab.png') });
  await tabs.nth(0).click();
  await page.locator('.source-items-photo').waitFor();
  assert.deepEqual(errors, []);
  console.log('Assets tab passed:', work);
} finally { await app.close(); }
