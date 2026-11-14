import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/markdown-'));
const folder = join(work, 'Book.imageflow');
const current = async (page) => (await page.evaluate(() => window.imageflow.currentProject())).value;
const until = async (check, label = 'operation settled') => {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.ok(await check(), label);
};
const errors = [];
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' }, timeout: 20000 });
const nativeClose = async (page) => {
  const window = await app.browserWindow(page);
  await window.evaluate((window) => window.close());
};
const editorWindow = async () => {
  await until(() => app.windows().some((page) => page.url() === 'imageflow://editor/markdown'), 'Markdown window opens');
  const page = app.windows().find((page) => page.url() === 'imageflow://editor/markdown');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('textbox', { name: 'Markdown source' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea').disabled);
  return page;
};
const textBox = (page) => page.getByRole('textbox', { name: 'Markdown source' });
const saveNow = async (page) => page.getByRole('button', { name: 'Save Now' }).click();
const open = async (page, id) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await page.evaluate((id) => window.imageflow.showMarkdown({ id }), id);
    if (!result.code) { assert.ok('value' in result, result.error); return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Book stayed busy');
};
try {
  const page = await testBook(app, folder, true);
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ dialog }) => {
    globalThis.markdownChoice = 2;
    globalThis.closeChoice = 0;
    globalThis.markdownPrompts = [];
    dialog.showMessageBox = async (_owner, options) => {
      globalThis.markdownPrompts.push(options);
      return { response: options.message.includes('external Markdown') ? globalThis.markdownChoice : globalThis.closeChoice };
    };
  });
  await page.getByRole('tab', { name: /^Texts/ }).click();
  await page.getByRole('button', { name: 'New Text', exact: true }).click();
  await page.getByRole('dialog', { name: 'New Text' }).getByRole('textbox', { name: 'Name' }).fill('Introduction');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  let editor = await editorWindow();
  await textBox(editor).fill('# A new introduction\n\nWritten **inside ImageFlow**.');
  await until(async () => {
    const summary = await current(page);
    return Object.values(summary.texts).includes('# A new introduction\n\nWritten **inside ImageFlow**.');
  });
  assert.equal(await editor.getByRole('region', { name: 'Formatted preview' }).locator('strong').innerText(), 'inside ImageFlow');
  if (process.env.MARKDOWN_SCREENSHOT) await editor.screenshot({ path: process.env.MARKDOWN_SCREENSHOT });
  const created = Object.entries((await current(page)).project.texts).find(([, path]) => typeof path === 'string' && path.endsWith('-Introduction.md'));
  assert.ok(created);
  await page.locator('[data-id="' + created[0] + '"]').getByRole('button', { name: /^Edit / }).click();
  assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/markdown').length, 1, 'one editor per source');
  await textBox(editor).fill('Pending at editor close');
  await nativeClose(editor);
  await until(() => editor.isClosed());
  assert.equal(await readFile(join(folder, created[1]), 'utf8'), 'Pending at editor close');
  console.log('creation, live preview, autosave, focus-existing and close flush passed');

  // Edit a source shared by two story spreads, and verify actual book artwork updates in both places.
  await page.locator('[data-id="arrival"]').getByRole('button', { name: /^Edit / }).click();
  editor = await editorWindow();
  const shared = Array.from({ length: 120 }, () => 'A shared story from the Markdown editor.').join('\n\n');
  await textBox(editor).fill(shared);
  await until(async () => (await current(page)).texts.arrival === shared);
  const frame = page.frameLocator('iframe.book-frame-book[data-current][data-ready]');
  await until(async () => (await frame.locator('[data-spread="arriving"]').innerText()).includes('A shared story from the Markdown editor.'));
  assert.ok((await frame.locator('[data-spread="turning"]').innerText()).includes('A shared story from the Markdown editor.'));
  console.log('shared source edits update both placed stories');

  const arrival = join(folder, 'texts/arrival.md');
  await writeFile(arrival, 'Clean outside edit');
  await until(async () => await textBox(editor).inputValue() === 'Clean outside edit');
  await textBox(editor).fill('My pending edit'); await writeFile(arrival, 'Their outside edit'); await saveNow(editor);
  await editor.getByRole('region', { name: 'Outside changes' }).waitFor();
  assert.equal(await textBox(editor).inputValue(), 'My pending edit');
  assert.equal(await readFile(arrival, 'utf8'), 'Their outside edit');
  await editor.getByRole('button', { name: 'Keep My Text' }).click();
  await until(async () => await readFile(arrival, 'utf8') === 'My pending edit');
  await textBox(editor).fill('Another pending edit'); await writeFile(arrival, 'Use this outside text'); await saveNow(editor);
  await editor.getByRole('button', { name: 'Use Outside Text' }).click();
  await until(async () => await textBox(editor).inputValue() === 'Use this outside text');
  console.log('clean outside reload and both conflict resolutions passed');

  // A failed save must survive a canceled close and retry successfully after the file becomes writable.
  await chmod(arrival, 0o444); await textBox(editor).fill('Retain this failed save'); await saveNow(editor);
  await editor.getByRole('alert').waitFor();
  await nativeClose(editor); await until(async () => (await app.evaluate(() => globalThis.markdownPrompts)).some((p) => p.message.includes('finish saving')));
  assert.equal(editor.isClosed(), false); assert.equal(await textBox(editor).inputValue(), 'Retain this failed save');
  await chmod(arrival, 0o644); await editor.getByRole('button', { name: 'Retry', exact: true }).click();
  await until(async () => await readFile(arrival, 'utf8') === 'Retain this failed save');
  await rename(arrival, arrival + '.moved');
  await textBox(editor).fill('Pending while the original is missing'); await saveNow(editor);
  await editor.getByRole('alert').waitFor();
  assert.equal(await textBox(editor).inputValue(), 'Pending while the original is missing');
  await rename(arrival + '.moved', arrival); await saveNow(editor);
  await until(async () => await readFile(arrival, 'utf8') === 'Pending while the original is missing');
  await nativeClose(editor); await until(() => editor.isClosed());
  console.log('read-only failure retains pending text on close and supports retry');

  // Import an external file and exercise all three choices, preserving the linked source ID when copied.
  const external = join(work, 'external.md'); await writeFile(external, 'External original');
  let added;
  for (let attempt = 0; attempt < 50; attempt++) {
    added = await page.evaluate(async (path) => {
    const summary = (await window.imageflow.currentProject()).value;
    return window.imageflow.importFiles(summary.id, { kind: 'markdown', mode: 'link', paths: [path] });
    }, external);
    if (added.code !== 'BOOK_BUSY') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok('value' in added, added.error); const id = added.value.imported[0];
  await open(page, id); assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/markdown').length, 0, 'Abort does not open');
  assert.equal(typeof (await current(page)).project.texts[id], 'object');
  await app.evaluate(() => { globalThis.markdownChoice = 0; });
  await open(page, id); editor = await editorWindow();
  assert.ok((await editor.locator('.markdown-header').innerText()).includes('Editing external original'));
  await textBox(editor).fill('Edited external original'); await saveNow(editor);
  await until(async () => await readFile(external, 'utf8') === 'Edited external original');
  await nativeClose(editor); await until(() => editor.isClosed());
  await app.evaluate(() => { globalThis.markdownChoice = 1; });
  await open(page, id); editor = await editorWindow();
  const copied = (await current(page)).project.texts[id]; assert.equal(typeof copied, 'string');
  await textBox(editor).fill('Internal copy edit'); await saveNow(editor);
  await until(async () => await readFile(join(folder, copied), 'utf8') === 'Internal copy edit');
  assert.equal(await readFile(external, 'utf8'), 'Edited external original');
  const prompts = await app.evaluate(() => globalThis.markdownPrompts.filter((p) => p.message.includes('external Markdown')));
  assert.equal(prompts.length, 3); assert.deepEqual(prompts[0].buttons, ['Edit external', 'Copy first', 'Abort']);
  console.log('Edit external / Copy first / Abort passed');

  // The Assets entry point opens the same source editor rather than a duplicate.
  await page.evaluate(() => window.imageflow.showAssets([]));
  await until(() => app.windows().some((page) => page.url() === 'imageflow://editor/assets'));
  const assets = app.windows().find((page) => page.url() === 'imageflow://editor/assets');
  await assets.locator('[data-source="markdown:' + id + '"]').getByRole('button', { name: /^Edit / }).click();
  assert.equal(app.windows().filter((page) => page.url() === 'imageflow://editor/markdown').length, 1);
  // The Markdown renderer has no generic book or arbitrary-file editing capability.
  const forbidden = await editor.evaluate(() => window.imageflow.showMarkdown({ name: 'Forbidden' })); assert.ok(forbidden.error);
  await textBox(editor).fill('Pending at book close'); await nativeClose(page);
  await until(() => page.isClosed()); assert.equal(editor.isClosed(), true);
  assert.equal(await readFile(join(folder, copied), 'utf8'), 'Pending at book close');
  console.log('Assets editor entry point, capability checks and book-close flush passed');

  // Starting from no text sources still offers New Text; quit drains its pending content.
  const empty = join(work, 'Empty.imageflow');
  await cp(join(root, 'sample/starter'), empty, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
  const json = JSON.parse(await readFile(join(empty, 'project.json'), 'utf8')); json.texts = {};
  for (const spread of json.spreads) for (const box of Object.values(spread.boxes ?? {})) delete box.text;
  await writeFile(join(empty, 'project.json'), JSON.stringify(json));
  const emptyPage = await testBook(app, empty);
  await emptyPage.getByRole('tab', { name: /^Texts/ }).click(); await emptyPage.getByRole('button', { name: 'New Text', exact: true }).click();
  await emptyPage.getByRole('dialog', { name: 'New Text' }).getByRole('textbox', { name: 'Name' }).fill('First text');
  await emptyPage.getByRole('button', { name: 'Create', exact: true }).click(); editor = await editorWindow();
  await textBox(editor).fill('Pending at app quit');
  const emptySource = Object.values((await current(emptyPage)).project.texts)[0];
  await app.evaluate(({ app }) => { app.quit(); });
  await until(() => emptyPage.isClosed());
  assert.equal(await readFile(join(empty, emptySource), 'utf8'), 'Pending at app quit');
  assert.deepEqual(errors, []);
  console.log('empty-list creation and app-quit flush passed; no renderer errors');
} finally {
  await app.close().catch(() => {});
  await rm(work, { recursive: true, force: true });
}
