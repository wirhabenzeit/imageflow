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
  // Portalled controls must not send hover or drop events to the React canvas ancestors.
  await w.mouse.move(0, 0);
  const underneath = await frame.locator('[data-spread="title"] [data-edit="subtitle"]').boundingBox();
  await popover.dispatchEvent('mousemove', { clientX: underneath.x + 5, clientY: underneath.y + 5 });
  assert.equal(await w.locator('.edit-target:not(.active)').count(), 0, 'Panel movement does not highlight artwork behind it');
  const beforeDrop = await read();
  const photoUnderPanel = await frame.locator('[data-spread="arriving"] [data-box="hero"]').boundingBox();
  const incomingPhoto = await w.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-imageflow-photo', 'shore');
    return transfer;
  });
  const dropOnPanel = { dataTransfer: incomingPhoto, clientX: photoUnderPanel.x + 5, clientY: photoUnderPanel.y + 5 };
  await popover.dispatchEvent('dragover', dropOnPanel);
  assert.equal(await w.locator('.box-highlight').count(), 0, 'A panel is not a canvas drop target');
  await popover.dispatchEvent('drop', dropOnPanel);
  await w.waitForTimeout(250);
  assert.deepEqual(await read(), beforeDrop, 'Dropping on a panel never changes the underlying photo');
  await incomingPhoto.dispose();
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
  
  // Custom components behave like the other item controls: live edits, background scrolling, and Close.
  await w.getByRole('button', { name: 'Calendar spread 14–15', exact: true }).click();
  const editorDialog = w.getByRole('dialog', { name: 'Edit calendar' });
  const calendarEditor = w.frameLocator('iframe.element-editor-frame');
  const waitBook = async () => {
    await ready();
    await w.waitForFunction(() => !document.querySelector('.preview-state, .preview-message'));
  };
  const waitCalendar = async (check) => {
    for (let i = 0; i < 100; i++) {
      if (check((await read()).spreads[7])) return;
      await w.waitForTimeout(100);
    }
    assert.ok(check((await read()).spreads[7]));
  };
  const editorReady = async ({ sized = true } = {}) => {
    await editorDialog.waitFor();
    await w.waitForFunction(() => !document.querySelector('.element-editor .ee-status.muted')).catch(async (error) => {
      // Name which state the editor is stuck in: loading (no editor-ready from the frame) or blocked (and why).
      const state = await w.evaluate(() => ({
        status: [...document.querySelectorAll('.element-editor .ee-status')].map((node) => node.className + ': ' + node.textContent),
        frame: document.querySelector('iframe.element-editor-frame')?.getAttribute('src'),
        books: [...document.querySelectorAll('iframe.book-frame-book')].map((node) => [node.getAttribute('src'), node.dataset]),
        preview: document.querySelector('.preview-state, .preview-message')?.textContent,
      }));
      throw new Error(error.message + '\nEditor state: ' + JSON.stringify(state));
    });
    if (!sized) return;
    await w.waitForFunction(() => {
      const frame = document.querySelector('iframe.element-editor-frame');
      const heights = (window.__frameHeights ??= []);
      heights.push(frame?.style.height);
      if (heights.length > 4) heights.shift();
      const stable = heights.length === 4 && heights.every((h) => h && h !== '240px' && h === heights[0]);
      if (stable) window.__frameHeights = [];
      return stable;
    }, null, { polling: 100 });
  };
  const openCalendarEditor = async (options) => {
    await waitBook();
    at = await center('[data-spread="march"] [data-element="grid"]');
    await w.mouse.click(at.x, at.y);
    await editorReady(options);
  };
  const closeEditor = async () => {
    await editorDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await editorDialog.waitFor({ state: 'detached' });
    await waitBook();
  };
  const undoCalendar = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      await w.getByRole('button', { name: 'Undo', exact: true }).click();
      await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
      await waitBook();
    }
  };
  const editorPosition = async () => {
    const panel = await editorDialog.boundingBox(), canvas = await w.locator('.canvas-wrap').boundingBox();
    const close = await editorDialog.getByRole('button', { name: 'Close', exact: true }).boundingBox();
    assert.ok(Math.abs(panel.x + panel.width / 2 - canvas.x - canvas.width / 2) < 2);
    assert.ok(Math.abs(canvas.y + canvas.height - panel.y - panel.height - 16) < 2);
    assert.ok(panel.y >= canvas.y && panel.x >= canvas.x && panel.x + panel.width <= canvas.x + canvas.width);
    assert.ok(close.y >= panel.y && close.y + close.height <= panel.y + panel.height, 'Close remains visible');
  };
  await openCalendarEditor();
  assert.equal(await w.locator(':modal').count(), 0, 'The editor never makes the background inert');
  assert.equal(await editorDialog.getByRole('button', { name: /^(Cancel|Done)$/ }).count(), 0);
  await editorPosition();
  const canvas = w.locator('main.canvas'), canvasBox = await canvas.boundingBox();
  const scrollBefore = await canvas.evaluate((el) => el.scrollTop);
  await w.mouse.move(canvasBox.x + 12, canvasBox.y + 30);
  await w.mouse.wheel(0, 260);
  await w.waitForFunction((before) => document.querySelector('main.canvas').scrollTop !== before, scrollBefore);
  assert.ok(await editorDialog.isVisible(), 'Scrolling leaves the editor open');
  await editorPosition();
  await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).fill('Typing survives resizing');
  const owner = await app.browserWindow(w), windowSize = await owner.evaluate((window) => window.getContentSize());
  await owner.evaluate((window) => window.setContentSize(940, 650));
  await w.waitForFunction(() => innerWidth === 940);
  await editorReady();
  await editorPosition();
  assert.ok(await editorDialog.locator('.ee-body').evaluate((el) => el.scrollHeight > el.clientHeight));
  assert.equal(await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).inputValue(), 'Typing survives resizing');
  await editorDialog.locator('.ee-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await editorPosition();
  await w.screenshot({ path: join(root, '.build', 'custom-controls-live-small.png') });
  await owner.evaluate((window, [width, height]) => window.setContentSize(width, height), windowSize);
  await editorReady();
  await closeEditor();
  await waitCalendar((s) => s.params.title === 'Typing survives resizing');
  await undoCalendar();
  assert.equal((await read()).spreads[7].params.title, undefined);

  // Generated choices and custom buttons save while the panel stays open; rapid changes survive preview rebuilds.
  await openCalendarEditor();
  await editorDialog.getByRole('radio', { name: 'Sunday' }).click();
  await waitCalendar((s) => s.elements.grid.params.firstWeekday === 'sunday');
  assert.equal(await calendarEditor.locator('.days strong').first().textContent(), 'Su');
  await calendarEditor.getByRole('button', { name: 'Next month' }).click();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await waitCalendar((s) => s.elements.grid.params.month === '2027-04-01' && s.elements.grid.params.marked === '14');
  await waitBook();
  assert.equal(await editorDialog.getByRole('alert').count(), 0, 'Own saves do not invalidate the editor');
  assert.match(await frame.locator('[data-spread="march"] [data-element="grid"] h3').textContent(), /April 2027/);
  await w.screenshot({ path: join(root, '.build', 'custom-controls-live.png') });
  await closeEditor();
  await undoCalendar(3);
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });

  // Escape closes without reverting applied choices, and discards only the field still being typed.
  await openCalendarEditor();
  await calendarEditor.getByRole('button', { name: '3', exact: true }).click();
  await waitCalendar((s) => s.elements.grid.params.marked === '3');
  await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).fill('Uncommitted typing');
  await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).press('Escape');
  await editorDialog.waitFor({ state: 'detached' });
  assert.equal((await read()).spreads[7].params.title, undefined);
  await undoCalendar();

  // Closing waits for the frame's typed field; a missing reply keeps the panel usable and never invents a save.
  await openCalendarEditor();
  await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).fill('Not acknowledged');
  // Simulate a frame that has stopped answering the host while the panel itself remains alive.
  await w.locator('iframe.element-editor-frame').evaluate((frame) => { frame.src = 'about:blank'; });
  await editorDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await editorDialog.getByRole('alert').filter({ hasText: 'has not finished the current field' }).waitFor({ timeout: 8000 });
  assert.equal((await read()).spreads[7].params.title, undefined);
  await editorDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await editorDialog.waitFor({ state: 'detached', timeout: 1500 });

  // The host independently rejects malformed or out-of-scope frame reports before writing project data.
  await openCalendarEditor();
  await calendarEditor.locator('body').evaluate(() => {
    parent.postMessage({ type: 'editor-draft', values: { month: 'invalid', firstWeekday: 'sunday' }, spread: { typo: 'bad' } }, '*');
  });
  await editorDialog.getByRole('alert').filter({ hasText: 'values the template does not allow' }).waitFor();
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });
  assert.equal((await read()).spreads[7].params.typo, undefined);
  await calendarEditor.locator('body').press('Escape');
  await editorDialog.waitFor({ state: 'detached' });

  // An outside click flushes typing before dismissing the frame.
  await openCalendarEditor();
  await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).fill('Saved on outside click');
  await w.locator('.status-bar').click();
  await editorDialog.waitFor({ state: 'detached' });
  await waitCalendar((s) => s.params.title === 'Saved on outside click');
  await waitBook();
  await undoCalendar();

  // One outside click performs its action after flushing, including Undo of the field just typed.
  await openCalendarEditor();
  await calendarEditor.getByRole('textbox', { name: 'Calendar title' }).fill('Undo this typing');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await editorDialog.waitFor({ state: 'detached' });
  await w.waitForFunction(() => document.querySelector('.status')?.textContent === 'Edit undone');
  await waitBook();
  assert.equal((await read()).spreads[7].params.title, undefined);
  await openCalendarEditor();
  await w.locator('.spread-thumb[data-spread="title"]').click();
  await editorDialog.waitFor({ state: 'detached' });
  assert.equal(await w.locator('.spread-thumb[data-spread="title"]').getAttribute('aria-current'), 'page');
  await openCalendarEditor();
  await w.getByRole('tab', { name: /^Texts/ }).click();
  await editorDialog.waitFor({ state: 'detached' });
  assert.equal(await w.getByRole('tab', { name: /^Texts/ }).getAttribute('aria-selected'), 'true');
  await w.getByRole('tab', { name: /^Photos/ }).click();

  // A rejected save is acknowledged to the editor, which visibly stops and can be reopened on saved values.
  await openCalendarEditor();
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project:save');
    if (!original) throw new Error('Missing project save handler');
    ipcMain.removeHandler('project:save');
    ipcMain.handle('project:save', () => {
      ipcMain.removeHandler('project:save');
      ipcMain.handle('project:save', original);
      return { error: 'Simulated save failure' };
    });
  });
  await editorDialog.getByRole('radio', { name: 'Sunday' }).click();
  await editorDialog.getByRole('alert').filter({ hasText: 'The last change could not be saved' }).waitFor();
  assert.equal(await editorDialog.getByRole('radio', { name: 'Sunday' }).isDisabled(), true);
  assert.equal((await read()).spreads[7].elements.grid.params.firstWeekday, undefined);
  await closeEditor();
  await openCalendarEditor();
  await editorDialog.getByRole('radio', { name: 'Sunday' }).click();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await waitCalendar((s) => s.elements.grid.params.firstWeekday === 'sunday' && s.elements.grid.params.marked === '14');
  await closeEditor();
  await undoCalendar(2);

  const menu = (label) => menuAction(app, label);
  const rerendered = async (change) => {
    const old = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
    await change();
    await w.waitForFunction((url) => {
      const f = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return f && f.getAttribute('src') !== url;
    }, old, { timeout: 30000 });
    await waitBook();
  };
  // A watcher reload pauses the editor until the unrelated template change finishes, then editing resumes.
  const reloadTemplate = join(project, 'template', 'index.tsx');
  const beforeReload = await readFile(reloadTemplate, 'utf8');
  assert.ok(beforeReload.includes("'Paper tone'"));
  await openCalendarEditor();
  const reloadPreview = await w.locator('iframe.book-frame-book[data-current]').getAttribute('src');
  // Hold the real watcher notification path open long enough to attempt an edit during rebuilding.
  await owner.evaluate((window) => window.webContents.send('project:changed', { building: true }));
  await editorDialog.getByRole('status').filter({ hasText: 'Editing is paused while the book reloads' }).waitFor();
  assert.equal(await editorDialog.getByRole('radio', { name: 'Sunday' }).isDisabled(), true);
  assert.equal(await w.locator('.element-editor-frame').evaluate((frame) => frame.inert), true);
  await editorDialog.getByRole('radio', { name: 'Sunday' }).evaluate((button) => button.click());
  assert.equal((await read()).spreads[7].elements.grid.params.firstWeekday, undefined);
  await writeFile(reloadTemplate, beforeReload.replace("'Paper tone'", "'Paper tone (reload test)'"));
  await w.waitForFunction((url) => {
    const frame = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
    return frame && frame.getAttribute('src') !== url;
  }, reloadPreview, { timeout: 30000 });
  await waitBook();
  assert.equal(await editorDialog.getByRole('radio', { name: 'Sunday' }).isDisabled(), false);
  await editorDialog.getByRole('radio', { name: 'Sunday' }).click();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await waitCalendar((s) => s.elements.grid.params.firstWeekday === 'sunday' && s.elements.grid.params.marked === '14');
  assert.equal(await editorDialog.getByRole('alert').count(), 0);
  await closeEditor();
  await undoCalendar(2);
  await rerendered(() => writeFile(reloadTemplate, beforeReload));

  const beforeExternal = await readFile(join(project, 'project.json'), 'utf8');
  await openCalendarEditor();
  const external = JSON.parse(beforeExternal);
  external.spreads[7].elements.grid.params.month = '2028-05-01';
  await writeFile(join(project, 'project.json'), JSON.stringify(external, null, 2));
  await rerendered(() => menu('Reload Book'));
  await editorDialog.getByRole('alert').filter({ hasText: 'changed while this editor was open' }).waitFor();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).press('Meta+Enter');
  await w.waitForTimeout(300);
  assert.ok(await editorDialog.isVisible());
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2028-05-01' });
  await closeEditor();
  await writeFile(join(project, 'project.json'), beforeExternal);
  await rerendered(() => menu('Reload Book'));

  // Template changes also invalidate an open frame, including a changed default with no explicit saved value.
  const templateFile = join(project, 'template', 'index.tsx');
  const templateSource = await readFile(templateFile, 'utf8');
  const unsaved = JSON.parse(beforeExternal);
  delete unsaved.spreads[7].elements.grid.params.month;
  await writeFile(join(project, 'project.json'), JSON.stringify(unsaved, null, 2));
  await rerendered(() => menu('Reload Book'));
  await openCalendarEditor();
  const defaultMonth = "default: '2027-01-01', precision: 'month'";
  assert.ok(templateSource.includes(defaultMonth));
  await rerendered(() => writeFile(templateFile, templateSource.replace(defaultMonth, "default: '2028-01-01', precision: 'month'")));
  await editorDialog.getByRole('alert').filter({ hasText: 'changed while this editor was open' }).waitFor();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await w.waitForTimeout(300);
  assert.deepEqual((await read()).spreads[7].elements.grid.params, {});
  await closeEditor();
  await rerendered(() => writeFile(templateFile, templateSource));
  await writeFile(join(project, 'project.json'), beforeExternal);
  await rerendered(() => menu('Reload Book'));

  // Custom commit() remains supported, and one set({...}) is one Undo step.
  const withEditor = (code) => templateSource.replace(
    'function CalendarEditor({ values, set, readOnly, Control }: CalendarEditorProps) {',
    'function CalendarEditor({ values, set, readOnly, Control, commit, setSpread }: CalendarEditorProps) {\n' + code);
  const jump = `  const jump = <button type="button" onClick={() => { set({ month: '2027-04-01', marked: '9' }); commit(); }}>Jump to April</button>;
  const explode = <button type="button" onClick={() => { throw new Error('handler exploded'); }}>Explode</button>;`;
  await rerendered(() => writeFile(templateFile, withEditor(jump).replace(
    '<div className="calendar-editor-nav">', '<div className="calendar-editor-nav">{jump}{explode}')));
  await openCalendarEditor();
  await calendarEditor.getByRole('button', { name: 'Jump to April' }).click();
  await editorDialog.waitFor({ state: 'detached' });
  await waitCalendar((s) => s.elements.grid.params.month === '2027-04-01' && s.elements.grid.params.marked === '9');
  await waitBook();
  await undoCalendar();
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });

  // A failure keeps earlier applied changes, rejects subsequent writes, and leaves Close usable.
  await openCalendarEditor();
  await calendarEditor.getByRole('button', { name: '14', exact: true }).click();
  await waitCalendar((s) => s.elements.grid.params.marked === '14');
  await calendarEditor.getByRole('button', { name: 'Explode' }).click();
  await editorDialog.getByRole('alert').filter({ hasText: 'The editor stopped working: handler exploded' }).waitFor();
  await closeEditor();
  assert.equal((await read()).spreads[7].elements.grid.params.marked, '14');
  await undoCalendar();

  // Both scopes validate writes, keep warnings visible, and avoid redundant Undo entries for repeated values.
  const warn = `  const warn = <button type="button" onClick={() => {
    set({ marked: '9', firstWeekday: 'sunday' } as any);
    setSpread({ title: 'Scoped title', typo: 'bad' } as any);
  }}>Try changes</button>;`;
  await rerendered(() => writeFile(templateFile, withEditor(warn).replace(
    '<div className="calendar-editor-nav">', '<div className="calendar-editor-nav">{warn}')));
  await openCalendarEditor();
  await calendarEditor.getByRole('button', { name: 'Try changes' }).click();
  await editorDialog.locator('.ee-warnings').getByText(/setSpread\(\) ignored typo/).waitFor();
  await waitCalendar((s) => s.params.title === 'Scoped title' && s.elements.grid.params.marked === '9');
  await calendarEditor.getByRole('button', { name: 'Try changes' }).click();
  assert.equal(await editorDialog.locator('.ee-warnings li').count(), 2);
  await closeEditor();
  assert.equal((await read()).spreads[7].params.typo, undefined);
  assert.equal((await read()).spreads[7].elements.grid.params.firstWeekday, undefined);
  await undoCalendar(2);
  assert.deepEqual((await read()).spreads[7].elements.grid.params, { month: '2027-03-01' });
  assert.equal((await read()).spreads[7].params.title, undefined);

  // Errors during rendering are shown without trapping the user in a modal.
  await rerendered(() => writeFile(templateFile, withEditor("  if (values.month) throw new Error('render exploded');")));
  await openCalendarEditor({ sized: false });
  await editorDialog.getByRole('alert').filter({ hasText: 'The editor stopped working: render exploded' }).waitFor();
  await closeEditor();
  await rerendered(() => writeFile(templateFile, templateSource));

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
  await w.locator('.crop-more > summary').focus();
  await w.keyboard.press('ArrowDown');
  assert.equal(await w.evaluate(() => document.activeElement.textContent), 'Replace photo…');
  await w.keyboard.press('Enter');
  const photoChooser = w.getByRole('dialog', { name: 'Replace photo in Main photo' });
  await photoChooser.waitFor();
  await w.screenshot({ path: join(root, '.build', 'crop-photo-chooser.png') });
  await w.keyboard.press('Escape');
  await photoChooser.waitFor({ state: 'detached' });
  assert.ok(await w.locator('.crop-editor').isVisible(), 'Escape closes only the chooser');
  await w.locator('.crop-more > summary').click();
  await w.getByRole('button', { name: 'Replace photo…', exact: true }).click();
  await photoChooser.locator('[data-photo="shore"]').click();
  await saved('Shore placed in Main photo');
  assert.equal((await read()).spreads[1].boxes.hero.photo, 'shore');
  await w.waitForFunction(() => !document.querySelector('.crop-editor'));
  await openBox('Main photo');
  await w.locator('.crop-more > summary').click();
  await w.getByRole('button', { name: 'Remove photo', exact: true }).click();
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
  await saved('Spread deleted');
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
