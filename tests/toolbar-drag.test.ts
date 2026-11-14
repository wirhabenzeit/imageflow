import assert from 'node:assert/strict';
import test from 'node:test';
import { validToolbarDragRegions } from '../desktop/mac-header';

test('toolbar rectangles accept resized controls and an empty presentation layout', () => {
  assert.equal(validToolbarDragRegions([]), true);
  assert.equal(validToolbarDragRegions([
    { x: 0, y: 0, width: 940, height: 44 },
    { x: 780.5, y: 7, width: 112, height: 30 },
  ]), true);
});

test('renderer cannot request drag regions outside the toolbar or invalid native coordinates', () => {
  for (const value of [null, {}, [{ x: 0, y: 0, width: 940, height: 201 }],
    [{ x: -1, y: 0, width: 10, height: 10 }], [{ x: 0, y: 0, width: NaN, height: 44 }],
    [{ x: 0, y: 0, width: Infinity, height: 44 }], [{ x: 0, y: 0, width: '940', height: 44 }],
    new Array(129).fill({ x: 0, y: 0, width: 1, height: 1 })]) {
    assert.equal(validToolbarDragRegions(value), false);
  }
});
