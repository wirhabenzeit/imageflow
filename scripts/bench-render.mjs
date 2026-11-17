import { testBook, menuAction } from './ui-actions.mjs';
// Measures editor rendering cost (issue #11): time from one edit to every book frame being ready, memory, and
// rapid consecutive edits. Builds a book from the starter spreads, optionally with a distinct photo per box.
//
//   npm run build && node scripts/stage-desktop.mjs
//   node scripts/bench-render.mjs --spreads 151 --unique [--visible] [--repeat 5]
//
// With an IMAGEFLOW_PROFILE=1 build, it also reports how long each step of a render took in each view (median over
// --repeat edits), from the imageflow.render.* marks in src/render.tsx, and long tasks in the editor window.
//
// --spreads   spread count (15 ≈ 28 pages, 51 ≈ 100 pages, 151 ≈ 300 pages)
// --unique    copy a photo file per photo box, as in a real book
// --visible   show the window; hidden windows skip painting and can understate the cost
// --repeat    timed single edits, reported as the median (default 1)
// --settle    milliseconds to wait after opening before editing, for background work such as the cover (default 1500)
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { copySample } from '../desktop/sample-book.mjs';

const { values } = parseArgs({ options: {
  spreads: { type: 'string', default: '15' }, unique: { type: 'boolean' }, visible: { type: 'boolean' },
  repeat: { type: 'string', default: '1' }, settle: { type: 'string', default: '1500' },
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'bench-'));
const project = join(work, 'Book.imageflow');
await copySample(join(root, 'sample', 'starter'), project);
const data = JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const [first, ...middle] = data.spreads.slice(0, -1);
const body = [];
while (body.length < Number(values.spreads) - 2) body.push({ ...structuredClone(middle[body.length % middle.length]), id: 's' + body.length });
data.spreads = [first, ...body, data.spreads.at(-1)];
let photos = 4;
if (values.unique) {
  const index = JSON.parse(await readFile(join(project, 'photos.json'), 'utf8'));
  photos = 0;
  // Boxes of a spread layout, and of the page layouts of a sheet shown as two pages.
  const states = (spread) => [spread, spread.pages?.left, spread.pages?.right].filter(Boolean);
  for (const spread of data.spreads) for (const box of states(spread).flatMap((state) => Object.values(state.boxes ?? {}))) {
    if (!box.photo || !index[box.photo]) continue;
    const id = 'u' + photos++;
    await cp(join(project, index[box.photo].path), join(project, 'photos', id + '.jpg'));
    index[id] = { ...index[box.photo], path: 'photos/' + id + '.jpg' };
    box.photo = id;
  }
  await writeFile(join(project, 'photos.json'), JSON.stringify(index, null, 2));
}
await writeFile(join(project, 'project.json'), JSON.stringify(data, null, 2));

const app = await _electron.launch({
  executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, ...(values.visible ? {} : { IMAGEFLOW_HIDE_WINDOW: '1' }) },
});
// Render step timings and long tasks, by frame. Recorded only while `marks` is set.
let marks;
await app.context().exposeBinding('__benchRecord', ({ frame }, record) => { marks?.push({ url: frame.url(), ...record }); });
await app.context().addInitScript(() => {
  const emit = (record) => { void window.__benchRecord(record).catch(() => {}); };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) emit({ type: 'longtask', duration: e.duration }); }).observe({ type: 'longtask' });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name.startsWith('imageflow.render.')) emit({ type: e.name.slice(17), duration: e.duration }); })
    .observe({ type: 'measure' });
});
const viewOf = (url) => url.includes('view=thumbs') ? 'thumbs' : url.includes('view=layouts') ? 'layouts' : url.startsWith('imageflow://editor') ? 'host' : 'book';
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) / 2)]) : undefined; };
const memoryMB = async () => Math.round((await app.evaluate(({ app }) =>
  app.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0))) / 1024);
try {
  marks = [];
  const w = await testBook(app, project);
  w.setDefaultTimeout(300000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  const views = ['book', 'thumbs', 'layouts'];
  const allReady = (page = w) => page.waitForFunction((views) => views.every((view) =>
    document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]')), views);
  let start = Date.now();
  // When each view of the opened book is first ready, and its render steps.
  const openViewMs = {};
  await Promise.all(views.map((view) => w.waitForFunction((view) =>
    document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]'), view).then(() => { openViewMs[view] = Date.now() - start; })));
  await allReady();
  const openMs = Date.now() - start;
  // Photo requests during the open, by view: how many, and when they started and finished (Resource Timing).
  const openRequests = {};
  for (const frame of w.frames()) {
    if (!frame.url().includes('/render/')) continue;
    const entries = await frame.evaluate(() => performance.getEntriesByType('resource')
      .filter(({ name }) => /\/(photo|thumb)\//.test(name))
      .map(({ name, startTime, responseEnd }) => ({ kind: name.match(/\/(photo|thumb)\//)[1], start: Math.round(startTime), end: Math.round(responseEnd) }))).catch(() => []);
    if (!entries.length) continue;
    const durations = entries.map(({ start, end }) => end - start);
    openRequests[viewOf(frame.url())] = { count: entries.length, firstStart: Math.min(...entries.map(({ start }) => start)),
      lastEnd: Math.max(...entries.map(({ end }) => end)), medianMs: median(durations), maxMs: Math.max(...durations),
      kinds: [...new Set(entries.map(({ kind }) => kind))] };
  }
  const openSteps = {};
  for (const { url, type, duration } of marks) {
    if (type === 'longtask') continue;
    const view = viewOf(url);
    openSteps[view] ??= {};
    openSteps[view][type] = Math.round((openSteps[view][type] ?? 0) + duration);
  }
  marks = undefined;
  await w.waitForTimeout(Number(values.settle));
  const idleMB = await memoryMB();
  // Which renderer process runs each view: frames in the editor's process share its main thread.
  const processes = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((window) =>
    window.webContents.mainFrame.framesInSubtree.map((frame) => ({ url: frame.url, pid: frame.osProcessId }))));
  const editorPid = processes.find(({ url }) => url.startsWith('imageflow://editor'))?.pid;
  const viewProcess = Object.fromEntries(processes.filter(({ url }) => url.includes('/render/'))
    .map(({ url, pid }) => [viewOf(url), pid === editorPid ? 'editor' : 'own']));

  // A document parameter changes every page, so the whole book re-renders, as after most edits.
  if (await w.locator('.template-controls').getAttribute('open') === null) await w.locator('.template-controls > summary').click();
  const pageNumbers = w.getByRole('checkbox', { name: 'Page numbers', exact: true });
  let peakMB = idleMB;
  const sampler = setInterval(() => { memoryMB().then((value) => { peakMB = Math.max(peakMB, value); }, () => {}); }, 100);
  const edits = [];
  for (let run = 0; run < Number(values.repeat); run++) {
    // Wait for the frame that renders the edit: it has a new URL, while the previous frame stays ready meanwhile.
    const before = await w.evaluate((views) => Object.fromEntries(views.map((view) =>
      [view, document.querySelector('iframe.book-frame-' + view + '[data-current]')?.getAttribute('src')])), views);
    marks = [];
    start = Date.now();
    await pageNumbers.click();
    const ms = {};
    for (const view of views) {
      await w.waitForFunction(({ view, old }) => {
        const frame = document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]');
        return frame && frame.getAttribute('src') !== old;
      }, { view, old: before[view] });
      ms[view] = Date.now() - start;
    }
    await w.waitForTimeout(300);
    const steps = {};
    for (const { url, type, duration } of marks) {
      const view = viewOf(url);
      steps[view] ??= {};
      if (type === 'longtask') { steps[view].longtasks = (steps[view].longtasks ?? 0) + 1; steps[view].longestTask = Math.max(steps[view].longestTask ?? 0, Math.round(duration)); }
      else steps[view][type] = (steps[view][type] ?? 0) + duration;
    }
    marks = undefined;
    edits.push({ ms, steps });
    await w.waitForTimeout(500);
  }
  clearInterval(sampler);
  const editMs = Object.fromEntries(views.map((view) => [view, median(edits.map(({ ms }) => ms[view]))]));
  const stepMs = {};
  for (const view of new Set(edits.flatMap(({ steps }) => Object.keys(steps)))) {
    stepMs[view] = Object.fromEntries([...new Set(edits.flatMap(({ steps }) => Object.keys(steps[view] ?? {})))]
      .map((type) => [type, median(edits.map(({ steps }) => steps[view]?.[type] ?? 0))]));
  }

  // Five rapid edits: time until the last one is on screen, then make sure no older render replaces it.
  const book = w.frameLocator('iframe.book-frame-book[data-current]');
  const shows = async (numbered) => (await book.locator('.folio').count().catch(() => -1) > 0) === numbered;
  const expected = !await pageNumbers.isChecked();
  start = Date.now();
  for (let i = 0; i < 5; i++) await pageNumbers.click();
  while (!await shows(expected)) {
    if (Date.now() - start > 30000) throw new Error('The last of five rapid edits did not appear within 30 s.');
    await w.waitForTimeout(25);
  }
  const rapid5Ms = Date.now() - start;
  await w.waitForTimeout(1000);
  const finalCorrect = await shows(expected);
  const images = await book.locator('body').evaluate(() => ({
    boxes: document.querySelectorAll('img').length,
    loaded: [...document.images].filter((img) => img.getAttribute('src') && img.complete && img.naturalWidth).length,
  }));
  // Open the book again in the same app, with its photo renditions already made: the usual case.
  await w.close();
  start = Date.now();
  const again = await testBook(app, project);
  again.setDefaultTimeout(300000);
  await allReady(again);
  const reopenMs = Date.now() - start;
  console.log(JSON.stringify({
    spreads: data.spreads.length, pages: 2 + body.length * 2, photos, openMs, reopenMs, openViewMs, openSteps, openRequests, process: viewProcess, editMs, stepMs, idleMB, peakMB, rapid5Ms,
    finalCorrect, images,
  }));
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
