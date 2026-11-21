import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mm, pageSequence, printFormat, resolveFormat } from '../src/format';
import { layoutFootprint } from '../src/layouts';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { bookIndex, chooseFormat, normalizeTemplate, Spread, SpreadView, templateSchema } from '../src/template';
import type { RenderContext } from '../src/template';
import { textAssignments } from '../src/text-assignments';

// One Markdown box over several rectangles (`rects`): the markup it draws. How the text flows through them is covered by
// scripts/smoke-spread-text.mjs, which needs a browser.
const format = printFormat({ label: 'Book', trim: { width: mm(200), height: mm(240) },
  bleed: { all: mm(3), binding: mm(0) }, safe: { all: mm(10), binding: mm(18) },
  pageCount: { min: 2, max: 100, step: 2 }, ends: 'inside-covers' });
const left = { x: 10, y: 150, width: 180, height: 80 };
const right = { x: 218, y: 150, width: 180, height: 80 };

const markup = (props: Record<string, unknown>) => {
  const template = chooseFormat(templateSchema.parse(normalizeTemplate({ id: 'rects', version: '1', contract: 1, format,
    spreads: ({ spread }: { spread: <T>(x: T) => T }) => ({
      story: spread({ label: 'Story', boxes: { body: { type: 'markdown', label: 'Story' } },
        render: (ctx: RenderContext) => createElement(Spread, null, createElement(ctx.MarkdownBox, { id: 'body', columns: 2, className: 'body', ...props })) }),
    }) })));
  const input: RenderProject = {
    project: projectSchema.parse({ schemaVersion: 2, title: 'Rects', template: { id: 'rects', version: '1' }, texts: { story: 'texts/story.md' },
      spreads: [{ id: 's', definition: 'story', params: {}, boxes: { body: { text: 'story' } }, elements: {} }] }),
    mode: 'edit', problems: [], template: { script: '', assets: {} }, photos: {}, texts: { story: 'Story' }, files: {},
  };
  const sequence = pageSequence(input.project.spreads.map((spread) => layoutFootprint(spread, template.spreads)), format);
  return renderToStaticMarkup(createElement(SpreadView, { book: input, template, format: resolveFormat(format),
    spread: input.project.spreads[0], page: sequence.spreads[0].page, index: bookIndex(input, template, sequence),
    positions: textAssignments(input, template).positions, renderPhotos: false }));
};
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test('rects draws the box once and its further rectangles as parts of it', () => {
  const html = markup({ rects: [left, right] });
  assert.equal(count(html, /data-box="body"/g), 1, 'Only the first rectangle is the box');
  assert.equal(count(html, /data-box-rect="body"/g), 1);
  assert.match(html, /data-rect="1"/);
  assert.equal(count(html, /class="if-markdown body"/g), 2, 'Both carry the box classes');
  assert.equal(count(html, /data-columns="2"/g), 2, 'Both have the box\'s columns');
  assert.equal(count(html, /data-empty/g), 0, 'The assigned text is there for both');
  assert.match(html, /left:10mm;top:150mm;width:180mm;height:80mm/);
  assert.match(html, /left:218mm;top:150mm;width:180mm;height:80mm/);
});

test('three rectangles are numbered in order', () => {
  const html = markup({ rects: [left, right, { ...right, x: 400 }] });
  assert.deepEqual([...html.matchAll(/data-rect="(\d+)"/g)].map(([, n]) => n), ['1', '2']);
});

test('a box with rect or without placement draws no further rectangles', () => {
  assert.equal(count(markup({ rect: left }), /data-box-rect/g), 0);
  assert.equal(count(markup({}), /data-box-rect/g), 0);
});

test('alignHeads marks the box only when it has rects', () => {
  assert.equal(count(markup({ rects: [left, right], alignHeads: true }), /data-align-heads/g), 1);
  assert.equal(count(markup({ rects: [left, right] }), /data-align-heads/g), 0);
  assert.equal(count(markup({ rect: left, alignHeads: true }), /data-align-heads/g), 0);
  assert.equal(count(markup({ rects: [left], alignHeads: true }), /data-align-heads/g), 0, 'One rectangle has nothing to align');
});

test('rect and rects are exclusive, and rects needs a rectangle', () => {
  assert.throws(() => markup({ rect: left, rects: [left, right] }), /rect or rects, not both/);
  assert.throws(() => markup({ rects: [] }), /at least one rectangle/);
});
