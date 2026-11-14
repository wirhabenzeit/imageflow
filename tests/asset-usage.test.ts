import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetUsage } from '../src/asset-usage';
import { projectSchema } from '../src/project';

test('unused detection includes document, layout, box and element parameter references', () => {
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' },
    params: { cover: 'cover', file: 'route' }, files: { route: 'files/route.gpx' }, texts: { story: 'texts/story.md' },
    spreads: [{ id: 's', definition: 'a', params: { photo: 'map' }, boxes: { other: { params: { alternate: 'alternate' } } }, elements: { stamp: { params: { text: 'story' } } } }] });
  const usage = assetUsage({ project, photoIndex: Object.fromEntries(['cover', 'map', 'alternate', 'unused'].map((id) => [id, { path: 'photos/' + id + '.jpg' }])) }, ['2–3']);
  assert.equal(usage.photo.cover[0].pages, 'Book settings');
  assert.equal(usage.photo.map[0].spread, 's');
  assert.equal(usage.photo.alternate[0].spread, 's');
  assert.equal(usage.text.story[0].spread, 's');
  assert.equal(usage.file.route[0].pages, 'Book settings');
  assert.equal(usage.photo.unused, undefined);
});
