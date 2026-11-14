import { packagedMacApp, packagedMacExecutable } from './mac-paths.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import metadata from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = packagedMacApp(root);
const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')]).toString());
assert.equal(info.CFBundleShortVersionString, metadata.version, 'The Mac bundle must display the release version.');
const type = info.UTExportedTypeDeclarations.find((type) => type.UTTypeIdentifier === 'ch.wirhabenzeit.imageflow.book');
assert.ok(type.UTTypeConformsTo.includes('com.apple.package'));
assert.ok(type.UTTypeTagSpecification['public.filename-extension'].includes('imageflow'));
const declaration = info.CFBundleDocumentTypes.find((entry) => entry.LSItemContentTypes.includes(type.UTTypeIdentifier));
assert.equal(declaration.LSTypeIsPackage, true);
assert.equal(declaration.CFBundleTypeIconFile, 'ImageFlowBook.icns');
const templateDeclaration = info.CFBundleDocumentTypes.find((entry) => entry.LSItemContentTypes.includes('ch.wirhabenzeit.imageflow.template'));
assert.equal(templateDeclaration.CFBundleTypeIconFile, 'ImageFlowTemplate.icns');
for (const icon of [info.CFBundleIconFile, declaration.CFBundleTypeIconFile, templateDeclaration.CFBundleTypeIconFile]) await stat(join(bundle, 'Contents/Resources', icon));
const work = await realpath(await mkdtemp(join(root, '.build/document-registration-')));
const first = join(work, 'Cold Launch.imageflow');
const second = join(work, 'Finder Open.imageflow');
for (const path of [first, second]) await cp(join(root, 'sample/starter'), path, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
let app;
try {
  app = await _electron.launch({ executablePath: packagedMacExecutable(root), args: ['--user-data-dir=' + join(work, 'profile'), first],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const one = await app.firstWindow();
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), metadata.version, 'About ImageFlow must use the release version.');
  one.setDefaultTimeout(30000);
  await one.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  assert.equal(one.url(), 'imageflow://editor/');
  assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/start').length, 0, 'Direct opening bypasses the chooser');
  const original = (await one.evaluate(() => window.imageflow.currentProject())).value;
  assert.equal(original.folder, 'Cold Launch.imageflow');
  await app.evaluate(({ app }) => { globalThis.openFilesObserved = []; app.on('open-file', (_event, path) => globalThis.openFilesObserved.push(path)); });
  // Launch Services delivers a real macOS open-file event to the running packaged app.
  execFileSync('/usr/bin/open', ['-a', bundle, second]);
  let two;
  for (let attempt = 0; attempt < 1000; attempt++) {
    two = app.windows().find((page) => page !== one && page.url() === 'imageflow://editor/');
    if (two) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(two, 'Finder opens a second book window');
  two.setDefaultTimeout(30000);
  await two.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  assert.equal((await two.evaluate(() => window.imageflow.currentProject())).value.folder, 'Finder Open.imageflow');
  assert.ok((await app.evaluate(() => globalThis.openFilesObserved)).includes(second));
  execFileSync('/usr/bin/open', ['-a', bundle, first]);
  for (let attempt = 0; !(await app.evaluate(() => globalThis.openFilesObserved.length >= 2)); attempt++) {
    assert.ok(attempt < 500); await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/').length, 2);
  assert.equal((await one.evaluate(() => window.imageflow.currentProject())).value.handle, original.handle);
  console.log('Packaged macOS document type, document icon, cold opening, real Finder events, and existing-window routing passed.');
} finally {
  await app?.close();
  await rm(work, { recursive: true, force: true });
}
