import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, nextPresentation, testBook } from './ui-actions.mjs';
import { buildMacHeaderState, macHeaderState } from './mac-header-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const visible = process.argv.includes('--visible');
const work = await mkdtemp(join(root, '.build/presentation-window-'));
const headerHelper = buildMacHeaderState(work);
async function fixture(name) {
  const folder = join(work, name + '.imageflow');
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), `import {defineTemplate,mm,p,printFormat,Spread} from 'imageflow';
export default defineTemplate({id:'presentation-window',version:'1',contract:1,
format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:500,step:2}}),
spreads:{page:{label:'Page',parameters:{note:p.string({label:'Note',default:'A page'})},render:ctx=><Spread><ctx.Text parameter="note" rect={ctx.geometry.spread('safe')}/></Spread>}}});`);
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: name, template: { id: 'presentation-window', version: '1' },
    spreads: ['a', 'b', 'c'].map((id) => ({ id, definition: 'page', params: { note: id } })) }));
  return folder;
}
const [one, two] = await Promise.all([fixture('One'), fixture('Two')]);
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: visible ? '' : '1' } });
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
async function open(editor, spread) {
  const opened = nextPresentation(app);
  assert.ok('value' in await editor.evaluate((spread) => window.imageflow.startPresentation(spread), spread));
  const presentation = await opened;
  await presentation.waitForURL('imageflow://editor/presentation');
  await presentation.locator('.book-frame-present[data-current][data-ready]').waitFor();
  return presentation;
}
async function closeWindow(page) {
  const closed = page.waitForEvent('close');
  await (await app.browserWindow(page)).evaluate((window) => window.close());
  await closed;
}
try {
  const editor = await testBook(app, one);
  await editor.locator('.book-frame-book[data-current][data-ready]').waitFor();
  const window = await app.browserWindow(editor);
  const originalBounds = await window.evaluate((window) => window.getBounds());
  const originalHeader = headerHelper ? await macHeaderState(window, headerHelper) : undefined;
  // Capture both editors in the normal desktop work area. On a small screen, opening an oversized editor
  // while simple fullscreen hides the menu/Dock gives it temporary screen-sized bounds; macOS fits it back
  // into the work area when presentation ends. That automatic fit is separate from resizing an existing editor.
  const other = await testBook(app, two);
  await other.locator('.book-frame-book[data-current][data-ready]').waitFor();
  const otherWindow = await app.browserWindow(other);
  const otherBounds = await otherWindow.evaluate((window) => window.getBounds());
  const presentation = await open(editor, 'b');
  console.log('Presentation opened in its own window.');
  const viewer = await app.browserWindow(presentation);
  assert.notEqual(await viewer.evaluate((window) => window.id), await window.evaluate((window) => window.id));
  assert.deepEqual(await window.evaluate((window) => window.getBounds()), originalBounds);
  assert.equal(await viewer.evaluate((window) => window.isSimpleFullScreen() || window.isFullScreen()), visible);
  assert.equal(await viewer.evaluate((window) => window.isVisible()), visible);
  const state = (await presentation.evaluate(() => window.imageflow.presentationState())).value;
  assert.equal(state.start, 'b');
  assert.equal(state.summary.folder, 'One.imageflow');
  assert.ok('error' in await editor.evaluate(() => window.imageflow.presentationState()), 'Editor cannot read presentation-only bootstrap');
  assert.ok('error' in await presentation.evaluate(() => window.imageflow.startPresentation('a')), 'Viewer cannot create another presentation');
  assert.ok('error' in await presentation.evaluate(async () => {
    const { value } = await window.imageflow.presentationState();
    return window.imageflow.saveProject(value.summary.id, value.summary);
  }), 'Presentation has no book-writing capability');
  await editor.evaluate(() => window.imageflow.closePresentation());
  assert.equal(presentation.isClosed(), false, 'An editor cannot send a viewer-only close request');
  await editor.evaluate(() => window.imageflow.startPresentation('c'));
  assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/presentation').length, 1, 'Repeated launch reuses the presentation');
  // Successive saved revisions must reach the viewer without losing its lazy render resources.
  for (let index = 0; index < 3; ++index) {
    const saved = await editor.evaluate(async (index) => {
      const { value } = await window.imageflow.currentProject();
      value.project.title = 'Revision ' + index;
      return window.imageflow.saveProject(value.id, value);
    }, index);
    assert.ok(saved.value, JSON.stringify(saved));
    await presentation.waitForFunction((id) => document.querySelector('.book-frame-present[data-current][data-ready]')?.getAttribute('src')?.includes(id), saved.value.id);
  }
  console.log('Live revisions reached the presentation.');
  assert.deepEqual(await otherWindow.evaluate((window) => window.getBounds()), otherBounds,
    'Presenting the first book leaves the other editor unchanged');
  const firstClosed = presentation.waitForEvent('close');
  const otherPresentation = await open(other, 'a');
  await firstClosed;
  assert.equal((await otherPresentation.evaluate(() => window.imageflow.presentationState())).value.summary.folder, 'Two.imageflow');
  await closeWindow(editor);
  assert.equal(otherPresentation.isClosed(), false, 'Closing a different book leaves the current presentation open');
  await closeWindow(otherPresentation);
  assert.equal(other.isClosed(), false, 'Close Window dismisses only the presentation');
  assert.deepEqual(await otherWindow.evaluate((window) => window.getBounds()), otherBounds);
  if (headerHelper) assert.equal((await macHeaderState(otherWindow, headerHelper)).presentationOptions, originalHeader.presentationOptions,
    'Switching books and closing presentation restores the original Mac menu/Dock options');
  const finalPresentation = await open(other, 'c');
  const finalClosed = finalPresentation.waitForEvent('close');
  await closeWindow(other);
  await finalClosed;
  assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/presentation').length, 0, 'Closing the owning book leaves no presentation window');
  console.log('Separate presentation window, editor bounds, book isolation, live revisions, and close lifecycle passed.');
} catch (error) { console.error('Presentation lifecycle failure:', error); throw error; }
finally { await closeApp(app); }
