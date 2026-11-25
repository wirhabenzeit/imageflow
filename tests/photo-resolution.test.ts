import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countResolution, mergeResolution, newResolution } from '../src/photo-resolution';

test('the photos of a render are counted with the one that prints at the fewest pixels', () => {
  const found = newResolution(180);
  countResolution(found, 300.4, { spread: 'a', box: 'hero', source: 'p1' });
  countResolution(found, 190.6, { spread: 'b', page: 'left', box: 'hero', source: 'p2' });
  countResolution(found, undefined, { spread: 'c', box: 'hero', source: 'p3' });
  countResolution(found, NaN, { spread: 'c', box: 'side', source: 'p4' });
  assert.deepEqual(found, { minimumPpi: 180, measured: 2, notMeasured: 2, lowest: { ppi: 191, spread: 'b', page: 'left', box: 'hero', source: 'p2' } });
  const cover = newResolution(undefined);
  assert.deepEqual(cover, { minimumPpi: null, measured: 0, notMeasured: 0 });
  countResolution(cover, 150, { cover: true, box: 'front', source: 'p1' });
  assert.deepEqual(mergeResolution(found, cover), { minimumPpi: 180, measured: 3, notMeasured: 2, lowest: { ppi: 150, cover: true, box: 'front', source: 'p1' } });
  assert.deepEqual(mergeResolution(undefined, cover), cover);
  assert.deepEqual(mergeResolution(found, undefined), found);
});
