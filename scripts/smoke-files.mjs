import { existsSync } from 'node:fs';
import { createRouteFixture } from './route-fixture.mjs';
import { clickPage, closeApp, menuAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// File parameters (#16): a test-only route map reads an optional GPX track from the project's files/.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'files-'));
const project = join(work, 'Book.imageflow');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  await createRouteFixture(project);
  const w = await testBook(app, project);
  w.setDefaultTimeout(20000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, project);
  const openDialog = (paths) => app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  // data-current marks the newest frame, which may still be loading after a change; read only a rendered one.
  const settled = () => w.waitForSelector('iframe.book-frame-book[data-current][data-ready]', { state: 'attached', timeout: 30000 });
  const status = async () => { await settled(); return frame.locator('body').evaluate(() => window.imageflowRenderStatus); };
  const saved = (text) => w.waitForFunction((text) => document.querySelector('.status')?.textContent === text, text);
  // Runs a change and waits for the book frame that renders its result.
  const rerendered = async (change) => {
    const old = await w.evaluate(() => document.querySelector('iframe.book-frame-book[data-current]')?.getAttribute('data-revision') ?? null);
    await change();
    await w.waitForFunction((url) => {
      const current = document.querySelector('iframe.book-frame-book[data-current][data-ready]');
      return current && current.getAttribute('data-revision') !== url;
    }, old, { timeout: 30000 });
  };
  const route = '[data-spread="road"] [data-element="route"]';
  const trackLine = async () => { await settled(); return frame.locator(route + ' polyline').count(); };
  const messages = async (kind) => (await status())[kind].map(({ message }) => message).join('\n');
  const routeDialog = w.getByRole('dialog', { name: 'Edit route' });
  const routeEditor = w.frameLocator('iframe.element-editor-frame');
  const editorReady = async () => {
    await routeDialog.waitFor();
    await w.waitForFunction(() => !document.querySelector('.element-editor .ee-status.muted'));
    // The panel grows upward while the frame loads; wait until its height has settled.
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
  const waitRoute = async (check) => {
    for (let i = 0; i < 100; i++) {
      if (check((await read()).spreads.find(({ id }) => id === 'road').elements.route.params)) return;
      await w.waitForTimeout(100);
    }
    assert.ok(check((await read()).spreads.find(({ id }) => id === 'road').elements.route.params));
  };
  const closeRoute = async () => {
    await routeDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await routeDialog.waitFor({ state: 'detached' });
    await w.waitForFunction(() => !document.querySelector('.preview-state, .preview-message'));
  };
  // Clicking the inset opens its Edit route editor, which owns the GPX track and the viewport. Returns the track
  // control, ImageFlow's own file control inside the template's editor.
  const openRoute = async () => {
    await frame.locator(route).scrollIntoViewIfNeeded();
    await w.waitForTimeout(200);
    const box = await frame.locator(route).boundingBox();
    await clickPage(w, box.x + box.width / 2, box.y + box.height / 2);
    await editorReady();
    return routeEditor.getByRole('combobox', { name: 'GPX track' });
  };

  await w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  // The fixture assigns a sample track: drawn, no issues. The other panorama has none and shows an empty frame.
  assert.equal(await trackLine(), 1);
  assert.equal((await status()).errors.length + (await status()).warnings.length, 0);
  assert.equal(await frame.locator('[data-spread="headlands"] [data-element="route"]').getAttribute('class'), 'route-map empty');

  // The route map saves each zoom/move while open; each action is undoable.
  const viewBox = () => frame.locator(route + ' svg').getAttribute('viewBox');
  assert.equal(await viewBox(), '0.000 0.000 100.000 100.000');
  // Clicking the inset opens its editor directly.
  await frame.locator(route).scrollIntoViewIfNeeded();
  await w.waitForTimeout(200);
  const inset = await frame.locator(route).boundingBox();
  await clickPage(w, inset.x + inset.width / 2, inset.y + inset.height / 2);
  await editorReady();
  const note = (text) => routeEditor.locator('.route-editor-nav', { hasText: text }).waitFor();
  await routeEditor.getByRole('button', { name: 'Zoom in' }).click();
  await note('Zoom 1.5×');
  await routeEditor.getByRole('button', { name: 'Zoom in' }).click();
  await note('Zoom 2.3×');
  await routeEditor.getByRole('application', { name: 'Route viewport' }).press('ArrowRight');
  await routeEditor.locator('svg[viewBox="32.218 27.778 44.444 44.444"]').waitFor();
  await waitRoute((p) => p.zoom === 2.25 && p.centerX === 0.5444);
  await closeRoute();
  await saved('Route map updated');
  const framed = (await read()).spreads.find(({ id }) => id === 'road').elements.route.params;
  assert.deepEqual(framed, { track: 'senja-road', centerX: 0.5444, zoom: 2.25 });
  // Saved is not yet shown: the book view renders the saved view next.
  for (let i = 0; i < 100 && await viewBox() !== '32.218 27.778 44.444 44.444'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await viewBox(), '32.218 27.778 44.444 44.444');
  for (let i = 0; i < 3; i++) await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
  assert.equal(await viewBox(), '0.000 0.000 100.000 100.000');
  // Without a track the editor says what is missing.
  const empty = frame.locator('[data-spread="headlands"] [data-element="route"]');
  await empty.scrollIntoViewIfNeeded();
  await w.waitForTimeout(200);
  const emptyBox = await empty.boundingBox();
  // The inset lies over the panorama photo: what is drawn on top decides, so the click opens its editor rather
  // than selecting the photo.
  await clickPage(w, emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2);
  await routeDialog.waitFor();
  assert.equal(await w.locator('.crop-editor').count(), 0);
  await routeEditor.getByText('Choose a GPX track to draw the route.').waitFor();
  assert.equal(await routeEditor.getByRole('combobox', { name: 'GPX track' }).inputValue(), '');
  await routeDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await w.waitForFunction(() => !document.querySelector('.element-editor'));

  // Clearing is a valid state: no route, no issue. The editor saves the change at once, and Undo
  // restores the assignment.
  let track = await openRoute();
  assert.equal(await track.inputValue(), 'senja-road');
  await routeEditor.getByRole('button', { name: 'Remove GPX track', exact: true }).click();
  await routeEditor.getByText('Choose a GPX track to draw the route.').waitFor();
  await waitRoute((p) => p.track === '');
  await closeRoute();
  await saved('Route map updated');
  assert.equal((await read()).spreads.find(({ id }) => id === 'road').elements.route.params.track, '');
  assert.equal(await trackLine(), 0);
  assert.equal((await status()).errors.length, 0);
  await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
  assert.equal(await trackLine(), 1);

  // Choose… in the editor copies the file into files/ and registers it at once; the editor reads it immediately and
  // Choosing it assigns it immediately. A file the template cannot parse is the template's diagnostic; the book still renders.
  const broken = join(work, 'Broken ride.gpx');
  await writeFile(broken, '<gpx><trk><trkseg><trkpt lat="69.2"');
  await openDialog([broken]);
  track = await openRoute();
  await routeEditor.getByRole('combobox', { name: 'GPX track' }).selectOption(':choose');
  await routeEditor.getByText('Broken ride.gpx is not valid GPX.').waitFor();
  assert.match(await track.inputValue(), /^fl-/);
  assert.deepEqual((await track.locator('option').allTextContents()).sort(), ['Choose file…', 'Replace file…', 'senja-road.gpx']);
  await waitRoute((p) => /^fl-/.test(p.track));
  await closeRoute();
  await saved('Route map updated');
  const afterImport = await read();
  const imported = afterImport.spreads.find(({ id }) => id === 'road').elements.route.params.track;
  assert.match(imported, /^fl-/);
  assert.match(afterImport.files[imported], /^files\/fl-[a-f0-9-]{12}-Broken ride\.gpx$/);
  assert.equal(await readFile(join(project, afterImport.files[imported]), 'utf8'), await readFile(broken, 'utf8'));
  assert.equal(await trackLine(), 0);
  assert.match(await messages('warnings'), /Broken ride\.gpx is not valid GPX; the route is left out\./);
  assert.deepEqual((await status()).errors.map(({ code, message }) => code + ': ' + message), []);
  // The template reports it with issue(): a stable code on the route element, its file parameter and the file, once.
  const gpx = (await status()).warnings.filter(({ code }) => code === 'template:gpx-invalid');
  assert.deepEqual(gpx.map(({ spread, element, parameter, source, suggestion }) => ({ spread, element, parameter, source, hint: !!suggestion })),
    [{ spread: 'road', element: 'route', parameter: 'track', source: imported, hint: true }]);
  // Undo removes the assignment but keeps the registered file, so it can be chosen again.
  await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
  assert.equal(await trackLine(), 1);
  assert.equal((await read()).files[imported], afterImport.files[imported]);

  // An assigned file that disappears is an error that names the parameter; restoring it clears the error.
  const sample = join(project, 'files', 'senja-road.gpx');
  const aside = join(work, 'senja-road.gpx');
  await rerendered(() => rename(sample, aside));
  assert.match(await messages('errors'), /Route map · GPX track: Missing project file: files\/senja-road\.gpx/);
  assert.equal(await trackLine(), 1, 'Keep a visibly stale last-good parameter-file preview while its original is missing.');
  await rerendered(() => rename(aside, sample));
  assert.equal(await trackLine(), 1);
  assert.equal((await status()).errors.length, 0);

  // File controls follow the book’s import policy through the editor-frame bridge.
  for (const mode of ['link', 'copy']) {
    const original = join(work, mode + '-through-editor.gpx');
    await writeFile(original, await readFile(sample));
    await openDialog([original]);
    if (((await read()).importMode ?? 'copy') !== mode) await rerendered(() => menuAction(app, 'Copy Assets into Book'));
    await openRoute();
    assert.equal(await routeEditor.getByRole('combobox', { name: 'File import mode' }).count(), 0);
    await routeEditor.getByRole('combobox', { name: 'GPX track' }).selectOption(':choose');
    await routeEditor.locator('.box-photo-name').filter({ hasText: mode + '-through-editor.gpx' }).waitFor();
    const selectedTrack = await routeEditor.getByRole('combobox', { name: 'GPX track' }).inputValue();
    await waitRoute((p) => p.track === selectedTrack);
    await closeRoute();
    const state = await read();
    const id = state.spreads.find(({ id }) => id === 'road').elements.route.params.track;
    if (mode === 'link') assert.deepEqual(state.files[id], { path: original, linked: true });
    else assert.equal(typeof state.files[id], 'string');
    await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
    assert.equal(await trackLine(), 1);
  }

  // A file of a type the parameter does not accept, registered by hand, is reported rather than parsed.
  // The book may show an Undo before its save has finished; editing project.json from outside meanwhile is a conflict.
  for (let i = 0; i < 200 && existsSync(join(project, '.imageflow/persistence/pending-save.json')); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  const data = await read();
  data.files.notes = 'files/notes.txt';
  data.spreads.find(({ id }) => id === 'road').elements.route.params.track = 'notes';
  await writeFile(join(project, 'files', 'notes.txt'), 'not a track');
  await writeFile(join(project, 'project.json'), JSON.stringify(data, null, 2));
  await rerendered(() => menuAction(app, 'Reload'));
  assert.match(await messages('errors'), /GPX track: notes\.txt is not a \.gpx file/);
  // A reference to an ID that is not registered is kept and reported, not dropped.
  delete data.files.notes;
  await writeFile(join(project, 'project.json'), JSON.stringify(data, null, 2));
  await rerendered(() => menuAction(app, 'Reload'));
  assert.match(await messages('errors'), /GPX track: the assigned file is no longer in the project/);
  assert.equal((await read()).spreads.find(({ id }) => id === 'road').elements.route.params.track, 'notes');
  data.spreads.find(({ id }) => id === 'road').elements.route.params.track = 'senja-road';
  await writeFile(join(project, 'project.json'), JSON.stringify(data, null, 2));

  await rerendered(() => menuAction(app, 'Reload'));
  assert.equal(await trackLine(), 1);

  // The Assets tab removes a file that is still assigned only after saying where it is used. Cancel changes nothing;
  // Remove clears the assignment and the registry entry together, and one Undo brings both back.
  await app.evaluate(({ dialog }) => {
    globalThis.prompts = []; globalThis.answer = 1;
    dialog.showMessageBox = async (_owner, options) => { globalThis.prompts.push(options); return { response: globalThis.answer }; };
  });
  await w.locator('.sources-bar [role="tab"]').filter({ hasText: 'Assets' }).click();
  const row = w.locator('.source-manager-embedded .asset-row[data-source="file:senja-road"]');
  await row.waitFor();
  await row.click();
  await w.keyboard.press('Delete');
  await w.waitForFunction(() => document.querySelector('.source-manager-embedded[aria-busy="false"]'));
  const [prompt] = await app.evaluate(() => globalThis.prompts);
  assert.match(prompt.message, /senja-road\.gpx/);
  assert.match(prompt.detail, /used in: .*Page/);
  assert.deepEqual(prompt.buttons, ['Remove', 'Cancel']);
  assert.equal((await read()).files['senja-road'], 'files/senja-road.gpx', 'Cancel keeps the file');
  assert.equal((await read()).spreads.find(({ id }) => id === 'road').elements.route.params.track, 'senja-road');
  await app.evaluate(() => { globalThis.answer = 0; });
  await rerendered(() => w.keyboard.press('Delete'));
  assert.equal((await read()).files['senja-road'], undefined);
  assert.equal((await read()).spreads.find(({ id }) => id === 'road').elements.route.params.track, undefined);
  assert.equal(await trackLine(), 0);
  assert.ok((await readdir(join(project, 'files'))).includes('senja-road.gpx'), 'The copied file stays for Undo');
  await rerendered(() => w.getByRole('button', { name: 'Undo', exact: true }).click());
  assert.equal((await read()).files['senja-road'], 'files/senja-road.gpx');
  assert.equal((await read()).spreads.find(({ id }) => id === 'road').elements.route.params.track, 'senja-road');
  assert.equal(await trackLine(), 1);
  assert.equal((await app.evaluate(() => globalThis.prompts)).length, 2);

  // Import… takes a file the template's file parameter accepts, and skips one it does not.
  const extra = join(work, 'Extra ride.gpx');
  const sheet = join(work, 'Sheet.csv');
  await writeFile(extra, await readFile(join(project, 'files', 'senja-road.gpx')));
  await writeFile(sheet, 'a,b\n1,2\n');
  await openDialog([extra, sheet]);
  await w.getByRole('button', { name: 'Import…' }).click();
  await w.locator('.source-manager-embedded .asset-row', { hasText: 'Extra ride.gpx' }).waitFor();
  const added = Object.values((await read()).files).filter((path) => /Extra ride/.test(path));
  assert.equal(added.length, 1);
  assert.match(added[0], /^files\/fl-[a-f0-9-]{12}-Extra ride\.gpx$/);
  assert.ok(!(await readdir(join(project, 'files'))).some((name) => name.includes('Sheet')), 'Unaccepted files are skipped');
  await w.getByText('1 unsupported file skipped.').waitFor();
  await w.locator('.sources-bar [role="tab"]').filter({ hasText: 'Photos' }).click();
  // The Assets window imports the same way and tells the book window.
  const second = join(work, 'Second ride.gpx');
  await writeFile(second, await readFile(extra));
  await openDialog([second]);
  await menuAction(app, 'Assets…');
  const manager = await (async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = app.windows().find((window) => window.url() === 'imageflow://editor/assets');
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Assets window did not open');
  })();
  await manager.getByRole('button', { name: 'Import…' }).click();
  await manager.locator('.asset-row', { hasText: 'Second ride.gpx' }).waitFor();
  assert.equal(Object.values((await read()).files).filter((path) => /Second ride/.test(path)).length, 1);
  await w.locator('.sources-bar [role="tab"]').filter({ hasText: 'Assets' }).click();
  await w.locator('.source-manager-embedded .asset-row', { hasText: 'Second ride.gpx' }).waitFor();
  await w.locator('.sources-bar [role="tab"]').filter({ hasText: 'Photos' }).click();

  // References are relative to the project: a moved project opens with its track.
  const moved = join(work, 'Moved book.imageflow');
  await rename(project, moved);
  await openDialog([moved]);
  await rerendered(() => menuAction(app, 'Open project…'));
  assert.equal(await trackLine(), 1);
  assert.equal((await status()).errors.length, 0);
  assert.ok((await readdir(join(moved, 'files'))).includes('senja-road.gpx'));
  console.log('ImageFlow file parameters passed.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
