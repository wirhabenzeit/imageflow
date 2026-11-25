import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, popupAction, testBook } from './ui-actions.mjs';

// The 25 November evening beta findings in the app: a photo only set aside is not marked used (UI-016), a choice too
// wide for the Inspector becomes a menu instead of scrolling it sideways (UI-015), and a placed photo's caption is
// edited where the photo is, switching on the box setting that shows it (UI-014).
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/photo-captions-'));
const folder = join(work, 'Captions.imageflow');
for (const dir of ['template', 'photos']) await mkdir(join(folder, dir), { recursive: true });
const variants = { bleed: 'Full bleed', margins: 'In the margins', landscape: 'Landscape', framed: 'Framed', small: 'Small' };
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,p,printFormat,box,Spread} from 'imageflow';
const caption = p.boolean({label:'Show caption',default:false,shows:'caption'});
const single = (style: string, label: string) => ({label, family:'single', variant:{style}, boxes:{hero:box.photo('Photo',{caption})},
  render:(ctx: any)=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.page('left','safe')}/>{ctx.boxes.hero.params.caption && ctx.boxes.hero.photo?.caption
    ? <p className="caption" style={ctx.geometry.css({x:mm(120),y:mm(20),width:mm(60),height:mm(20)})}>{ctx.boxes.hero.photo.caption}</p> : null}</Spread>});
export default defineTemplate({id:'captions',version:'1',contract:1,
format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:100,step:2}}),
layoutFamilies:{single:{label:'Single photo',picker:{label:'Single photo',choice:{tag:'style',options:${JSON.stringify(variants)}}}}},
spreads:{${Object.entries(variants).map(([style, label]) => `${style}:single('${style}','${label}')`).join(',')},
trio:{label:'Three photos',boxes:{hero:box.photo('Photo'),third:box.photo('Third')},render:(ctx: any)=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.page('left','safe')}/><ctx.PhotoBox id="third" rect={ctx.geometry.page('right','safe')}/></Spread>}}});`);
// As after switching from Three photos: the third photo is stored on the spread, and its layout has no box for it.
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Captions', template: { id: 'captions', version: '1' },
  spreads: [{ id: 'one', definition: 'bleed', boxes: { hero: { photo: 'shown' }, third: { photo: 'aside' } } }] }));
for (const [id, background] of [['shown', '#709fb0'], ['aside', '#cbb68b'], ['loose', '#8b6f9a']]) {
  await sharp({ create: { width: 800, height: 600, channels: 3, background } }).jpeg().toFile(join(folder, 'photos', id + '.jpg'));
}
await writeFile(join(folder, 'photos.json'), JSON.stringify(Object.fromEntries(['shown', 'aside', 'loose'].map((id) => [id, { path: 'photos/' + id + '.jpg', title: id }]))));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const until = async (check, message = 'Operation completed') => { for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)); } assert.ok(await check(), message); };
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
try {
  const page = await testBook(app, folder);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();

  // UI-016: the placed photo has its check mark; the one set aside has none, and says where it is.
  await page.locator('.source-photo[data-id="shown"] .badge[aria-label="Used once"]').waitFor();
  await until(async () => /set aside on page/.test(await page.locator('.source-photo[data-id="aside"]').getAttribute('title') ?? ''), 'the tile names where it is set aside');
  assert.equal(await page.locator('.source-photo[data-id="aside"] .badge').count(), 0);
  await page.locator('.source-photo[data-id="aside"]').click();
  await page.locator('.source-inspector').getByText('Not placed').waitFor();
  await page.locator('.source-inspector').getByText('Set aside on').waitFor();
  await popupAction(app, page, page.locator('.sources-bar .photo-view-menu button'), 'Unused only');
  await until(async () => await page.locator('.source-photo').count() === 2, 'Unused lists the photo set aside and the loose one');
  assert.deepEqual(await page.locator('.source-photo').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.id).sort()), ['aside', 'loose']);

  // UI-015: five variants do not fit the Inspector, so the choice is a menu, and the Inspector does not scroll sideways.
  await page.locator('.spread-thumb[data-spread="one"]').click();
  const family = page.locator('.inspector .layout-family-field');
  await family.waitFor();
  await until(async () => await family.locator('select').count() === 1, 'the overflowing choice became a menu');
  const inspector = page.locator('.inspector');
  assert.ok(await inspector.evaluate((node) => node.scrollWidth <= node.clientWidth), 'the Inspector does not scroll sideways');
  await family.locator('select').selectOption({ label: 'Framed' });
  await until(async () => (await current(page)).project.spreads[0].definition === 'framed', 'the menu chooses a variant');

  // UI-014: Caption… beside the box's settings; the first caption switches on Show caption, a click elsewhere saves it.
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  await page.getByRole('button', { name: 'Edit Photo', exact: true }).click();
  const toolbar = page.locator('.crop-toolbar');
  await toolbar.getByRole('button', { name: 'Caption…' }).click();
  await toolbar.getByRole('textbox', { name: 'Caption of shown' }).fill('At the pass');
  await page.locator('.spread-thumb[data-spread="one"]').click();
  await until(async () => (await current(page)).photoIndex.shown.caption === 'At the pass', 'the caption is saved when the photo is deselected');
  assert.equal((await current(page)).project.spreads[0].boxes.hero.params.caption, true, 'Show caption is switched on for the first caption');

  // Edit Caption… in the Inspector's list opens the field at once; Escape keeps the saved caption.
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  const items = await popupAction(app, page, page.getByRole('button', { name: 'Edit Photo', exact: true }), 'Edit Caption…', { button: 'right' });
  assert.ok(items.some(({ label }) => label === 'Edit Caption…'));
  const field = page.getByRole('textbox', { name: 'Caption of shown' });
  await until(async () => await field.count() === 1 && await field.evaluate((node) => node === document.activeElement), 'the caption field opens in focus');
  assert.equal(await field.evaluate((node) => getComputedStyle(node).resize), 'vertical', 'the field has the app’s field styles');
  await field.fill('Discarded');
  await page.keyboard.press('Escape');
  await until(async () => await field.count() === 0, 'Escape closes the caption');
  assert.equal((await current(page)).photoIndex.shown.caption, 'At the pass');
  // A request is used up: selecting the photo again later opens its toolbar without the caption.
  await toolbar.getByRole('button', { name: 'Done', exact: true }).click();
  await toolbar.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Edit Photo', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Caption…' }).waitFor();
  assert.equal(await field.count(), 0, 'the caption stays closed');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(work, 'captions.png') });
  console.log('Set-aside photos, overflowing choices and captions passed:', work);
} finally { await closeApp(app); }
