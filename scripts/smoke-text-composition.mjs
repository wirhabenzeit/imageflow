import { closeApp, testBook } from './ui-actions.mjs';
import assert from 'node:assert/strict';
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
  },
  spreads: {
`);
const storyBox = "story: { type: 'markdown', label: 'Story', flowOrder: 1 },";
template = replace(template, storyBox, "story: { type: 'markdown', label: 'Story', flowOrder: 1, composition: 'story' },");
// The same layout twice more: one whose box names no composition, one whose composition throws.
const layout = template.slice(template.indexOf('    story: {\n      label'), template.lastIndexOf('  },\n});'));
const variant = (id, composition) => layout.replace('    story: {', '    ' + id + ': {').replace(", composition: 'story'", composition ? ", composition: '" + composition + "'" : '');
template = replace(template, layout, layout + variant('plain', '') + variant('broken', 'broken'));
await writeFile(templateFile, template);

const paragraph = (n) => 'Paragraph ' + n + ' follows the shore and counts the horses grazing above the water, one after another.';
await writeFile(join(project, 'texts/arrival.md'), '---\ntitle: Song-Kul\ndate: 12 June\n---\n\n' +
  [1, 2, 3, 4].map(paragraph).concat('## 13 June · The *pass*', paragraph(5)).join('\n\n') + '\n');
await writeFile(join(project, 'texts/note.md'), 'A short note that its composition cannot shape.\n');
const file = join(project, 'project.json');
const book = JSON.parse(await readFile(file, 'utf8'));
book.texts.note = 'texts/note.md';
const spread = (id, definition, text) => ({ id, definition, params: { eyebrow: '', heading: '' }, boxes: { story: { text } } });
book.spreads = [spread('opens', 'story', 'arrival'), spread('continues', 'plain', 'arrival'), spread('fails', 'broken', 'note')];
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
  // The continuing box names no composition: the text keeps the first box's, and the check says so.
  const mixed = shown.findings.filter(({ code }) => code === 'text-composition-mixed');
  assert.equal(mixed.length, 1);
  assert.deepEqual([mixed[0].spread, mixed[0].box, mixed[0].details.composition, mixed[0].details.boxComposition], ['continues', 'story', 'story', '']);
  // A composition that throws is reported, and its text flows as plain Markdown.
  const failed = shown.findings.filter(({ code }) => code === 'text-composition-failed');
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].spread, failed[0].details.composition], ['fails', 'broken']);
  assert.match(shown.fails, /^<p data-s="0" data-e="\d+">A short note that its composition cannot shape\.<\/p>$/);
  assert.deepEqual(shown.findings.filter(({ code }) => code === 'text-overflow'), [], 'The composed text fits its two boxes');
  console.log('ImageFlow text composition passed.');
} finally {
  await closeApp(app);
  await rm(work, { recursive: true, force: true });
}
