import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mm, pageSequence } from '../src/format';
import { p } from '../src/parameters';
import { projectSchema } from '../src/project';
import type { RenderProject } from '../src/project';
import { bookContext, bookIndex, chooseFormat, templateSchema } from '../src/template';

const format = {
  label: 'Anchor test', trim: { width: mm(100), height: mm(100) },
  bleed: { top: mm(3), bottom: mm(3), outside: mm(3), binding: mm(0) },
  safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
  structure: { delivery: 'pages', ends: 'single-pages', pageCount: { min: 2, max: 40, step: 2 } },
  output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
};
const render = () => null;
const heading = p.string({ label: 'Heading', default: 'Untitled' });

function book(spreads: object[], anchors: Record<string, (context: { params: Record<string, unknown> }) => unknown> = {}) {
  const template = chooseFormat(templateSchema.parse({
    id: 'anchors', version: '1', contract: 1, format, parameters: {},
    spreads: {
      opening: { label: 'Opening', span: 'right', render, anchors: anchors.opening },
      chapter: { label: 'Chapter', parameters: { heading }, render,
        anchors: anchors.chapter ?? (({ params }: { params: Record<string, unknown> }) => [{ id: 'chapter', title: params.heading, side: 'right' }]) },
      plain: { label: 'Plain', render },
      closing: { label: 'Closing', span: 'left', render, anchors: anchors.closing },
    },
  }));
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Anchors', template: { id: 'anchors', version: '1' }, spreads });
  const sequence = pageSequence(project.spreads.map(({ definition }) => template.spreads[definition].span), template.format);
  const rendered = { project, photos: {}, texts: {}, files: {}, problems: [], mode: 'export', template: { script: '', assets: {} } } as RenderProject;
  return bookIndex(rendered, template, sequence);
}

test('anchors resolve to the declared page of each spread, in book order', () => {
  const index = book([
    { id: 'start', definition: 'opening' },
    { id: 'one', definition: 'chapter', params: { heading: 'Arrival' } },
    { id: 'gap', definition: 'plain' },
    { id: 'two', definition: 'chapter' },
    { id: 'end', definition: 'closing' },
  ], {
    opening: () => [{ id: 'cover', side: 'left' }],
    closing: () => [{ id: 'colophon', side: 'right', title: 'Colophon' }],
  });
  assert.equal(index.pages, 8);
  // A single page has one page, whichever side the declaration names. Unassigned parameters use their defaults.
  assert.deepEqual(index.anchors, [
    { id: 'cover', spread: 'start', page: 1, side: 'right' },
    { id: 'chapter', title: 'Arrival', spread: 'one', page: 3, side: 'right' },
    { id: 'chapter', title: 'Untitled', spread: 'two', page: 7, side: 'right' },
    { id: 'colophon', title: 'Colophon', spread: 'end', page: 8, side: 'left' },
  ]);
});

test('anchors of one spread are listed in page order, whatever order they are declared in', () => {
  const index = book([{ id: 'one', definition: 'chapter' }],
    { chapter: () => [{ id: 'b', side: 'right' }, { id: 'a' }, { id: 'c', side: 'left' }] });
  assert.deepEqual(index.anchors.map(({ id, page, side }) => [id, page, side]), [['a', 1, 'left'], ['c', 1, 'left'], ['b', 2, 'right']]);
});

test('lookups report missing and ambiguous anchors once per spread and return copies', () => {
  const index = { ...book([{ id: 'one', definition: 'chapter' }, { id: 'two', definition: 'chapter' }]), lookups: new Map() };
  const context = bookContext(index, 'one');
  assert.deepEqual(context.anchors('chapter').map(({ page }) => page), [2, 4]);
  assert.equal(context.anchors().length, 2);
  assert.equal(context.anchors('nothing').length, 0);
  assert.equal(context.anchor('chapter')?.spread, 'one');
  assert.equal(context.anchor('chapter')?.spread, 'one');
  assert.equal(context.anchor('map'), undefined);
  assert.deepEqual([...index.lookups.values()], [
    { spread: 'one', anchor: 'chapter', found: 2 },
    { spread: 'one', anchor: 'map', found: 0 },
  ]);
  // Templates cannot change what other spreads see.
  context.anchors('chapter')[0].page = 99;
  assert.equal(bookContext(index, 'two').anchors('chapter')[0].page, 2);
});

test('invalid or failing anchor declarations name the layout', () => {
  assert.throws(() => book([{ id: 'one', definition: 'chapter' }], { chapter: () => [{ id: '' }] }), /Chapter declares invalid anchors: 0\.id/);
  assert.throws(() => book([{ id: 'one', definition: 'chapter' }], { chapter: () => [{ id: 'x', page: 3 }] }), /Chapter declares invalid anchors/);
  assert.throws(() => book([{ id: 'one', definition: 'chapter' }], { chapter: () => { throw new Error('boom'); } }),
    /Chapter could not declare its anchors: boom/);
  assert.throws(() => templateSchema.parse({ id: 'x', version: '1', contract: 1, format, parameters: {},
    spreads: { main: { label: 'Main', render, anchors: 'chapter' } } }), /anchors function/);
});
