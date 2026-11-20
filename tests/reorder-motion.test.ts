import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookGeometry } from '../src/desktop';
import { provisionalOrder, reorderOffsets } from '../src/reorder-motion';

const geometry = (ids: string[]): BookGeometry => ({
  type: 'geometry', width: 200, height: ids.length * 100, boxes: [], targets: [],
  sheets: ids.map((spread, i) => ({ spread, x: 10, y: i * 100, width: 180, height: 80 })),
});

test('only displaced spreads move from their previous positions', () => {
  assert.deepEqual(reorderOffsets(geometry(['a', 'b', 'c']), geometry(['b', 'a', 'c'])), [
    { spread: 'b', x: 0, y: 100 }, { spread: 'a', x: 0, y: -100 },
  ]);
});

test('opening, edits and sheets that did not move do not animate', () => {
  const before = geometry(['a', 'b']);
  for (const after of [undefined, geometry(['a', 'b']), geometry(['a']), geometry(['a', 'b', 'c']), geometry(['c', 'd'])]) {
    assert.deepEqual(reorderOffsets(before, after), []);
  }
  assert.deepEqual(reorderOffsets(undefined, before), []);
});

test('after a removal the following spreads slide up, and after an insertion down; the ones above stay (F-036)', () => {
  assert.deepEqual(reorderOffsets(geometry(['a', 'b', 'c', 'd']), geometry(['a', 'c', 'd'])), [
    { spread: 'c', x: 0, y: 100 }, { spread: 'd', x: 0, y: 100 },
  ]);
  assert.deepEqual(reorderOffsets(geometry(['a', 'b', 'c']), geometry(['a', 'new', 'b', 'c'])), [
    { spread: 'b', x: 0, y: -100 }, { spread: 'c', x: 0, y: -100 },
  ]);
});

test('resizing a sidebar or changing sheet dimensions does not count as reordering', () => {
  const before = geometry(['a', 'b']);
  const after = geometry(['b', 'a']);
  assert.deepEqual(reorderOffsets(before, { ...after, width: 220 }), []);
  after.sheets[0].height = 100;
  assert.deepEqual(reorderOffsets(before, after), []);
});

test('a frame on show gets the edited order: added spreads copy a duplicate or look like the one before', () => {
  const spread = (id: string, photo = id) => ({ id, definition: 'photo', boxes: { hero: { photo } } });
  const shown = ['a', 'b', 'c'];
  assert.equal(provisionalOrder([spread('a'), spread('b'), spread('c')], shown), undefined, 'nothing to change');
  assert.equal(provisionalOrder([spread('a')], undefined), undefined, 'no frame on show yet');
  assert.deepEqual(provisionalOrder([spread('a'), spread('c')], shown), { order: ['a', 'c'], added: {} });
  assert.deepEqual(provisionalOrder([spread('b'), spread('a'), spread('c')], shown), { order: ['b', 'a', 'c'], added: {} });
  assert.deepEqual(provisionalOrder([spread('a'), spread('b'), spread('copy', 'b'), spread('c')], shown),
    { order: ['a', 'b', 'copy', 'c'], added: { copy: { like: 'b', copy: true } } });
  assert.deepEqual(provisionalOrder([spread('new', 'empty'), spread('a'), spread('b'), spread('c')], shown),
    { order: ['new', 'a', 'b', 'c'], added: { new: { like: 'a' } } }, 'at the start, like the spread after it');
  assert.deepEqual(provisionalOrder([spread('a'), spread('new', 'empty'), spread('b'), spread('c')], shown),
    { order: ['a', 'new', 'b', 'c'], added: { new: { like: 'a' } } });
});
