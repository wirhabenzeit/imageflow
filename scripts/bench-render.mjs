import { testBook, menuAction } from './ui-actions.mjs';
// Measures editor rendering cost (issue #11): time from one edit to every book frame being ready, memory, and
// rapid consecutive edits. Builds a book from the starter spreads, optionally with a distinct photo per box.
//
//   npm run build && node scripts/stage-desktop.mjs
//   node scripts/bench-render.mjs --spreads 151 --unique [--visible]
//
// --spreads   spread count (15 ≈ 28 pages, 51 ≈ 100 pages, 151 ≈ 300 pages)
// --unique    copy a photo file per photo box, as in a real book
// --visible   show the window; hidden windows skip painting and can understate the cost
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import electron from 'electron';
import { _electron } from 'playwright-core';

const { values } = parseArgs({ options: {
  spreads: { type: 'string', default: '15' }, unique: { type: 'boolean' }, visible: { type: 'boolean' },
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'bench-'));
const project = join(work, 'Book.imageflow');
await cp(join(root, 'sample/starter'), project, { recursive: true, filter: (path) => !path.includes('.imageflow') });
const data = JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
const [first, ...middle] = data.spreads.slice(0, -1);
const body = [];
while (body.length < Number(values.spreads) - 2) body.push({ ...structuredClone(middle[body.length % middle.length]), id: 's' + body.length });
data.spreads = [first, ...body, data.spreads.at(-1)];
let photos = 4;
if (values.unique) {
  const index = JSON.parse(await readFile(join(project, 'photos.json'), 'utf8'));
  photos = 0;
  for (const spread of data.spreads) for (const box of Object.values(spread.boxes)) {
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
const memoryMB = async () => Math.round((await app.evaluate(({ app }) =>
  app.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0))) / 1024);
try {
  const w = await testBook(app, project);
  w.setDefaultTimeout(300000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  const views = ['book', 'thumbs', 'layouts'];
  const allReady = () => w.waitForFunction((views) => views.every((view) =>
    document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]')), views);
  let start = Date.now();

  await allReady();
  const openMs = Date.now() - start;
  await w.waitForTimeout(1500);
  const idleMB = await memoryMB();

  const heading = w.getByRole('textbox', { name: 'Heading' }).first();
  await heading.fill('Bench');
  let peakMB = idleMB;
  const sampler = setInterval(() => { memoryMB().then((value) => { peakMB = Math.max(peakMB, value); }, () => {}); }, 100);
  // Wait for the frame that renders the edit: it has a new URL, while the previous frame stays ready meanwhile.
  const before = await w.evaluate((views) => Object.fromEntries(views.map((view) =>
    [view, document.querySelector('iframe.book-frame-' + view + '[data-current]')?.getAttribute('src')])), views);
  start = Date.now();
  await heading.blur();
  const editMs = {};
  for (const view of views) {
    await w.waitForFunction(({ view, old }) => {
      const frame = document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]');
      return frame && frame.getAttribute('src') !== old;
    }, { view, old: before[view] });
    editMs[view] = Date.now() - start;
  }
  clearInterval(sampler);

  // Five rapid edits: time until the last one is on screen, then make sure no older render replaces it.
  const book = w.frameLocator('iframe.book-frame-book[data-current]');
  const shows = async (text) => (await book.locator('[data-spread="title"] h1').textContent().catch(() => '')) === text;
  start = Date.now();
  for (let i = 0; i < 5; i++) { await heading.fill('Rapid ' + i); await heading.blur(); }
  while (!await shows('Rapid 4')) {
    if (Date.now() - start > 30000) throw new Error('The last of five rapid edits did not appear within 30 s.');
    await w.waitForTimeout(25);
  }
  const rapid5Ms = Date.now() - start;
  await w.waitForTimeout(1000);
  const finalHeading = (await shows('Rapid 4')) ? 'Rapid 4' : 'replaced';
  const images = await book.locator('body').evaluate(() => ({
    boxes: document.querySelectorAll('img').length,
    loaded: [...document.images].filter((img) => img.getAttribute('src') && img.complete && img.naturalWidth).length,
  }));
  console.log(JSON.stringify({
    spreads: data.spreads.length, pages: 2 + body.length * 2, photos, openMs, editMs, idleMB, peakMB, rapid5Ms,
    finalHeadingCorrect: finalHeading === 'Rapid 4', images,
  }));
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
