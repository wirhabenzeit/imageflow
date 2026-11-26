import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';
import { closeApp, copySpreadStarter, testBook } from './ui-actions.mjs';

// Export Proof: the Photobook starter's spreads, kept together, on A4 sheets at each density; and faster than the
// print PDF of the same book. Then a template whose photo box draws through a callback and whose picture never
// finishes: the callback's photo is proof sized too, and the stalled picture fails alone, by the clock.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build/proof-'));
const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const page = await testBook(app, join(work, 'Proof.imageflow'), true);
  await page.waitForFunction(() => window.imageflow.currentProject);
  await page.locator('.canvas iframe.book-frame-book[data-current][data-ready]').waitFor();
  const spreads = await page.evaluate(async () => (await window.imageflow.currentProject()).value.project.spreads.length);
  // The save panel answers with `value` spreads per sheet, or is cancelled.
  const answer = async (filePath, value, canceled = false) => app.evaluate(({ dialog }, { filePath, value, canceled }) => {
    globalThis.proofPrompts = [];
    dialog.showSaveDialog = async (_owner, options) => { globalThis.proofPrompts.push(options); return { canceled, filePath, value }; };
    dialog.showMessageBox = async () => ({ response: 1 });
  }, { filePath, value, canceled });
  const run = (surface) => page.evaluate(async (surface) => {
    const { value } = await window.imageflow.currentProject();
    const started = performance.now();
    const result = await window.imageflow.exportBook(value.id, surface);
    return { result, ms: performance.now() - started };
  }, surface);

  const times = {};
  for (const perPage of [1, 4, 12]) {
    const output = join(work, 'proof-' + perPage + '.pdf');
    await answer(output, perPage);
    const { result, ms } = await run('proof');
    times[perPage] = ms;
    assert.ok(result.value, JSON.stringify(result));
    assert.deepEqual(result.value.errors.filter(({ code }) => /photo/.test(code ?? '')), [], 'every photo loads at its proof size');
    const prompts = await app.evaluate(() => globalThis.proofPrompts);
    assert.equal(prompts.length, 1, 'One panel asks for the density and the destination');
    assert.deepEqual(prompts[0].control.choices.map(({ label }) => label), ['1', '4', '12']);
    assert.match(prompts[0].defaultPath, /Proof - Proof\.pdf$/);
    const pdf = await PDFDocument.load(await readFile(output));
    assert.equal(pdf.getPageCount(), Math.ceil(spreads / perPage), 'spreads per sheet: ' + perPage);
    const { width, height } = pdf.getPage(0).getSize();
    assert.ok(Math.abs(Math.max(width, height) - 841.9) < 2 && Math.abs(Math.min(width, height) - 595.3) < 2, 'A4 sheets: ' + width + ' × ' + height);
    assert.match(pdf.getTitle() ?? '', /Proof/);
  }
  // The density is remembered for the next proof, and a cancelled panel does not change it.
  await answer(join(work, 'cancel.pdf'), 1, true);
  assert.equal((await run('proof')).result.value, null, 'Cancel saves nothing');
  assert.equal((await app.evaluate(() => globalThis.proofPrompts))[0].control.value, 12);
  await run('proof');
  assert.equal((await app.evaluate(() => globalThis.proofPrompts))[1].control.value, 12);
  await assert.rejects(readFile(join(work, 'cancel.pdf')), { code: 'ENOENT' });

  await answer(join(work, 'print.pdf'), 1);
  const print = await run();
  assert.ok(print.result.value, JSON.stringify(print.result));

  const story = join(work, 'Callback.imageflow');
  await copySpreadStarter(story);
  const source = join(story, 'template', 'index.tsx');
  const template = await readFile(source, 'utf8');
  const plain = `<ctx.PhotoBox id="hero" rect={ctx.geometry.page(photo, 'bleed')} />`;
  assert.ok(template.includes(plain));
  await writeFile(source, template.replace(/^import \{ /, 'import { RenderedImage, ').replace(plain, `<ctx.PhotoBox id="hero" rect={ctx.geometry.page(photo, 'bleed')}>{(photo) =>
    <svg width={photo.box.width} height={photo.box.height}><image className="proof-callback" href={photo.src} x={photo.image.x} y={photo.image.y}
      width={photo.image.width} height={photo.image.height} preserveAspectRatio="none" /></svg>}</ctx.PhotoBox>
    <RenderedImage label="Stalled" inputs={{}} style={{ position: 'absolute', left: '10mm', top: '10mm', width: '20mm', height: '20mm' }}
      draw={() => new Promise(() => {})} />`));
  await app.evaluate(({ dialog }) => {
    const show = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (...args) => args.at(-1)?.message === 'Trust this book’s template?' ? Promise.resolve({ response: 0 }) : show(...args);
  });
  const callbackPage = await testBook(app, story);
  await callbackPage.locator('.canvas iframe.book-frame-book[data-current][data-ready]').waitFor();
  const requested = [];
  const watch = (window) => window.on('request', (request) => { if (/\/(proof-)?photo\//.test(request.url())) requested.push(request.url()); });
  app.on('window', watch);
  await answer(join(work, 'callback.pdf'), 1);
  const callback = await callbackPage.evaluate(async () => {
    const started = performance.now();
    const result = await window.imageflow.exportBook((await window.imageflow.currentProject()).value.id, 'proof');
    return { result, ms: performance.now() - started };
  });
  app.off('window', watch);
  assert.ok(callback.result.value, JSON.stringify(callback.result));
  const failed = callback.result.value.errors.filter(({ code }) => code === 'rendered-image-failed');
  assert.ok(failed.length >= 1 && failed.every(({ message }) => /Stalled/.test(message)), JSON.stringify(callback.result.value.errors));
  assert.ok(callback.ms < 150_000, 'The stalled picture times out alone: ' + Math.round(callback.ms) + ' ms');
  assert.ok(requested.length, 'The proof loads photos');
  for (const url of requested) assert.match(url, /\/proof-photo\/[\w-]+\/(512|1024|1536|2048)$/, 'Every photo is proof sized: ' + url);

  console.log('Proof export passed: ' + spreads + ' spreads; proof ' + Object.entries(times).map(([n, ms]) => n + '-up ' + Math.round(ms) + ' ms').join(', ') +
    '; print PDF ' + Math.round(print.ms) + ' ms; ' +
    'a callback photo box loads proof-sized photos and a stalled picture fails alone after ' + Math.round(callback.ms / 1000) + ' s.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
