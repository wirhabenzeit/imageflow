import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook } from './ui-actions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const mode of ['missing-reply', 'changed-geometry', 'superseded']) {
  const work = await mkdtemp(join(root, '.build/reorder-fallback-'));
  let app;
  try {
    app = await _electron.launch({ executablePath: electron,
      args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
      env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
    await app.context().addInitScript(mode => {
      window.motionTest = { labels: 0, replies: 0, changed: false, events: [] };
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.matches('.spread-thumb')) {
          window.motionTest.labels++;
          window.motionTest.events.push({ type: 'label', spread: this.dataset.spread, time: performance.now() });
        }
        return animate.apply(this, args);
      };
      if (window !== window.top) return;
      let held;
      let release = false;
      let preparedWidth;
      const widths = new Map();
      window.releaseReorderReply = () => {
        release = true;
        if (held) window.dispatchEvent(new MessageEvent('message', {
          data: held.data, origin: held.origin, source: held.source,
        }));
      };
      window.addEventListener('message', event => {
        if (event.origin !== 'imageflow://render') return;
        if (event.data?.type === 'geometry' || event.data?.type === 'reorder-ready') {
          const frame = [...document.querySelectorAll('iframe')].find(frame => frame.contentWindow === event.source);
          window.motionTest.events.push({ type: event.data.type, width: event.data.width, title: frame?.title,
            current: frame?.getAttribute('data-current'), ready: frame?.getAttribute('data-ready'), time: performance.now() });
        }
        if (event.data?.type === 'geometry') widths.set(event.source, event.data.width);
        if (event.data?.type === 'reorder-ready' && !release && (!held || event.source === held.source)) {
          event.stopImmediatePropagation();
          held = event;
          preparedWidth = widths.get(event.source);
          window.motionTest.replies++;
          if (mode === 'changed-geometry') {
            const frame = [...document.querySelectorAll('iframe')].find(frame => frame.contentWindow === event.source);
            frame.style.width = (frame.clientWidth - 24) + 'px';
          }
        } else if (mode === 'changed-geometry' && held && event.source === held.source && event.data?.type === 'geometry' && event.data.width !== preparedWidth) {
          window.motionTest.changed = true;
          // Let BookFrame receive the new geometry before delivering the old reply.
          setTimeout(() => window.releaseReorderReply(), 0);
        }
      }, true);
    }, mode);
    const project = join(work, 'Book.imageflow');
    const page = await testBook(app, project, true);
    const ready = () => page.locator('iframe.book-frame-thumbs[data-current][data-ready]').waitFor();
    const saved = text => page.waitForFunction(text => document.querySelector('.status')?.textContent === text, text);
    const moved = page.locator('.spread-thumb[data-spread="arriving"]');
    await ready();
    await page.locator('iframe.book-frame-book[data-current][data-ready]').waitFor();
    await page.locator('.spread-thumb[data-spread="arriving"][draggable="true"]').waitFor();
    const initialFrame = await page.locator('iframe.book-frame-thumbs[data-current]').getAttribute('src');
    await moved.focus();
    await page.keyboard.press('Alt+Meta+ArrowDown');
    await saved('Spread moved to pages 4–5');
    await page.waitForFunction(() => window.motionTest.replies > 0);
    if (mode === 'superseded') {
      await moved.focus();
      await page.keyboard.press('Alt+Meta+ArrowDown');
      await saved('Spread moved to pages 6–7');
    }
    await ready();
    const currentFrame = await page.locator('iframe.book-frame-thumbs[data-current]').getAttribute('src');
    assert.notEqual(currentFrame, initialFrame, 'A missing animation reply cannot freeze the sidebar');
    if (mode !== 'superseded') {
      assert.equal(await page.evaluate(() => window.motionTest.labels), 0, 'Fallback also skips the label animation: ' +
        JSON.stringify(await page.evaluate(() => window.motionTest.events)));
      if (mode === 'changed-geometry') assert.equal(await page.evaluate(() => window.motionTest.changed), true);
      const artwork = page.frames().find(frame => frame.url() === currentFrame);
      assert.ok(artwork);
      await artwork.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 5000 });
      await page.evaluate(() => window.releaseReorderReply());
      assert.equal(await page.locator('iframe.book-frame-thumbs[data-current]').getAttribute('src'), currentFrame,
        'A late reply must not replace the published frame');
      assert.equal(await page.evaluate(() => window.motionTest.labels), 0);
    }
    if (mode === 'superseded') {
      await page.evaluate(() => window.releaseReorderReply());
      assert.equal(await page.locator('iframe.book-frame-thumbs[data-current]').getAttribute('src'), currentFrame,
        'A superseded candidate cannot publish its stale geometry');
    }
    const projectState = JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
    const expectedIndex = mode === 'superseded' ? 3 : 2;
    assert.equal(projectState.spreads[expectedIndex].id, 'arriving');
    assert.equal(await moved.getAttribute('aria-current'), 'page');
    console.log('Reorder fallback passed:', mode);
  } finally { await app?.close(); await rm(work, { recursive: true, force: true }); }
}
