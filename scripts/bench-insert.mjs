// Times adding a spread to an existing book in the editor (beta finding F-032): from the command until the book view
// and its thumbnails show the new revision. Works on a copy of the book, so the original is never changed.
//
//   IMAGEFLOW_PROFILE=1 npx vite build && node scripts/stage-desktop.mjs   (or npm run build, without render steps)
//   IMAGEFLOW_PROFILE=1 IMAGEFLOW_WARM=1 npx vite build ...                 (prototype: frames render new revisions in place)
//   node scripts/bench-insert.mjs --book path/to/Book.imageflow [--repeat 3] [--settle 45000] [--profile out.json]
//
// --book     the book to copy; the copy is made next to it, so photos it links by relative path still resolve
// --repeat   inserts to time, one after another (default 3)
// --settle   milliseconds to wait after opening, so maps and thumbnails finish drawing first (default 20000)
// --double   two inserts in a row per run, as a double-click does
// --profile  write CPU profiles of the render frames created by the first insert to this file
// --visible  show the window; hidden windows skip painting
//
// The book's map sites are trusted without asking, as for the user's own books. With a profiling build, each run also
// reports the render steps per view (src/render.tsx) and every picture actually drawn, that is, every cache miss.
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

const { values } = parseArgs({ options: {
  book: { type: 'string' }, repeat: { type: 'string', default: '3' }, settle: { type: 'string', default: '20000' },
  visible: { type: 'boolean' }, double: { type: 'boolean' }, profile: { type: 'string' },
} });
if (!values.book) throw new Error('--book is required.');
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(dirname(values.book), '.bench-'));
const project = join(work, basename(values.book));
await cp(values.book, project, { recursive: true });

const app = await _electron.launch({
  executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, ...(values.visible ? {} : { IMAGEFLOW_HIDE_WINDOW: '1' }) },
});
let marks;
await app.context().exposeBinding('__benchRecord', ({ frame }, record) => { marks?.push({ url: frame.url(), ...record }); });
await app.context().addInitScript(() => {
  const emit = (record) => { void window.__benchRecord(record).catch(() => {}); };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) emit({ type: 'longtask', duration: e.duration }); }).observe({ type: 'longtask' });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name.startsWith('imageflow.')) emit({ type: e.name.slice(10), duration: e.duration }); })
    .observe({ type: 'measure' });
});
const viewOf = (url) => url.includes('view=thumbs') ? 'thumbs' : url.includes('view=layouts') ? 'layouts' : url.startsWith('imageflow://editor') ? 'host' : 'book';
const views = ['book', 'thumbs'];
try {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const w = await testBook(app, project);
  w.on('console', (message) => { if (message.text().startsWith('imageflow.warm')) console.error(message.text()); });
  w.setDefaultTimeout(300000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.setContentSize(1400, 900)));
  let start = Date.now();
  await w.waitForFunction((views) => views.every((view) => document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]')), views);
  const openMs = Date.now() - start;
  await w.waitForTimeout(Number(values.settle));
  const pictures = async () => Object.fromEntries(await Promise.all(w.frames().filter((frame) => frame.url().includes('/render/')).map(async (frame) =>
    [viewOf(frame.url()), await frame.evaluate(() => ({ spreads: document.querySelectorAll('.if-spread-container').length,
      ...[...document.querySelectorAll('.if-rendered-image')]
        .reduce((counts, node) => ({ ...counts, [node.dataset.rendered]: (counts[node.dataset.rendered] ?? 0) + 1 }), {}) })).catch(() => 'gone')])));
  const processes = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((window) =>
    window.webContents.mainFrame.framesInSubtree.filter((frame) => frame.url.includes('/render/')).map((frame) => [frame.url, frame.osProcessId])));
  console.error(JSON.stringify({ openMs, pictures: await pictures(),
    processes: Object.fromEntries(processes.map(([url, pid]) => [viewOf(url), pid])) }));
  const runs = [];
  for (let run = 0; run < Number(values.repeat); run++) {
    const before = await w.evaluate((views) => Object.fromEntries(views.map((view) =>
      [view, document.querySelector('iframe.book-frame-' + view + '[data-current]')?.dataset.revision])), views);
    const profile = values.profile && run === 0;
    // New render frames start paused, so their whole render is profiled.
    if (profile) await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().map((window) => window.webContents).find((contents) => contents.getURL() === 'imageflow://editor/');
      globalThis.benchDebugger = contents.debugger;
      const debug = contents.debugger;
      if (!debug.isAttached()) debug.attach('1.3');
      globalThis.benchSessions = [];
      debug.on('message', async (_event, method, params) => {
        if (method !== 'Target.attachedToTarget') return;
        globalThis.benchSessions.push(params.sessionId);
        for (const [command, args] of [['Profiler.enable', {}], ['Profiler.setSamplingInterval', { interval: 250 }], ['Profiler.start', {}]]) {
          await debug.sendCommand(command, args, params.sessionId).catch(() => {});
        }
        await debug.sendCommand('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      });
      await debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    });
    marks = [];
    start = Date.now();
    await menuAction(app, 'Add Spread');
    if (values.double) await menuAction(app, 'Add Spread');
    const ms = {};
    await Promise.all(views.map((view) => w.waitForFunction(({ view, old }) => {
      const frame = document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]');
      // The revision a frame shows: a new frame's, or a newer one a warm frame rendered in place (IMAGEFLOW_WARM).
      return frame && frame.dataset.revision !== old;
    }, { view, old: before[view] }, { polling: 10 }).then(() => { ms[view] = Date.now() - start; })));
    await w.waitForTimeout(3000);
    if (profile) {
      const profiles = await app.evaluate(async () => {
        const out = [];
        for (const session of globalThis.benchSessions) {
          const result = await globalThis.benchDebugger.sendCommand('Profiler.stop', {}, session).catch(() => undefined);
          if (result) out.push(result.profile);
        }
        return out;
      });
      await writeFile(values.profile, JSON.stringify(profiles));
    }
    const steps = {};
    for (const { url, type, duration } of marks) {
      const view = steps[viewOf(url)] ??= {};
      if (type === 'longtask') { view.longtasks = (view.longtasks ?? 0) + 1; view.longtaskMs = Math.round((view.longtaskMs ?? 0) + duration); }
      else view[type] = Math.round((view[type] ?? 0) + duration);
    }
    marks = undefined;
    runs.push({ ms, steps, pictures: await pictures() });
    console.error(JSON.stringify(runs.at(-1)));
    await w.waitForTimeout(2000);
  }
  console.log(JSON.stringify({ openMs, runs }));
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
