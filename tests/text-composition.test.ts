import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeHtml, markdownBlocks, markdownToHtml } from '../src/markdown';
import { mm, printFormat } from '../src/format';
import { p } from '../src/parameters';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { box, chooseFormat, normalizeTemplate, Spread, templateInfo, templateSchema, textComposition } from '../src/template';
import type { TextComposition } from '../src/template';
import { textAssignments } from '../src/text-assignments';

const source = '---\ntitle: Song-Kul\n---\n\nWe left *early*.\n\n## 12 June · Lake **Song-Kul**\n\n- one\n- two\n\n> Quoted.\n\n---\n\n```\ncode\n```\n';

test('a text splits into its top-level blocks', () => {
  const blocks = markdownBlocks(source);
  assert.deepEqual(blocks.map(({ type, depth, ordered, text }) => ({ type, depth, ordered, text })), [
    { type: 'paragraph', depth: undefined, ordered: undefined, text: 'We left early.' },
    { type: 'heading', depth: 2, ordered: undefined, text: '12 June · Lake Song-Kul' },
    { type: 'list', depth: undefined, ordered: false, text: 'one\ntwo' },
    { type: 'blockquote', depth: undefined, ordered: undefined, text: 'Quoted.' },
    { type: 'rule', depth: undefined, ordered: undefined, text: '' },
  ]);
  // The blocks are the text: joined, they are what an uncomposed box flows.
  assert.equal(blocks.map(({ html }) => html).join(''), markdownToHtml(source));
  assert.match(blocks[1].html, /^<h2 data-s="\d+" data-e="\d+">12 June · Lake <strong [^>]+>Song-Kul<\/strong><\/h2>$/);
  assert.match(blocks[1].content, /^12 June · Lake <strong [^>]+>Song-Kul<\/strong>$/);
  assert.equal(blocks[1].start, source.indexOf('## 12'));
});

// What the renderer does with a composition, without the page: placeholders rendered by React, then replaced.
function compose(render: (blocks: { type: string; text: string; node: unknown; content: unknown }[]) => unknown) {
  const blocks = markdownBlocks(source);
  const staged = renderToStaticMarkup(createElement(Fragment, null, render(blocks.map(({ type, text }, i) => ({
    type, text,
    node: createElement('if-block', { key: i, 'data-i': i }),
    content: createElement('if-block', { key: i + ':content', 'data-i': i, 'data-part': 'content' }),
  }))) as never));
  return { html: composeHtml(staged, blocks), blocks };
}

test('a composition that returns every block is the plain text', () => {
  assert.equal(compose((blocks) => blocks.map(({ node }) => node)).html, markdownToHtml(source));
});

test('a composition adds, replaces and wraps blocks', () => {
  const { html, blocks } = compose((all) => [
    createElement('p', { key: 'lead', className: 'date', 'data-keep-next': '' }, '12 June'),
    ...all.map((block, i) => block.type === 'heading'
      ? createElement('div', { key: i, className: 'day-head', 'data-keep-next': '' }, createElement('h3', null, block.content as never))
      : block.node),
    createElement('p', { key: 'trail', className: 'end' }, '❦'),
  ]);
  assert.ok(html.startsWith('<p class="date" data-keep-next="">12 June</p>' + blocks[0].html));
  assert.ok(html.includes('<div class="day-head" data-keep-next=""><h3>' + blocks[1].content + '</h3></div>' + blocks[2].html));
  assert.ok(html.endsWith(blocks[4].html + '<p class="end">❦</p>'));
  assert.ok(!html.includes('if-block'));
});

test('text a template writes is never read as a placeholder', () => {
  const { html } = compose(() => createElement('p', null, '<if-block data-i="0"></if-block>'));
  assert.equal(html, '<p>&lt;if-block data-i=&quot;0&quot;&gt;&lt;/if-block&gt;</p>');
});

const format = printFormat({ label: 'Book', trim: { width: mm(200), height: mm(240) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(10), binding: mm(18) },
  pageCount: { min: 2, max: 100, step: 2 }, ends: 'inside-covers' });
const declaration = (boxes: Record<string, unknown>, compositions: Record<string, unknown> = {
  story: ({ blocks, meta, document }: TextComposition) => [
    createElement('h3', { key: 'title' }, String(meta.title) + ' in ' + String(document.language)),
    ...blocks.map((block) => block.node),
  ],
}) => normalizeTemplate({ id: 'composed', version: '1', contract: 1, format, compositions,
  parameters: { language: p.string({ label: 'Language', default: 'en' }) },
  spreads: ({ spread }: { spread: <T>(x: T) => T }) => ({
    opener: spread({ label: 'Opener', boxes, render: () => createElement(Spread) }),
    plain: spread({ label: 'Plain', boxes: { body: box.markdown('Story') }, render: () => createElement(Spread) }),
  }) });
const template = chooseFormat(templateSchema.parse(declaration({ body: box.markdown('Story', { composition: 'story' }) })));
const book: RenderProject = {
  project: projectSchema.parse({ schemaVersion: 2, title: 'Composed', template: { id: 'composed', version: '1' }, texts: { story: 'texts/story.md' },
    spreads: ['opener', 'plain'].map((definition) => ({ id: definition, definition, params: {}, boxes: { body: { text: 'story', params: {} } }, elements: {} })) }),
  mode: 'export', problems: [], template: { script: '', assets: {} }, photos: {}, texts: { story: source }, files: {},
};

test('a box names a declared composition, and only a Markdown box does', () => {
  assert.throws(() => templateSchema.parse(declaration({ body: box.markdown('Story', { composition: 'missing' }) })),
    /Box body names composition missing, which the template's compositions do not declare/);
  assert.throws(() => templateSchema.parse(declaration({ hero: { ...box.photo('Photo'), composition: 'story' } })), /Only Markdown boxes name a composition/);
  assert.throws(() => templateSchema.parse(declaration({ body: box.markdown('Story') }, { story: 'not a function' })), /Expected a composition function/);
  // The editor's plain declarations keep the name and leave the functions in the render frame.
  const info = templateInfo(template);
  assert.equal(info.spreads.opener.boxes.body.composition, 'story');
  assert.ok(!('compositions' in info));
});

test('a chain carries each box\'s composition, for the first to decide and the check to compare', () => {
  const chain = textAssignments(book, template).chains.get('story')!;
  assert.deepEqual(chain.map(({ spread, composition }) => [spread, composition]), [['opener', 'story'], ['plain', undefined]]);
});

test('a composition reads the text and the document, and its result is the flow\'s HTML', () => {
  const { element, blocks } = textComposition(template, book, 'story', source, 'opener');
  const html = composeHtml(renderToStaticMarkup(element), blocks);
  assert.equal(html, '<h3>Song-Kul in en</h3>' + markdownToHtml(source));
  assert.throws(() => textComposition(template, book, 'missing', source, 'opener'), /declares no composition missing/);
});
