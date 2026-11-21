import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeHtml, markdownBlocks, markdownToHtml } from '../src/markdown';

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

// What MarkdownBox does with a render callback, without the page: placeholders rendered by React, then replaced.
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
