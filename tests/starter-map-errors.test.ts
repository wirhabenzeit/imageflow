import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLoadError } from '../sample/starter/template/map-errors';

const providers = { 'https://tiles.openfreemap.org': 'OpenFreeMap (map tiles)', 'https://tiles.mapterhorn.com': 'Mapterhorn (elevation for contour lines)' };

test('a failed elevation tile names Mapterhorn and its status, without suggesting a permission problem', () => {
  const text = describeLoadError(new Error('Bad response: 503 for https://tiles.mapterhorn.com/5/16/6.webp'), providers);
  assert.equal(text, 'Mapterhorn (elevation for contour lines) answered HTTP 503 for https://tiles.mapterhorn.com/5/16/6.webp. Try again later, or move the map a little.');
  assert.doesNotMatch(text, /openfreemap/i);
});

test('MapLibre tile errors keep their provider and status', () => {
  const text = describeLoadError(new Error('AJAXError: Not Found (404): https://tiles.openfreemap.org/planet/20261101/7/88/47.pbf'), providers);
  assert.match(text, /^OpenFreeMap \(map tiles\) answered HTTP 404 for https:\/\/tiles\.openfreemap\.org\/planet\/20261101\/7\/88\/47\.pbf\./);
  assert.match(describeLoadError(Object.assign(new Error('Not Found'), { status: 404 }), providers), /^A map site answered HTTP 404\. /);
});

test('only an unreachable site mentions that the book may need to be allowed to load from it', () => {
  const text = describeLoadError(new TypeError('Failed to fetch https://tiles.openfreemap.org/planet.'), providers);
  assert.equal(text, 'OpenFreeMap (map tiles) could not be reached (https://tiles.openfreemap.org/planet). Check the internet connection, and that this book may load from https://tiles.openfreemap.org.');
  assert.equal(describeLoadError(new Error('Style is not done loading'), providers), 'Style is not done loading');
});
