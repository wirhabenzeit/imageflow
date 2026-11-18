import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { closeApp, testBook } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';
import { packagedMacExecutable } from './mac-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'thumbnail-scroll-'));
const book = join(work, 'Scroll.imageflow');
const packaged = process.argv.includes('--packaged');
let app, page;
let finishThumbnails;
try {
  await copySample(join(root, 'sample/starter'), book);
  const [photo] = Object.keys(JSON.parse(await readFile(join(book, 'photos.json'), 'utf8')));
  await writeFile(join(book, 'template/index.tsx'), `import { box, defineTemplate, mm, p, Spread, printFormat } from 'imageflow';
export default defineTemplate({ id: 'thumbnail-scroll', version: '1', contract: 1,
  format: printFormat({ label: 'Scroll', trim: { width: mm(100), height: mm(100) }, bleed: mm(3), safe: mm(8),
    ends: 'inside-covers', pageCount: { min: 2, max: 120, step: 2 } }),
  spreads: ({ spread }) => ({ plain: spread({ label: 'Plain', boxes: { photo: box.photo('Photo') },
    parameters: { heading: p.string({ label: 'Heading', default: 'New spread' }) },
    render: ctx => <Spread><ctx.Text parameter="heading" rect={ctx.geometry.page('left', 'safe')} />
      <ctx.PhotoBox id="photo" rect={ctx.geometry.page('right', 'safe')} /></Spread> }) }) });`);
  await writeFile(join(book, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Scroll', template: { id: 'thumbnail-scroll', version: '1' },
    spreads: Array.from({ length: 16 }, (_, i) => ({ id: 'sheet-' + i, definition: 'plain', params: { heading: 'Spread ' + (i + 1) },
      boxes: { photo: { photo, params: {} } }, elements: {} })) }));
  app = await _electron.launch({ executablePath: packaged ? packagedMacExecutable(root) : electron, args: [...(packaged ? [] : [join(root, '.build/desktop')]), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  const holdThumbnails = new Promise(resolve => { finishThumbnails = resolve; });
  await app.context().route('**/thumb/**', async route => {
    if (new URL(route.request().frame().url()).searchParams.get('view') === 'thumbs') await holdThumbnails;
    await route.continue();
  });
  page = await testBook(app, book);
  await app.browserWindow(page).then(handle => handle.evaluate(window => window.setContentSize(1400, 900)));
  const ready = () => page.waitForFunction(() => ['book', 'thumbs'].every(view =>
    document.querySelector('.book-frame-' + view + '[data-current][data-ready]:not(.book-frame-pending)')));
  const sidebar = page.frameLocator('.book-frame-thumbs[data-current]');
  await sidebar.locator('img[data-src][src]').first().waitFor({ state: 'attached' });
  await page.locator('.book-frame-book[data-current][data-ready]:not(.book-frame-pending)').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.book-frame-thumbs[data-ready]').count(), 0, 'the first canvas appears while thumbnail photos are held');
  finishThumbnails();
  await ready();
  const distant = sidebar.locator('[data-spread="sheet-14"] img[data-src]');
  assert.equal(await distant.getAttribute('src'), null, 'offscreen thumbnail photos are deferred');
  await page.locator('.spread-thumb[data-spread="sheet-14"]').click();
  await page.waitForFunction(() => document.querySelector('.thumbs-scroll').scrollTop > 1000);
  await sidebar.locator('[data-spread="sheet-14"] img[data-src][src]').waitFor({ state: 'attached' });
  for (const action of ['Add', 'Duplicate']) {
    const before = await page.evaluate(() => {
      const list = document.querySelector('.thumbs-scroll');
      window.thumbnailScrollSamples = [list.scrollTop];
      list.onscroll = () => window.thumbnailScrollSamples.push(list.scrollTop);
      return { top: list.scrollTop, selected: document.querySelector('.spread-thumb[aria-current="page"]').dataset.spread,
        frame: document.querySelector('.book-frame-thumbs[data-current]').src };
    });
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.waitForFunction(before => document.querySelector('.book-frame-thumbs[data-current]')?.src !== before, before.frame);
    await ready();
    const after = await page.evaluate(() => {
      const list = document.querySelector('.thumbs-scroll'), selected = document.querySelector('.spread-thumb[aria-current="page"]');
      const outer = list.getBoundingClientRect(), inner = selected.getBoundingClientRect();
      return { top: list.scrollTop, selected: selected.dataset.spread, samples: window.thumbnailScrollSamples,
        visible: inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 };
    });
    assert.notEqual(after.selected, before.selected, action + ' selects the new spread');
    assert.ok(after.top >= before.top - 2, action + ' keeps the sidebar near the insertion point: ' + before.top + ' → ' + after.top);
    assert.ok(after.samples.every(top => top >= before.top - 2), action + ' never jumps up while the new thumbnail loads: ' + after.samples);
    assert.ok(after.visible, action + ' brings the new thumbnail into view');
  }
  console.log('Canvas reveals before thumbnails, sidebar photos load on scroll, and Add/Duplicate preserve the insertion point.');
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(() => ({ status: document.querySelector('.status')?.textContent,
      scroll: document.querySelector('.thumbs-scroll')?.scrollTop,
      frames: [...document.querySelectorAll('.book-frame-book, .book-frame-thumbs')].map(f => ({ src: f.src, ready: f.hasAttribute('data-ready'), current: f.hasAttribute('data-current'), className: f.className })) })));
  }
  throw error;
} finally {
  finishThumbnails?.();
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
