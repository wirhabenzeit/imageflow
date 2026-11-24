import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, menuAction, testBook } from './ui-actions.mjs';

// Photos of a Lightroom Classic catalog in the real app (ADR 0011, section 2), against the tests' stand-in for the
// plugin: an import that waits for no previews, a photo edited in Develop that keeps its picture marked out of date,
// and Refresh from Lightroom. No Lightroom is involved, and the bridge file is in the app's temporary profile.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/lightroom-')));
const folder = join(work, 'Lightroom.imageflow');
await build({ entryPoints: [join(root, 'tests/lightroom-fake.ts')], outfile: join(work, 'fake.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
const { FakeLightroom, uuid } = await import(pathToFileURL(join(work, 'fake.mjs')).href);
for (const dir of ['template', 'photos', 'texts', 'files']) await mkdir(join(folder, dir), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,printFormat,box,Spread} from 'imageflow';
export default defineTemplate({id:'lightroom',version:'1',contract:1,format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:100,step:2}}),
spreads:{story:{label:'Story',boxes:{hero:box.photo('Hero')},render:ctx=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')}/></Spread>}}});`);
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Lightroom', template: { id: 'lightroom', version: '1' }, texts: {}, files: {},
  spreads: [{ id: 'one', definition: 'story', boxes: { hero: {} } }] }));
await writeFile(join(folder, 'photos.json'), '{}');

const count = 60;
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const until = async (check, message) => { const end = Date.now() + 30_000; for (;;) { if (await check()) return; assert.ok(Date.now() < end, message); await new Promise((resolve) => setTimeout(resolve, 50)); } };
const plugin = new FakeLightroom(join(work, 'profile/lightroom-bridge.json'), '1.1.0');
try {
  const page = await testBook(app, folder);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  const summary = async () => (await page.evaluate(() => window.imageflow.currentProject())).value;
  const statuses = async () => Object.values((await summary()).sources ?? {});
  for (let n = 1; n <= count; n++) plugin.selection.push(plugin.add(n, { title: 'Photo ' + n, color: '#3070' + (16 + n).toString(16) }));
  let open;
  plugin.thumbnailGate = new Promise((resolve) => { open = resolve; });
  await plugin.connect();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });

  // The import is done, saved and in use while Lightroom has not handed over one preview.
  await menuAction(app, 'Import Selected from Lightroom Classic…');
  await until(async () => (await statuses()).length === count, 'The photos are in the book');
  assert.ok((await statuses()).every(({ pending }) => pending), 'their previews are still to come');
  assert.equal(Object.values((await summary()).photoSizes).filter(({ width }) => width === 6000).length, count, 'laid out at their size');
  await until(() => plugin.jobs.some(({ type }) => type === 'thumbnails'), 'and are asked for');
  await page.locator('.source-photo .missing', { hasText: 'Loading…' }).first().waitFor();
  // The book stays editable meanwhile.
  const photo = (await summary()).sources && Object.keys((await summary()).photoIndex)[0];
  const saved = await page.evaluate(async (photo) => {
    const { value } = await window.imageflow.currentProject();
    value.project.spreads[0].boxes.hero = { photo };
    return window.imageflow.saveProject(value.id, { project: value.project, photoIndex: value.photoIndex });
  }, photo);
  assert.ok(saved.value, JSON.stringify(saved));
  open();
  await until(async () => (await statuses()).every(({ state }) => state === 'available'), 'every preview came');
  assert.equal(plugin.jobs.filter(({ type }) => type === 'render').length, 0, 'and nothing was rendered');
  await page.locator('.source-photo img').first().waitFor();
  assert.equal(await page.locator('.source-photo .missing').count(), 0);

  // Edited in Develop, where Lightroom has no preview of it: it keeps its picture and says so.
  const index = (await summary()).photoIndex;
  const edited = index[photo].lightroom.uuid;
  const status = async () => (await summary()).sources['photo:' + photo];
  const picture = async () => (await summary()).photoRevisions[photo];
  const before = await picture();
  plugin.refused.add(edited);
  plugin.edit(edited, { develop: { Exposure2012: 1 }, color: '#f02020' });
  await plugin.changes([edited]);
  await until(async () => (await status()).outOfDate, 'the edited photo is out of date');
  assert.equal(await picture(), before);
  await page.locator('.source-photo[data-id="' + photo + '"] .source-storage', { hasText: 'Out of date' }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const asked = plugin.jobs.length;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(plugin.jobs.length, asked, 'nothing is asked again and again while there is none');
  assert.equal(plugin.jobs.filter(({ type }) => type === 'render').length, 0);
  // Back in Library the plugin reports it, and its new picture shows.
  plugin.refused.delete(edited);
  await plugin.changes([edited]);
  await until(async () => !(await status()).outOfDate && await picture() !== before, 'the new picture shows');
  assert.equal(plugin.jobs.filter(({ type }) => type === 'render').length, 0);

  // Refresh from Lightroom renders, also of a photo with no preview.
  plugin.refused.add(edited);
  plugin.edit(edited, { develop: { Exposure2012: 2 }, color: '#20f020' });
  await plugin.changes([edited]);
  await until(async () => (await status()).outOfDate, 'out of date again');
  const result = await page.evaluate((key) => window.imageflow.sourceAction({ action: 'refresh', keys: [key] }), 'photo:' + photo);
  assert.ok(result.value?.message, JSON.stringify(result));
  await until(async () => !(await status()).outOfDate, 'refreshed');
  assert.deepEqual(plugin.jobs.filter(({ type }) => type === 'render').map(({ uuids }) => uuids), [[edited]]);

  // A photo with no picture at all that Lightroom refuses is rendered.
  plugin.selection = [plugin.add(count + 1, { color: '#8040c0' })];
  plugin.refused.add(uuid(count + 1));
  await menuAction(app, 'Import Selected from Lightroom Classic…');
  await until(async () => { const all = await statuses(); return all.length === count + 1 && all.every(({ state }) => state === 'available'); }, 'the refused photo has a picture');
  assert.equal(plugin.jobs.filter(({ type }) => type === 'render').length, 2);
  assert.deepEqual(errors, []);
  console.log('Lightroom: import without waiting, out of date in Develop, updated in Library, refreshed on request.');
} finally {
  await plugin.quit(true).catch(() => {});
  await closeApp(app);
}
