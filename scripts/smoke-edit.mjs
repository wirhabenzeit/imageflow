import { testBook, menuAction, exportAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import electron from 'electron';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';

// Click-to-edit: nodes marked with ctx.edit() open a popover that edits their parameters in place.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'edit-'));
const project = join(work, 'Book.imageflow');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project, true);
  w.setDefaultTimeout(20000);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, project);

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
  
  // Calendar: clicking the element opens its template-supplied editor (#15). Its other parameter (week start) is a
  // generated control below the editor in the same dialog, saved together with Done.
  await w.getByRole('button', { name: 'Calendar spread 14–15', exact: true }).click();
  const editorDialog = w.getByRole('dialog', { name: 'Edit calendar' });
  const calendarEditor = w.frameLocator('iframe.element-editor-frame');
  // Waits until the editor reported ready (or failed) and its frame took its content height, so clicks do not land
  // while the frame is still growing.
  const editorReady = async ({ sized = true } = {}) => {
    await editorDialog.waitFor();
    await w.waitForFunction(() => !document.querySelector('dialog.element-editor .ee-status.muted'));
    if (!sized) return;
    // The dialog is centred, so it moves while the frame still grows; wait until its height has settled.
    await w.waitForFunction(() => {
      const frame = document.querySelector('iframe.element-editor-frame');
      const state = (window.__frameHeights ??= []);
      state.push(frame?.style.height);
      if (state.length > 4) state.shift();
      const settled = state.length === 4 && state.every((height) => height && height !== '240px' && height === state[0]);
      if (settled) window.__frameHeights = [];
      return settled;
    }, null, { polling: 100 });
  };
  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await editorReady();
  assert.equal(await w.locator('.edit-popover').count(), 0);
  await editorDialog.getByRole('button', { name: 'Cancel' }).click();
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));
  await ready();
  await w.mouse.click(at.x, at.y);
  await editorReady();
  await editorDialog.locator('.ee-fields').getByRole('radio', { name: 'Sunday' }).click();
  // The dialog's draft is not saved until Done.
  assert.equal((await read()).spreads[7].elements.grid?.params?.firstWeekday ?? 'monday', 'monday');
  await editorDialog.getByRole('button', { name: 'Done' }).click();
  for (let i = 0; i < 50 && (await read()).spreads[7].elements.grid?.params?.firstWeekday !== 'sunday'; i++) await w.waitForTimeout(100);
  assert.equal((await read()).spreads[7].elements.grid.params.firstWeekday, 'sunday');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  assert.equal((await read()).spreads[7].elements.grid?.params?.firstWeekday ?? 'monday', 'monday');

  // The editor proposes a draft; Done saves month and marks together as one edit, and one Undo reverts both.
  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await editorReady();
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

  // The calendar editor also edits the layout's title (a spread parameter it declares in `spread`): saved in the
  // same edit as the grid, and not offered again as a sidebar control.
  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await editorReady();
  assert.equal(await w.locator('.inspector').getByRole('textbox', { name: 'Calendar title' }).count(), 0);
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).fill('Senja in spring');
  await editorDialog.getByRole('button', { name: 'Done' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Calendar grid updated');
  assert.equal((await read()).spreads[7].params.title, 'Senja in spring');
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01', marked: '14' });
  await ready();
  assert.equal(await frame.locator('[data-spread="march"] .calendar-title').textContent(), 'Senja in spring');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  assert.equal((await read()).spreads[7].params.title, undefined);
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });

  // The dialog's generated controls and the editor share one draft: choosing Sunday below the editor redraws its
  // calendar at once, and Cancel discards both.
  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await editorReady();
  const firstWeekday = () => calendarEditor.locator('.days strong').first().textContent();
  assert.equal(await firstWeekday(), 'Mo');
  await editorDialog.getByRole('radio', { name: 'Sunday' }).click();
  for (let i = 0; i < 50 && await firstWeekday() !== 'Su'; i++) await w.waitForTimeout(100);
  assert.equal(await firstWeekday(), 'Su');
  await editorDialog.getByRole('button', { name: 'Cancel' }).click();
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });

  // A native control in the editor keeps typed text until it loses focus. The dialog's Done applies it first, so
  // typing and clicking Done saves what was typed. Only the frame's answer saves: a frame too busy to answer, or one
  // that fails while applying, saves nothing and keeps the dialog open. (The patched editor stalls or throws when
  // "slow" or "boom" loses focus.)
  const calendarFile = join(project, 'template', 'index.tsx');
  const calendarSource = await readFile(calendarFile, 'utf8');
  const withControl = calendarSource
    .replace('  return <div className="calendar-editor">\n', `  return <div className="calendar-editor" onBlurCapture={(event) => {
      const value = (event.target as HTMLInputElement).value;
      if (value === 'slow') for (const end = Date.now() + 6500; Date.now() < end;);
      if (value === 'boom') throw new Error('blur failed');
    }}>
    <Control parameter="marked" />\n`);
  assert.notEqual(withControl, calendarSource);
  let previousRender = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await writeFile(calendarFile, withControl);
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previousRender, { timeout: 30000 });
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await editorReady();
  await calendarEditor.getByRole('textbox', { name: 'Marked days' }).fill('14');
  await editorDialog.getByRole('button', { name: 'Done' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Calendar grid updated');
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01', marked: '14' });
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');

  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await editorReady();
  await calendarEditor.getByRole('textbox', { name: 'Marked days' }).fill('slow');
  await editorDialog.getByRole('button', { name: 'Done' }).click();
  await editorDialog.getByText('The editor did not respond, so nothing was saved.').waitFor({ timeout: 8000 });
  assert.equal(await editorDialog.isVisible(), true);
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });
  // The late answer to the expired request saves nothing either; trying Done again saves the applied text.
  await w.waitForTimeout(2500);
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });
  await editorDialog.getByRole('button', { name: 'Done' }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Calendar grid updated');
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01', marked: 'slow' });
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');

  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.click(at.x, at.y);
  await editorReady();
  await calendarEditor.getByRole('button', { name: 'Next month' }).click();
  await calendarEditor.getByRole('textbox', { name: 'Marked days' }).fill('boom');
  await editorDialog.getByRole('button', { name: 'Done' }).click();
  await editorDialog.getByText(/The editor stopped working: .*blur failed/).waitFor();
  assert.equal(await editorDialog.getByRole('button', { name: 'Done' }).isDisabled(), true);
  await w.waitForTimeout(6000);
  assert.equal(await editorDialog.isVisible(), true);
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });
  await editorDialog.getByRole('button', { name: 'Cancel' }).click();
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));

  previousRender = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await writeFile(calendarFile, calendarSource);
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previousRender, { timeout: 30000 });

  // A double-click (out of habit) opens it too and does not close it again; Escape inside it discards the draft.
  await ready();
  at = await center('[data-spread="march"] [data-element="grid"]');
  await w.mouse.dblclick(at.x, at.y);
  await editorReady();
  await calendarEditor.getByRole('button', { name: '3', exact: true }).click();
  await calendarEditor.getByRole('button', { name: '3', exact: true }).press('Escape');
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });
  await w.locator('.status-bar').click();
  await w.waitForFunction(() => !document.querySelector('.edit-popover'));

  // Editor review cases (#15). Helpers: click an application menu item; wait for the book to render anew.
  const menu = (label) => menuAction(app, label);
  const rerendered = async (change) => {
    const old = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
    await change();
    await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, old, { timeout: 30000 });
  };
  // Waits until the editor reported ready (or failed) and its frame took its content height, so clicks do not land
  // while the frame is still growing.
  const openCalendarEditor = async ({ sized = true } = {}) => {
    at = await center('[data-spread="march"] [data-element="grid"]');
    await w.mouse.click(at.x, at.y);
    await editorReady({ sized });
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
  await rerendered(() => menu('Reload Book'));
  await editorDialog.getByRole('alert').filter({ hasText: 'changed while this editor was open' }).waitFor();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  assert.equal(await editorDialog.getByRole('button', { name: 'Done' }).isDisabled(), true);
  await calendarEditor.getByRole('button', { name: '14', exact: true }).press('Meta+Enter');
  await w.waitForTimeout(300);
  assert.ok(await editorDialog.isVisible());
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2028-05-01' });
  await closeEditor();
  await writeFile(join(project, 'project.json'), beforeExternal);
  await rerendered(() => menu('Reload Book'));

  // The same holds when only the template changes what the editor shows: a calendar without a saved month uses the
  // template default, and a new default makes the open draft stale too.
  const templateFile = join(project, 'template', 'index.tsx');
  const templateSource = await readFile(templateFile, 'utf8');
  const unsaved = JSON.parse(beforeExternal);
  delete unsaved.spreads[7].elements.grid.params.month;
  await writeFile(join(project, 'project.json'), JSON.stringify(unsaved, null, 2));
  await rerendered(() => menu('Reload Book'));
  await openCalendarEditor();
  assert.match(await calendarEditor.locator('h3').textContent(), /January 2027/);
  const defaultMonth = "default: '2027-01-01', precision: 'month'";
  assert.ok(templateSource.includes(defaultMonth));
  await rerendered(() => writeFile(templateFile, templateSource.replace(defaultMonth, "default: '2028-01-01', precision: 'month'")));
  await editorDialog.getByRole('alert').filter({ hasText: 'changed while this editor was open' }).waitFor({ timeout: 30000 });
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  assert.equal(await editorDialog.getByRole('button', { name: 'Done' }).isDisabled(), true);
  await calendarEditor.getByRole('button', { name: '14', exact: true }).press('Meta+Enter');
  await w.waitForTimeout(300);
  assert.ok(await editorDialog.isVisible());
  assert.deepEqual((await read()).spreads[7].elements.grid.params, {});
  await closeEditor();
  await rerendered(() => writeFile(templateFile, templateSource));
  await writeFile(join(project, 'project.json'), beforeExternal);
  await rerendered(() => menu('Reload Book'));

  // set() followed directly by commit() saves the values just set, not the previous render's.
  const withEditor = (code) => templateSource.replace(
    'function CalendarEditor({ values, set, readOnly, Control }: ElementEditorProps) {',
    'function CalendarEditor({ values, set, readOnly, Control, commit }: ElementEditorProps) {\n' + code);
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
  await w.locator('.status-bar').click();
  await w.waitForFunction(() => !document.querySelector('.edit-popover'));

  // Clicking a text box opens its editor: its text, its own options (columns) and the body size the template marks
  // it with.
  at = await center('[data-spread="arriving"] [data-box="body"]');
  await w.mouse.click(at.x, at.y);
  const story = w.getByRole('dialog', { name: 'Edit Story' });
  await story.waitFor();
  assert.equal(await story.getByRole('combobox', { name: 'Story assignment' }).inputValue(), 'arrival');
  await story.getByRole('spinbutton', { name: 'Body size' }).waitFor();
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

  // A click selects a photo. Dragging the selected photo pans it and pinching zooms it; each gesture saves itself as
  // an undoable edit. Plain scrolling scrolls the book. Escape deselects.
  const hero = () => read().then((data) => data.spreads[1].boxes.hero);
  const until = async (check) => { for (let i = 0; i < 50 && !(await check()); i++) await w.waitForTimeout(100); assert.ok(await check()); };
  at = await center('[data-spread="arriving"] [data-box="hero"]');
  await w.mouse.click(at.x, at.y);
  await w.locator('.crop-editor').waitFor();
  assert.equal(await w.locator('.edit-popover').count(), 0);
  await w.mouse.move(at.x, at.y);
  await w.mouse.down();
  await w.mouse.move(at.x - 120, at.y, { steps: 8 });
  await w.mouse.up();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Crop updated');
  await until(async () => (await hero()).crops?.story?.zoom === 1);
  assert.ok(await w.locator('.crop-editor').isVisible(), 'the photo stays selected');
  const zoomLabel = () => w.locator('.crop-zoom').textContent();
  await w.mouse.wheel(0, -240);
  await w.waitForTimeout(600);
  assert.equal(await zoomLabel(), '1.0×', 'plain scrolling does not zoom');
  // Pinch arrives as ctrl-wheel over the photo; the plain scroll may have moved it.
  const pinchAt = await center('[data-spread="arriving"] [data-box="hero"]');
  await w.mouse.move(pinchAt.x, pinchAt.y);
  await w.keyboard.down('Control');
  await w.mouse.wheel(0, -60);
  await w.keyboard.up('Control');
  await until(async () => (await hero()).crops?.story?.zoom > 1);
  assert.match(await w.locator('.crop-ppi').textContent(), /^\d+ ppi$/);
  // The crop belongs to the spread's current layout; its centre is the focus other layouts fill around.
  const { crops, focus } = await hero();
  const crop = crops.story;
  assert.ok(crop.centerX > 0.5 && crop.zoom > 1, JSON.stringify(crop));
  assert.deepEqual(focus, { centerX: crop.centerX, centerY: crop.centerY });
  await w.keyboard.press('Escape');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  assert.deepEqual((await hero()).crops, { story: crop });
  // Each gesture is one Undo step: first the pinch, then the drag.
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  assert.equal((await hero()).crops.story.zoom, 1);
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await until(async () => (await hero()).crops === undefined);

  // The toolbar zooms with its slider, saved when the key is released, and holds the box's own parameters.
  const toolbar = w.locator('.crop-toolbar');
  await ready();
  await w.mouse.click(at.x, at.y);
  await w.locator('.crop-editor').waitFor();
  await toolbar.getByRole('slider', { name: 'Zoom' }).focus();
  await w.keyboard.press('ArrowRight');
  await w.keyboard.press('ArrowRight');
  await until(async () => (await hero()).crops?.story?.zoom > 1);
  await toolbar.getByRole('checkbox', { name: 'Show caption' }).check();
  await until(async () => (await hero()).params.caption === true);
  await toolbar.getByRole('slider', { name: 'Zoom' }).focus();
  await w.keyboard.press('Escape');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await until(async () => (await hero()).crops === undefined && !(await hero()).params.caption);

  // Dragging a photo that is not selected moves it: onto another photo box the two swap, as one edit.
  await ready();
  await w.getByRole('button', { name: 'Two photos 10–11', exact: true }).click();
  const left = await center('[data-spread="water"] [data-box="hero"]');
  const right = await center('[data-spread="water"] [data-box="second"]');
  const pair = async () => (await read()).spreads.find(({ id }) => id === 'water').boxes;
  const before = await pair();
  await w.mouse.move(left.x, left.y);
  await w.mouse.down();
  await w.mouse.move(right.x, right.y, { steps: 10 });
  await w.locator('.photo-move-ghost').waitFor();
  await w.mouse.up();
  await w.waitForFunction(() => / swapped$/.test(document.querySelector('.status')?.textContent ?? ''));
  const after = await pair();
  assert.equal(after.hero.photo, before.second.photo);
  assert.equal(after.second.photo, before.hero.photo);
  assert.equal(await w.locator('.crop-editor').count(), 0, 'a move does not select');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await until(async () => (await pair()).hero.photo === before.hero.photo);
  await ready();
  at = await center('[data-spread="arriving"] [data-box="hero"]');

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
    await w.mouse.click(at.x, at.y);
    await w.waitForFunction(() => /rotates or mirrors/.test(document.querySelector('.status')?.textContent ?? ''));
    assert.equal(await w.locator('.crop-editor').count(), 0, rule);
    // The click opened the photo's popover instead; close it so it doesn't cover the next attempt.
    await w.locator('.status-bar').click();
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

  // The sidebar lists a spread's boxes and elements; each opens its editor on the page, also from the keyboard.
  const openBox = async (label) => {
    await ready();
    await w.locator('.inspector').getByRole('button', { name: 'Edit ' + label, exact: true }).click();
    await w.locator('.crop-editor, .edit-popover').first().waitFor();
  };
  // Continued texts show their flow position in the list and beside the source control in the box's editor.
  await thumb('Photo and story 16–17');
  await w.locator('.inspector .content-state').getByText(/· 3 of 3$/).waitFor();
  await openBox('Story');
  const storyEditor = w.getByRole('dialog', { name: 'Edit Story' });
  await storyEditor.getByText('Flow 3 of 3', { exact: true }).waitFor();
  assert.equal(await storyEditor.getByRole('combobox', { name: 'Story assignment' }).inputValue(), 'arrival');
  await storyEditor.getByRole('radio', { name: '2 columns' }).waitFor();
  await w.keyboard.press('Escape');
  await thumb('Photo and story 2–3');

  // #9: photos can be assigned from the keyboard, to an empty box and as a replacement; Undo restores. A placed
  // photo is selected, with Replace and Remove in its toolbar; an empty box opens its editor with Choose photo.
  await openBox('Main photo');
  await w.locator('.crop-content').getByRole('combobox', { name: 'Replace photo in Main photo' }).selectOption('shore');
  await saved('Shore placed in Main photo');
  assert.equal((await read()).spreads[1].boxes.hero.photo, 'shore');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  await openBox('Main photo');
  await w.locator('.crop-content').getByRole('button', { name: 'Remove' }).click();
  await saved('Photo removed from Main photo');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  await openBox('Main photo');
  await w.getByRole('dialog', { name: 'Edit Main photo' }).getByRole('combobox', { name: 'Choose photo for Main photo' }).selectOption('cottage');
  await saved('Cottage placed in Main photo');
  assert.equal((await read()).spreads[1].boxes.hero.photo, 'cottage');
  for (let i = 0; i < 3; i++) {
    await w.getByRole('button', { name: 'Undo', exact: true }).click();
    await saved('Edit undone');
  }
  assert.equal((await read()).spreads[1].boxes.hero.photo, 'segla');

  // #10: a rejected value in one spread's field does not appear in another spread with the same field.
  await thumb('Photo grid 2×2 6–7');
  const gap = w.getByRole('spinbutton', { name: 'Gap', exact: true });
  await gap.fill('99');
  await gap.press('Tab');
  await w.locator('.inspector .error-text').filter({ hasText: 'within the field' }).waitFor();
  await thumb('Photo grid 2×2 20–21');
  await w.waitForFunction(() => !document.querySelector('.inspector .error-text'));
  assert.equal(await gap.inputValue(), '6');
  assert.equal((await read()).spreads[3].params.gutter, undefined);

  // #8: a proof export keeps Book check errors; print export still refuses the book.
  await thumb('Two photos 10–11');
  await ready();
  await w.getByRole('button', { name: 'Delete', exact: true }).click();
  await saved('Saved');
  await ready();
  await w.waitForFunction(() => /Book check · 1 error/.test(document.querySelector('.book-check-toggle')?.textContent ?? ''));
  // The Book check is an indicator next to Export; clicking it lists the issues.
  assert.equal(await w.locator('.inspector .book-check-list').count(), 0);
  assert.deepEqual(await w.locator('.status-bar .book-check-toggle > [aria-hidden]').allTextContents(), ['1 error']);
  await w.locator('.book-check-toggle').click();
  assert.match(await w.getByRole('dialog', { name: 'Book check' }).textContent(), /Page count is 26/);
  await w.keyboard.press('Escape');
  await w.getByRole('dialog', { name: 'Book check' }).waitFor({ state: 'detached' });
  const pdf = join(work, 'proof.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
  await exportAction(w, 'Export proof PDF');
  await w.waitForFunction(() => /^Proof PDF saved/.test(document.querySelector('.status')?.textContent ?? '') ||
    document.querySelector('.status-error'), null, { timeout: 60000 });
  assert.match(await statusText(), /^Proof PDF saved\. 1 error/);
  assert.match(await w.locator('.book-check-toggle').textContent(), /Book check · 1 error/);
  await w.locator('.export-menu > summary').click();
  assert.equal(await w.getByRole('button', { name: 'Export print PDF', exact: true }).isDisabled(), true);
  await w.locator('.export-menu > summary').click();
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved('Edit undone');
  await ready();
  await w.waitForFunction(() => /Book check · No issues/.test(document.querySelector('.book-check-toggle')?.textContent ?? ''));

  // #17: a template with several formats; switching re-renders at the new size and exports at it; Undo returns.
  await w.getByText('Book settings', { exact: true }).click();
  let previous = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await w.getByRole('combobox', { name: 'Format' }).selectOption('landscape');
  await saved('Format changed to Landscape · 32 × 24 cm');
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previous);
  assert.equal((await read()).format, 'landscape');
  const landscape = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(landscape.template.formatId, 'landscape');
  assert.deepEqual(landscape.errors, []);
  const sheetBox = await frame.locator('.if-sheet').first().boundingBox();
  assert.ok(Math.abs(sheetBox.width / sheetBox.height - (323 * 2) / 246) < 0.01);
  const printed = join(work, 'landscape.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, printed);
  await exportAction(w, 'Export print PDF');
  await w.waitForFunction(() => /^Print PDF saved/.test(document.querySelector('.status')?.textContent ?? '') ||
    document.querySelector('.status-error'), null, { timeout: 90000 });
  assert.match(await statusText(), /^Print PDF saved/);
  const points = (millimetres) => millimetres * 72 / 25.4;
  const firstPage = (await PDFDocument.load(await readFile(printed))).getPage(0).getMediaBox();
  assert.ok(Math.abs(firstPage.width - points(323)) < 0.5 && Math.abs(firstPage.height - points(246)) < 0.5, JSON.stringify(firstPage));
  previous = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved('Edit undone');
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previous);
  assert.equal((await read()).format, undefined);
  assert.equal((await frame.locator('body').evaluate(() => window.imageflowRenderStatus)).template.formatId, 'square');

  // A preset with impossible geometry is a template error at load, and the editor stays usable around it.
  const formatsFile = join(project, 'template', 'index.tsx');
  const formatsSource = await readFile(formatsFile, 'utf8');
  await writeFile(formatsFile, formatsSource.replace('  formats: {', "  formats: {\n    huge: bookFormat('Huge', 1200, 290),"));
  await w.waitForFunction(() => /PDF dimensions must be between 10 and 1000 mm/.test(document.querySelector('.status-error')?.textContent ?? ''), null, { timeout: 30000 });
  assert.ok(await w.locator('.document-settings').isVisible(), 'the sidebar survives a template format error');
  assert.ok(await w.getByRole('button', { name: 'Undo', exact: true }).isVisible());
  await writeFile(formatsFile, formatsSource);
  await w.waitForFunction(() => !document.querySelector('.status-error'), null, { timeout: 30000 });
  await ready();

  // A saved format the template no longer offers: previewed in the default, but an error that blocks print export.
  previous = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await writeFile(join(project, 'project.json'), JSON.stringify({ ...await read(), format: 'retired' }, null, 2));
  await menuAction(app, 'Reload');
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previous);
  const retired = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(retired.template.formatId, 'square');
  assert.match(retired.errors.map(({ message }) => message).join('\n'), /no longer offers the format retired/);
  assert.equal(await w.getByRole('combobox', { name: 'Format' }).inputValue(), 'retired');
  await w.getByRole('combobox', { name: 'Format' }).selectOption('square');
  await saved('Format changed to WhiteWall Gallery Square · 29 × 29 cm');
  await ready();
  await w.waitForFunction(() => /Book check · No issues/.test(document.querySelector('.book-check-toggle')?.textContent ?? ''));
  assert.equal((await read()).format, 'square');

  // A template converted to one fixed format ignores the saved choice and shows no Format picker.
  await w.getByRole('combobox', { name: 'Format' }).selectOption('landscape');
  await saved('Format changed to Landscape · 32 × 24 cm');
  await ready();
  const named = `  formats: {
    square: bookFormat('WhiteWall Gallery Square · 29 × 29 cm', 290, 290),
    landscape: bookFormat('Landscape · 32 × 24 cm', 320, 240),
  },
  defaultFormat: 'square',`;
  assert.ok(formatsSource.includes(named));
  previous = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await writeFile(formatsFile, formatsSource.replace(named, "  format: bookFormat('WhiteWall Gallery Square · 29 × 29 cm', 290, 290),"));
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previous, { timeout: 30000 });
  const fixed = await frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  assert.equal(fixed.template.formatId, 'default');
  assert.deepEqual(fixed.errors, []);
  assert.equal(await w.getByRole('combobox', { name: 'Format' }).count(), 0);
  assert.equal((await read()).format, 'landscape');
  previous = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  await writeFile(formatsFile, formatsSource);
  await w.waitForFunction((url) => { const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]'); return f && f.getAttribute('src') !== url; }, previous, { timeout: 30000 });
  assert.equal(await w.getByRole('combobox', { name: 'Format' }).inputValue(), 'landscape');
  console.log('ImageFlow click-to-edit passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
