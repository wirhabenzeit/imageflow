import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { copySample } from '../desktop/sample-book.mjs';
import { closeApp, nextPresentation, testBook } from './ui-actions.mjs';

// A presentation covers its editor, and macOS reports a covered window as hidden: Chromium then neither lays out a
// new frame in it ("has no area") nor runs its timers at speed, so the editor's reload after a file change stalled
// and refused saves until the presentation closed (F-040), and a presentation left behind another app failed its
// next revision and drew the error over the artwork (F-038). Playwright keeps the pages it drives visible, so this
// checks that neither window is throttled while presenting, and that template edits reach both windows at once.
// It also presents the exterior cover (F-039). --visible runs on screen; --book <folder> uses a copy of a real book.
const root = fileURLToPath(new URL('../', import.meta.url));
const visible = process.argv.includes('--visible');
const book = process.argv.includes('--book') ? process.argv[process.argv.indexOf('--book') + 1] : undefined;
const work = await mkdtemp(join(root, '.build/presentation-reload-'));
const folder = join(work, 'Reload.imageflow');
const template = (note) => `import {defineTemplate,mm,p,printFormat,Spread} from 'imageflow';
export default defineTemplate({id:'presentation-reload',version:'1',contract:1,
format:printFormat({label:'Book',trim:{width:mm(100),height:mm(120)},bleed:{all:mm(3),binding:mm(0)},safe:mm(8),ends:'inside-covers',pageCount:{min:2,max:500,step:2}}),
spreads:{page:{label:'Page',parameters:{note:p.string({label:'Note',default:'A page'})},render:ctx=><Spread>
<ctx.Text parameter="note" rect={ctx.geometry.spread('safe')}/><span data-note>${note}</span></Spread>}}});`;
if (book) await cp(book, folder, { recursive: true });
else {
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), template('first'));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Reload', template: { id: 'presentation-reload', version: '1' },
    spreads: ['a', 'b', 'c'].map((id) => ({ id, definition: 'page', params: { note: id } })) }));
}
const styles = book ? await readFile(join(folder, 'template/styles.css'), 'utf8') : '';
const edit = (round) => book ? writeFile(join(folder, 'template/styles.css'), styles + '\n/* edit ' + round + ' */\n')
  : writeFile(join(folder, 'template/index.tsx'), template('changed ' + round));
const covered = join(work, 'Covered.imageflow');
await copySample(join(root, 'sample/starter'), covered);

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: visible ? '' : '1' } });
// A new revision's frame must show the spread on screen before it is swapped in, not the one the presentation started
// on: else its photos load only after the swap and blink. Each frame notes when it first shows the third spread, and
// the presentation when it swaps each frame in.
await app.context().addInitScript(() => {
  const observe = (check) => new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
  if (location.search.includes('view=present')) observe(() => {
    if (document.documentElement.dataset.thirdAt) return;
    const crop = [...document.querySelectorAll('.if-present-crop')].find((node) => node.style.visibility !== 'hidden');
    if (crop?.textContent.startsWith('c')) document.documentElement.dataset.thirdAt = String(Date.now());
  });
  else if (location.href.startsWith('imageflow://editor')) observe(() => {
    window.shownAt ??= {};
    for (const frame of document.querySelectorAll('.book-frame-present:not(.book-frame-pending)')) window.shownAt[frame.dataset.revision] ??= Date.now();
  });
});
const throttling = (window) => window.evaluate((window) => window.webContents.getBackgroundThrottling());
async function present(editor, start) {
  const opened = nextPresentation(app);
  if (start) assert.ok('value' in await editor.evaluate((spread) => window.imageflow.startPresentation(spread), start));
  else await editor.getByRole('button', { name: 'Presentation', exact: true }).click();
  const presentation = await opened;
  await presentation.locator('.book-frame-present[data-current][data-ready]').waitFor({ timeout: 180_000 });
  return presentation;
}
try {
  const editor = await testBook(app, folder);
  await editor.locator('.book-frame-book[data-current][data-ready]').waitFor({ timeout: 180_000 });
  const editorWindow = await app.browserWindow(editor);
  const throttled = await throttling(editorWindow);
  assert.equal(throttled, visible, 'A visible editor is throttled when out of sight, as before');
  const spreads = (await editor.evaluate(() => window.imageflow.currentProject())).value.project.spreads;
  const presentation = await present(editor, spreads[1].id);
  assert.equal(await throttling(editorWindow), false, 'The editor behind the presentation renders at full speed');
  assert.equal(await throttling(await app.browserWindow(presentation)), false, 'The presentation renders while another app covers it');
  let before = (await editor.evaluate(() => window.imageflow.currentProject())).value.id;
  // Away from the spread the presentation started on.
  await presentation.keyboard.press('ArrowRight');
  await presentation.locator('.presentation-indicator').filter({ hasText: / 3 \/ / }).waitFor();
  for (let round = 0; round < 3; ++round) {
    const started = Date.now();
    await edit(round);
    let now = before;
    while (now === before && Date.now() - started < 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      now = (await editor.evaluate(() => window.imageflow.currentProject())).value.id;
    }
    assert.notEqual(now, before, 'The template edit made a new revision');
    // The editor's reload ends when its book view shows the new revision; saves wait for that.
    await editor.waitForFunction((id) => document.querySelector('.book-frame-book[data-current][data-ready]')?.getAttribute('src')?.includes(id), now, { timeout: 120_000 });
    const reloaded = Date.now() - started;
    before = now;
    await presentation.waitForFunction((id) => document.querySelector('.book-frame-present[data-current][data-ready]')?.getAttribute('src')?.includes(id), now, { timeout: 30_000 });
    assert.deepEqual(await presentation.locator('.presentation-message, .presentation-notice').allTextContents(), []);
    if (!book) {
      const frame = presentation.frames().find((item) => item.url().includes(now) && item.url().includes('view=present'));
      const third = Number(await frame.evaluate(() => document.documentElement.dataset.thirdAt));
      const shown = await presentation.evaluate((id) => window.shownAt?.[id], now);
      assert.ok(third && shown && third <= shown, 'The new frame showed the current spread before it was swapped in: ' + JSON.stringify({ third, shown }));
    }
    assert.equal(await editor.getByText('Updating the book after its files changed').count(), 0, 'The editor reload settled');
    assert.ok(reloaded < 15_000, 'The editor reload finished while presenting (' + reloaded + ' ms)');
    console.log('Template edit ' + round + ' reached the editor in ' + reloaded + ' ms and the presentation.');
  }
  if (!book) {
    // A revision that fails while an earlier one is shown keeps the artwork, with a short notice.
    await writeFile(join(folder, 'template/index.tsx'), template('broken').replace('<ctx.Text', '<ctx.Text missing={(() => { throw new Error("Broken on purpose"); })()}'));
    await presentation.locator('.presentation-notice').waitFor({ timeout: 60_000 });
    assert.equal(await presentation.locator('.presentation-message').count(), 0, 'No full-screen error over the working artwork');
    assert.equal(await presentation.locator('.book-frame-present:not(.book-frame-pending)[data-ready]').count(), 1);
    await edit(3);
    await presentation.locator('.presentation-notice').waitFor({ state: 'detached', timeout: 60_000 });
    console.log('A failed revision left the shown artwork with a short notice.');
  }
  const closed = presentation.waitForEvent('close');
  await presentation.keyboard.press('Escape').catch(() => {}); // The page closes during the key press.
  await closed;
  assert.equal(await throttling(editorWindow), throttled, 'Closing the presentation restores the editor');

  // The cover is the presentation's first item, opened from the Cover view.
  const cover = await testBook(app, covered);
  await cover.locator('.book-frame-book[data-current][data-ready]').waitFor({ timeout: 180_000 });
  await cover.getByRole('radio', { name: 'Cover', exact: true }).click();
  await cover.getByLabel('Cover layout', { exact: true }).selectOption('wrapPhoto');
  await cover.waitForFunction(async () => !!(await window.imageflow.currentProject()).value.project.cover);
  await cover.locator('.cover-preview-sheet[data-ready]').waitFor({ timeout: 60_000 });
  // The sheet is also ready while the cover is empty. The editor presents the cover only once it has the chosen layout
  // itself (the saved project reaches it after the main process has it), so wait for the prompt to go.
  await cover.getByRole('button', { name: 'Choose a cover layout' }).waitFor({ state: 'detached', timeout: 60_000 });
  const showing = await present(cover);
  await showing.locator('.presentation-cover:not(.presentation-cover-hidden) .book-frame-cover[data-ready]').waitFor({ timeout: 20_000 })
    .catch(async (error) => { console.log(await showing.evaluate(() => document.body.innerHTML.replace(/<p>[^]*?<\/p>/g, '').slice(0, 3000))); throw error; });
  const total = (await cover.evaluate(() => window.imageflow.currentProject())).value.project.spreads.length + 1;
  await showing.mouse.move(10, 10);
  assert.match(await showing.locator('.presentation-indicator').textContent(), new RegExp('^Cover · 1 / ' + total + '$'));
  const sheet = await showing.locator('.presentation-cover-sheet').boundingBox();
  const screen = await showing.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(sheet.width > screen.width / 2 && sheet.height <= screen.height, 'The cover sheet fills the screen: ' + JSON.stringify({ sheet, screen }));
  await showing.keyboard.press('ArrowRight');
  await showing.locator('.presentation-cover.presentation-cover-hidden').waitFor();
  assert.match(await showing.locator('.presentation-indicator').textContent(), new RegExp(' · 2 / ' + total + '$'));
  await showing.keyboard.press('Home');
  await showing.locator('.presentation-cover:not(.presentation-cover-hidden)').waitFor();
  const ended = showing.waitForEvent('close');
  await showing.keyboard.press('Escape').catch(() => {});
  await ended;
  await cover.locator('.cover-preview-sheet[data-ready]').waitFor();
  console.log('The cover opens the presentation, and ending there returns to the Cover view.');
} catch (error) { console.error('Presentation reload failure:', error); throw error; }
finally { await closeApp(app); }
