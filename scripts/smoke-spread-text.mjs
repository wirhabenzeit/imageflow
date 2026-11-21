import { closeApp, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// One Markdown box over several rectangles (`rects`): the text runs through the rectangles in order, and with
// `alignHeads` a head that opens the box leaves the same room at the top of every rectangle. The fixture sets its text
// on a baseline grid with a fractional line (21.4px), where a band that is off by a rounding error falls off the grid.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.build'), { recursive: true });
const work = await mkdtemp(join(root, '.build', 'spread-text-'));
const project = join(work, 'Spread.imageflow');
await mkdir(join(project, 'template'), { recursive: true });
await mkdir(join(project, 'texts'), { recursive: true });
await cp(join(root, 'tests/fixtures/field-notes/template/fonts'), join(project, 'template/fonts'), { recursive: true });
await cp(join(root, 'scripts/fixtures/spread-text/template.tsx'), join(project, 'template/index.tsx'));
await cp(join(root, 'scripts/fixtures/spread-text/styles.css'), join(project, 'template/styles.css'));

const sentences = [
  'We left the yurt before sunrise and followed the stream up into the cold light.',
  'The horses were already grazing above the water, one after another, unbothered by the wind.',
  'Bread, tea and a handful of dried apricots; nobody spoke until the ridge came into view.',
  'On the far side the valley opened and the lake lay flat and silver under a low sky.',
  'A herder waved from his saddle, shouted something we could not understand, and rode on.',
  'By noon the snow had softened and every step sank a little; we counted the passes aloud.',
  'Smoke rose from a stove somewhere below, thin and straight, the only vertical thing in the landscape.',
  'We pitched the tents behind a wall of stones and waited for the evening to settle.',
];
const paragraph = (n) => Array.from({ length: 7 }, (_, i) => sentences[(n * 3 + i) % sentences.length]).join(' ');
const day = (n, title, paragraphs, offset = 0) => '## ' + n + ' June · ' + title + '\n\n' +
  Array.from({ length: paragraphs }, (_, p) => paragraph(n * 5 + p + offset)).join('\n\n');
// A day that opens the box, spills into the second rectangle, and a second day that begins there.
const story = day(12, 'Over the pass', 4) + '\n\n' + day(13, 'Song-Kul', 1).split('. ').slice(0, 4).join('. ') + '.';
const wide = [day(12, 'Over the pass', 9), day(13, 'Song-Kul', 8, 2), day(14, 'The long descent', 7, 4)].join('\n\n');
const texts = { aligned: story, plain: story, wide, short: story, single: day(12, 'Over the pass', 2) };
for (const [id, text] of Object.entries(texts)) await writeFile(join(project, 'texts', id + '.md'), text + '\n');
await writeFile(join(project, 'photos.json'), '{}\n');
await writeFile(join(project, 'project.json'), JSON.stringify({
  schemaVersion: 1, title: 'Spread text', template: { id: 'spread-text', version: '0.1.0' }, params: {},
  texts: Object.fromEntries(Object.keys(texts).map((id) => [id, 'texts/' + id + '.md'])),
  spreads: [['aligned', 'band'], ['plain', 'bandPlain'], ['wide', 'run'], ['short', 'short'], ['single', 'single']].map(([id, definition]) =>
    ({ id, definition, params: {}, boxes: { body: { text: id } } })),
}, null, 2));

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project);
  w.setDefaultTimeout(60000);
  await w.waitForSelector('iframe.book-frame-book[data-current][data-ready]', { state: 'attached' });
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const shown = await frame.locator('body').evaluate(async () => {
    await document.fonts.ready;
    const spans = (element) => getComputedStyle(element).columnSpan === 'all';
    // How far below the top of the box its columns start, in the box's own CSS pixels: the bottom of the heads or the
    // spacer that open it, with their margins. The book may be zoomed, which scales rectangles but not computed lengths.
    const band = (box) => {
      const scale = box.getBoundingClientRect().width / box.offsetWidth;
      const top = box.getBoundingClientRect().top;
      let bottom = 0;
      for (const child of box.children) {
        if (!spans(child) || !/\S/.test(child.textContent) && child.dataset.levelSpacer === undefined) break;
        bottom = (child.getBoundingClientRect().bottom - top) / scale + parseFloat(getComputedStyle(child).marginBottom);
      }
      return bottom;
    };
    const sheet = (spread) => document.querySelector('[data-spread="' + spread + '"] .if-sheet');
    const rects = (spread) => [...sheet(spread).querySelectorAll('.if-markdown')].map((box) => {
      const line = parseFloat(getComputedStyle(box).lineHeight);
      return {
        id: box.dataset.box ?? box.dataset.boxRect, rect: Number(box.dataset.rect ?? 0), band: band(box), line,
        spacer: box.querySelector(':scope > [data-level-spacer]') !== null,
        opensWithHead: !!box.firstElementChild?.matches('.day-head'),
        heads: box.querySelectorAll('.day-head').length, midHeads: [...box.querySelectorAll('.day-head')].filter((head) => head !== box.firstElementChild).length,
        text: box.textContent.trim().length,
      };
    });
    const { errors, warnings } = window.imageflowRenderStatus;
    const finding = ({ code, spread, box }) => ({ code, spread, box });
    return {
      spreads: Object.fromEntries(['aligned', 'plain', 'wide', 'short', 'single'].map((spread) => [spread, rects(spread)])),
      extra: Object.fromEntries(['aligned', 'plain', 'wide', 'short', 'single'].map((spread) => [spread, sheet(spread).querySelectorAll('[data-box-rect]').length])),
      errors: errors.map(finding), warnings: warnings.map(finding),
    };
  });

  const [first, second] = shown.spreads.aligned;
  // alignHeads: the head that opens the first rectangle leaves the same room at the top of the second, down to a rounding error.
  assert.equal(shown.spreads.aligned.length, 2, 'The box is drawn over two rectangles');
  assert.deepEqual(shown.spreads.aligned.map(({ id, rect }) => [id, rect]), [['body', 0], ['body', 1]]);
  assert.ok(first.opensWithHead && first.band > 0, 'The text opens with a head');
  assert.ok(Math.abs(first.band - second.band) < 0.05, 'The second rectangle starts level with the first: ' + first.band + ' vs ' + second.band);
  assert.ok(second.spacer && !second.opensWithHead, 'The second rectangle holds the room as a spacer');
  assert.ok(second.text > 0 && second.midHeads === 1, 'The text continues, and the next day begins in the second rectangle');
  for (const { band, line } of shown.spreads.aligned) {
    const lines = band / line;
    assert.ok(Math.abs(lines - Math.round(lines)) < 0.01, 'The band is a whole number of lines: ' + lines);
  }

  // Without alignHeads each rectangle flows on its own: the second starts at its own top.
  const [plain, plainSecond] = shown.spreads.plain;
  assert.ok(plain.band > 0 && plainSecond.band === 0 && !plainSecond.spacer, 'Without alignHeads the second rectangle keeps its own top');

  // Running text over both pages: heads fall where the text puts them and move nothing else.
  const [run, runSecond] = shown.spreads.wide;
  assert.ok(run.opensWithHead && runSecond.band === 0 && !runSecond.spacer, 'Running text is not aligned');
  assert.ok(run.midHeads + runSecond.midHeads >= 2 && runSecond.text > 0, 'Heads fall in both rectangles');

  // A single rectangle draws no further rectangles.
  assert.deepEqual(shown.extra, { aligned: 1, plain: 1, wide: 1, short: 1, single: 0 });
  assert.equal(shown.spreads.single.length, 1);

  // A rectangle shorter than the room has nothing left to hold text: the flow reports overflow.
  assert.deepEqual(shown.errors.map(({ code, spread }) => [code, spread]), [['text-overflow', 'short']]);
  assert.deepEqual(shown.warnings.map(({ code, spread }) => [code, spread]), []);
  console.log('smoke-spread-text ok');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
