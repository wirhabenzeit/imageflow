import { packagedMacExecutable } from './mac-paths.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import sharp from 'sharp';
import { testBook, menuAction, retryBookRefresh, waitForPage } from './ui-actions.mjs';

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
const app = await _electron.launch({ executablePath: packaged ? packagedMacExecutable(root) : electron, args: [...(packaged ? [] : [join(root, '.build/desktop')]), '--user-data-dir=' + join(work, 'profile')], env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
const stderr = [];
app.process().stderr.on('data', (bytes) => stderr.push(String(bytes)));
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
async function ready(page) {
  page.setDefaultTimeout(30000);
  await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await page.waitForFunction(() => !document.querySelector('.preview-state') && !document.querySelector('.book-check-stale'));
}
async function reload(page) { await page.reload(); await ready(page); }
async function assetWindow() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = app.windows().find((window) => window.url() === 'imageflow://editor/assets');
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Assets window did not open');
}

try {
  const page = await testBook(app, folder, true);
  await ready(page);
  let summary = await current(page);
  assert.ok((await page.evaluate(async () => { const { value } = await window.imageflow.currentProject(); value.project.importMode = 'link'; return window.imageflow.saveProject(value.id, value); })).value);
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
  await waitForPage(page, async (id) => (await window.imageflow.currentProject()).value.photoSizes[id]?.width === 3600, imported.photo);
  assert.deepEqual((await current(page)).project.spreads[1].boxes.hero.crops, crop);
  const goodPhoto = await readFile(photo);
  await writeFile(photo, goodPhoto.subarray(0, 12));
  await waitForPage(page, async (id) => {
    const source = (await window.imageflow.currentProject()).value.sources['photo:' + id];
    return source.state === 'unreadable' && source.cached;
  }, imported.photo);
  await writeFile(photo, goodPhoto);
  await waitForPage(page, async (id) => (await window.imageflow.currentProject()).value.sources['photo:' + id].state === 'available', imported.photo);
  const markdownReplacement = join(external, 'new.md');
  await writeFile(markdownReplacement, '# Revised externally\n\nA second edition.');
  await rename(markdownReplacement, text);
  await waitForPage(page, async (id) => (await window.imageflow.currentProject()).value.texts[id]?.includes('A second edition.'), imported.markdown);
  const fileBefore = (await current(page)).sources['file:' + imported.file].digest;
  await writeFile(file, (await readFile(file, 'utf8')).replace('</gpx>', '<!-- external save --></gpx>'));
  await waitForPage(page, async ({ id, before }) => (await window.imageflow.currentProject()).value.sources['file:' + id].digest !== before, { id: imported.file, before: fileBefore });
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
    if (raced.code !== 'BOOK_BUSY' && !raced.error?.includes('while preparing export')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.match(raced.error, /Sources changed during export/);
  await reload(page);
  await assert.rejects(stat(race), { code: 'ENOENT' });
  await waitForPage(page, async () => (await window.imageflow.currentProject()).value.sources && !document.querySelector('.preview-state'));
  // Remove all originals. The book stays editable and every source keeps a marked cached view.
  const photoBytes = await readFile(photo); const textBytes = await readFile(text); const fileBytes = await readFile(file);
  await Promise.all([photo, text, file].map((path) => rm(path)));
  await waitForPage(page, async () => Object.values((await window.imageflow.currentProject()).value.sources).filter((source) => source.linked).every((source) => source.state === 'missing' && source.cached));
  await ready(page);
  await menuAction(app, 'Assets…');
  const managerWindow = await assetWindow();
  const manager = managerWindow.getByRole('region', { name: 'Assets' });
  await manager.waitFor();
  // A linked-file refresh may still own the book just after the renderer becomes ready.
  // Retry only that explicit busy response; any other error must fail with its actual message.
  const collection = await retryBookRefresh(async () => {
    await manager.getByRole('button', { name: /^Copy All \d+ into Book$/ }).click();
    const alert = manager.getByRole('alert');
    await alert.waitFor();
    return { error: await alert.innerText(), code: await alert.getAttribute('data-error-code') };
  }, () => ready(page));
  assert.match(collection.error, /Cannot include all assets/);
  await page.screenshot({ path: join(root, '.build/linked-missing-sources.png') });
  await managerWindow.close();
  const checked = await retryBookRefresh(async () => {
    state = await current(page);
    return page.evaluate((id) => window.imageflow.checkBook(id, {}), state.id);
  }, () => ready(page));
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
  await waitForPage(page, async () => Object.values((await window.imageflow.currentProject()).value.sources).every((source) => source.state === 'available'));
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
  await waitForPage(page, async (id) => (await window.imageflow.currentProject()).value.sources['photo:' + id].state === 'missing', unusedId);
  const unusedPrint = join(work, 'Unused-missing-print.pdf');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, unusedPrint);
  const printable = await page.evaluate((id) => window.imageflow.exportBook(id, 'print'), (await current(page)).id);
  assert.ok(printable.value, JSON.stringify(printable));
  await stat(unusedPrint);
  await writeFile(unused, photoBytes);
  await waitForPage(page, async (id) => (await window.imageflow.currentProject()).value.sources['photo:' + id].state === 'available', unusedId);
  await reload(page);
  // Linked assets carry a chain, and the native context menu copies only the selected original into this book.
  await menuAction(app, 'Assets…');
  const linkedWindow = await assetWindow();
  const linkedRow = linkedWindow.locator('[data-source="photo:' + unusedId + '"]');
  await linkedRow.getByRole('img', { name: 'Linked to original file' }).waitFor();
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function ({ callback }) {
      globalThis.assetMenuLabels = this.items.map(({ label }) => label);
      this.items.find(({ label }) => label === 'Copy into Book').click();
      callback();
    };
  });
  await linkedRow.click({ button: 'right' });
  await waitForPage(linkedWindow, async (id) => !(await window.imageflow.currentProject()).value.photoIndex[id].linked, unusedId);
  assert.deepEqual(await app.evaluate(() => globalThis.assetMenuLabels), ['Show in Finder', 'Copy into Book', '', 'Remove from Book']);
  await linkedRow.getByRole('img', { name: 'Linked to original file' }).waitFor({ state: 'detached' });
  await stat(unused);
  await linkedWindow.close();
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
  await menuAction(app, 'Assets…');
  const accessWindow = await assetWindow();
  const accessManager = accessWindow.getByRole('region', { name: 'Assets' });
  const unapprovedRow = accessManager.getByRole('option').filter({ hasText: 'NotChosen.gpx' });
  await unapprovedRow.getByText('Locate to approve', { exact: true }).waitFor();
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function ({ callback }) {
      globalThis.assetMenuLabels = this.items.map(({ label }) => label);
      this.items.find(({ label }) => label === 'Locate…').click();
      callback();
    };
  });
  await unapprovedRow.click({ button: 'right' });
  await accessWindow.waitForFunction(() => !document.querySelector('[data-source="file:notchosen"]')?.textContent.includes('Locate to approve'));
  assert.deepEqual(await app.evaluate(() => globalThis.assetMenuLabels), ['Show in Finder', 'Locate…', '', 'Remove from Book']);
  assert.deepEqual((await current(page)).history, historyBeforeLocate, 'Locate does not add an empty Undo step');
  await accessWindow.close();
  await reload(page);
  assert.match(await loadedFile(), /private dummy fixture/);
  // Save a Copy exposes collection as an explicit choice and opens an independent, portable document.
  const portable = join(work, 'Portable.imageflow');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, portable);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.duplicateOptions = options;
      return { response: 0, checkboxChecked: true };
    };
  });
  const before = new Set(app.windows());
  await menuAction(app, 'Save a Copy…');
  await page.waitForFunction(() => !document.querySelector('.save-copy-dialog'));
  for (let attempt = 0; !app.windows().some((page) => !before.has(page) && page.url() === 'imageflow://editor/'); attempt++) {
    assert.ok(attempt < 300, 'Duplicate opens the copied book');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await app.evaluate(() => globalThis.duplicateOptions)).checkboxLabel, 'Include all files');
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
