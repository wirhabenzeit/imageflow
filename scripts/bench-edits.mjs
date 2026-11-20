// Times spread edits in the editor as the user sees them, on the heavy test book (scripts/heavy-book.mjs) by default.
//
//   npm run build && node scripts/stage-desktop.mjs && node scripts/bench-edits.mjs [--book path] [--repeat 3]
//
// For each edit (Add, Delete, Move Down, Duplicate on a spread in the middle of the book) it reports, from the click:
// - feedback: the first painted frame in which the sidebar or the book view's labels show the edit;
// - shown:    when the book view shows the edited book's render;
// - settled:  when the window last changed, after 2 s without change (screenshots, so about ±0.2 s).
//
// --book     another book; it is copied next to itself, and its photo approvals are taken from the installed app's
//            profile, so its linked photos load (see approveHeavyBook)
// --profile  with a profiling build (IMAGEFLOW_PROFILE=1 npx vite build), also the render steps and pictures drawn
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';
import { approveHeavyBook, bookKey, heavyBook } from './heavy-book.mjs';

const { values } = parseArgs({ options: { book: { type: 'string' }, repeat: { type: 'string', default: '3' }, profile: { type: 'boolean' },
  settle: { type: 'string', default: '30000' } } });
const root = fileURLToPath(new URL('../', import.meta.url));
let source; let approvals;
if (values.book) {
  source = values.book;
  approvals = JSON.parse(await readFile(join(process.env.HOME, 'Library/Application Support/ImageFlow/source-access', await bookKey(source) + '.json'), 'utf8').catch(() => '{}'));
} else ({ book: source, approvals } = await heavyBook());
const work = await mkdtemp(join(dirname(source), '.bench-'));
const book = join(work, basename(source));
await cp(source, book, { recursive: true });
await approveHeavyBook(join(work, 'profile'), book, approvals);

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')] });
let marks = [];
if (values.profile) {
  await app.context().exposeBinding('__benchRecord', ({ frame }, record) => { marks.push({ url: frame.url(), at: Date.now(), ...record }); });
  await app.context().addInitScript(() => {
    const emit = (record) => { void window.__benchRecord(record).catch(() => {}); };
    new PerformanceObserver((list) => { for (const e of list.getEntries()) emit({ type: 'longtask', duration: e.duration }); }).observe({ type: 'longtask' });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name.startsWith('imageflow.')) emit({ type: e.name.slice(10), duration: e.duration }); })
      .observe({ type: 'measure' });
  });
}
const view = (url) => url.includes('view=thumbs') ? 'thumbs' : url.includes('view=layouts') ? 'layouts' : url.includes('layout-picker') ? 'picker'
  : url.startsWith('imageflow://editor') ? 'host' : 'book';
const steps = (t) => {
  const out = {};
  for (const m of marks) {
    if (m.type.startsWith('render.') && m.duration < 20) continue;
    const key = view(m.url) + ' ' + m.type.replace(/ [0-9a-f-]{36}/, '');
    out[key] ??= { n: 0, ms: 0, until: 0 };
    out[key].n++; out[key].ms += Math.round(m.duration); out[key].until = Math.max(out[key].until, m.at - t);
  }
  marks = [];
  return out;
};
try {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const w = await testBook(app, book);
  w.setDefaultTimeout(120000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.setContentSize(1400, 900)));
  await w.waitForFunction(() => document.querySelector('iframe.book-frame-book[data-current][data-ready]'));
  const photos = await w.frames().find((frame) => frame.url().includes('view=book'))?.evaluate(() => document.querySelectorAll('img[data-src]').length);
  if (!photos) throw new Error('The book shows no photos: are its linked photos approved?');
  await w.waitForTimeout(Number(values.settle));
  // What the user sees of the book's structure in the host: sidebar buttons and the book view's labels, in order and place.
  await w.evaluate(() => {
    window.__structure = () => JSON.stringify([...document.querySelectorAll('.spread-thumb, .sheet-label')].map((node) => {
      const { top, left } = node.getBoundingClientRect();
      return [node.dataset.spread ?? node.dataset.canvasSpread, Math.round(top), Math.round(left), node.textContent];
    }));
  });
  const shownRevision = () => w.evaluate(() => document.querySelector('iframe.book-frame-book[data-ready]:not(.book-frame-pending)')?.dataset.revision);
  async function measure(action) {
    const before = await shownRevision();
    await w.evaluate(() => {
      const initial = window.__structure();
      window.__feedback = undefined;
      const sample = () => {
        if (window.__structure() !== initial) { window.__feedback = performance.now(); return; }
        requestAnimationFrame(sample);
      };
      window.__clicked = performance.now();
      requestAnimationFrame(sample);
    });
    const t = Date.now();
    await action();
    let shown; let previous = ''; let lastChange = t;
    while (Date.now() - lastChange < 2000 && Date.now() - t < 30000) {
      const hash = createHash('sha1').update(await w.screenshot()).digest('hex');
      const at = Date.now();
      if (hash !== previous) { previous = hash; lastChange = at; }
      if (shown === undefined && await shownRevision() !== before) shown = at - t;
    }
    const feedback = await w.evaluate(() => window.__feedback === undefined ? undefined : Math.round(window.__feedback - window.__clicked));
    return { feedback, shown, settled: lastChange - t, ...(values.profile ? { steps: steps(t) } : {}) };
  }
  const button = (name) => w.getByRole('button', { name, exact: true });
  const pick = async (n) => { await w.locator('button.spread-thumb').nth(n).click(); await w.waitForTimeout(2000); };
  const results = { add: [], delete: [], move: [], duplicate: [] };
  const count = await w.locator('button.spread-thumb').count();
  for (let run = 0; run < Number(values.repeat); run++) {
    const at = Math.round(count * (run + 1) / (Number(values.repeat) + 1));
    await pick(at);
    results.add.push(await measure(() => button('Add').click()));
    await w.waitForTimeout(1500);
    // The added spread is selected; delete it again.
    results.delete.push(await measure(() => button('Delete').click()));
    await w.waitForTimeout(1500);
    await pick(at);
    results.move.push(await measure(() => button('Move spread down').click()));
    await w.waitForTimeout(1500);
    results.duplicate.push(await measure(() => button('Duplicate').click()));
    await w.waitForTimeout(1500);
  }
  for (const [edit, runs] of Object.entries(results)) console.log(edit.padEnd(10), runs.map(({ feedback, shown, settled }) =>
    `feedback ${feedback ?? '–'} ms · shown ${shown ?? '–'} ms · settled ${settled} ms`).join('   |   '));
  if (values.profile) console.log(JSON.stringify(results, null, 1));
} finally {
  await app.close().catch(() => {});
  await rm(work, { recursive: true, force: true });
}
