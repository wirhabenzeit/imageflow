import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';

// Export Proof: the Photobook starter's spreads, kept together, on A4 sheets at each density; and faster than the
// print PDF of the same book.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/proof-'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const page = await testBook(app, join(work, 'Proof.imageflow'), true);
  await page.waitForFunction(() => window.imageflow.currentProject);
  await page.locator('.canvas iframe.book-frame-book[data-current][data-ready]').waitFor();
  const spreads = await page.evaluate(async () => (await window.imageflow.currentProject()).value.project.spreads.length);
  const answer = async (filePath, response) => app.evaluate(({ dialog }, { filePath, response }) => {
    globalThis.proofPrompts = [];
    dialog.showSaveDialog = async (_owner, options) => { globalThis.proofPrompts.push(options); return { canceled: false, filePath }; };
    dialog.showMessageBox = async (_owner, options) => { globalThis.proofPrompts.push(options); return { response }; };
  }, { filePath, response });
  const run = (surface) => page.evaluate(async (surface) => {
    const { value } = await window.imageflow.currentProject();
    const started = performance.now();
    const result = await window.imageflow.exportBook(value.id, surface);
    return { result, ms: performance.now() - started };
  }, surface);

  const times = {};
  for (const [index, perPage] of [1, 4, 12].entries()) {
    const output = join(work, 'proof-' + perPage + '.pdf');
    await answer(output, index);
    const { result, ms } = await run('proof');
    times[perPage] = ms;
    assert.ok(result.value, JSON.stringify(result));
    assert.deepEqual(result.value.errors.filter(({ code }) => /photo/.test(code ?? '')), [], 'every photo loads at its proof size');
    const prompts = await app.evaluate(() => globalThis.proofPrompts);
    assert.deepEqual(prompts[0].buttons, ['1 Spread', '4 Spreads', '12 Spreads', 'Cancel']);
    assert.match(prompts[1].defaultPath, /Proof - Proof\.pdf$/);
    const pdf = await PDFDocument.load(await readFile(output));
    assert.equal(pdf.getPageCount(), Math.ceil(spreads / perPage), 'spreads per sheet: ' + perPage);
    const { width, height } = pdf.getPage(0).getSize();
    assert.ok(Math.abs(Math.max(width, height) - 841.9) < 2 && Math.abs(Math.min(width, height) - 595.3) < 2, 'A4 sheets: ' + width + ' × ' + height);
    assert.match(pdf.getTitle() ?? '', /Proof/);
  }
  // The density is remembered for the next proof.
  await answer(join(work, 'cancel.pdf'), 3);
  assert.equal((await run('proof')).result.value, null, 'Cancel saves nothing');
  assert.equal((await app.evaluate(() => globalThis.proofPrompts))[0].defaultId, 2);
  await assert.rejects(readFile(join(work, 'cancel.pdf')), { code: 'ENOENT' });

  await answer(join(work, 'print.pdf'), 1);
  const print = await run();
  assert.ok(print.result.value, JSON.stringify(print.result));
  console.log('Proof export passed: ' + spreads + ' spreads; proof ' + Object.entries(times).map(([n, ms]) => n + '-up ' + Math.round(ms) + ' ms').join(', ') +
    '; print PDF ' + Math.round(print.ms) + ' ms.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
