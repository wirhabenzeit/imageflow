// Frame reuse (#210): after each edit, the book view and thumbnails that rendered it in place must match a fresh frame
// of the same revision.
//
//   npm run build && node scripts/stage-desktop.mjs && node scripts/check-warm-frames.mjs [--book path]
//
// Settings → Faster book updates is on by default, which reuses the frames.
//
// Without --book it edits a copy of the starter. Each step is an app command or an external edit of project.json,
// which the editor takes as a new revision. A fresh frame for the revision is loaded beside the reused one, at the same
// width, and their spreads are compared: markup and text with session URLs, loaded photo sources and drawn pictures
// left out, the order of spreads and the sheets' positions. Also checks that the frames were reused, not replaced.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import electron from 'electron';
import { _electron } from 'playwright-core';
import { testBook, menuAction } from './ui-actions.mjs';

const { values } = parseArgs({ options: { book: { type: 'string' } } });
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(values.book ? dirname(values.book) : (process.env.TMPDIR ?? '/tmp'), '.warm-check-'));
const project = join(work, values.book ? basename(values.book) : 'Warm.imageflow');
if (values.book) await cp(values.book, project, { recursive: true });

// What a frame shows, without what differs between two frames of one revision.
function snapshot() {
  const normalize = (html) => html.replace(/imageflow:\/\/(render|thumbs)\/render\/[\w-]{36}\//g, 'R/').replace(/blob:[^"' )]+/g, 'BLOB');
  const spreads = {};
  for (const container of document.querySelectorAll('.if-spread-container')) {
    const clone = container.cloneNode(true);
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of ['src', 'style', 'data-loaded', 'data-fitted', 'data-rendered', 'data-ppi', 'data-near', 'data-pending', 'data-vector', 'title']) {
        if (name === 'style' && !node.matches('.if-spread-container, .if-sheet, .if-rendered-image *')) continue;
        node.removeAttribute(name);
      }
    }
    for (const picture of clone.querySelectorAll('.if-rendered-image')) picture.replaceChildren();
    // A photo box with a render callback draws its photo only near the viewport, which differs between the frames.
    for (const box of clone.querySelectorAll('[data-photo-render="custom"]')) box.replaceChildren();
    // Attributes in a fixed order: React appends one it adds later, which a new frame renders in place.
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      const attributes = [...node.attributes].map(({ name, value }) => [name, value]).sort(([a], [b]) => a < b ? -1 : 1);
      for (const [name] of attributes) node.removeAttribute(name);
      for (const [name, value] of attributes) node.setAttribute(name, value);
    }
    spreads[container.dataset.spread] = normalize(clone.outerHTML);
  }
  const sheets = [...document.querySelectorAll('.if-sheet')].map((sheet) => {
    const { x, y, width, height } = sheet.getBoundingClientRect();
    return [x, y + scrollY, width, height].map(Math.round).join(',');
  });
  return { order: [...document.querySelectorAll('.if-spread-container')].map((container) => container.dataset.spread), spreads, sheets };
}

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
let failures = 0;
try {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); });
  const w = await testBook(app, project, !values.book);
  w.on('console', (message) => { if (message.text().startsWith('imageflow.warm')) console.log('  ' + message.text().slice(0, 300)); });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.setContentSize(1400, 900)));
  const views = ['book', 'thumbs'];
  const current = () => w.evaluate((views) => Object.fromEntries(views.map((view) => {
    const frame = document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]');
    return [view, frame && { src: frame.getAttribute('src'), revision: frame.dataset.revision, width: frame.clientWidth, height: frame.clientHeight }];
  })), views);
  await w.waitForFunction((views) => views.every((view) => document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]')), views);
  await w.waitForTimeout(1500);
  const first = await current();

  // Waits until both views show a revision other than `before`, then compares each with a fresh frame of it.
  async function compare(step, before) {
    await w.waitForFunction(({ views, before }) => views.every((view) => {
      const frame = document.querySelector('iframe.book-frame-' + view + '[data-current][data-ready]');
      return frame && frame.dataset.revision !== before[view].revision;
    }), { views, before }, { timeout: 60000 });
    await w.waitForTimeout(800);
    const now = await current();
    for (const view of views) {
      const reused = w.frames().find((frame) => frame.url().includes('view=' + view) && frame.url().includes(now[view].revision));
      const url = now[view].src.replace(/\/render\/[\w-]{36}/, '/render/' + now[view].revision);
      // A fresh frame of the same revision, as wide as the shown one, outside the editor's own frames.
      await w.evaluate(({ url, width, height, view }) => {
        document.querySelector('#warm-reference')?.remove();
        const frame = document.createElement('iframe');
        frame.id = 'warm-reference'; frame.src = url; frame.dataset.view = view;
        // Taller than the shown frame, which is as tall as its content, so no scroll bar narrows the layout.
        frame.style.cssText = 'position:fixed;left:0;top:0;border:0;width:' + width + 'px;height:' + (height + 100) + 'px;opacity:0;pointer-events:none';
        document.body.append(frame);
      }, { url, width: now[view].width, height: now[view].height, view });
      let fresh;
      for (let i = 0; i < 200 && !fresh; i++) {
        fresh = w.frames().find((frame) => frame !== reused && frame.url().startsWith(url.split('?')[0]) && frame.url().includes('view=' + view) &&
          frame.parentFrame() === w.mainFrame());
        if (!fresh) await w.waitForTimeout(50);
      }
      await fresh.waitForFunction(() => document.querySelector('.if-book') &&
        [...document.querySelectorAll('.if-spread-container')].every((container) => container.hasAttribute('data-fitted')), null, { timeout: 60000 });
      await fresh.waitForTimeout(500);
      const [a, b] = await Promise.all([(reused ?? w.frames().find((frame) => frame.url().includes('view=' + view) && frame !== fresh)).evaluate(snapshot), fresh.evaluate(snapshot)]);
      const problems = [];
      if (JSON.stringify(a.order) !== JSON.stringify(b.order)) problems.push('spread order differs');
      const moved = a.sheets.findIndex((sheet, i) => sheet !== b.sheets[i]);
      if (moved >= 0 || a.sheets.length !== b.sheets.length) problems.push('sheet ' + moved + ' is at ' + a.sheets[moved] + ', fresh at ' + b.sheets[moved] + ' (x,y,width,height)');
      for (const id of b.order) if (a.spreads[id] !== b.spreads[id]) {
        const left = a.spreads[id] ?? '', right = b.spreads[id] ?? '';
        let at = 0; while (at < left.length && left[at] === right[at]) at++;
        problems.push('spread ' + id + ' differs at ' + at + ':\n    reused: ' + left.slice(Math.max(0, at - 80), at + 120) + '\n    fresh:  ' + right.slice(Math.max(0, at - 80), at + 120));
      }
      console.log((problems.length ? '✖ ' : '✓ ') + step + ' · ' + view + (problems.length ? '\n  ' + problems.join('\n  ') : ''));
      failures += problems.length ? 1 : 0;
      await w.evaluate(() => document.querySelector('#warm-reference')?.remove());
    }
  }
  const edit = async (step, change) => {
    const before = await current();
    const file = join(project, 'project.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    change(data);
    await writeFile(file, JSON.stringify(data, null, 2) + '\n');
    await compare(step, before);
  };
  const command = async (step, run) => { const before = await current(); await run(); await compare(step, before); };

  const data = JSON.parse(await readFile(join(project, 'project.json'), 'utf8'));
  const ids = data.spreads.map((spread) => spread.id);
  await command('Add Spread', () => menuAction(app, 'Add Spread'));
  await command('Add Spread again', () => menuAction(app, 'Add Spread'));
  await command('Undo', () => w.getByRole('button', { name: 'Undo', exact: true }).click());
  await edit('Move the third spread to the end', (p) => p.spreads.push(...p.spreads.splice(2, 1)));
  await edit('Delete the fourth spread', (p) => p.spreads.splice(3, 1));
  await edit('Change a heading', (p) => {
    const spread = p.spreads.find((spread) => spread.params && Object.values(spread.params).some((value) => typeof value === 'string')) ??
      p.spreads.find((spread) => spread.pages?.right?.params);
    const params = spread.pages?.right?.params ?? spread.params;
    const key = Object.keys(params).find((key) => typeof params[key] === 'string') ?? 'heading';
    params[key] = 'Changed in place';
  });
  await edit('Swap the first two spreads after the opening', (p) => { [p.spreads[1], p.spreads[2]] = [p.spreads[2], p.spreads[1]]; });
  await edit('Remove a text from its box', (p) => {
    for (const spread of p.spreads) for (const state of [spread, spread.pages?.left, spread.pages?.right].filter(Boolean)) {
      const entry = Object.entries(state.boxes ?? {}).find(([, box]) => box.text);
      if (entry) { console.log('  removes text ' + entry[1].text + ' from ' + spread.id + (state === spread ? '' : state === spread.pages?.left ? ' (left)' : ' (right)') + ' box ' + entry[0]); delete entry[1].text; return; }
    }
  });
  await edit('Restore the original order', (p) => {
    const byId = new Map(p.spreads.map((spread) => [spread.id, spread]));
    p.spreads = [...ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), ...p.spreads.filter((spread) => !ids.includes(spread.id))];
  });
  const last = await current();
  for (const view of views) assert.equal(last[view].src, first[view].src, view + ': the frame was reused, not replaced');
  console.log(failures ? failures + ' comparisons differ.' : 'Every reused frame matched a fresh one; the frames were reused throughout.');
} finally {
  await app.close();
  await rm(work, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
