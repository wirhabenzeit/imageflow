import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourcePlacements } from '../src/source-placement';

const boxes = { cover: { type: 'photo' }, left: { type: 'photo' }, right: { type: 'photo' }, story: { type: 'markdown' } };
const saved = { cover: { photo: 'keep', params: {} }, right: { photo: 'keep-too', params: {} } };
const photos = ['one', 'two', 'three'].map(id => ({ kind: 'photo' as const, id }));
test('placing a selection fills empty matching boxes without replacing existing work', () => {
  assert.deepEqual(sourcePlacements(boxes, saved, photos), [{ box: 'left', source: photos[0] }]);
});
test('a group dropped on a filled box replaces only that explicit target, then uses empty boxes', () => {
  assert.deepEqual(sourcePlacements(boxes, saved, photos, 'cover'), [{ box: 'cover', source: photos[0] }, { box: 'left', source: photos[1] }]);
  assert.equal(saved.right.photo, 'keep-too');
});
