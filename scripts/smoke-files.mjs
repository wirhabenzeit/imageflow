import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// File parameters (#16): the starter's panorama route map reads an optional GPX track from the project's files/.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'files-'));
const project = join(work, 'Book');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await app.firstWindow();
  w.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, project);
  const openDialog = (paths) => app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const status = () => frame.locator('body').evaluate(() => window.imageflowRenderStatus);
  const saved = (text) => w.waitForFunction((text) => document.querySelector('.status')?.textContent === text, text);
  // Runs a change and waits for the book frame that renders its result.
  const rerendered = async (change) => {
    const old = await w.evaluate(() => document.querySelector('iframe.book-frame-book[data-current]')?.getAttribute('src') ?? null);
    await change();
    await w.waitForFunction((url) => {
      const current = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return current && current.getAttribute('src') !== url;
    }, old, { timeout: 30000 });
  };
  const route = '[data-spread="road"] [data-element="route"]';
  const trackLine = () => frame.locator(route + ' polyline').count();
  const messages = async (kind) => (await status())[kind].map(({ message }) => message).join('\n');
  const openRoute = async () => {
    await frame.locator(route).scrollIntoViewIfNeeded();
    await w.waitForTimeout(200);
    const box = await frame.locator(route).boundingBox();
    await w.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const popover = w.getByRole('dialog', { name: 'Edit GPX track' });
    await popover.waitFor();
    return popover;
  };
  const closePopover = async () => {
    await w.locator('.toolbar .brand').click();
    await w.waitForFunction(() => !document.querySelector('.edit-popover'));
  };

  await rerendered(() => w.getByRole('button', { name: 'New project…', exact: true }).click());
  // The starter assigns a sample track: drawn, no issues. The other panorama has none and shows an empty frame.
  assert.equal(await trackLine(), 1);
  assert.equal((await status()).errors.length + (await status()).warnings.length, 0);
  assert.equal(await frame.locator('[data-spread="headlands"] [data-element="route"]').getAttribute('class'), 'route-map empty');

  // The route map's own editor frames part of the route: zoom and move, then Done saves the viewport as one edit.
  const viewBox = () => frame.locator(route + ' svg').getAttribute('viewBox');
  assert.equal(await viewBox(), '0.000 0.000 100.000 100.000');
  // Clicking the inset opens its popover; the editor owns the viewport, so the popover offers it as a button.
  await (await openRoute()).getByRole('button', { name: 'Frame route…' }).click();
  const routeDialog = w.getByRole('dialog', { name: 'Frame route' });
  await routeDialog.waitFor();
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor .ee-status.muted'));
  await w.waitForFunction(() => document.querySelector('iframe.element-editor-frame')?.style.height !== '240px');
  const routeEditor = w.frameLocator('iframe.element-editor-frame');
  const note = (text) => routeEditor.locator('.route-editor-note', { hasText: text }).waitFor();
  await routeEditor.getByRole('button', { name: 'Zoom in' }).click();
  await note('Zoom 1.5×');
  await routeEditor.getByRole('button', { name: 'Zoom in' }).click();
  await note('Zoom 2.3×');
  await routeEditor.getByRole('application', { name: 'Route viewport' }).press('ArrowRight');
  await routeEditor.locator('svg[viewBox="32.218 27.778 44.444 44.444"]').waitFor();
  await rerendered(() => routeDialog.getByRole('button', { name: 'Done' }).click());
  await saved('Route map updated');
  const framed = (await read()).spreads.find(({ id }) => id === 'road').elements.route.params;
  assert.deepEqual(framed, { track: 'senja-road', centerX: 0.5444, centerY: 0.5, zoom: 2.25 });
  assert.equal(await viewBox(), '32.218 27.778 44.444 44.444');
  await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
  assert.equal(await viewBox(), '0.000 0.000 100.000 100.000');
  // Without a track the editor says what is missing.
  const empty = frame.locator('[data-spread="headlands"] [data-element="route"]');
  await empty.scrollIntoViewIfNeeded();
  await w.waitForTimeout(200);
  const emptyBox = await empty.boundingBox();
  // Double-clicking the inset, which lies over the panorama photo, opens its editor rather than crop mode.
  await w.mouse.dblclick(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2);
  await routeDialog.waitFor();
  assert.equal(await w.locator('.crop-editor').count(), 0);
  await routeEditor.getByText('Choose a GPX track for the route map first.').waitFor();
  await routeDialog.getByRole('button', { name: 'Cancel' }).click();
  await w.waitForFunction(() => !document.querySelector('dialog.element-editor'));

  // Clearing is a valid state: no route, no issue. Undo restores the assignment.
  let popover = await openRoute();
  assert.equal(await popover.getByRole('combobox', { name: 'GPX track' }).inputValue(), 'senja-road');
  await rerendered(() => popover.getByRole('combobox', { name: 'GPX track' }).selectOption(''));
  await saved('GPX track updated');
  assert.equal((await read()).spreads.find(({ id }) => id === 'road').elements.route.params.track, '');
  assert.equal(await trackLine(), 0);
  assert.equal((await status()).errors.length, 0);
  await closePopover();
  await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
  assert.equal(await trackLine(), 1);

  // Choose… copies the file into files/, registers it and assigns it. A file the template cannot parse is the
  // template's diagnostic (data-issue); the book still renders.
  const broken = join(work, 'Broken ride.gpx');
  await writeFile(broken, '<gpx><trk><trkseg><trkpt lat="69.2"');
  await openDialog([broken]);
  popover = await openRoute();
  await rerendered(() => popover.getByRole('button', { name: 'Choose…' }).click());
  await saved('GPX track updated');
  const afterImport = await read();
  const imported = afterImport.spreads.find(({ id }) => id === 'road').elements.route.params.track;
  assert.match(imported, /^fl-/);
  assert.match(afterImport.files[imported], /^files\/fl-[a-f0-9-]{12}-Broken ride\.gpx$/);
  assert.equal(await readFile(join(project, afterImport.files[imported]), 'utf8'), await readFile(broken, 'utf8'));
  assert.equal(await trackLine(), 0);
  assert.match(await messages('warnings'), /Broken ride\.gpx is not valid GPX; the route is left out\./);
  assert.equal((await status()).errors.length, 0);
  assert.deepEqual((await popover.getByRole('combobox', { name: 'GPX track' }).locator('option').allTextContents()).sort(),
    ['Broken ride.gpx', 'None', 'senja-road.gpx']);
  // Undo removes the assignment but keeps the registered file, so it can be chosen again.
  await closePopover();
  await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
  assert.equal(await trackLine(), 1);
  assert.equal((await read()).files[imported], afterImport.files[imported]);

  // An assigned file that disappears is an error that names the parameter; restoring it clears the error.
  const sample = join(project, 'files', 'senja-road.gpx');
  const aside = join(work, 'senja-road.gpx');
  await rerendered(() => rename(sample, aside));
  assert.match(await messages('errors'), /Route map · GPX track: Missing project file: files\/senja-road\.gpx/);
  assert.equal(await trackLine(), 0);
  await rerendered(() => rename(aside, sample));
  assert.equal(await trackLine(), 1);
  assert.equal((await status()).errors.length, 0);

  // A file of a type the parameter does not accept, registered by hand, is reported rather than parsed.
  const data = await read();
  data.files.notes = 'files/notes.txt';
  data.spreads.find(({ id }) => id === 'road').elements.route.params.track = 'notes';
  await writeFile(join(project, 'files', 'notes.txt'), 'not a track');
  await writeFile(join(project, 'project.json'), JSON.stringify(data, null, 2));
  await rerendered(() => w.getByRole('button', { name: 'Reload', exact: true }).click());
  assert.match(await messages('errors'), /GPX track: notes\.txt is not a \.gpx file/);
  // A reference to an ID that is not registered is kept and reported, not dropped.
  delete data.files.notes;
  await writeFile(join(project, 'project.json'), JSON.stringify(data, null, 2));
  await rerendered(() => w.getByRole('button', { name: 'Reload', exact: true }).click());
  assert.match(await messages('errors'), /GPX track: the assigned file is no longer in the project/);
  assert.equal((await read()).spreads.find(({ id }) => id === 'road').elements.route.params.track, 'notes');
  data.spreads.find(({ id }) => id === 'road').elements.route.params.track = 'senja-road';
  await writeFile(join(project, 'project.json'), JSON.stringify(data, null, 2));

  // References are relative to the project: a moved project opens with its track.
  const moved = join(work, 'Moved book');
  await rename(project, moved);
  await openDialog([moved]);
  await rerendered(() => w.getByRole('button', { name: 'Open project…', exact: true }).click());
  assert.equal(await trackLine(), 1);
  assert.equal((await status()).errors.length, 0);
  assert.ok((await readdir(join(moved, 'files'))).includes('senja-road.gpx'));
  console.log('ImageFlow file parameters passed.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
