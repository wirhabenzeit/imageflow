import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { menuAction, testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/ui-polish-'));
const folder = join(work, 'Polish.imageflow');
await mkdir(join(folder, 'template'), { recursive: true });
await mkdir(join(folder, 'photos'));
await writeFile(join(folder, 'template/index.tsx'), `import { defineTemplate, mm, p, printFormat, Spread, box } from 'imageflow';
const make = (height) => printFormat({label:'Size '+height,trim:{width:mm(100),height:mm(height)},bleed:{all:mm(3),binding:mm(0)},safe:mm(5),ends:'single-pages',pageCount:{min:2,max:100,step:2}});
export default defineTemplate({id:'polish',version:'1',contract:1,formats:{small:make(100),tall:make(170)},parameters:{show:p.boolean({label:'Show footer',default:true}),footer:p.string({label:'Footer',default:'Trip'})},
controls:['show',{group:'Details',when:{show:true},controls:[{parameter:'footer',label:'Book footer'}]}],
spreads:Object.fromEntries(['right','spread','left'].map(span=>[span,{label:span,span,boxes:{hero:box.photo('Hero')},render:ctx=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')}/>{ctx.document.show&&<span style={{position:'absolute',top:'5mm',left:'5mm'}}>{ctx.document.footer}</span>}</Spread>}]))});`);
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Polish', template: { id: 'polish', version: '1' },
  spreads: Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, definition: i === 0 ? 'right' : i === 9 ? 'left' : 'spread', boxes: { hero: { photo: 'image' } } })) }));
await writeFile(join(folder, 'photos.json'), JSON.stringify({ image: { path: 'photos/Photo.png' } }));
await sharp({ create: { width: 3200, height: 2200, channels: 3, background: '#709fb0' } }).png().toFile(join(folder, 'photos/Photo.png'));
const external = join(work, 'mixed');
await mkdir(join(external, '.hidden'), { recursive: true });
await sharp({ create: { width: 80, height: 120, channels: 3, background: '#a17b65' } }).png().toFile(join(external, 'Portrait.png'));
await writeFile(join(external, 'Story.md'), '# Hello\n\nA story.');
await writeFile(join(external, 'Skip.txt'), 'Skip');
await writeFile(join(external, 'Broken.jpg'), 'unreadable image');
await writeFile(join(external, '.hidden/Hidden.md'), 'Hidden');
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 20000 });
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
const until = async (check) => { for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)); } assert.ok(await check(), 'Book operation settled'); };
const ready = async (page) => page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();

try {
  const page = await testBook(app, folder);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await ready(page);
  const settings = page.locator('.document-settings');
  await settings.locator('summary').click();
  assert.equal(await settings.getByLabel('Book footer', { exact: true }).count(), 1);
  await settings.getByLabel('Book footer', { exact: true }).fill('WWW');
  await page.keyboard.press('Tab');
  await ready(page);
  assert.equal(await page.locator('.presentation').count(), 0, 'Typing W in a field must not present');
  // Copy/link belongs to this book and is undoable.
  await page.locator('.canvas').focus();
  const policyBefore = await page.evaluate(async () => (await window.imageflow.currentProject()).value.id);
  await menuAction(app, 'Copy Assets into Book');
  await until(async () => { const value = await current(page); return value.id !== policyBefore && value.project.importMode === 'link'; });
  await ready(page);
  const undoBefore = await page.evaluate(async () => (await window.imageflow.currentProject()).value.id);
  await menuAction(app, 'Undo Book Edit');
  await until(async () => { const value = await current(page); return value.id !== undoBefore && value.project.importMode !== 'link'; });
  await ready(page);
  // Format changes preserve the visible spread, even if a different spread was selected earlier.
  await page.locator('.spread-thumb[data-spread="s6"]').click();
  const anchor = async () => {
    const frame = page.frameLocator('.canvas .book-frame-book:not(.book-frame-pending)');
    const sheet = await frame.locator('[data-spread="s6"] .if-sheet').boundingBox();
    const viewport = await page.locator('.canvas').boundingBox();
    return { sheet, viewport, relative: (viewport.y + viewport.height / 2 - sheet.y) / sheet.height };
  };
  await page.waitForTimeout(400);
  const before = await anchor();
  await page.screenshot({path:join(work,'before.png')});
  await settings.getByRole('combobox').selectOption('tall');
  await ready(page);
  await page.waitForTimeout(400);
  const after = await anchor();
  await page.screenshot({path:join(work,'after.png')});
  assert.ok(Math.abs(after.relative - before.relative) < .025, JSON.stringify({ before, after }));
  await menuAction(app, 'Zoom In');
  await page.waitForTimeout(250);
  const beforePanel = await anchor();
  await menuAction(app, 'Hide Sources');
  await page.waitForTimeout(250);
  const afterPanel = await anchor();
  assert.ok(Math.abs(beforePanel.relative - afterPanel.relative) < .025, 'Panel changes preserve the reading position at manual zoom');
  await menuAction(app, 'Show Sources');
  await page.waitForTimeout(250);
  // Native context menu acts on the right-clicked spread, independently of the old selection.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function ({ callback }) {
      const item = this.items.find((item) => item.id === 'presentation');
      if (item) item.click(item);
      callback?.();
    };
  });
  await page.locator('.spread-thumb[data-spread="s3"]').click({ button: 'right' });
  await page.locator('.presentation').waitFor();
  const proof = page.frameLocator('.presentation .book-frame-present:not(.book-frame-pending)');
  await proof.locator('.if-presentation .if-present-crop:visible').waitFor();
  assert.match(await page.locator('.presentation-indicator').textContent(), /pp\. 6–7/);
  assert.equal(await proof.locator('.if-presentation .if-placeholder, .if-presentation [data-edit]').count(), 0);
  const photo = proof.locator('.if-present-crop:visible img').first();
  assert.match(await photo.getAttribute('src'), /\/proof-photo\//);
  assert.equal(await photo.evaluate((image) => image.naturalWidth), 3200);
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator('.presentation-indicator').textContent(), /pp\. 8–9/);
  await page.keyboard.press('f');
  assert.match(await page.locator('.presentation-indicator').textContent(), /p\. 8/);
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator('.presentation-indicator').textContent(), /p\. 9/);
  await page.keyboard.press('b');
  await page.keyboard.press('g');
  await proof.locator('.if-presentation.overview').waitFor();
  assert.equal(await proof.locator('.if-present-crop').count(), 10);
  await page.keyboard.press('Enter');
  await page.keyboard.press('1'); await page.keyboard.press('Enter');
  assert.match(await page.locator('.presentation-indicator').textContent(), /p\. 1 /);
  await page.keyboard.press('1'); await page.keyboard.press('3'); await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.locator('.presentation').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.spread-thumb[data-spread="s6"]').getAttribute('aria-current'), 'page');
  await ready(page);
  await page.waitForTimeout(300);
  const returned = await anchor();
  assert.ok(returned.sheet.y < returned.viewport.y + returned.viewport.height && returned.sheet.y + returned.sheet.height > returned.viewport.y, 'Editor reveals the last presented spread');
  // Mixed recursive imports skip unknown files and hidden folders, following the book's policy.
  const importBefore = await page.evaluate(async () => (await window.imageflow.currentProject()).value.id);
  await menuAction(app, 'Copy Assets into Book');
  await until(async () => { const value = await current(page); return value.id !== importBefore && value.project.importMode === 'link'; });
  await ready(page);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, external);
  await menuAction(app, 'Import…');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('1 unsupported file skipped'));
  const result = await page.evaluate(async () => (await window.imageflow.currentProject()).value);
  assert.equal(Object.keys(result.photoIndex).length, 2);
  assert.equal(Object.keys(result.project.texts).length, 1);
  assert.equal(Object.values(result.sources).filter(({ linked }) => linked).length, 2);
  assert.match(await page.locator('.status').innerText(), /1 unreadable or invalid file skipped/);
  const emptyFolder = join(work, 'empty'); await mkdir(emptyFolder);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, emptyFolder);
  await menuAction(app, 'Import…');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('No files found to import'));
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, join(external, 'Skip.txt'));
  await menuAction(app, 'Import…');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('No supported files were selected'));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(work, 'editor.png') });
  console.log('UI polish smoke passed:', work);
} finally { await app.close(); }
