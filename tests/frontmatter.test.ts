import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { splitFrontmatter } from '../src/frontmatter';
import { markdownToHtml } from '../src/markdown';
import { mm, pageSequence, printFormat } from '../src/format';
import { layoutFootprint } from '../src/layouts';
import { projectSchema } from '../src/project';
import type { RenderProject, SpreadState } from '../src/project';
import { bookContext, bookIndex, chooseFormat, editorContext, normalizeTemplate, Spread, templateSchema } from '../src/template';
import type { AnchorContext } from '../src/template';
import { textAssignments } from '../src/text-assignments';

const header = `---
title: Crossing the Alps
eyebrow: Field notes
dark: true
chapter: 3
date: 2024-05-01
skip: no
places:
  - { name: Bergün, latitude: 46.63, longitude: 9.75 }
  - name: Albula Pass
    latitude: 46.58
---

We left before sunrise.`;

test('a header becomes JSON-shaped fields, with dates and yes/no as strings', () => {
  const { meta, error } = splitFrontmatter(header);
  assert.equal(error, undefined);
  assert.deepEqual(meta, { title: 'Crossing the Alps', eyebrow: 'Field notes', dark: true, chapter: 3, date: '2024-05-01', skip: 'no',
    places: [{ name: 'Bergün', latitude: 46.63, longitude: 9.75 }, { name: 'Albula Pass', latitude: 46.58 }] });
  assert.deepEqual(splitFrontmatter('---\nn: .inf\n---\n').meta, { n: null });
  assert.deepEqual(splitFrontmatter('---\n---\nBody').meta, {});
  assert.deepEqual(splitFrontmatter('﻿---\r\ntitle: A\r\n...\r\nBody').meta, { title: 'A' });
});

test('the header is blanked in place, so Markdown offsets still count from the start of the file', () => {
  const { body } = splitFrontmatter(header);
  assert.equal(body.length, header.length);
  assert.equal(body.split('\n').length, header.split('\n').length);
  assert.ok(body.endsWith('We left before sunrise.'));
  const html = markdownToHtml(header);
  assert.doesNotMatch(html, /<hr|<h2|Crossing/);
  const start = header.indexOf('We left');
  assert.match(html, new RegExp('^<p data-s="' + start + '" data-e="' + header.length + '">We left before sunrise.</p>$'));
});

test('Markdown that only starts with a thematic break stays Markdown', () => {
  for (const source of ['---\n\nA paragraph.\n\n---\nMore', '---\n# Heading\n\nText\n---\n', '---\nNo closing rule', 'Text\n---\n', ' ---\na: 1\n---\n']) {
    const result = splitFrontmatter(source);
    assert.deepEqual([result.body, result.meta, result.error], [source, null, undefined], source);
  }
  assert.match(markdownToHtml('---\n\nA paragraph.\n\n---\nMore'), /^<hr/);
});

test('a header meant as YAML that cannot be read is reported and still left out of the text', () => {
  const source = '---\ntitle: Alps\nplaces: [oops\n---\nBody';
  const { body, meta, error } = splitFrontmatter(source);
  assert.equal(meta, null);
  assert.equal(error?.line, 3);
  assert.match(error!.message, /\S/);
  assert.doesNotMatch(error!.message, /at line/);
  assert.equal(markdownToHtml(source).replace(/ data-[se]="\d+"/g, ''), '<p>Body</p>');
  assert.equal(splitFrontmatter('---\ntitle: A\ntitle: B\n---\n').error?.line, 3);
  assert.match(splitFrontmatter('---\n- one\n- two\n---\n').error!.message, /key: value/);
});

const format = printFormat({ label: 'Book', trim: { width: mm(200), height: mm(240) }, bleed: { all: mm(3), binding: mm(0) },
  safe: { all: mm(10), binding: mm(18) }, pageCount: { min: 2, max: 100, step: 2 }, ends: 'inside-covers' });
const template = chooseFormat(templateSchema.parse(normalizeTemplate({ id: 'chapters', version: '1', contract: 1, format,
  spreads: ({ spread }: { spread: <T>(x: T) => T }) => ({
    story: spread({ label: 'Story', boxes: { body: { type: 'markdown', label: 'Body', flowOrder: 1 }, aside: { type: 'markdown', label: 'Aside', flowOrder: 2 } },
      anchors: ({ boxes }: AnchorContext) => {
        const text = boxes.body.text;
        return text?.part === 1 && typeof text.meta.title === 'string' ? [{ id: 'section', title: text.meta.title }] : [];
      },
      render: () => createElement(Spread) }),
  }) })));
const spread = (id: string, body?: string, aside?: string): SpreadState => ({ id, definition: 'story', params: {}, elements: {},
  boxes: { ...body ? { body: { text: body, params: {} } } : {}, ...aside ? { aside: { text: aside, params: {} } } : {} } });

const alpsBook = (): RenderProject => ({
    project: projectSchema.parse({ schemaVersion: 2, title: 'Alps', template: { id: 'chapters', version: '1' },
      texts: { alps: 'texts/alps.md', note: 'texts/note.md', plain: 'texts/plain.md' },
      spreads: [spread('one', 'alps', 'note'), spread('two', 'alps', 'plain')] }),
    mode: 'edit', problems: [], template: { script: '', assets: {} }, photos: {}, files: {},
    texts: { alps: header, note: '---\ntitle: A note\n---\nAside.', plain: 'No header.' },
});

test('every box of a chain sees its source’s header; other sources on the spread keep their own', () => {
  const book = alpsBook();
  const { positions } = textAssignments(book, template);
  assert.deepEqual([positions['one:body'].part, positions['two:body'].part, positions['two:body'].parts], [1, 2, 2]);
  assert.equal(positions['one:body'].meta.title, 'Crossing the Alps');
  assert.equal(positions['two:body'].meta, positions['one:body'].meta);
  assert.deepEqual(positions['one:aside'].meta, { title: 'A note' });
  assert.deepEqual(positions['two:aside'].meta, {});
  book.texts.alps = '---\ntitle: [oops\n---\nBody';
  assert.deepEqual(textAssignments(book, template).positions['one:body'].meta, {});
});

const indexOf = (book: RenderProject) =>
  bookIndex(book, template, pageSequence(book.project.spreads.map((spread) => layoutFootprint(spread, template.spreads)), template.format));

test('book.texts lists every placed text in book order with its header and boxes, frozen', () => {
  const texts = bookContext(indexOf(alpsBook()), 'one').texts;
  assert.deepEqual(texts.map(({ id, title, meta }) => [id, title, meta.title]),
    [['alps', 'alps.md', 'Crossing the Alps'], ['note', 'note.md', 'A note'], ['plain', 'plain.md', undefined]]);
  assert.deepEqual(texts[0].boxes, [
    { spread: 'one', box: 'body', part: 1, pageNumbers: { left: 1, right: 2 } },
    { spread: 'two', box: 'body', part: 2, pageNumbers: { left: 3, right: 4 } }]);
  assert.ok(Object.isFrozen(texts) && Object.isFrozen(texts[0].meta) && Object.isFrozen((texts[0].meta.places as object[])[0]));
  assert.throws(() => { (texts[0].meta as Record<string, unknown>).title = 'Changed'; });
});

test('anchors read their boxes’ text, so a layout can name an anchor after where its text starts', () => {
  assert.deepEqual(indexOf(alpsBook()).anchors.map(({ id, title, spread }) => [id, title, spread]), [['section', 'Crossing the Alps', 'one']]);
});

test('editors see the same flow positions and header fields as render', () => {
  const book = alpsBook();
  const { context } = editorContext(book, template, 'two')!;
  assert.equal(context.boxes.body.text?.part, 2);
  assert.equal(context.boxes.body.text?.meta.title, 'Crossing the Alps');
  assert.equal(context.book.texts.length, 3);
  const key = editorContext(book, template, 'two')!.key;
  book.texts.alps = book.texts.alps.replace('Crossing the Alps', 'Over the Alps');
  assert.notEqual(editorContext(book, template, 'two')!.key, key);
});

test('anchors read book.texts and their own spread, so a page without a text box names its anchor after the text beside it (F-022)', () => {
  const routes = chooseFormat(templateSchema.parse(normalizeTemplate({ id: 'chapters', version: '1', contract: 1, format,
    spreads: ({ spread }: { spread: <T>(x: T) => T }) => ({
      story: spread({ label: 'Story', boxes: { body: { type: 'markdown', label: 'Body', flowOrder: 1 }, aside: { type: 'markdown', label: 'Aside', flowOrder: 2 } },
        render: () => createElement(Spread) }),
      route: spread({ label: 'Route', anchors: ({ spread, book }: AnchorContext) => {
        // The text that starts on the next sheet: this route's day.
        const day = book.texts.find((text) => text.boxes.some((box) => box.part === 1 && box.pageNumbers.left !== undefined && box.spread !== spread));
        assert.ok(Object.isFrozen(book.texts));
        return [{ id: 'stage', title: typeof day?.meta.title === 'string' ? day.meta.title : 'Stage', side: 'left' }];
      }, render: () => createElement(Spread) }),
    }) })));
  const book = alpsBook();
  book.project.spreads.unshift({ id: 'map', definition: 'route', params: {}, boxes: {}, elements: {} });
  const index = bookIndex(book, routes, pageSequence(book.project.spreads.map((spread) => layoutFootprint(spread, routes.spreads)), routes.format));
  assert.deepEqual(index.anchors.map(({ id, title, spread }) => [id, title, spread]), [['stage', 'Crossing the Alps', 'map']]);
});
