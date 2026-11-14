import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { menuAction, testBook } from './ui-actions.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/ui-details-'));
const folder = join(work, 'Details.imageflow');
for (const dir of ['template', 'photos', 'texts']) await mkdir(join(folder, dir), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,p,printFormat,box,Spread} from 'imageflow';
export default defineTemplate({id:'details',version:'1',contract:1,format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:100,step:2}}),
spreads:{story:{label:'Story',boxes:{hero:box.photo('Hero'),body:box.markdown('Story',{parameters:{columns:p.enum({label:'Columns',default:'1',options:['1','2','3'],labels:{'1':'Full width','2':'2 columns','3':'3 columns'}}),size:p.number({label:'Body size',default:11,min:8,max:16,step:.5,unit:'pt'}),notes:p.string({label:'Footnote',default:''})}})},render:ctx=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.page('left','bleed')}/><ctx.MarkdownBox id="body" rect={ctx.geometry.page('right','safe')} columns={Number(ctx.boxes.body.params.columns)} style={{fontSize:ctx.boxes.body.params.size+'pt'}}/></Spread>},
other:{label:'Other',boxes:{hero:box.photo('Hero')},render:ctx=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')}/></Spread>}}});`);
await writeFile(join(folder, 'texts/Story.md'), '# A short story\n\nA paragraph for the compact text toolbar.');
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Details', template: { id: 'details', version: '1' }, texts: { text: 'texts/Story.md' },
  spreads: [{ id: 'one', definition: 'story', boxes: { hero: { photo: 'late', crops: { story: { zoom: 2, centerX: .5, centerY: .5 } } }, body: { text: 'text' } } }, { id: 'two', definition: 'story' }] }));
const photoIndex = {};
for (const [id, title, date] of [['late', 'C', '2026:11:03 08:00:00'], ['early', 'A', '2026:11:02 23:50:00'], ['night', 'B', '2026:11:03 00:20:00'], ['estimated', 'D', undefined]]) {
  const image = sharp({ create: { width: 800, height: 600, channels: 3, background: id === 'early' ? '#cbb68b' : '#709fb0' } });
  if (date) image.withExif({ IFD2: { DateTimeOriginal: date, OffsetTimeOriginal: '+02:00' } });
  await image.jpeg().toFile(join(folder, 'photos', id + '.jpg'));
  photoIndex[id] = { path: 'photos/' + id + '.jpg', title };
}
photoIndex.missing = { path: 'photos/Missing.jpg', title: 'Z' };
await writeFile(join(folder, 'photos.json'), JSON.stringify(photoIndex));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const until = async (check, message = 'Operation completed') => { for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)); } assert.ok(await check(), message); };
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
const ready = async (page) => page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
async function popup(command, label) {
  await app.evaluate(({ Menu }, { command, label }) => {
    Menu.prototype.popup = function ({ callback }) {
      const walk = (menu) => menu.items.flatMap((item) => [item, ...item.submenu ? walk(item.submenu) : []]);
      globalThis.lastContext = walk(this).map(({ id, label, enabled }) => ({ id, label, enabled }));
      const item = walk(this).find((item) => label ? item.label === label : item.id === command);
      if (command || label) { if (!item?.enabled) throw new Error('Context action unavailable: ' + (command || label)); item.click(item); }
      callback?.();
    };
  }, { command, label });
}
try {
  const page = await testBook(app, folder);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await ready(page);
  const summary = await current(page);
  assert.equal(summary.photoDates.early.captured, '2026-11-02T23:50:00+02:00');
  assert.equal(summary.photoDates.estimated.capturedEstimated, true);
  const projectBefore = await readFile(join(folder, 'project.json'), 'utf8');
  const photosBefore = await readFile(join(folder, 'photos.json'), 'utf8');
  const historyBefore = summary.history;
  const ids = async () => page.locator('.source-items-photo .source-photo').evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  assert.deepEqual((await ids()).slice(0, 3), ['early', 'night', 'late']);
  await menuAction(app, 'By Day');
  await page.locator('.photo-group-divider').first().waitFor();
  assert.equal(await page.locator('.photo-group-divider').count(), 4);
  await menuAction(app, 'Show Capture Time');
  assert.equal(await page.locator('.photo-capture-time').count(), 4);
  await page.locator('.photo-group-divider').nth(1).click();
  assert.equal(await page.locator('.source-photo[aria-selected="true"]').count(), 2);
  await menuAction(app, 'Custom…');
  const gap = page.getByRole('dialog', { name: 'Group photos by time gap' });
  await gap.getByRole('spinbutton').fill('15'); await gap.getByRole('button', { name: 'Group Photos' }).click();
  await until(async () => await page.locator('.photo-group-divider').count() === 5);
  await menuAction(app, 'Assets…');
  await until(() => app.windows().some((window) => window.url() === 'imageflow://editor/assets'));
  const assets = app.windows().find((window) => window.url() === 'imageflow://editor/assets');
  assets.on('pageerror', (error) => errors.push(error.message));
  await assets.locator('.asset-row').first().waitFor();
  assert.deepEqual(await assets.locator('.asset-row[data-source^="photo:"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.source.slice(6))), await ids());
  await popup(undefined, 'Import Order');
  await assets.locator('.photo-view-menu button').click();
  await until(async () => (await ids())[0] === 'late', 'Assets view preferences propagate to the strip');
  assert.equal(await readFile(join(folder, 'project.json'), 'utf8'), projectBefore);
  assert.equal(await readFile(join(folder, 'photos.json'), 'utf8'), photosBefore);
  assert.deepEqual((await current(page)).history, historyBefore);
  await assets.screenshot({ path: join(work, 'assets.png') });
  await assets.close();
  // Asset actions are the same registry commands in the strip and utility window.
  await page.locator('.source-photo[data-id="early"]').click();
  await page.locator('.si-facts dt').filter({ hasText: /^Captured$/ }).waitFor();
  await page.locator('.source-photo[data-id="estimated"]').click();
  await page.locator('.si-facts dt').filter({ hasText: /^Modified$/ }).waitFor();
  await popup('asset-place');
  await page.locator('.source-photo[data-id="early"]').click({ button: 'right' });
  await until(async () => (await current(page)).project.spreads[0].boxes.hero.photo === 'early');
  await ready(page);
  await popup('asset-preview');
  await page.locator('.source-photo[data-id="early"]').click({ button: 'right' });
  await page.getByRole('dialog', { name: /Quick Look/ }).waitFor();
  assert.match(await page.getByRole('dialog', { name: /Quick Look/ }).innerText(), /Captured/);
  await page.keyboard.press('Escape');
  // Compact text controls save through the existing Undo path, with longer controls in the gear panel.
  await page.locator('.spread-thumb[data-spread="one"]').click();
  await page.getByRole('button', { name: 'Edit Story', exact: true }).click();
  const toolbar = page.locator('.edit-popover-compact');
  await toolbar.waitFor();
  assert.ok((await toolbar.boundingBox()).height < 90, 'Markdown toolbar stays one row');
  await page.screenshot({ path: join(work, 'toolbar.png') });
  await toolbar.getByRole('radio', { name: '2 columns' }).click();
  await toolbar.getByRole('spinbutton', { name: 'Body size', exact: true }).fill('12.5');
  await toolbar.getByRole('button', { name: 'Done', exact: true }).click();
  await until(async () => (await current(page)).project.spreads[0].boxes.body.params.size === 12.5);
  assert.equal((await current(page)).project.spreads[0].boxes.body.params.columns, '2');
  await ready(page);
  await page.getByRole('button', { name: 'Edit Story', exact: true }).click();
  await toolbar.getByLabel('More settings', { exact: true }).click();
  await toolbar.getByRole('textbox', { name: 'Footnote' }).fill('Remember this');
  await toolbar.getByRole('button', { name: 'Done', exact: true }).click();
  await until(async () => (await current(page)).project.spreads[0].boxes.body.params.notes === 'Remember this');
  await ready(page);
  // Canvas photo context actions target the clicked box and preserve Undo history.
  await page.locator('.spread-thumb[data-spread="one"]').click();
  await popup('box-remove-photo');
  const photo = await page.frameLocator('.canvas .book-frame-book:not(.book-frame-pending)').locator('[data-spread="one"] [data-box="hero"]').boundingBox();
  await page.mouse.click(photo.x + photo.width / 2, photo.y + photo.height / 2, { button: 'right' });
  await until(async () => !(await current(page)).project.spreads[0].boxes.hero.photo);
  await ready(page); await page.locator('.canvas').focus();
  await menuAction(app, 'Undo Book Edit');
  await until(async () => (await current(page)).project.spreads[0].boxes.hero.photo === 'early');
  await ready(page);
  await popup('change-layout', 'Other');
  await page.locator('.spread-thumb[data-spread="one"]').click({ button: 'right' });
  await until(async () => (await current(page)).project.spreads[0].definition === 'other');
  await ready(page);
  await page.locator('.spread-thumb[data-spread="one"]').click();
  await page.locator('.spread-thumb[data-spread="two"]').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.spread-thumb[aria-pressed="true"]').count(), 2);
  await popup('duplicate-spread');
  await page.locator('.spread-thumb[data-spread="two"]').click({ button: 'right' });
  await until(async () => (await current(page)).project.spreads.length === 4);
  assert.ok((await app.evaluate(() => globalThis.lastContext)).some(({ label }) => label === 'Duplicate 2 Spreads'));
  await ready(page);
  await page.locator('.canvas').focus(); await menuAction(app, 'Undo Book Edit');
  await until(async () => (await current(page)).project.spreads.length === 2);
  // The utility library and welcome screen use the same native command definitions.
  await page.evaluate(() => window.imageflow.showTemplates());
  await until(() => app.windows().some((window) => window.url() === 'imageflow://editor/templates'));
  const templates = app.windows().find((window) => window.url() === 'imageflow://editor/templates');
  const templateRow = templates.locator('.template-library-row').first(); await templateRow.waitFor();
  await popup(); await templateRow.click({ button: 'right' });
  const templateCommands = await app.evaluate(() => globalThis.lastContext.map(({ id }) => id));
  assert.ok(templateCommands.includes('template-export') && templateCommands.includes('template-new') && templateCommands.includes('template-reveal'));
  await app.evaluate(({ dialog }) => { globalThis.templateNewAsked = false; dialog.showSaveDialog = async () => { globalThis.templateNewAsked = true; return { canceled: true }; }; });
  await popup('template-new'); await templateRow.click({ button: 'right' });
  await until(() => app.evaluate(() => globalThis.templateNewAsked));
  assert.equal(templates.isClosed(), false, 'Cancelling New Book leaves the library open');
  await templates.close();
  await page.locator('.book-check-toggle').click();
  const issue = page.locator('.book-check-panel li').first(); await issue.waitFor();
  const message = await issue.innerText();
  await popup('issue-copy'); await issue.click({ button: 'right' });
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), message);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(work, 'details.png') });
  await page.close();
  await until(() => app.windows().some((window) => window.url() === 'imageflow://editor/start'));
  const welcome = app.windows().find((window) => window.url() === 'imageflow://editor/start');
  const recent = welcome.locator('.recent-books li').filter({ hasText: 'Details' }); await recent.waitFor();
  await popup('recent-remove'); await recent.click({ button: 'right' });
  await recent.waitFor({ state: 'detached' });
  console.log('Photo dates, shared view preferences, grouping, asset actions, compact Markdown controls and canvas context menus passed:', work);
} finally { await app.close(); }
