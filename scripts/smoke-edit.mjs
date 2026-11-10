import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import electron from 'electron';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

// Click-to-edit: nodes marked with ctx.edit() open a popover that edits their parameters in place.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'edit-'));
const project = join(work, 'Book');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await app.firstWindow();
  w.setDefaultTimeout(20000);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, project);
  await w.getByRole('button', { name: 'New project…', exact: true }).click();
  const ready = () => w.waitForSelector('iframe.book-frame-book[data-current][data-ready]');
  await ready();
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const status = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.deepEqual(status.warnings, []);
  const center = async (selector) => {
    await frame.locator(selector).scrollIntoViewIfNeeded();
    await w.waitForTimeout(150);
    const box = await frame.locator(selector).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  // Heading on the title page
  let at = await center('[data-spread="title"] [data-edit="heading"]');
  await w.mouse.move(at.x, at.y);
  await w.locator('.edit-target').waitFor();
  await w.mouse.click(at.x, at.y);
  const popover = w.getByRole('dialog', { name: 'Edit Heading' });
  await popover.waitFor();
  const input = popover.getByRole('textbox', { name: 'Heading' });
  assert.equal(await input.evaluate((el) => el === document.activeElement), true);
  await input.fill('North of the Arctic');
  await input.press('Meta+Enter');
  await popover.waitFor({ state: 'detached' });
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Heading updated');
  assert.equal((await read()).spreads[0].params.heading, 'North of the Arctic');
  await ready();
  assert.equal(await frame.locator('[data-spread="title"] h1').textContent(), 'North of the Arctic');
  
  // Escape discards
  at = await center('[data-spread="title"] [data-edit="subtitle"]');
  await w.mouse.click(at.x, at.y);
  const sub = w.getByRole('dialog', { name: 'Edit Subtitle' });
  await sub.getByRole('textbox').fill('discard me');
  await sub.getByRole('textbox').press('Escape');
  await sub.waitFor({ state: 'detached' });
  assert.notEqual((await read()).spreads[0].params.subtitle, 'discard me');
  
  // Calendar: month picker + week start in one popover
  await w.getByRole('button', { name: 'Calendar spread 14–15', exact: true }).click();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  const cal = w.getByRole('dialog', { name: 'Edit Month, Week starts' });
  await cal.waitFor();
  await cal.locator('input[type="month"]').fill('2027-08');
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Month updated');
  assert.equal((await read()).spreads[7].elements.grid.params.month, '2027-08-01');
  await ready();
  assert.match(await frame.locator('[data-spread="march"] [data-element="grid"] h3').textContent(), /August 2027/);
  await cal.getByRole('radio', { name: 'Sunday' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Week starts updated');
  assert.equal((await read()).spreads[7].elements.grid.params.firstWeekday, 'sunday');
  assert.ok(await cal.isVisible());
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  assert.equal((await read()).spreads[7].elements.grid?.params?.firstWeekday ?? 'monday', 'monday');

  // Clicking a text box edits its own options (columns) plus the body size the template marks it with.
  at = await center('[data-spread="arriving"] [data-box="body"]');
  await w.mouse.click(at.x, at.y);
  const story = w.getByRole('dialog', { name: 'Edit Columns, Body size' });
  await story.waitFor();
  assert.match(await story.locator('.ep-head').textContent(), /^Story/);
  await story.getByRole('radio', { name: '2 columns' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Columns updated');
  await w.keyboard.press('Escape');
  await ready();
  assert.equal((await read()).spreads[1].boxes.body.params.columns, '2');
  assert.equal(await frame.locator('[data-spread="arriving"] [data-box="body"]').getAttribute('data-columns'), '2');
  const flowed = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.deepEqual(flowed.errors, []);
  assert.deepEqual(flowed.flow['arriving:body'], { part: 1, parts: 3, title: 'arrival.md' });

  // Crop mode: double-click a photo, drag and zoom it, commit as one edit; Esc discards; Undo removes it.
  at = await center('[data-spread="arriving"] [data-box="hero"]');
  await w.mouse.dblclick(at.x, at.y);
  await w.locator('.crop-editor').waitFor();
  await w.mouse.move(at.x, at.y);
  await w.mouse.down();
  await w.mouse.move(at.x - 120, at.y, { steps: 8 });
  await w.mouse.up();
  await w.mouse.wheel(0, -240);
  assert.match(await w.locator('.crop-ppi').textContent(), /^\d+ ppi$/);
  await w.keyboard.press('Enter');
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Crop updated');
  await ready();
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  const crop = (await read()).spreads[1].boxes.hero.crop;
  assert.ok(crop.centerX > 0.5 && crop.zoom > 1, JSON.stringify(crop));
  await w.mouse.dblclick(at.x, at.y);
  await w.locator('.crop-editor').waitFor();
  await w.mouse.wheel(0, -400);
  await w.keyboard.press('Escape');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  assert.deepEqual((await read()).spreads[1].boxes.hero.crop, crop);
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  assert.equal((await read()).spreads[1].boxes.hero.crop, undefined);
  console.log('ImageFlow click-to-edit passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
