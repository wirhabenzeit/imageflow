import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closestIds } from '../src/closest-ids';

test('a wrong ID is answered with the ones most like it, siblings and the family\u2019s own first (API-017)', () => {
  const layouts = ['gridPage', 'gridPage2x2', 'gridPage3x2', 'gridPage3x3', 'story', 'photoStory', 'quote', 'photoLandscape'];
  assert.deepEqual(closestIds('gridPage2x3', layouts), ['gridPage2x2', 'gridPage3x3', 'gridPage3x2', 'gridPage']);
  assert.deepEqual(closestIds('Quotes', layouts), ['quote']);
  assert.deepEqual(closestIds('storyPhoto', ['photo']), []);
  assert.deepEqual(closestIds('completelyOther', layouts), []);
  assert.equal(closestIds('gridPage9x9', Array.from({ length: 30 }, (_, n) => 'gridPage' + n + 'x9')).length, 5);
});
