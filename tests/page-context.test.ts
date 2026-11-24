import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mm, pageSequence, printFormat, resolveFormat } from '../src/format';
import { layoutFootprint } from '../src/layouts';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { p } from '../src/parameters';
import { installPurityGuards } from '../src/purity';
import { bookContext, bookIndex, chooseFormat, editorContext, Page, SpreadError, SpreadView, templateSchema } from '../src/template';
import type { AnchorLookup, Template } from '../src/template';

const format = printFormat({ label: 'Book', trim: { width: mm(100), height: mm(120) },
  bleed: mm(3), safe: mm(5), pageCount: { min: 2, max: 100, step: 2 }, ends: 'inside-covers' });
const makeTemplate = (): Template => chooseFormat(templateSchema.parse({ id: 'pages', version: '1', contract: 1, format,
  spreads: {
    full: { label: 'Hidden', anchors: () => [{ id: 'hidden' }], credits: () => [{ id: 'hidden', text: 'Hidden' }], render: () => null },
    page: { label: 'Page', span: 'page', parameters: { title: p.string({ label: 'Title', default: '' }) },
      anchors: ({ params }: { params: Record<string, unknown> }) => [{ id: params.title, side: 'right' }],
      credits: ({ params }: { params: Record<string, unknown> }) => [{ id: 'shared', text: params.title, side: 'right' }],
      render: ({ book }: { book: ReturnType<typeof bookContext> }) => { book.anchor('missing'); return createElement(Page); } },
  } }));
const book = (): RenderProject => ({ project: projectSchema.parse({ title: 'Pages', schemaVersion: 2,
  template: { id: 'pages', version: '1' }, spreads: [
    { id: 'first', definition: 'full', split: true, pages: {
      left: { definition: 'page', params: { title: 'First' } }, right: { definition: 'page', params: { title: 'Second' } } } },
    { id: 'second', definition: 'full', split: true, pages: {
      left: { definition: 'page', params: { title: 'Third' } }, right: { definition: 'page', params: { title: 'Fourth' } } } },
  ] }), photos: {}, files: {}, texts: {}, mode: 'edit', template: { script: '', assets: {} } });
const sequence = (input: RenderProject, template: Template) => pageSequence(input.project.spreads.map((spread) => layoutFootprint(spread, template.spreads)), format);

test('shown page anchors and credits use their own page and attribute conflicts separately', () => {
  const input = book(), template = makeTemplate();
  const index = bookIndex(input, template, sequence(input, template));
  assert.deepEqual(index.anchors.map(({ id, page, side }) => [id, page, side]),
    [['First', 1, 'left'], ['Second', 2, 'right'], ['Third', 3, 'left'], ['Fourth', 4, 'right']]);
  assert.deepEqual(index.credits, [{ id: 'shared', text: 'First', pages: [1, 2, 3, 4], spreads: ['first', 'second'] }]);
  assert.deepEqual(index.creditConflicts?.map(({ spread, page, text }) => [spread, page, text]),
    [['first', 'right', 'Second'], ['second', 'left', 'Third'], ['second', 'right', 'Fourth']]);
});

test('each page render records its own anchor lookups and deduplicates only within that page', () => {
  const input = book(), template = makeTemplate(), pages = sequence(input, template);
  const index = { ...bookIndex(input, template, pages), lookups: new Map<string, AnchorLookup>() };
  const render = () => renderToStaticMarkup(createElement(SpreadView, { book: input, template, format: resolveFormat(format),
    spread: input.project.spreads[0], page: pages.spreads[0].page, index, positions: {}, renderPhotos: false }));
  render(); render();
  assert.deepEqual([...index.lookups.values()], [
    { spread: 'first', page: 'left', anchor: 'missing', found: 0 },
    { spread: 'first', page: 'right', anchor: 'missing', found: 0 },
  ]);
});

test('failed or invalid page anchor and credit declarations identify their page', () => {
  for (const kind of ['anchors', 'credits'] as const) for (const throwing of [false, true]) {
    const input = book(), template = makeTemplate();
    template.spreads.page[kind] = (({ params }: { params: Record<string, unknown> }) => {
      if (params.title === 'Second') { if (throwing) throw new Error('broken'); return [{ id: '' }]; }
      return kind === 'anchors' ? [{ id: String(params.title) }] : [{ id: String(params.title), text: 'Credit' }];
    });
    assert.throws(() => bookIndex(input, template, sequence(input, template)), (error: unknown) =>
      error instanceof SpreadError && error.spread === 'first' && error.page === 'right');
  }
});

test('page editor context follows its own values and page number and refreshes for book index changes', () => {
  const input = book(), template = makeTemplate();
  const left = editorContext(input, template, 'first', 'left')!, right = editorContext(input, template, 'first', 'right')!;
  assert.equal(left.context.params.title, 'First');
  assert.equal(right.context.params.title, 'Second');
  assert.deepEqual(left.context.page, { left: 1 });
  assert.deepEqual(right.context.page, { right: 2 });
  assert.equal(right.context.side, 'right');
  input.project.spreads[1].pages!.left!.params.title = 'Changed';
  const changed = editorContext(input, template, 'first', 'right')!;
  assert.notEqual(changed.key, right.key);
  assert.equal(changed.context.book.anchor('Changed')?.page, 3);
  assert.equal(changed.context.params.title, 'Second');
});

test('a page render failure carries its page and original cause', () => {
  const input = book(), template = makeTemplate(), pages = sequence(input, template);
  const cause = new Error('Broken right page');
  template.spreads.page.render = (ctx) => { if (ctx.side === 'right') throw cause; return createElement(Page); };
  assert.throws(() => renderToStaticMarkup(createElement(SpreadView, { book: input, template, format: resolveFormat(format),
    spread: input.project.spreads[0], page: pages.spreads[0].page, index: bookIndex(input, template, pages), positions: {}, renderPhotos: false })),
    (error: unknown) => error instanceof SpreadError && error.spread === 'first' && error.page === 'right' && error.cause === cause);
});


test('purity calls during page declarations belong to that page and clear after a thrown declaration', () => {
  const input = book(), template = makeTemplate();
  const target = { fetch: () => undefined, setTimeout: () => undefined };
  const guards = installPurityGuards(target, '/template.js', () => 'at /template.js');
  template.spreads.page.anchors = () => { target.fetch(); return []; };
  template.spreads.page.credits = () => { target.setTimeout(); return []; };
  bookIndex(input, template, sequence(input, template));
  assert.deepEqual(guards.calls, [
    { api: 'fetch', spread: 'first', page: 'left' }, { api: 'fetch', spread: 'first', page: 'right' },
    { api: 'fetch', spread: 'second', page: 'left' }, { api: 'fetch', spread: 'second', page: 'right' },
    { api: 'setTimeout', spread: 'first', page: 'left' }, { api: 'setTimeout', spread: 'first', page: 'right' },
    { api: 'setTimeout', spread: 'second', page: 'left' }, { api: 'setTimeout', spread: 'second', page: 'right' },
  ]);
  template.spreads.page.anchors = () => { throw new Error('broken'); };
  assert.throws(() => bookIndex(input, template, sequence(input, template)));
  target.fetch();
  assert.deepEqual(guards.calls.at(-1), { api: 'fetch' });
});
