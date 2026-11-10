import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  
  // Calendar: the popover keeps generated controls for parameters the template's editor does not own (week
  // start) and offers the template-supplied calendar editor for month and marked days (#15).
  await w.getByRole('button', { name: 'Calendar spread 14–15', exact: true }).click();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  const cal = w.getByRole('dialog', { name: 'Edit Week starts' });
  await cal.waitFor();
  assert.equal(await cal.locator('input[type="month"]').count(), 0);
  await cal.getByRole('radio', { name: 'Sunday' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Week starts updated');
  assert.equal((await read()).spreads[7].elements.grid.params.firstWeekday, 'sunday');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  assert.equal((await read()).spreads[7].elements.grid?.params?.firstWeekday ?? 'monday', 'monday');

  // The editor proposes a draft; Done saves month and marks together as one edit, and one Undo reverts both.
  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await w.getByRole('dialog', { name: 'Edit Week starts' }).getByRole('button', { name: 'Edit calendar…' }).click();
  const editorDialog = w.getByRole('dialog', { name: 'Edit calendar' });
  await editorDialog.waitFor();
  const calendarEditor = w.frameLocator('iframe.element-editor-frame');
  await calendarEditor.getByRole('button', { name: 'Next month' }).click();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  assert.equal((await read()).spreads[7].elements.grid.params.month, '2027-03-01');
  await editorDialog.getByRole('button', { name: 'Done' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Calendar grid updated');
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-04-01', marked: '14' });
  await ready();
  assert.match(await frame.locator('[data-spread="march"] [data-element="grid"] h3').textContent(), /April 2027/);
  assert.equal(await frame.locator('[data-spread="march"] [data-element="grid"] .marked').textContent(), '14');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });

  // Double-click opens the editor directly; Escape inside it discards the draft.
  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.dblclick(at.x, at.y);
  await editorDialog.waitFor();
  await calendarEditor.getByRole('button', { name: '3', exact: true }).click();
  await calendarEditor.getByRole('button', { name: '3', exact: true }).press('Escape');
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });
  await w.locator('.toolbar .brand').click();
  await w.waitForFunction(() => !document.querySelector('.edit-popover'));

  // Editor review cases (#15). Helpers: click an application menu item; wait for the book to render anew.
  const menu = (label) => app.evaluate(({ Menu }, label) => {
    const find = (items) => {
      for (const item of items) {
        if (item.label === label) return item;
        const inner = item.submenu && find(item.submenu.items);
        if (inner) return inner;
      }
    };
    find(Menu.getApplicationMenu().items).click();
  }, label);
  const rerendered = async (change) => {
    const old = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
    await change();
    await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, old, { timeout: 30000 });
  };
  // Waits until the editor reported ready (or failed) and its frame took its content height, so clicks do not land
  // while the frame is still growing.
  const openCalendarEditor = async ({ sized = true } = {}) => {
    at = await center('[data-spread="march"] [data-element="grid"]');
    await w.mouse.dblclick(at.x, at.y);
    await editorDialog.waitFor();
    await w.waitForFunction(() => !document.querySelector('dialog.element-editor .ee-status.muted'));
    if (sized) await w.waitForFunction(() => document.querySelector('iframe.element-editor-frame')?.style.height !== '240px');
  };
  const closeEditor = async () => {
    await editorDialog.getByRole('button', { name: 'Cancel' }).click();
    await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));
  };

  // Newer values arriving while the editor is open (here Reload after an external edit) make its draft stale:
  // the dialog says so and neither Done nor ⌘↩ overwrites them.
  const beforeExternal = await readFile(join(project, 'project.json'), 'utf8');
  await openCalendarEditor();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).waitFor();
  const external = JSON.parse(beforeExternal);
  external.spreads[7].elements.grid.params.month = '2028-05-01';
  await writeFile(join(project, 'project.json'), JSON.stringify(external, null, 2));
  await rerendered(() => menu('Reload Project'));
  await editorDialog.getByRole('alert').filter({ hasText: 'changed while this editor was open' }).waitFor();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  assert.equal(await editorDialog.getByRole('button', { name: 'Done' }).isDisabled(), true);
  await calendarEditor.getByRole('button', { name: '14', exact: true }).press('Meta+Enter');
  await w.waitForTimeout(300);
  assert.ok(await editorDialog.isVisible());
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2028-05-01' });
  await closeEditor();
  await writeFile(join(project, 'project.json'), beforeExternal);
  await rerendered(() => menu('Reload Project'));

  // set() followed directly by commit() saves the values just set, not the previous render's.
  const templateFile = join(project, 'template', 'index.tsx');
  const templateSource = await readFile(templateFile, 'utf8');
  const withEditor = (code) => templateSource.replace(
    'function CalendarEditor({ values, set, readOnly }: ElementEditorProps) {',
    'function CalendarEditor({ values, set, readOnly, commit }: ElementEditorProps) {\n' + code);
  const jump = `  const jump = <button type="button" onClick={() => { set({ month: '2027-04-01', marked: '9' }); commit(); }}>Jump to April</button>;
  const explode = <button type="button" onClick={() => { throw new Error('handler exploded'); }}>Explode</button>;`;
  await rerendered(() => writeFile(templateFile, withEditor(jump).replace(
    '<div className="calendar-editor-nav">', '<div className="calendar-editor-nav">{jump}{explode}')));
  await openCalendarEditor();
  await calendarEditor.getByRole('button', { name: 'Jump to April' }).click();
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));
  for (let start = Date.now(); (await read()).spreads[7].elements.grid.params.month !== '2027-04-01' && Date.now() - start < 10000;) {
    await w.waitForTimeout(50);
  }
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-04-01', marked: '9' });
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  await ready();

  // An editor that throws in an event handler reports it, and the dialog only offers Cancel.
  await openCalendarEditor();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await calendarEditor.getByRole('button', { name: 'Explode' }).click();
  await editorDialog.getByRole('alert').filter({ hasText: 'The editor stopped working: handler exploded' }).waitFor();
  assert.equal(await editorDialog.getByRole('button', { name: 'Done' }).isDisabled(), true);
  await closeEditor();
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });

  // An editor that throws while rendering is reported instead of leaving a blank dialog.
  await rerendered(() => writeFile(templateFile, withEditor("  if (values.month) throw new Error('render exploded');")));
  await openCalendarEditor({ sized: false });
  await editorDialog.getByRole('alert').filter({ hasText: 'The editor stopped working: render exploded' }).waitFor();
  assert.equal(await editorDialog.getByText('Loading the editor…').count(), 0);
  assert.equal(await editorDialog.getByRole('button', { name: 'Done' }).isDisabled(), true);
  await closeEditor();
  await rerendered(() => writeFile(templateFile, templateSource));
  await w.locator('.toolbar .brand').click();
  await w.waitForFunction(() => !document.querySelector('.edit-popover'));

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

  // Focused toolbar controls handle their own keys: Enter on Cancel cancels, arrows on the slider zoom.
  const toolbar = w.locator('.crop-toolbar');
  await w.mouse.dblclick(at.x, at.y);
  await w.locator('.crop-editor').waitFor();
  await w.mouse.wheel(0, -300);
  await toolbar.getByRole('button', { name: 'Cancel' }).focus();
  await w.keyboard.press('Enter');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  assert.equal((await read()).spreads[1].boxes.hero.crop, undefined);
  await w.mouse.dblclick(at.x, at.y);
  await w.locator('.crop-editor').waitFor();
  const zoomBefore = await toolbar.getByRole('slider', { name: 'Zoom' }).inputValue();
  await toolbar.getByRole('slider', { name: 'Zoom' }).focus();
  await w.keyboard.press('ArrowRight');
  await w.keyboard.press('ArrowRight');
  assert.ok(Number(await toolbar.getByRole('slider', { name: 'Zoom' }).inputValue()) > Number(zoomBefore));
  await w.keyboard.press('Escape');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  assert.equal((await read()).spreads[1].boxes.hero.crop, undefined);

  // A frame the template rotates (here 180°, which keeps its size) is not offered crop mode.
  // A template file change can reload the project more than once; wait until the book frame has stayed the same.
  async function settled(before) {
    let src = before;
    for (let stable = 0; stable < 4;) {
      await w.waitForTimeout(200);
      const now = await w.evaluate(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]')?.getAttribute('src'));
      if (now && now !== before && now === src) stable++;
      else stable = 0;
      src = now;
    }
  }
  const css = join(project, 'template/styles.css');
  const originalCss = await readFile(css, 'utf8');
  for (const rule of ['transform: rotate(180deg)', 'rotate: 180deg', 'scale: -1 1']) {
    const before = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
    await writeFile(css, originalCss + '\n.if-spread-container[data-spread="arriving"] [data-box="hero"] { ' + rule + '; }\n');
    await settled(before);
    at = await center('[data-spread="arriving"] [data-box="hero"]');
    await w.mouse.dblclick(at.x, at.y);
    await w.waitForFunction(() => /rotates or mirrors/.test(document.querySelector('.status')?.textContent ?? ''));
    assert.equal(await w.locator('.crop-editor').count(), 0, rule);
    // The double-click's first click opened the photo's popover; close it so it doesn't cover the next attempt.
    await w.locator('.toolbar .brand').click();
    await w.waitForFunction(() => !document.querySelector('.edit-popover'));
  }
  const restored = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await writeFile(css, originalCss);
  await settled(restored);
  at = await center('[data-spread="arriving"] [data-box="hero"]');

  // #11: the book view loads photos near the screen only; scrolling to the end loads the photos there.
  await w.locator('main.canvas').evaluate((el) => el.scrollTo(0, 0));
  const lastPhoto = frame.locator('[data-spread="twilight"] [data-box="hero"] img');
  assert.equal(await lastPhoto.getAttribute('src'), null);
  await w.locator('main.canvas').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await lastPhoto.and(frame.locator('img[src]')).waitFor({ state: 'attached' });
  assert.ok(await lastPhoto.evaluate((img) => img.decode().then(() => img.naturalWidth > 0)));
  await w.locator('main.canvas').evaluate((el) => el.scrollTo(0, 0));
  // Every sidebar thumbnail loads.
  await w.frameLocator('iframe.book-frame-thumbs[data-current]').locator('body').evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode())).then(() =>
      [...document.images].every((img) => img.complete && img.naturalWidth > 0)));

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
