import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
try {
  // Keep rendering deterministic: insertion/thumbnail geometry is the behavior under test, not photo loading.
  await copySample(join(root, 'sample/starter'), book);
  await writeFile(join(book, 'template/index.tsx'), `import { defineTemplate, mm, p, Spread, printFormat } from 'imageflow';
export default defineTemplate({ id: 'thumbnail-scroll', version: '1', contract: 1,
  format: printFormat({ label: 'Scroll', trim: { width: mm(100), height: mm(100) }, bleed: mm(3), safe: mm(8),
    ends: 'inside-covers', pageCount: { min: 2, max: 120, step: 2 } }),
  spreads: ({ spread }) => ({ plain: spread({ label: 'Plain', parameters: { heading: p.string({ label: 'Heading', default: 'New spread' }) },
    render: ctx => <Spread><ctx.Text parameter="heading" rect={ctx.geometry.page('left', 'safe')} /></Spread> }) }) });`);
  await writeFile(join(book, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Scroll', template: { id: 'thumbnail-scroll', version: '1' },
    spreads: Array.from({ length: 16 }, (_, i) => ({ id: 'sheet-' + i, definition: 'plain', params: { heading: 'Spread ' + (i + 1) }, boxes: {}, elements: {} })) }));
  app = await _electron.launch({ executablePath: packaged ? packagedMacExecutable(root) : electron, args: [...(packaged ? [] : [join(root, '.build/desktop')]), '--user-data-dir=' + join(work, 'profile')],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, IMAGEFLOW_HIDE_WINDOW: '1' } });
  page = await testBook(app, book);
  await app.browserWindow(page).then(handle => handle.evaluate(window => window.setContentSize(1400, 900)));
  const ready = () => page.waitForFunction(() => ['book', 'thumbs'].every(view =>
    document.querySelector('.book-frame-' + view + '[data-current][data-ready]:not(.book-frame-pending)')));
  await ready();
  await page.locator('.spread-thumb[data-spread="sheet-14"]').click();
  await page.waitForFunction(() => document.querySelector('.thumbs-scroll').scrollTop > 1000);
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
  console.log('Thumbnail scroll passed: Add and Duplicate near the end keep the insertion point in view without jumping up.');
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.evaluate(() => ({ status: document.querySelector('.status')?.textContent,
      scroll: document.querySelector('.thumbs-scroll')?.scrollTop,
      frames: [...document.querySelectorAll('.book-frame-book, .book-frame-thumbs')].map(f => ({ src: f.src, ready: f.hasAttribute('data-ready'), current: f.hasAttribute('data-current'), className: f.className })) })));
  }
  throw error;
} finally {
  if (app) await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
