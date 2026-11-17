import assert from 'node:assert/strict';
import test from 'node:test';
import { PreviewPictureCache } from '../desktop/preview-picture-cache';
import { previewPictureUrl } from '../src/preview-picture';

const get = (cache: PreviewPictureCache, key: string, scope = 'template + permission') =>
  cache.respond(new Request('https://cache.test/picture'), scope, key);
const put = (cache: PreviewPictureCache, key: string, bytes: number[], scope = 'template + permission') =>
  cache.respond(new Request('https://cache.test/picture', { method: 'PUT', body: new Uint8Array(bytes),
    headers: { 'Content-Type': 'image/png' } }), scope, key);

test('thumbnail pictures survive render sessions, while template and permission scopes stay separate', async () => {
  const cache = new PreviewPictureCache();
  assert.equal((await put(cache, 'map', [1, 2, 3])).status, 204);
  const hit = await get(cache, 'map');
  assert.equal(hit.headers.get('Content-Type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await hit.arrayBuffer())], [1, 2, 3]);
  assert.equal((await get(cache, 'map', 'changed template')).status, 404);
  assert.equal((await get(cache, 'map', 'network denied')).status, 404);
  cache.clear();
  assert.equal((await get(cache, 'map')).status, 404);
});

test('thumbnail memory is bounded and evicts the least recently used picture', async () => {
  const cache = new PreviewPictureCache(6, 4);
  await put(cache, 'a', [1, 2, 3]);
  await put(cache, 'b', [4, 5, 6]);
  await get(cache, 'a');
  await put(cache, 'c', [7, 8, 9]);
  assert.equal((await get(cache, 'b')).status, 404);
  assert.equal((await get(cache, 'a')).status, 200);
  assert.equal((await put(cache, 'huge', [1, 2, 3, 4, 5])).status, 413);
  await put(cache, 'a', [10]);
  await put(cache, 'd', [1, 2]);
  assert.equal((await get(cache, 'c')).status, 200, 'Replacing an entry updates the memory accounting');
  const smallPictures = new PreviewPictureCache(1000, 100, 2);
  for (const key of ['a', 'b', 'c']) await put(smallPictures, key, [1]);
  assert.equal((await get(smallPictures, 'a')).status, 404, 'Entry count also bounds tiny pictures and their metadata');
});

test('thumbnail identity includes drawing inputs and output resolution, without a render-session ID', async () => {
  const identity = ['map', 0, { longitude: 17, latitude: 69 }, 2200, 1100, .5];
  const before = await previewPictureUrl('/session-one/picture/', identity);
  const revisit = await previewPictureUrl('/session-two/picture/', identity);
  assert.equal(before.split('/').at(-1), revisit.split('/').at(-1));
  assert.notEqual(await previewPictureUrl('/session-one/picture/', [...identity, 'changed']), before);
  assert.notEqual(await previewPictureUrl('/session-one/picture/', identity.with(5, 1)), before);
});

test('one picture saved under several keys is stored once and stays while any key names it', async () => {
  const cache = new PreviewPictureCache(10, 10);
  for (const key of ['drawing', 'vector', 'place']) assert.equal((await put(cache, key, [1, 2, 3, 4, 5, 6])).status, 204);
  assert.equal(cache.size, 6, 'Three keys of identical bytes take the memory of one picture');
  await put(cache, 'other', [9, 9, 9, 9]);
  assert.equal(cache.size, 10);
  // A new picture needs room: the least recently used keys go, and their bytes only once no key is left.
  await put(cache, 'new', [7, 7, 7, 7]);
  assert.equal((await get(cache, 'drawing')).status, 404);
  assert.equal(cache.size, 8, 'The shared picture went with its last key');
  assert.equal((await get(cache, 'other')).status, 200);
  const same = new PreviewPictureCache(6, 6, 2);
  await put(same, 'a', [1, 2, 3]);
  await put(same, 'b', [4, 5, 6]);
  await put(same, 'c', [4, 5, 6]);
  assert.equal(same.size, 3, 'Evicting another key of the reused picture keeps it accounted once');
  assert.deepEqual([...new Uint8Array(await (await get(same, 'c')).arrayBuffer())], [4, 5, 6]);
});

test('book windows share one cache, and closing a book releases only what no other open book uses', async () => {
  const cache = new PreviewPictureCache();
  const one = cache.view('one'), two = cache.view('two');
  const request = (bytes?: number[]) => new Request('https://cache.test/picture', bytes ? { method: 'PUT', body: new Uint8Array(bytes),
    headers: { 'Content-Type': 'image/webp' } } : {});
  await one.respond(request([1]), 'scope', 'mine');
  await one.respond(request([2]), 'scope', 'shared');
  assert.equal((await two.respond(request(), 'scope', 'shared')).status, 200);
  one.clear();
  assert.equal((await two.respond(request(), 'scope', 'mine')).status, 404);
  assert.equal((await two.respond(request(), 'scope', 'shared')).status, 200, 'A picture the other open book used stays');
  two.clear();
  assert.equal(cache.size, 0);
});

test('the budget follows the computer’s memory, between 1 and 4 GiB', async () => {
  const { previewPictureBudget } = await import('../desktop/preview-picture-cache');
  const GiB = 1024 ** 3;
  assert.equal(previewPictureBudget(4 * GiB), GiB);
  assert.equal(previewPictureBudget(16 * GiB), 2 * GiB);
  assert.equal(previewPictureBudget(128 * GiB), 4 * GiB);
});
