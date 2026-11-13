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
