import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { testBook, menuAction } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await realpath(await mkdtemp(join(root, '.build/linked-smoke-')));
const folder = join(work, 'Linked Book.imageflow');
const external = join(work, 'external');
await mkdir(external);
const photo = join(external, 'Landscape.png');
const text = join(external, 'Story.md');
const file = join(external, 'Route.gpx');
await sharp({ create: { width: 3200, height: 2400, channels: 3, background: '#275a48' } }).png().toFile(photo);
await writeFile(text, '# Linked story\n\nWords from outside the book.');
await cp(join(root, 'sample/starter/files/senja-road.gpx'), file);
const packaged = process.argv.includes('--packaged');
const app = await _electron.launch({ executablePath: packaged ? join(root, 'out', 'ImageFlow-darwin-' + process.arch, 'ImageFlow.app/Contents/MacOS/ImageFlow') : electron, args: [...(packaged ? [] : [join(root, '.build/desktop')]), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const stderr = [];
app.process().stderr.on('data', (bytes) => stderr.push(String(bytes)));
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
async function ready(page) {
  page.setDefaultTimeout(30000);
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await page.waitForFunction(() => !document.querySelector('.preview-state') && !document.querySelector('.book-check-stale'));
}
async function reload(page) { await page.reload(); await ready(page); }
try {
  const page = await testBook(app, folder, true);
  await ready(page);
  let summary = await current(page);
  summary.project.importMode = 'link';
  assert.ok((await page.evaluate((s) => window.imageflow.saveProject(s.id, { project: s.project, photoIndex: s.photoIndex }), summary)).value);
  await reload(page);
  const imported = {};
  for (const [kind, path] of [['photo', photo], ['markdown', text], ['file', file]]) {
    const result = await page.evaluate(async ({ kind, path }) => {
      const { value } = await window.imageflow.currentProject();
      return window.imageflow.importFiles(value.id, { kind, paths: [path], accept: ['.gpx'] });
    }, { kind, path });
    assert.ok(result.value, JSON.stringify(result));
    imported[kind] = result.value.imported[0];
  }
  await reload(page);
  summary = await current(page);
  assert.equal(Object.values(summary.sources).filter((source) => source.linked).length, 3);
  summary.project.spreads[1].boxes.hero = { photo: imported.photo, params: {}, crops: { story: { centerX: .3, centerY: .6, zoom: 1.2 } } };
  summary.project.spreads[3].boxes.hero = { photo: imported.photo, params: {} };
  summary.project.spreads[1].boxes.body = { text: imported.markdown, params: {} };
  summary.project.spreads[9].elements.route.params.track = imported.file;
  assert.ok((await page.evaluate((s) => window.imageflow.saveProject(s.id, { project: s.project, photoIndex: s.photoIndex }), summary)).value);
  await reload(page);
  const crop = (await current(page)).project.spreads[1].boxes.hero.crops;
  const replacement = join(external, 'New.png');
  await sharp({ create: { width: 3600, height: 2800, channels: 3, background: '#e4b874' } }).png().toFile(replacement);
  await rename(replacement, photo);
  await page.waitForFunction(async (id) => (await window.imageflow.currentProject()).value.photoSizes[id]?.width === 3600, imported.photo);
  assert.deepEqual((await current(page)).project.spreads[1].boxes.hero.crops, crop);
  const goodPhoto = await readFile(photo);
  await writeFile(photo, goodPhoto.subarray(0, 12));
  await page.waitForFunction(async (id) => {
    const source = (await window.imageflow.currentProject()).value.sources['photo:' + id];
    return source.state === 'unreadable' && source.cached;
  }, imported.photo);
  await writeFile(photo, goodPhoto);
  await page.waitForFunction(async (id) => (await window.imageflow.currentProject()).value.sources['photo:' + id].state === 'available', imported.photo);
  const markdownReplacement = join(external, 'new.md');
  await writeFile(markdownReplacement, '# Revised externally\n\nA second edition.');
  await rename(markdownReplacement, text);
  await page.waitForFunction(async (id) => (await window.imageflow.currentProject()).value.texts[id]?.includes('A second edition.'), imported.markdown);
  const fileBefore = (await current(page)).sources['file:' + imported.file].digest;
  await writeFile(file, (await readFile(file, 'utf8')).replace('</gpx>', '<!-- external save --></gpx>'));
  await page.waitForFunction(async ({ id, before }) => (await window.imageflow.currentProject()).value.sources['file:' + id].digest !== before, { id: imported.file, before: fileBefore });
  await ready(page);
  // An external write during rendering must neither change pinned image bytes nor publish a falsely current PDF.
  const race = join(work, 'Race.pdf');
  const raceReplacement = join(external, 'Race.png');
  await sharp({ create: { width: 3600, height: 2800, channels: 3, background: '#354177' } }).png().toFile(raceReplacement);
  const ownerId = await (await app.browserWindow(page)).evaluate((window) => window.id);
  await app.evaluate(({ BrowserWindow, dialog }, { id, replacement, photo, output }) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
    const fs = process.getBuiltinModule('node:fs');
    const owner = BrowserWindow.fromId(id);
    const send = owner.webContents.send.bind(owner.webContents);
    owner.webContents.send = (channel, ...args) => {
      if (channel === 'project:progress' && String(args[0]).startsWith('Rendering spreads')) {
        fs.renameSync(replacement, photo);
        owner.webContents.send = send;
      }
      return send(channel, ...args);
    };
  }, { id: ownerId, replacement: raceReplacement, photo, output: race });
  let state = await current(page);
  let raced;
  for (let attempt = 0; attempt < 5; attempt++) {
    raced = await page.evaluate((id) => window.imageflow.exportBook(id, 'proof'), (await current(page)).id);
    if (!raced.error?.includes('while preparing export')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.match(raced.error, /Sources changed during export/);
  await reload(page);
  await assert.rejects(stat(race), { code: 'ENOENT' });
  await page.waitForFunction(async () => (await window.imageflow.currentProject()).value.sources && !document.querySelector('.preview-state'));
  // Remove all originals. The book stays editable and every source keeps a marked cached view.
  const photoBytes = await readFile(photo); const textBytes = await readFile(text); const fileBytes = await readFile(file);
  await Promise.all([photo, text, file].map((path) => rm(path)));
  await page.waitForFunction(async () => Object.values((await window.imageflow.currentProject()).value.sources).filter((source) => source.linked).every((source) => source.state === 'missing' && source.cached));
  await ready(page);
  await menuAction(app, 'Manage Sources…');
  const manager = page.getByRole('dialog', { name: 'Book sources' });
  await manager.waitFor();
  // A linked-file refresh may still own the book just after the renderer becomes ready.
  // Retry only that explicit busy response; any other error must fail with its actual message.
  let collectionError;
  for (let attempt = 0; attempt < 5; attempt++) {
    await manager.getByRole('button', { name: 'Include All Assets', exact: true }).click();
    const alert = manager.getByRole('alert');
    await alert.waitFor();
    collectionError = await alert.innerText();
    if (collectionError !== 'ImageFlow is finishing another operation in this book.') break;
    await ready(page);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(collectionError, /Cannot include all assets/);
  await page.screenshot({ path: join(root, '.build/linked-missing-sources.png') });
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  let checked;
  for (let attempt = 0; attempt < 5; attempt++) {
    state = await current(page);
    checked = await page.evaluate((id) => window.imageflow.checkBook(id, {}), state.id);
    const stale = checked.value?.diagnostics.some((finding) => finding.code === 'source-changed');
    if (!stale && checked.error !== 'ImageFlow is finishing another operation in this book.') break;
    await ready(page);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(checked.value?.diagnostics.some((finding) => finding.code === 'source-unavailable'), JSON.stringify(checked));
  const print = join(work, 'Missing-print.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, print);
  const blocked = await page.evaluate((id) => window.imageflow.exportBook(id, 'print'), state.id);
  assert.ok(blocked.error);
  await assert.rejects(stat(print), { code: 'ENOENT' });
  const proof = join(work, 'Missing-proof.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, proof);
  const warned = await page.evaluate((id) => window.imageflow.exportBook(id, 'proof'), (await current(page)).id);
  assert.ok(warned.value, JSON.stringify(warned));
  assert.ok(warned.value.errors.some((finding) => finding.code === 'source-unavailable'));
  await stat(proof);
  assert.match(execFileSync('pdftotext', [proof, '-']).toString(), /PROOF: ORIGINAL UNAVAILABLE/);
  await Promise.all([writeFile(photo, photoBytes), writeFile(text, textBytes), writeFile(file, fileBytes)]);
  await page.waitForFunction(async () => Object.values((await window.imageflow.currentProject()).value.sources).every((source) => source.state === 'available'));
  await ready(page);
  await reload(page);
  // An unavailable unused library original is a warning, not a reason to block printing.
  const unused = join(external, 'Unused.png');
  await writeFile(unused, photoBytes);
  const unusedImport = await page.evaluate(async (path) => {
    const { value } = await window.imageflow.currentProject();
    return window.imageflow.importFiles(value.id, { kind: 'photo', mode: 'link', paths: [path] });
  }, unused);
  assert.ok(unusedImport.value, JSON.stringify(unusedImport));
  const unusedId = unusedImport.value.imported[0];
  await reload(page);
  await rm(unused);
  await page.waitForFunction(async (id) => (await window.imageflow.currentProject()).value.sources['photo:' + id].state === 'missing', unusedId);
  const unusedPrint = join(work, 'Unused-missing-print.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, unusedPrint);
  const printable = await page.evaluate((id) => window.imageflow.exportBook(id, 'print'), (await current(page)).id);
  assert.ok(printable.value, JSON.stringify(printable));
  await stat(unusedPrint);
  await writeFile(unused, photoBytes);
  await page.waitForFunction(async (id) => (await window.imageflow.currentProject()).value.sources['photo:' + id].state === 'available', unusedId);
  await reload(page);
  // A shared manifest cannot approve a local file, even when its extension is valid for a parameter.
  const unselected = join(external, 'NotChosen.gpx');
  await writeFile(unselected, '<gpx><!-- private dummy fixture --></gpx>');
  const manifestPath = join(folder, 'project.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files.notchosen = { path: unselected, linked: true };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await page.evaluate(() => window.imageflow.openProject('reload'));
  await reload(page);
  assert.equal((await current(page)).sources['file:notchosen'].state, 'unapproved');
  const loadedFile = () => page.frameLocator('iframe.book-frame-book[data-current][data-ready]').locator('body').evaluate(async () =>
    (await (await fetch(location.pathname + '/data')).json()).files.notchosen.text);
  assert.equal(await loadedFile(), undefined);
  const historyBeforeLocate = (await current(page)).history;
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, unselected);
  await menuAction(app, 'Manage Sources…');
  const accessManager = page.getByRole('dialog', { name: 'Book sources' });
  const unapprovedRow = accessManager.getByRole('row').filter({ hasText: 'NotChosen.gpx' });
  await unapprovedRow.getByText('Locate to approve access', { exact: true }).waitFor();
  await unapprovedRow.getByRole('button', { name: 'Locate…', exact: true }).click();
  await unapprovedRow.getByText('Available', { exact: true }).waitFor();
  assert.deepEqual((await current(page)).history, historyBeforeLocate, 'Locate does not add an empty Undo step');
  await accessManager.getByRole('button', { name: 'Done', exact: true }).click();
  await reload(page);
  assert.match(await loadedFile(), /private dummy fixture/);
  // Save a Copy exposes collection as an explicit choice and opens an independent, portable document.
  const portable = join(work, 'Portable.imageflow');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, portable);
  await menuAction(app, 'Save a Copy…');
  const save = page.getByRole('dialog', { name: 'Save a copy' });
  await save.waitFor();
  assert.equal(await save.getByRole('checkbox', { name: 'Include all assets' }).isChecked(), true);
  await page.screenshot({ path: join(root, '.build/linked-save-copy.png') });
  const before = new Set(app.windows());
  await save.getByRole('button', { name: 'Choose Location…' }).click();
  await page.waitForFunction(() => !document.querySelector('.save-copy-dialog') || document.querySelector('.save-copy-dialog [role=alert]'));
  if (await save.count()) throw new Error(await save.getByRole('alert').textContent());
  const copy = app.windows().find((page) => !before.has(page) && page.url() === 'imageflow://editor/');
  assert.ok(copy);
  await ready(copy);
  const portableState = await current(copy);
  assert.ok(Object.values(portableState.sources).every((source) => !source.linked && source.state === 'available'));
  assert.deepEqual(portableState.project.spreads[1].boxes.hero.crops, crop);
  assert.equal(portableState.project.spreads[1].boxes.hero.photo, imported.photo);
  await rm(external, { recursive: true });
  await copy.evaluate(() => window.imageflow.openProject('reload'));
  await reload(copy);
  assert.ok(Object.values((await current(copy)).sources).every((source) => source.state === 'available'));
  console.log('Linked photos, Markdown and parameter files, atomic refresh, cached missing states, export consistency, and portable Save a Copy passed.');
} catch (error) { console.error(stderr.join('\n')); throw error; }
finally { await app.close(); await rm(work, { recursive: true, force: true }); }
