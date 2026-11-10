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

  // #11: the book view loads photos near the screen only; scrolling to the end loads the photos there.
  await w.locator('main.canvas').evaluate((el) => el.scrollTo(0, 0));
  const lastPhoto = frame.locator('[data-spread="twilight"] [data-box="hero"] img');
  assert.equal(await lastPhoto.getAttribute('src'), null);
  await w.locator('main.canvas').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await lastPhoto.and(frame.locator('img[src]')).waitFor({ state: 'attached' });
  assert.ok(await lastPhoto.evaluate((img) => img.decode().then(() => img.naturalWidth > 0)));
  await w.locator('main.canvas').evaluate((el) => el.scrollTo(0, 0));

  const statusText = () => w.locator('.status').textContent();
  const saved = (text) => w.waitForFunction((text) => document.querySelector('.status')?.textContent === text, text);
  const thumb = (name) => w.getByRole('button', { name, exact: true }).click();

  // #12: the layout picker says when it restarts a text this spread continues.
  await thumb('Photo and story 16–17');
  await w.locator('.layout-note').filter({ hasText: 'arrival.md part 3 of 3' }).waitFor();
  await thumb('Photo and story 2–3');
  assert.equal(await w.locator('.layout-note').count(), 0);

  // #9: photos can be assigned from the keyboard, to an empty box and as a replacement; Undo restores.
  await w.getByRole('combobox', { name: 'Replace photo in Main photo' }).selectOption('shore');
  await saved('Shore placed in Main photo');
  assert.equal((await read()).spreads[1].boxes.hero.photo, 'shore');
  await w.locator('.box-photo-info').getByRole('button', { name: 'Remove' }).first().click();
  await saved('Photo removed from Main photo');
  await w.getByRole('combobox', { name: 'Choose photo for Main photo' }).selectOption('cottage');
  await saved('Cottage placed in Main photo');
  assert.equal((await read()).spreads[1].boxes.hero.photo, 'cottage');
  for (let i = 0; i < 3; i++) {
    await w.getByRole('button', { name: 'Undo', exact: true }).click();
    await saved('Edit undone');
  }
  assert.equal((await read()).spreads[1].boxes.hero.photo, 'segla');

  // #10: a rejected value in one spread's field does not appear in another spread with the same field.
  await thumb('Photo grid 6–7');
  const gap = w.getByRole('spinbutton', { name: 'Gap', exact: true });
  await gap.fill('99');
  await gap.press('Tab');
  await w.locator('.inspector .error-text').filter({ hasText: 'within the field' }).waitFor();
  await thumb('Photo grid 20–21');
  await w.waitForFunction(() => !document.querySelector('.inspector .error-text'));
  assert.equal(await gap.inputValue(), '6');
  assert.equal((await read()).spreads[3].params.gutter, undefined);

  // #8: a proof export keeps Book check errors; print export still refuses the book.
  await thumb('Two photos 10–11');
  await ready();
  await w.getByRole('button', { name: 'Delete', exact: true }).click();
  await saved('Saved');
  await ready();
  await w.waitForFunction(() => /Book check · 1 error/.test(document.querySelector('.book-check-list summary')?.textContent ?? ''));
  const pdf = join(work, 'proof.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
  await w.getByRole('button', { name: 'Export proof PDF', exact: true }).click();
  await w.waitForFunction(() => /^Proof PDF saved/.test(document.querySelector('.status')?.textContent ?? '') ||
    document.querySelector('.status-error'), null, { timeout: 60000 });
  assert.match(await statusText(), /^Proof PDF saved\. 1 error/);
  assert.match(await w.locator('.book-check-list summary').textContent(), /Book check · 1 error/);
  await w.getByRole('button', { name: 'Export print PDF', exact: true }).click();
  await w.locator('.status-error').waitFor({ timeout: 60000 });
  assert.match(await statusText(), /Page count is 26/);
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved('Edit undone');
  await ready();
  await w.waitForFunction(() => /Book check · No issues/.test(document.querySelector('.book-check-list summary')?.textContent ?? ''));
  console.log('ImageFlow click-to-edit passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
