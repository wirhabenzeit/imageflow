import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuedSpread, editorLayoutsAt, firstEditorLayouts, firstSpreadLayouts, newEditorSpread } from '../src/editing';
import { layoutFootprint, planLayoutChange } from '../src/layouts';
import type { Layouts } from '../src/layouts';
import { mm, pageSequence, printFormat } from '../src/format';

const format = printFormat({ label: 'Book', trim: { width: mm(100), height: mm(100) }, bleed: mm(3), safe: mm(5),
  ends: 'inside-covers', pageCount: { min: 2, max: 100, step: 2 } });
const layout = (sides?: ('left' | 'right')[]) => ({ label: 'Page', span: 'page' as const, sides, parameters: {}, boxes: {}, elements: {} });
const pages: Layouts = { any: layout(), left: layout(['left']), right: layout(['right']) };

test('page-only facing templates can start and add complete sheets from page designs', () => {
  assert.deepEqual(firstEditorLayouts(pages, format), ['any', 'left', 'right']);
  assert.deepEqual(firstSpreadLayouts(pages, format), [], 'command insertion remains gated until page-addressed commands ship');
  for (const definition of ['any', 'left', 'right']) {
    const sheet = newEditorSpread(definition, pages, format, { index: 0, count: 1 })!;
    const side = definition === 'right' ? 'right' : 'left';
    assert.equal(sheet.split, true);
    assert.equal(sheet.pages?.[side]?.definition, definition);
    assert.equal(sheet.pages?.[side === 'left' ? 'right' : 'left'], undefined);
    assert.equal(layoutFootprint(sheet, pages).span, 'spread');
    assert.equal(pageSequence([layoutFootprint(sheet, pages)], format).count, 2);
    const next = newEditorSpread(definition, pages, format, { index: 1, count: 2 })!;
    assert.equal(pageSequence([layoutFootprint(sheet, pages), layoutFootprint(next, pages)], format).count, 4);
  }
});

test('single ends use ordinary page layouts while middle sheets compose page states', () => {
  const ends = { ...format, structure: { ...format.structure, ends: 'single-pages' as const } };
  assert.deepEqual(firstEditorLayouts(pages, ends), ['any', 'right']);
  assert.deepEqual(editorLayoutsAt(pages, ends, { index: 2, count: 3 }), ['any', 'left']);
  const opening = newEditorSpread('right', pages, ends, { index: 0, count: 3 })!;
  const middle = newEditorSpread('any', pages, ends, { index: 1, count: 3 })!;
  const closing = newEditorSpread('left', pages, ends, { index: 2, count: 3 })!;
  assert.equal(opening.split, undefined);
  assert.equal(middle.split, true);
  assert.equal(closing.split, undefined);
  const sequence = pageSequence([opening, middle, closing].map((sheet) => layoutFootprint(sheet, pages)), ends);
  assert.equal(sequence.count, 4);
  assert.deepEqual(sequence.issues, []);
  assert.equal(newEditorSpread('left', pages, ends, { index: 0, count: 3 }), undefined);
});

test('non-facing and spread designs preserve their ordinary one-state representation', () => {
  const single = printFormat({ label: 'Calendar', facingPages: false, trim: { width: mm(100), height: mm(100) },
    bleed: mm(3), safe: mm(5), pageCount: { min: 1, max: 100, step: 1 } });
  const layouts: Layouts = { ...pages, full: { ...layout(), span: 'spread' } };
  assert.equal(newEditorSpread('any', layouts, single, { index: 0, count: 1 })?.split, undefined);
  assert.equal(newEditorSpread('full', layouts, single, { index: 0, count: 1 }), undefined);
  assert.equal(newEditorSpread('full', layouts, format, { index: 0, count: 1 })?.split, undefined);
  assert.equal(newEditorSpread('missing', layouts, format, { index: 0, count: 1 }), undefined);
  const created = newEditorSpread('any', layouts, format, { index: 0, count: 1 })!;
  assert.equal(planLayoutChange(created, 'full', layouts).spread.split, undefined);
});

test('a new spread continues the selected sheet\'s layout where it fits (F-033)', () => {
  const ends = { ...format, structure: { ...format.structure, ends: 'single-pages' as const } };
  const layouts: Layouts = { ...pages, map: { ...layout(), label: 'Map', span: 'spread' }, photo: { ...layout(), label: 'Photo', span: 'spread' },
    title: layout(['right']) };
  const middle = { index: 2, count: 4 };
  const photo = { id: 'a', definition: 'photo', params: { caption: 'x' }, boxes: { hero: { photo: 'p1', params: {} } }, elements: {} };
  const next = continuedSpread(photo, layouts, format, middle)!;
  assert.equal(next.definition, 'photo');
  assert.notEqual(next.id, 'a');
  assert.deepEqual([next.params, next.boxes, next.split], [{}, {}, undefined], 'the layout continues, not the content');

  // A sheet of two page designs continues with both, empty; its stale sheet-level layout is not carried over.
  const sheet = { id: 'b', definition: 'map', split: true as const, params: {}, boxes: {}, elements: {},
    pages: { left: { definition: 'left', params: { x: 1 }, boxes: { a: { photo: 'p', params: {} } }, elements: {} }, right: { definition: 'any', params: {}, boxes: {}, elements: {} } } };
  const pair = continuedSpread(sheet, layouts, format, middle)!;
  assert.equal(pair.split, true);
  assert.equal(pair.definition, 'left');
  assert.deepEqual(pair.pages, { left: { definition: 'left', params: {}, boxes: {}, elements: {} }, right: { definition: 'any', params: {}, boxes: {}, elements: {} } });
  assert.equal(layoutFootprint(pair, layouts).span, 'spread');

  // A single opening page is not repeated inside the book, and a layout that does not fit falls back to the caller.
  const opening = { id: 'c', definition: 'title', params: {}, boxes: {}, elements: {} };
  assert.equal(continuedSpread(opening, layouts, ends, { index: 1, count: 3 }), undefined);
  assert.equal(continuedSpread(photo, layouts, ends, { index: 2, count: 3 }), undefined, 'the closing page of a single-ended book');
  assert.equal(continuedSpread({ ...photo, definition: 'removed' }, layouts, format, middle), undefined);
});
