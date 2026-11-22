import { bookShows, canvasArtworkBounds, closeApp, testBook, undoBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// Dragging a story box onto another story box swaps their texts in one Undo step, as photos swap (UI-002); dropping
// it on an empty story box moves the text there.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.build'), { recursive: true });
const work = await mkdtemp(join(root, '.build', 'text-swap-'));
const project = join(work, 'Swap.imageflow');
await mkdir(join(project, 'template'), { recursive: true });
await mkdir(join(project, 'texts'), { recursive: true });
await writeFile(join(project, 'template/index.tsx'), `import { box, defineTemplate, mm, printFormat, Spread } from 'imageflow';

export default defineTemplate({
  id: 'text-swap', version: '0.1.0', label: 'Text swap', contract: 1,
  format: printFormat({ label: 'A4', trim: { width: mm(210), height: mm(297) }, bleed: { all: mm(3), binding: mm(0) },
    safe: { all: mm(12), binding: mm(15) }, ends: 'inside-covers', pageCount: { min: 2, max: 40, step: 2 } }),
  parameters: {},
  spreads: ({ spread }) => ({
    three: spread({
      label: 'Three stories',
      boxes: { left: box.markdown('Left', { flowOrder: 1 }), right: box.markdown('Right', { flowOrder: 2 }), empty: box.markdown('Empty', { flowOrder: 3 }) },
      render: (ctx) => {
        const page = ctx.geometry.page('right', 'safe');
        const half = page.height / 2;
        return <Spread>
          <ctx.MarkdownBox id="left" rect={ctx.geometry.page('left', 'safe')} />
          <ctx.MarkdownBox id="right" rect={{ x: page.x, y: page.y, width: page.width, height: half - 10 }} />
          <ctx.MarkdownBox id="empty" rect={{ x: page.x, y: page.y + half, width: page.width, height: half }} />
        </Spread>;
      },
    }),
  }),
});
`);
await writeFile(join(project, 'texts/alpha.md'), 'Alpha story about the pass.\n');
await writeFile(join(project, 'texts/beta.md'), 'Beta story about the lake.\n');
await writeFile(join(project, 'photos.json'), '{}\n');
await writeFile(join(project, 'project.json'), JSON.stringify({
  schemaVersion: 1, title: 'Text swap', template: { id: 'text-swap', version: '0.1.0' }, params: {},
  texts: { alpha: 'texts/alpha.md', beta: 'texts/beta.md' },
  spreads: [{ id: 'sheet', definition: 'three', params: {}, boxes: { left: { text: 'alpha' }, right: { text: 'beta' } } }],
}, null, 2));
const read = async () => JSON.parse(await readFile(join(project, 'project.json'), 'utf8')).spreads[0].boxes;
const texts = (boxes) => Object.fromEntries(Object.entries(boxes).flatMap(([id, box]) => box.text ? [[id, box.text]] : []));

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project);
  w.setDefaultTimeout(60000);
  await w.waitForSelector('iframe.book-frame-book[data-current][data-ready]', { state: 'attached' });
  const drag = async (from, to) => {
    const a = await canvasArtworkBounds(w, '[data-spread="sheet"] [data-box="' + from + '"]');
    const b = await canvasArtworkBounds(w, '[data-spread="sheet"] [data-box="' + to + '"]');
    const since = Date.now();
    await w.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await w.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await w.mouse.move(a.x + a.width / 2 + (b.x + b.width / 2 - a.x - a.width / 2) * i / 10, a.y + a.height / 2 + (b.y + b.height / 2 - a.y - a.height / 2) * i / 10);
    }
    await w.waitForSelector('.text-move-ghost');
    await w.mouse.up();
    for (let i = 0; i < 100; i++) {
      if (JSON.stringify(texts(await read())) !== JSON.stringify(before)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await bookShows(w, { since });
  };

  let before = texts(await read());
  await drag('left', 'right');
  assert.deepEqual(texts(await read()), { left: 'beta', right: 'alpha' }, 'The two texts swapped');
  assert.equal(await w.locator('.text-move-ghost').count(), 0);

  before = texts(await read());
  await drag('right', 'empty');
  const moved = texts(await read());
  assert.equal(moved.empty, 'alpha', 'Dropped on an empty box, the text moved there');
  assert.equal(moved.right, undefined, 'and left its box empty');
  assert.equal(moved.left, 'beta');

  // Each drag is one Undo step.
  await undoBook(w);
  assert.deepEqual(texts(await read()), { left: 'beta', right: 'alpha' });
  await undoBook(w);
  assert.deepEqual(texts(await read()), { left: 'alpha', right: 'beta' });
  console.log('Text swap smoke passed');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
