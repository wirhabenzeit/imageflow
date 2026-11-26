import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, menuAction, testBook } from './ui-actions.mjs';

// Marks of a source library and the Filter (ADR 0014) in the real app, against the tests' stand-in for the Lightroom
// Classic plugin: stars, flags and labels on the thumbnails, the View toggle for labels, a rejected photo dimmed, the
// Inspector's rows, and the Filter in a book that also holds a photo of its own. A Lightroom rating filter leaves that
// photo in the strip, the Source pill narrows to one source, a filter rests while its source is deselected, and Quick
// Look steps through what is shown. Nightly only (`npm run test:desktop:suite`).
//
//   node scripts/smoke-source-marks.mjs [--screenshots <folder>]   (the open popover in light and dark)
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.argv.includes('--screenshots') ? process.argv[process.argv.indexOf('--screenshots') + 1] : undefined;
const work = await realpath(await mkdtemp(join(root, '.build/source-marks-')));
const folder = join(work, 'Marks.imageflow');
await build({ entryPoints: [join(root, 'tests/lightroom-fake.ts')], outfile: join(work, 'fake.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
const { FakeLightroom } = await import(pathToFileURL(join(work, 'fake.mjs')).href);
for (const dir of ['template', 'photos', 'texts', 'files']) await mkdir(join(folder, dir), { recursive: true });
await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,printFormat,box,Spread} from 'imageflow';
export default defineTemplate({id:'marks',version:'1',contract:1,format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:100,step:2}}),
spreads:{story:{label:'Story',boxes:{hero:box.photo('Hero')},render:ctx=><Spread><ctx.PhotoBox id="hero" rect={ctx.geometry.spread('bleed')}/></Spread>}}});`);
await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Marks', template: { id: 'marks', version: '1' }, texts: {}, files: {},
  spreads: [{ id: 'one', definition: 'story', boxes: { hero: {} } }] }));
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#b08a5a' } }).jpeg().toFile(join(folder, 'photos/inbook.jpg'));
await writeFile(join(folder, 'photos.json'), JSON.stringify({ inbook: { path: 'photos/inbook.jpg', title: 'In the book' } }));

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const until = async (check, message) => { const end = Date.now() + 30_000; for (;;) { if (await check()) return; assert.ok(Date.now() < end, message); await new Promise((resolve) => setTimeout(resolve, 50)); } };
// Plugin 1.3.0 is the first to send marks.
const plugin = new FakeLightroom(join(work, 'profile/lightroom-bridge.json'), '1.3.0');
try {
  const page = await testBook(app, folder);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.canvas .book-frame-book[data-current][data-ready]').waitFor();
  const summary = async () => (await page.evaluate(() => window.imageflow.currentProject())).value;
  const marked = {
    five: { title: 'Five', rating: 5, pickStatus: 1, colorNameForLabel: 'red' },
    rejected: { title: 'Rejected', rating: 2, pickStatus: -1 },
    four: { title: 'Four', rating: 4, colorNameForLabel: 'blue' },
    plain: { title: 'Plain' },
  };
  const uuids = Object.fromEntries(Object.entries(marked).map(([name, marks], n) => [name, plugin.add(n + 1, { ...marks, color: '#3a6ea5' })]));
  plugin.selection = Object.values(uuids);
  await plugin.connect();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  await menuAction(app, 'Import Selected from Lightroom Classic…');
  await until(async () => Object.keys((await summary()).photoIndex).length === 5, 'the Lightroom photos are in the book');
  const index = (await summary()).photoIndex;
  const id = Object.fromEntries(Object.entries(uuids).map(([name, uuid]) => [name, Object.keys(index).find((key) => index[key].lightroom?.uuid === uuid)]));
  const tile = (name) => page.locator('.source-photo[data-id="' + (id[name] ?? name) + '"]');
  const shown = async () => (await page.locator('.source-items-photo .source-photo').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.id))).sort();
  const names = (...list) => list.map((name) => id[name] ?? name).sort();

  // Thumbnails: filled stars only, a pick flag, a rejected photo dimmed with its cross; colour labels are off by default.
  await until(async () => await tile('five').locator('.source-mark-stars').count() === 1, 'the stars show');
  assert.equal(await tile('five').locator('.source-mark-stars').textContent(), '★★★★★');
  assert.equal(await tile('five').locator('.source-mark-flag-pick').count(), 1);
  assert.equal(await tile('five').locator('.source-mark-color').count(), 0);
  assert.equal(await tile('plain').locator('.source-marks').count(), 0);
  assert.equal(await tile('inbook').locator('.source-marks').count(), 0);
  await until(async () => await tile('rejected').evaluate((node) => node.classList.contains('source-rejected')), 'the rejected photo is dimmed');
  await tile('rejected').locator('img').waitFor();
  assert.ok(await tile('rejected').locator('img').evaluate((node) => Number(getComputedStyle(node).opacity) < 1), 'its picture is dimmed');
  assert.equal(await tile('rejected').locator('.source-mark-flag-reject').count(), 1);
  // View → Lightroom Classic → Show Color Labels puts the label on the tile; Show Stars takes the stars off.
  await menuAction(app, 'Show Color Labels');
  await until(async () => await tile('five').locator('.source-mark-color-red').count() === 1, 'the colour label shows');
  await menuAction(app, 'Show Stars');
  await until(async () => await tile('five').locator('.source-mark-stars').count() === 0, 'the stars are hidden');
  await menuAction(app, 'Show Stars');
  await until(async () => await tile('five').locator('.source-mark-stars').count() === 1, 'and shown again');

  // The Inspector lists every mark of the selected photo.
  await tile('five').click();
  const facts = page.locator('.source-inspector .si-facts').first();
  await facts.getByText('Rating', { exact: true }).waitFor();
  assert.equal(await facts.getByRole('img', { name: '5 of 5 stars' }).count(), 1);
  assert.equal(await facts.locator('dd', { hasText: 'Picked' }).count(), 1);
  assert.equal(await facts.locator('dd', { hasText: 'Red' }).count(), 1);

  // The View menu no longer filters; the Filter does. A Lightroom rating leaves the photo in the book in the strip.
  const trigger = page.locator('.sources-bar .photo-filter-trigger');
  assert.equal(await trigger.getAttribute('data-active'), null);
  await trigger.click();
  const popover = page.getByRole('dialog', { name: 'Filter photos' });
  await popover.waitFor();
  const lightroom = popover.locator('.pf-provider[data-provider="lightroom"]');
  assert.equal(await lightroom.getByRole('heading', { name: 'Lightroom Classic photos', exact: true }).count(), 1);
  assert.equal(await lightroom.locator('.pf-heading .source-origin-lightroom').count(), 1, 'headed by the provider\'s icon');
  assert.equal(await lightroom.locator('.pf-note').count(), 0, 'no note while nothing is set');
  await lightroom.getByRole('radio', { name: '4 stars or more' }).click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(names('five', 'four', 'inbook')), 'four stars or more, and the photo in the book');
  await lightroom.getByText('Photos from other sources stay visible.').waitFor();
  assert.notEqual(await trigger.getAttribute('data-active'), null, 'the button shows that a filter is set');
  assert.equal((await page.locator('.sources-bar [role="tab"][aria-selected="true"] .count').textContent()).trim(), '3/5');
  const chip = page.locator('.sources-bar').getByRole('button', { name: 'Remove filter: Lightroom Classic photos: 4 stars or more' });
  await chip.waitFor();
  assert.equal(await chip.locator('.source-origin-lightroom').count(), 1, 'the chip starts with the provider');
  // Another flag and the popover stays open while filters are combined.
  await lightroom.getByRole('radio', { name: 'Not Rejected' }).click();
  await lightroom.getByRole('button', { name: 'Blue label' }).click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(names('four', 'inbook')), 'blue only, with the book\'s photo');
  if (shots) {
    await mkdir(shots, { recursive: true });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await page.screenshot({ path: join(shots, 'filter-popover-' + colorScheme + '.png') });
    }
    await page.emulateMedia({ colorScheme: null });
  }
  await lightroom.getByRole('button', { name: 'Blue label' }).click();
  await lightroom.getByRole('radio', { name: 'Any' }).click();

  // The Source pill narrows to Lightroom Classic.
  const pill = (name) => popover.locator('.pf-pills').getByRole('button', { name });
  await pill('Lightroom Classic').click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(names('five', 'four')), 'only Lightroom photos of four stars or more');
  // Deselected, Lightroom's section and chip go and its rating rests: the book's photos all show.
  await pill('In Book').click();
  await pill('Lightroom Classic').click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(names('inbook')), 'only the book\'s photo');
  assert.equal(await lightroom.count(), 0, 'no Lightroom section while its source is deselected');
  assert.equal(await chip.count(), 0, 'and no chip');
  // With the Source filter cleared, the rating applies again.
  await pill('In Book').click();
  await until(async () => JSON.stringify(await shown()) === JSON.stringify(names('five', 'four', 'inbook')), 'the rating is back');
  await chip.waitFor();
  await page.keyboard.press('Escape');
  await popover.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('photo-filter-trigger')), true, 'the focus is back on Filter');

  // Quick Look steps through the filtered photos only.
  await tile('five').click();
  await page.keyboard.press('Space');
  const look = page.locator('dialog.quicklook');
  await look.waitFor();
  assert.match(await look.locator('.ql-header .muted').textContent(), / of 3$/);
  const seen = new Set();
  for (let step = 0; step < 4; step++) {
    seen.add((await look.locator('.ql-header h2').textContent()).trim());
    await page.keyboard.press(step < 2 ? 'ArrowRight' : 'ArrowLeft');
  }
  assert.deepEqual([...seen].sort(), ['Five', 'Four', 'In the book'].sort(), [...seen].join(', '));
  await page.keyboard.press('Escape');
  await look.waitFor({ state: 'detached' });

  // Removing the chip removes the filter; Clear Filters clears everything.
  await chip.click();
  await until(async () => (await shown()).length === 5, 'every photo again');
  await trigger.click();
  await popover.getByRole('radio', { name: 'Unused' }).click();
  await popover.getByRole('button', { name: 'Clear Filters' }).click();
  assert.equal(await popover.getByRole('button', { name: 'Clear Filters' }).isDisabled(), true);
  assert.equal(await page.locator('.sources-bar .filter-chip').count(), 0);
  // A click outside closes it.
  await page.locator('.canvas').click({ position: { x: 5, y: 5 } });
  await popover.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('Source marks: thumbnails, View toggles, Inspector rows, a provider\'s filter in a mixed book, Source pills and Quick Look.');
} finally {
  await plugin.quit(true).catch(() => {});
  await closeApp(app);
}
