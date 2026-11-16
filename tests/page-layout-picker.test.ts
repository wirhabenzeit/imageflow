import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mm, printFormat } from '../src/format';
import { editorLayoutChoices, editorLayoutPreviews, editorLayoutTarget, planLayoutChange } from '../src/layouts';
import type { Layouts } from '../src/layouts';
import type { SpreadState } from '../src/project';

const format = printFormat({ label: 'Book', trim: { width: mm(100), height: mm(100) }, bleed: mm(3), safe: mm(5),
  ends: 'single-pages', pageCount: { min: 4, max: 100, step: 2 } });
const page = (sides?: ('left' | 'right')[]) => ({ label: 'Page', span: 'page' as const, sides, parameters: {}, elements: {},
  boxes: { hero: { label: 'Hero', type: 'photo' as const, parameters: {} } } });
const layouts: Layouts = {
  full: { ...page(), span: 'spread' },
  photo: { ...page(), family: 'photos' }, alternative: { ...page(), family: 'photos' },
  left: page(['left']), right: page(['right']), opening: { ...page(), span: 'right' }, closing: { ...page(), span: 'left' },
};
const sheet = (): SpreadState => ({ id: 's', definition: 'full', params: {}, boxes: { hero: { params: {}, photo: 'spread' } }, elements: {} });
const middle = { index: 1, count: 3 };

test('editor choices include page and spread layouts and respect the selected side', () => {
  assert.deepEqual(editorLayoutChoices(layouts, sheet(), format, middle), ['full', 'photo', 'alternative', 'left']);
  assert.deepEqual(editorLayoutChoices(layouts, sheet(), format, middle, 'right'), ['full', 'photo', 'alternative', 'right']);
  assert.deepEqual(editorLayoutTarget(layouts, 'photo', format, middle, 'right'), { definition: 'photo', page: 'right' });
  assert.deepEqual(editorLayoutTarget(layouts, 'full', format, middle, 'right'), { definition: 'full', side: 'right' });
  assert.deepEqual(editorLayoutTarget(layouts, undefined, format, middle), { page: 'left' });
});

test('ordinary end page layouts use the required side and remain unsplit', () => {
  const first = { index: 0, count: 3 }, last = { index: 2, count: 3 };
  assert.deepEqual(editorLayoutChoices(layouts, sheet(), format, first, 'left'), ['photo', 'alternative', 'right', 'opening']);
  assert.deepEqual(editorLayoutChoices(layouts, sheet(), format, last, 'right'), ['photo', 'alternative', 'left', 'closing']);
  const request = editorLayoutTarget(layouts, 'photo', format, first, 'right');
  assert.deepEqual(request, { definition: 'photo', side: 'right' });
  assert.equal(planLayoutChange(sheet(), request, layouts).spread.split, undefined);
});

test('a page candidate previews the actual planned moves while leaving the facing page alone', () => {
  const original = sheet();
  original.split = true;
  original.pages = {
    left: { definition: 'photo', params: {}, boxes: { hero: { params: {}, photo: 'left' } }, elements: {} },
    right: { definition: 'alternative', params: {}, boxes: { hero: { params: {}, photo: 'right' } }, elements: {} },
  };
  const before = structuredClone(original);
  const target = editorLayoutTarget(layouts, 'photo', format, middle, 'right');
  const planned = planLayoutChange(original, target, layouts).spread;
  assert.equal(planned.pages?.right?.boxes.hero.photo, 'right');
  assert.deepEqual(planned.pages?.left, before.pages?.left);
  assert.deepEqual(original, before);
  const families = { photos: { label: 'Photos', picker: { label: 'Photos' } } };
  assert.deepEqual(editorLayoutPreviews(layouts, original, families, format, middle, 'right'), ['full', 'alternative', 'right']);
});

test('non-facing editor choices and changes keep one page per unit', () => {
  const single = printFormat({ label: 'Calendar', facingPages: false, trim: { width: mm(100), height: mm(100) },
    bleed: mm(3), safe: mm(5), pageCount: { min: 1, max: 100, step: 1 } });
  assert.deepEqual(editorLayoutChoices(layouts, sheet(), single, middle), ['photo', 'alternative', 'left', 'right']);
  assert.deepEqual(editorLayoutTarget(layouts, 'photo', single, middle), { definition: 'photo' });
});

test('the visual picker keeps restricted page tiles in the same order on either side', () => {
  const left = editorLayoutPreviews(layouts, sheet(), {}, format, middle, 'left', true);
  const right = editorLayoutPreviews(layouts, sheet(), {}, format, middle, 'right', true);
  assert.deepEqual(left, right);
  assert.ok(left.includes('left') && left.includes('right'));
  assert.equal(editorLayoutChoices(layouts, sheet(), format, middle, 'right').includes('left'), false,
    'A visible restricted tile still cannot be applied on the wrong side');
  const opening = editorLayoutPreviews(layouts, sheet(), {}, format, { index: 0, count: 3 }, 'right', true);
  assert.ok(opening.includes('left'));
});
