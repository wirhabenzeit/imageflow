import { closeApp, exportAction, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { _electron } from 'playwright-core';

// Text compositions (#230): a template shapes a text from its blocks, and the result flows through the book like
// Markdown. One book covers a composed chain, a chain whose boxes disagree and a composition that throws.
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(root, '.build', 'text-composition-'));
const project = join(work, 'Composed.imageflow');
await cp(join(root, 'tests/fixtures/field-notes'), project, { recursive: true, filter: (path) => !path.includes('/.imageflow') });

const templateFile = join(project, 'template/index.tsx');
const replace = (text, from, to) => { assert.ok(text.includes(from), 'The fixture template has ' + from); return text.replace(from, to); };
let template = await readFile(templateFile, 'utf8');
template = replace(template, "  spreads: {\n", `  compositions: {
    story: ({ blocks, meta, document }) => <>
      <p className="story-date" data-keep-next>{String(meta.date)}</p>
      <h3 className="story-title">{String(meta.title)}{document.showCaption ? '' : ' (no captions)'}</h3>
      {blocks.map((block) => block.type === 'heading' && block.depth === 2
        ? <div key={block.key} className="day-head" data-keep-next>
            <span className="day">{block.text.split(' · ')[0]}</span>
            <h3>{block.text.split(' · ')[1]}</h3>
          </div>
        : block.node)}
      <p className="end-mark">The end</p>
    </>,
    broken: () => { throw new Error('no such field'); },
    impure: ({ blocks }) => { setTimeout(() => {}, 0); return blocks.map((block) => block.node); },
  },
  spreads: {
`);
const storyBox = "story: { type: 'markdown', label: 'Story', flowOrder: 1 },";
template = replace(template, storyBox, "story: { type: 'markdown', label: 'Story', flowOrder: 1, composition: 'story' },");
// The same layout thrice more: no composition, a throwing composition, and an impure composition.
const layout = template.slice(template.indexOf('    story: {\n      label'), template.lastIndexOf('  },\n});'));
const variant = (id, composition) => layout.replace('    story: {', '    ' + id + ': {').replace(", composition: 'story'", composition ? ", composition: '" + composition + "'" : '');
template = replace(template, layout, layout + variant('plain', '') + variant('broken', 'broken') + variant('impure', 'impure'));
await writeFile(templateFile, template);

const paragraph = (n) => 'Paragraph ' + n + ' follows the shore and counts the horses grazing above the water, one after another.';
await writeFile(join(project, 'texts/arrival.md'), '---\ntitle: Song-Kul\ndate: 12 June\n---\n\n' +
  [1, 2, 3, 4].map(paragraph).concat('## 13 June · The *pass*', paragraph(5)).join('\n\n') + '\n');
await writeFile(join(project, 'texts/note.md'), 'A short note that its composition cannot shape.\n');
await writeFile(join(project, 'texts/impure.md'), 'A note composed with a timer.\n');
const file = join(project, 'project.json');
const book = JSON.parse(await readFile(file, 'utf8'));
book.texts.note = 'texts/note.md';
book.texts.impure = 'texts/impure.md';
const spread = (id, definition, text) => ({ id, definition, params: { eyebrow: '', heading: '' }, boxes: { story: { text } } });
book.spreads = [spread('opens', 'story', 'arrival'), spread('continues', 'plain', 'arrival'), spread('trailing', 'plain', 'arrival'), spread('fails', 'broken', 'note'), spread('impure', 'impure', 'impure')];
await writeFile(file, JSON.stringify(book, null, 2) + '\n');

const app = await _electron.launch({ executablePath: electron, args: [join(root, '.build/desktop'), '--user-data-dir=' + join(work, 'profile')],
  env: { ...process.env, IMAGEFLOW_HIDE_WINDOW: '1' } });
try {
  const w = await testBook(app, project);
  w.setDefaultTimeout(30000);
  await w.waitForSelector('iframe.book-frame-book[data-current][data-ready]', { state: 'attached' });
  const frame = w.frameLocator('iframe.book-frame-book[data-current]');
  const shown = await frame.locator('body').evaluate(() => {
    const box = (spread) => document.querySelector('[data-spread="' + spread + '"] [data-box="story"]');
    const shape = (spread) => [...box(spread).children].map((child) => child.tagName.toLowerCase() + (child.className ? '.' + [...child.classList].join('.') : ''));
    const { errors, warnings } = window.imageflowRenderStatus;
    const finding = ({ code, spread, box, details }) => ({ code, spread, box, details });
    return {
      opens: shape('opens'), continues: shape('continues'), fails: box('fails').innerHTML,
      title: box('opens').querySelector('.story-title').textContent,
      head: document.querySelector('.day-head')?.innerHTML.replace(/ data-s="c\d+"/g, ''),
      dates: document.querySelectorAll('.story-title').length, ends: document.querySelectorAll('.end-mark:not(.cont)').length,
      placeholders: document.querySelectorAll('if-block').length,
      findings: [...errors, ...warnings].filter(({ code }) => /^text-/.test(code)).map(finding),
    };
  });
  // The composition's own elements open the text, in the box it starts in and nowhere else; its end mark closes it.
  assert.deepEqual(shown.opens.slice(0, 3), ['p.story-date', 'h3.story-title', 'p'], 'The first box starts with the date and the title');
  assert.equal(shown.title, 'Song-Kul', 'The title comes from the header, and the document settings are read');
  assert.equal(shown.dates, 1, 'The title appears once in the book');
  assert.ok(shown.continues.length > 1 && !shown.continues.some((child) => /story-(date|title)/.test(child)), 'The text continues in the next box without its lead');
  assert.equal(shown.continues.at(-1), 'p.end-mark', 'The end mark closes the text');
  assert.equal(shown.ends, 1);
  // A replaced heading is the template's element, built from the heading's words.
  assert.equal(shown.head, '<span class="day">13 June</span><h3>The pass</h3>');
  assert.equal(shown.placeholders, 0, 'No placeholder reaches the page');
  // Every continuing box that names another composition (or none) is warned on; the text keeps the first box's.
  const mixed = shown.findings.filter(({ code }) => code === 'text-composition-mixed');
  assert.deepEqual(mixed.map(({ spread, box, details }) => [spread, box, details.composition, details.boxComposition]), [
    ['continues', 'story', 'story', ''],
    ['trailing', 'story', 'story', ''],
  ]);
  // A composition that throws is reported, and its text flows as plain Markdown.
  const failed = shown.findings.filter(({ code }) => code === 'text-composition-failed');
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].spread, failed[0].details.composition], ['fails', 'broken']);
  assert.match(shown.fails, /^<p data-s="0" data-e="\d+">A short note that its composition cannot shape\.<\/p>$/);
  assert.deepEqual(shown.findings.filter(({ code }) => code === 'text-overflow'), [], 'The composed text fits its two boxes');

  // Book check runs with purity guards installed: an impure call inside a composition is reported on its spread.
  const checked = await w.evaluate(async () => window.imageflow.checkBook((await window.imageflow.currentProject()).value.id, {}));
  assert.ok(checked.value, JSON.stringify(checked.error));
  const impureErrors = checked.value.diagnostics.filter(({ code }) => code === 'render-impure');
  assert.deepEqual(impureErrors.map(({ location, details }) => [location?.spread, details?.api]), [['impure', 'setTimeout']],
    'Impure calls inside a composition are reported by Book check');

  // Layout previews start each layout's text themselves: each shows the composition its own box names, and a
  // composition that throws leaves the preview its plain text.
  // The book's first sheet is a single page, which has no spread layouts to offer; the second spread has all three.
  await w.locator('.spread-thumb[data-spread="continues"]').click();
  await w.waitForFunction(() => {
    const frame = document.querySelector('iframe.book-frame-layouts[data-current][data-ready]:not([aria-hidden])');
    return frame && new URL(frame.src).searchParams.get('spread') === 'continues';
  });
  const previews = await w.frameLocator('iframe.book-frame-layouts[data-current]').locator('body').evaluate(() =>
    Object.fromEntries(['story', 'plain', 'broken'].map((layout) => {
      const box = document.querySelector('[data-spread="' + layout + '"] [data-box="story"]');
      return [layout, { first: box.firstElementChild?.className ?? '', composed: !!box.querySelector('.story-title'), text: /\S/.test(box.textContent) }];
    })));
  assert.deepEqual(previews.story, { first: 'story-date', composed: true, text: true }, 'The preview of a composing layout shows the composition');
  assert.deepEqual(previews.plain, { first: '', composed: false, text: true }, 'The preview of a plain layout shows plain Markdown');
  assert.deepEqual(previews.broken, { first: '', composed: false, text: true }, 'A failing composition leaves its preview the plain text');

  // The exported PDF carries the composed text: what the composition added is on the pages where the text starts,
  // where its heading falls and where it ends.
  const output = join(work, 'composed.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    // The book is too short to print and has a deliberate error; export it as a proof.
    dialog.showMessageBox = async () => ({ response: 1 });
  }, output);
  await exportAction(w);
  await w.waitForFunction(() => document.querySelector('.status-error') || document.querySelector('.status')?.textContent?.startsWith('PDF saved'), null, { timeout: 45000 });
  assert.match(await w.locator('.status').textContent(), /^PDF saved\./);
  const pageText = (page) => {
    try { return execFileSync('pdftotext', ['-f', String(page), '-l', String(page), '-layout', output, '-']).toString(); } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Install Poppler to run the text composition PDF checks.');
      throw error;
    }
  };
  // One PDF page per trimmed page: each spread's story box is on its right page (`trailing` is spread 3, `fails` is 4).
  const [opens, continues, fails] = [2, 4, 8].map(pageText);
  assert.match(opens, /12 June\s+Song-Kul\s+Paragraph 1 /, 'The PDF opens the text with the date and the title');
  assert.ok(!/Song-Kul|12 June/.test(continues), 'The PDF does not repeat the lead');
  assert.match(continues, /13 June\s+The pass\s+Paragraph 5 [\s\S]*The end\s*$/, 'The PDF has the replaced heading and the end mark');
  assert.match(fails, /A short note that its composition cannot shape\./);
  console.log('ImageFlow text composition passed.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
