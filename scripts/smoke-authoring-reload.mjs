import { menuAction } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, '.build');
await mkdir(build, { recursive: true });
const work = await mkdtemp(join(build, 'authoring-reload-'));
const project = join(work, 'Book');
const manifest = join(project, 'project.json');
const photos = join(project, 'photos.json');
const template = join(project, 'template/index.tsx');
const css = join(project, 'template/styles.css');
const shown = 'iframe.book-frame-book:not([aria-hidden])[data-ready]';
const current = 'iframe.book-frame-book[data-current][data-ready]';
const photo = '[data-spread="arriving"] [data-box="hero"] img';

async function replace(path, text) {
  await writeFile(path + '.tmp', text);
  await rename(path + '.tmp', path);
}

let app;
try {
  app = await _electron.launch({ executablePath: electron,
    args: [process.env.IMAGEFLOW_TEST_DESKTOP ?? join(build, 'desktop'), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' },
  });
  const window = await app.firstWindow();
  window.setDefaultTimeout(30000);
  const button = (name) => window.getByRole('button', { name, exact: true });
  const preview = window.frameLocator(shown);
  const frameUrl = () => window.locator(shown).getAttribute('src');
  const canvas = window.locator('main.canvas');
  const scroll = () => canvas.evaluate((el) => el.scrollTop);
  const selected = () => window.locator('.spread-thumb[aria-current]').getAttribute('data-spread');
  const error = () => window.locator('.status-error').textContent();
  const point = async (selector) => {
    const target = preview.locator(selector);
    await target.scrollIntoViewIfNeeded();
    const rect = await target.boundingBox();
    assert.ok(rect);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  const readyAfter = (previous) => window.waitForFunction(({ current, previous }) => {
    const frame = document.querySelector(current);
    return frame && frame.getAttribute('src') !== previous;
  }, { current, previous });

  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, project);
  await menuAction(app, 'New project…');
  await readyAfter(null);
  const source = await readFile(template, 'utf8');
  const style = await readFile(css, 'utf8');
  await window.evaluate(() => {
    window.reloadEvents = [];
    window.imageflow.onProjectChanged((change) => {
      window.reloadEvents.push('building' in change ? 'building' : 'error' in change ? 'error' : 'loaded');
    });
  });

  // Pause the watcher's receipt read. The preceding read is the title save's conflict check.
  await app.evaluate((_, manifest) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const read = fs.readFile;
    let reads = 0;
    let started;
    let release;
    const reached = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    fs.readFile = async (path, ...args) => {
      if (path === manifest && ++reads === 2) {
        started();
        await gate;
      }
      return read(path, ...args);
    };
    globalThis.manifestGate = {
      reached,
      release() { fs.readFile = read; release(); delete globalThis.manifestGate; },
    };
  }, manifest);

  // In-app writes render once, retain Undo, and can proceed during a receipt check for an earlier save.
  let previous = await frameUrl();
  const photoId = JSON.parse(await readFile(manifest, 'utf8')).spreads.find(({ id }) => id === 'arriving').boxes.hero.photo;
  try {
    await window.getByText('Book settings', { exact: true }).click();
    await window.getByLabel('Book title').fill('Edited in ImageFlow');
    await window.getByLabel('Book title').blur();
    await readyAfter(previous);
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).title, 'Edited in ImageFlow');
    assert.equal(await button('Undo').isEnabled(), true);

    await app.evaluate(() => {
      const timeout = AbortSignal.timeout(5000);
      return Promise.race([globalThis.manifestGate.reached, new Promise((_, reject) => {
        timeout.addEventListener('abort', () => reject(new Error('The watcher did not read the saved manifest.')), { once: true });
      })]);
    });
    previous = await frameUrl();
    await window.locator('.source-photo[data-id="' + photoId + '"]').click();
    await window.getByRole('textbox', { name: 'Alt text' }).fill('Edited photo in ImageFlow');
    await window.getByRole('textbox', { name: 'Alt text' }).blur();
    await window.waitForFunction(() => document.querySelector('.status')?.textContent === 'Alt text updated' || document.querySelector('.status-error'));
    assert.equal(await window.locator('.status').textContent(), 'Alt text updated');
  } finally {
    await app.evaluate(() => globalThis.manifestGate.release());
  }
  await readyAfter(previous);
  assert.equal(JSON.parse(await readFile(photos, 'utf8'))[photoId].altText, 'Edited photo in ImageFlow');
  await window.waitForTimeout(500);
  assert.deepEqual(await window.evaluate(() => window.reloadEvents), []);

  previous = await frameUrl();
  await replace(css, style + '\n:root { --reload-smoke: updated; }\n');
  await readyAfter(previous);
  assert.equal(await preview.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--reload-smoke').trim()), 'updated');
  assert.equal(await button('Undo').isEnabled(), true, 'a template-only reload preserves Undo');

  await button('Photo and story 2–3').click();
  await canvas.evaluate((el) => el.scrollTo({ top: el.scrollTop, behavior: 'instant' }));
  const cropPoint = await point(photo);
  await window.mouse.click(cropPoint.x, cropPoint.y);
  await window.locator('.crop-editor').waitFor();
  previous = await frameUrl();
  const position = await scroll();
  const beforeFailure = await readFile(manifest, 'utf8');
  assert.equal(await selected(), 'arriving');
  await window.evaluate(() => { window.reloadEvents.length = 0; });

  await replace(template, source + '\nconst brokenSyntax = ;\n');
  await window.getByText('Showing the last successful preview', { exact: true }).waitFor();
  assert.match(await error(), /template\/index\.tsx|could not be bundled/i);
  assert.equal(await frameUrl(), previous);
  assert.ok(Math.abs(await scroll() - position) <= 1);
  assert.equal(await selected(), 'arriving');
  assert.equal(await window.locator('.crop-editor').count(), 0);
  await window.locator('.export-menu > summary').click();
  assert.equal(await button('Export print PDF').isDisabled(), true);
  await window.locator('.export-menu > summary').click();
  assert.deepEqual((await window.evaluate(() => window.reloadEvents)).slice(0, 2), ['building', 'error']);

  // A runtime failure leaves the same last-good frame and rejects clicks and drops on its artwork.
  await replace(template, source + '\nthrow new Error("reload smoke runtime failure");\n');
  await window.locator('.status-error').filter({ hasText: 'reload smoke runtime failure' }).waitFor();
  assert.equal(await frameUrl(), previous);
  await window.mouse.click(cropPoint.x, cropPoint.y);
  await window.keyboard.press('+');
  await canvas.evaluate((el, { x, y }) => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-imageflow-photo', 'shore');
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer }));
  }, cropPoint);
  const headingPoint = await point('[data-spread="arriving"] [data-edit="heading"]');
  await window.mouse.click(headingPoint.x, headingPoint.y);
  assert.equal(await window.locator('.crop-editor, .edit-popover').count(), 0);
  assert.equal(await readFile(manifest, 'utf8'), beforeFailure);

  // The retained iframe can still fetch a lazy photo after two newer, failed render sessions.
  await replace(template, source + '\nthrow new Error("another reload failure");\n');
  await window.locator('.status-error').filter({ hasText: 'another reload failure' }).waitFor();
  assert.equal(await frameUrl(), previous);
  const farPhoto = preview.locator('[data-spread="twilight"] [data-box="hero"] img');
  assert.equal(await farPhoto.getAttribute('src'), null);
  await canvas.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await farPhoto.and(preview.locator('img[src]')).waitFor({ state: 'attached' });
  assert.equal(await farPhoto.evaluate((img) => img.decode().then(() => img.naturalWidth > 0)), true);
  await canvas.evaluate((el, position) => el.scrollTo(0, position), position);

  const fixed = source.replace('{ctx.params.heading}', '{"Reloaded " + ctx.params.heading}');
  assert.notEqual(fixed, source);
  await replace(template, fixed);
  await readyAfter(previous);
  assert.match(await preview.locator('[data-spread="title"] h1').textContent(), /^Reloaded /);
  assert.ok(Math.abs(await scroll() - position) <= 1);
  assert.equal(await selected(), 'arriving');
  assert.equal(await button('Undo').isEnabled(), true);

  // A cosmetic edit preserves the inline draft. A schema change preserves the text and blocks the old field.
  const openHeading = async () => {
    const heading = await point('[data-spread="arriving"] [data-edit="heading"]');
    await window.mouse.click(heading.x, heading.y);
  };
  await openHeading();
  const popover = window.getByRole('dialog', { name: 'Edit Heading' });
  const draft = popover.getByRole('textbox', { name: 'Heading' });
  await draft.fill('Heading kept through a CSS edit');
  previous = await frameUrl();
  await replace(css, style);
  await readyAfter(previous);
  assert.equal(await draft.inputValue(), 'Heading kept through a CSS edit');
  previous = await frameUrl();
  await draft.press('Meta+Enter');
  await readyAfter(previous);
  const beforeSchemaChange = await readFile(manifest, 'utf8');
  const book = JSON.parse(beforeSchemaChange);
  assert.equal(book.spreads.find(({ id }) => id === 'arriving').params.heading, 'Heading kept through a CSS edit');

  await openHeading();
  await draft.fill('Uncommitted stale heading');
  previous = await frameUrl();
  await replace(template, fixed.replace("label: 'Heading'", "label: 'Title for this spread'"));
  await readyAfter(previous);
  await popover.getByText(/This field changed while you were editing/).waitFor();
  assert.equal(await draft.inputValue(), 'Uncommitted stale heading');
  assert.equal(await draft.isDisabled(), true);
  await popover.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await readFile(manifest, 'utf8'), beforeSchemaChange);

  // A manual Reload consumes the manifest bytes even if their watcher event arrives later.
  await window.evaluate(() => { window.reloadEvents.length = 0; });
  previous = await frameUrl();
  book.title = 'Loaded manually';
  await replace(manifest, JSON.stringify(book));
  await menuAction(app, 'Reload');
  await readyAfter(previous);
  await window.locator('.project-identity').getByText('Loaded manually', { exact: true }).waitFor();
  const manuallyLoaded = await frameUrl();
  await window.waitForTimeout(500);
  assert.deepEqual(await window.evaluate(() => window.reloadEvents), []);
  assert.equal(await frameUrl(), manuallyLoaded);
  assert.equal(await button('Undo').isDisabled(), true);

  // Later edits to either manifest still reload from disk without clicking Reload.
  previous = await frameUrl();
  book.title = 'Edited on disk';
  await replace(manifest, JSON.stringify(book));
  await readyAfter(previous);
  await window.locator('.project-identity').getByText('Edited on disk', { exact: true }).waitFor();
  assert.equal(await button('Undo').isDisabled(), true);

  previous = await frameUrl();
  const index = JSON.parse(await readFile(photos, 'utf8'));
  index[photoId].altText = 'Edited photo on disk';
  await replace(photos, JSON.stringify(index));
  await readyAfter(previous);
  assert.equal(await preview.locator(photo).getAttribute('alt'), 'Edited photo on disk');
  console.log('ImageFlow authoring reload passed.');
} finally {
  try { await app?.close(); }
  finally { await rm(work, { recursive: true, force: true }); }
}
