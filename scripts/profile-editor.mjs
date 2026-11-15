// Run after IMAGEFLOW_PROFILE=1 npm run build && node scripts/stage-desktop.mjs.
// React's diagnostic fiber fields are version-specific; this harness targets the pinned React 19.2.3.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction, clickPage } from './ui-actions.mjs';
import { copySample } from '../desktop/sample-book.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, '.build', 'editor-profile-' + Date.now());
await mkdir(out, { recursive: true });
const results = []; let active; let app;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(out, 'profile')], env });
  await app.context().exposeBinding('__profileRecord', ({ frame }, record) => { if (active) active.events.push({ url: frame.url(), ...record }); });
  await app.context().addInitScript(() => {
    const emit = record => { void window.__profileRecord(record).catch(() => {}); };
    const shallow = (a, b) => a === b || (!!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.is(a[k], b[k])));
    const writeStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'imageflow.workspace.v1') emit({ type: 'panel-storage-write' });
      return writeStorage.call(this, key, value);
    };
    const localeString = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function(...args) {
      const start = performance.now();
      const value = localeString.apply(this, args);
      emit({ type: 'date-format', duration: performance.now() - start });
      return value;
    };
    const previousTrees = new WeakMap();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, inject: () => 1, checkDCE() {}, onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        const components = [];
        const previous = previousTrees.get(root) ?? new Set();
        const current = new Set();
        function visit(f) {
          if (!f) return;
          current.add(f);
          if (!previous.has(f) && (f.flags & 1) && typeof f.type === 'function') components.push({ name: f.type.displayName || f.type.name || 'anonymous', duration: f.actualDuration ?? 0,
            sameProps: !!f.alternate && shallow(f.memoizedProps, f.alternate.memoizedProps), sameState: !!f.alternate && f.memoizedState === f.alternate.memoizedState });
          visit(f.child); visit(f.sibling);
        }
        visit(root.current);
        previousTrees.set(root, current);
        emit({ type: 'commit', time: performance.now(), duration: root.current.actualDuration ?? 0, components });
      },
    };
    new PerformanceObserver(list => { for (const e of list.getEntries()) emit({ type: 'longtask', duration: e.duration, time: e.startTime }); }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.name.startsWith('imageflow.')) emit({ type: e.name.slice('imageflow.'.length), duration: e.duration }); performance.clearMeasures(); }).observe({ type: 'measure' });
    let last;
    function tick(now) { if (last !== undefined && now - last > 50) emit({ type: 'frame-gap', duration: now - last }); last = now; requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
    emit({ type: 'document' });
  });
  await app.evaluate(({ net, session }) => session.defaultSession.protocol.handle('https', request => new URL(request.url).host === 'tiles.openfreemap.org'
    ? Response.json({ version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#bcd6c2' } }] }, { headers: { 'access-control-allow-origin': '*' } })
    : net.fetch(request, { bypassCustomProtocolHandlers: true })));
  const requestedSample = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  for (const sample of ['starter', 'calendar'].filter(sample => !requestedSample || sample === requestedSample)) {
    const book = join(out, sample + '.imageflow');
    await copySample(join(root, 'sample', sample), book);
    const file = join(book, 'project.json'); const project = JSON.parse(await readFile(file, 'utf8'));
    if (sample === 'starter') project.spreads.splice(1, 0, { id: 'route', definition: 'map', params: { mapTitle: 'Senja' }, boxes: {}, elements: { map: { params: { tracks: [{ id: 'senja', track: 'senja-road' }], longitude: 17.4, latitude: 69.3, zoom: 9 } } } });
    const seed = project.spreads.slice(1).filter(s => s.definition !== 'map');
    while (project.spreads.length < 20) { const spread = structuredClone(seed[project.spreads.length % seed.length]); spread.id = 'profile-' + project.spreads.length; project.spreads.push(spread); }
    await writeFile(file, JSON.stringify(project));
    const page = await testBook(app, book); page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1500, height: 1000 });
    const ready = '.book-frame-book[data-current][data-ready]:not(.book-frame-pending)';
    await page.locator(ready).waitFor();
    const settle = () => page.waitForTimeout(800);
    async function run(name, action) {
      await settle(); active = { sample, name, events: [], started: Date.now() }; results.push(active);
      try { await action(); await settle(); } catch (error) { active.error = String(error); }
      active.elapsed = Date.now() - active.started; active = undefined;
      await writeFile(join(out, 'recordings.json'), JSON.stringify(results, null, 2));
      console.log(sample + ': ' + name + (results.at(-1).error ? ' FAILED ' + results.at(-1).error : ' recorded'));
    }
    if (process.argv.includes('--sources')) {
      const photos = page.locator('.source-items [role=option]');
      await run('source-photo-cold', async () => { await photos.first().click(); await page.locator('.source-inspector').waitFor(); });
      for (let i = 1; i <= 5; i++) {
        await page.locator('.spread-thumb').nth(2).click();
        await run('source-photo-remount-' + i, async () => { await photos.first().click(); });
      }
      for (let i = 1; i <= 5; i++) await run('source-photo-switch-' + i, async () => { await photos.nth(i % 2 ? 1 : 0).click(); });
      if (sample === 'starter') {
        await page.getByRole('tab', { name: /^Texts/ }).click();
        await run('source-text-cold', async () => { await page.locator('.source-items [role=option]').first().click(); });
        for (let i = 1; i <= 5; i++) {
          await page.locator('.spread-thumb').nth(2).click();
          await run('source-text-remount-' + i, async () => { await page.locator('.source-items [role=option]').first().click(); });
        }
      }
      await page.close(); continue;
    }
    await run('hover', async () => { const box = await page.locator('main.canvas').boundingBox(); for (let n = 0; n < 60; n++) await page.mouse.move(box.x + 20 + (n % 5) * (box.width - 40) / 5, box.y + 40 + (n % 12) * (box.height - 80) / 12); });
    await run('canvas-scroll', async () => { await page.mouse.move(800, 500); for (let n = 0; n < 12; n++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(50); } });
    await run('thumbnail-scroll', async () => { const box = await page.locator('.thumbs-scroll').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); for (let n = 0; n < 12; n++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(50); } });
    await run('select-spread', async () => { for (const i of [1, 2, 3, 2]) { await page.locator('.spread-thumb').nth(i).click(); await page.waitForTimeout(150); } });
    await run('select-source', async () => { await page.locator('.source-items [role=option]').first().click(); });
    await page.locator('.spread-thumb').nth(2).click();
    await run('reorder-shortcuts', async () => { await menuAction(app, 'Move Spread Down'); await page.locator(ready).waitFor(); await settle(); await menuAction(app, 'Undo Book Edit'); });
    await run('reorder-drag', async () => { await page.locator('.spread-thumb').nth(1).dragTo(page.locator('.spread-thumb').nth(3)); });
    await run('toggle-panels', async () => { for (const name of ['Toggle project panel', 'Toggle Inspector']) { const button = page.getByRole('button', { name, exact: true }); await button.click(); await page.waitForTimeout(200); await button.click(); } });
    await run('resize-panel', async () => { const box = await page.locator('.panel-divider').first().boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); for (let n = 1; n <= 25; n++) await page.mouse.move(box.x + n * 3, box.y + box.height / 2); await page.mouse.up(); });
    if (process.argv.includes('--panels')) { await page.close(); continue; }
    // Open the real inline editor, using the same canvas hit-testing as the desktop smoke suite.
    await run('open-inline-editor', async () => { const frame = page.frameLocator(ready); const target = sample === 'starter' ? frame.locator('[data-element="map"]') : frame.locator('.month .days').first(); await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(); await clickPage(page, box.x + box.width * .7, box.y + box.height * .6); await page.locator('.inline-editor.showing').waitFor(); });
    if (sample === 'starter') {
      await run('map-pan', async () => { const before = JSON.parse(await readFile(file, 'utf8')).spreads.find(s => s.id === 'route').elements.map.params.longitude; const box = await page.locator('.inline-editor.showing').boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(300); await page.mouse.down(); for (let n = 1; n <= 12; n++) { await page.mouse.move(box.x + box.width / 2 - n * 8, box.y + box.height / 2 - n * 3); await page.waitForTimeout(30); } await page.mouse.up(); await page.waitForTimeout(1200); const after = JSON.parse(await readFile(file, 'utf8')).spreads.find(s => s.id === 'route').elements.map.params.longitude; if (before === after) throw new Error('Map pan did not change saved longitude'); });
      await run('map-zoom', async () => { await page.mouse.wheel(0, -400); await page.waitForTimeout(1200); });
      await run('prepare-map-track', async () => { const toolbar = page.getByRole('toolbar', { name: 'Edit map' }); await toolbar.getByRole('button', { name: 'Tracks (1)' }).click(); const dialog = toolbar.getByRole('dialog', { name: 'Tracks' }); await dialog.getByRole('button', { name: 'Add', exact: true }).click(); });
      await run('type-map-track', async () => { const input = page.getByRole('dialog', { name: 'Tracks' }).getByRole('textbox', { name: 'Label', exact: true }); await input.pressSequentially('Profile route', { delay: 80 }); });
      await run('commit-map-track', async () => { await page.getByRole('dialog', { name: 'Tracks' }).getByRole('textbox', { name: 'Label', exact: true }).press('Enter'); });
    } else {
      await run('calendar-edit', async () => { const frame = page.frameLocator('iframe.inline-editor-frame'); await frame.locator('.days-on-page li button').nth(10).evaluate(node => node.click()); });
    }
    await run('close-inline-editor', async () => { await page.keyboard.press('Escape'); });
    if (sample === 'calendar') {
      await menuAction(app, 'Grid');
      for (let i = 0; i < 4; i++) await menuAction(app, 'Zoom Out');
      await settle();
      await run('open-calendar-panel', async () => { const target = page.frameLocator(ready).locator('.month .days').first(); await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(); await clickPage(page, box.x + box.width / 2, box.y + box.height / 2); await page.locator('.element-editor iframe').waitFor(); });
      await run('type-calendar-field', async () => { const editor = page.frameLocator('.element-editor iframe'); await editor.getByText('All marked days', { exact: true }).click(); const input = editor.getByRole('textbox').first(); await input.pressSequentially(', 01.01', { delay: 80 }); });
      await page.keyboard.press('Escape');
      await menuAction(app, 'Vertical'); await menuAction(app, 'Actual Size'); await settle();
    }
    await run('open-photo-crop', async () => {
      const target = page.frameLocator(ready).locator('[data-box-type="photo"]').first();
      await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox();
      await clickPage(page, box.x + box.width * .7, box.y + box.height * .7);
      await clickPage(page, box.x + box.width * .7, box.y + box.height * .7);
      await page.locator('.crop-toolbar').waitFor();
    });

    await page.close();
  }
} finally { await writeFile(join(out, 'recordings.json'), JSON.stringify(results, null, 2)); await app?.close(); console.log('Recordings: ' + out); }
