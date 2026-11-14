import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetPageLabels, assetUsage } from '../src/asset-usage';
import { assetMenu } from '../src/asset-menu';
import type { ProjectSummary } from '../src/desktop';
import { projectSchema } from '../src/project';
test('Assets and placement menus use the same page labels as the book canvas', () => {
  const summary: ProjectSummary = { id: 'book', folder: 'Book', readOnly: false, photos: {}, photoSizes: {}, texts: {},
    pageLabels: { one: '4–5' }, photoIndex: { photo: { path: 'photos/photo.jpg' } },
    project: projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [
      { id: 'one', definition: 'full', boxes: { hero: { photo: 'photo' } } },
    ] }) };
  assert.deepEqual(assetPageLabels(summary), ['4–5']);
  const placements = assetMenu(summary, ['photo:photo']).find(item => typeof item === 'object' && 'command' in item && item.command === 'asset-placements');
  assert.ok(placements && typeof placements === 'object' && 'items' in placements);
  assert.equal(placements.items?.[0] && typeof placements.items[0] === 'object' && 'label' in placements.items[0] ? placements.items[0].label : undefined, 'Pages 4–5');
});

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
