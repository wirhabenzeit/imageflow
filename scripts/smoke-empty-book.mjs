import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';

// A book without spreads opens, shows the empty state, reports itself in Book check, refuses export, and starts
// from the template's opening spreads or from one layout.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'empty-book-'));
const project = join(work, 'Empty.imageflow');
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  // Create the book from the starter, then empty it before opening.
  const page = await testBook(app, project, true);
  await page.close();
  const emptied = await read();
  emptied.spreads = [];
  await writeFile(join(project, 'project.json'), JSON.stringify(emptied, null, 2) + '\n');
  const w = await testBook(app, project);
  const empty = w.locator('.empty-book');
  const saved = (text) => w.waitForFunction((text) => document.querySelector('.status')?.textContent === text, text);
  const ready = () => w.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
  await empty.waitFor();
  await w.getByRole('heading', { name: 'This book has no spreads yet' }).waitFor();
  await w.waitForFunction(() => /Book check · 1 error/.test(document.querySelector('.book-check-toggle')?.textContent ?? ''));
  await w.locator('.book-check-toggle').click();
  assert.match(await w.locator('.book-check-panel').textContent(), /The book has no spreads yet\./);
  await w.locator('.book-check-toggle').click();
  assert.equal(await w.locator('.spread-thumb').count(), 0);
  assert.equal(await w.getByRole('button', { name: 'Delete', exact: true }).isDisabled(), true);
  assert.equal(await w.getByRole('button', { name: 'Duplicate', exact: true }).isDisabled(), true);
  assert.equal(await w.locator('button', { hasText: 'Export proof PDF' }).isDisabled(), true);
  // The starter offers its opening spreads and the layouts that can start a book: not the closing left page.
  const layouts = await empty.getByRole('group', { name: 'Layouts for the first spread' }).getByRole('button').allTextContents();
  assert.ok(layouts.includes('Title page') && layouts.includes('Photo and story'), layouts.join(', '));
  assert.ok(!layouts.includes('Closing page'), 'a single left page cannot start a book');

  await empty.getByRole('button', { name: 'Add the 3 opening spreads' }).click();
  await saved("Added the template's opening spreads");
  assert.deepEqual((await read()).spreads.map(({ definition }) => definition), ['title', 'story', 'closing']);
  await empty.waitFor({ state: 'detached' });
  await ready();
  assert.equal(await w.locator('.spread-thumb').count(), 3);
  assert.equal(await w.locator('.spread-thumb').first().getAttribute('aria-current'), 'page', 'the first new spread is selected');
  await w.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved('Edit undone');
  await empty.waitFor();
  assert.deepEqual((await read()).spreads, []);

  // One layout; then deleting the last spread empties the book again.
  await empty.getByRole('button', { name: 'Photo and story', exact: true }).click();
  await saved('Added Photo and story');
  assert.deepEqual((await read()).spreads.map(({ definition }) => definition), ['story']);
  await ready();
  const remove = w.getByRole('button', { name: 'Delete', exact: true });
  await w.waitForFunction(() => !document.querySelector('button[aria-label="Delete"]')?.disabled);
  await remove.click();
  await empty.waitFor();
  assert.deepEqual((await read()).spreads, []);
  // Add Spread in the sidebar also starts an empty book.
  await w.getByRole('button', { name: 'Add', exact: true }).click();
  await empty.waitFor({ state: 'detached' });
  assert.equal((await read()).spreads.length, 1);
  console.log('Empty book smoke test passed.');
} finally {
  await app.close();
}
