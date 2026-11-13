import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BookGeometry } from '../src/desktop';
import { reorderOffsets } from '../src/reorder-motion';

const geometry = (ids: string[]): BookGeometry => ({
  type: 'geometry', width: 200, height: ids.length * 100, boxes: [], targets: [],
  sheets: ids.map((spread, i) => ({ spread, x: 10, y: i * 100, width: 180, height: 80 })),
});

test('only displaced spreads move from their previous positions', () => {
  assert.deepEqual(reorderOffsets(geometry(['a', 'b', 'c']), geometry(['b', 'a', 'c'])), [
    { spread: 'b', x: 0, y: 100 }, { spread: 'a', x: 0, y: -100 },
  ]);
});

test('opening, edits, additions, removals and replaced IDs do not animate', () => {
  const before = geometry(['a', 'b']);
  for (const after of [undefined, geometry(['a', 'b']), geometry(['b']), geometry(['b', 'a', 'c']), geometry(['c', 'a'])]) {
    assert.deepEqual(reorderOffsets(before, after), []);
  }
  assert.deepEqual(reorderOffsets(undefined, before), []);
});

test('resizing a sidebar or changing sheet dimensions does not count as reordering', () => {
  const before = geometry(['a', 'b']);
  const after = geometry(['b', 'a']);
  assert.deepEqual(reorderOffsets(before, { ...after, width: 220 }), []);
  after.sheets[0].height = 100;
  assert.deepEqual(reorderOffsets(before, after), []);
});
