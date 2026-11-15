import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetPageLabels, assetUsage, clearFileAssignments, fileAssigned, fileExtensions, usageLabel } from '../src/asset-usage';
import { assetMenu } from '../src/asset-menu';
import type { ProjectSummary } from '../src/desktop';
import { projectSchema } from '../src/project';
test('Assets and placement menus use the same page labels as the book canvas', () => {
  const summary: ProjectSummary = { id: 'book', folder: 'Book', photos: {}, photoSizes: {}, texts: {},
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

test('a file held in a list item counts as used, and clearing takes it out of every scope', () => {
  const project = projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' },
    params: { route: 'a' }, files: { a: 'files/a.gpx', b: 'files/b.gpx', c: 'files/c.gpx' },
    spreads: [{ id: 's', definition: 'x', params: {}, boxes: {}, elements: { map: { params: { tracks: [{ id: 'one', track: 'b', label: 'Ride' }, { id: 'two', track: 'c' }] } } } }] });
  const usage = assetUsage({ project, photoIndex: {} }, ['2–3']);
  assert.deepEqual(usage.file.b, [{ spread: 's', pages: '2–3' }]);
  assert.equal(usage.file.c?.length, 1);
  assert.equal(fileAssigned(project, 'b'), true);
  clearFileAssignments(project, ['a', 'b']);
  assert.deepEqual(project.params, {});
  assert.deepEqual(project.spreads[0].elements.map.params, { tracks: [{ id: 'one', label: 'Ride' }, { id: 'two', track: 'c' }] });
  assert.equal(fileAssigned(project, 'a'), false);
  assert.equal(fileAssigned(project, 'c'), true);
});

test('the template\'s file parameters decide which file types can be imported', () => {
  const file = (accept: string[]) => ({ label: 'File', type: 'file' as const, default: '' as const, accept });
  const template = { parameters: { logo: file(['.svg']) }, spreads: { map: { parameters: {}, boxes: {},
    elements: { route: { parameters: { track: file(['.gpx', '.kml']), tracks: { label: 'Tracks', type: 'list' as const, item: { track: file(['.gpx', '.fit']) }, default: [] } } } } } } };
  assert.deepEqual(fileExtensions(template).sort(), ['.fit', '.gpx', '.kml', '.svg']);
  assert.deepEqual(fileExtensions(undefined), []);
  assert.equal(usageLabel('4–5'), 'Pages 4–5');
  assert.equal(usageLabel('Book settings'), 'Book settings');
});
