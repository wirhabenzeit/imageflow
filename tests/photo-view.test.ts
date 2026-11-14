import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectSummary } from '../src/desktop';
import { projectSchema } from '../src/project';
import { captureLabel, defaultPhotoView, orderedPhotos, photoGroups, photoViewChange, validPhotoView } from '../src/photo-view';
import { sourceList } from '../src/source-items';
const summary: ProjectSummary = { id: 'x', folder: 'Book', readOnly: false, photos: {}, photoSizes: {}, texts: {},
  project: projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [] }),
  photoIndex: { b: { path: 'b.jpg', title: 'Photo 10', captured: '2026-11-03T00:20:00+02:00' },
    no: { path: 'no.jpg' }, a: { path: 'a.jpg', title: 'Photo 2', captured: '2026-11-02T23:50:00+02:00' },
    c: { path: 'c.jpg', captured: '2026-11-03T07:00:00+02:00' } } };
test('capture sorting uses offsets, stable undated import order, and natural name sorting', () => {
  assert.deepEqual(orderedPhotos(summary), ['a', 'b', 'c', 'no']);
  assert.deepEqual(orderedPhotos(summary, { ...defaultPhotoView, sort: 'import' }), ['b', 'no', 'a', 'c']);
  assert.ok(orderedPhotos(summary, { ...defaultPhotoView, sort: 'name' }).indexOf('a') < orderedPhotos(summary, { ...defaultPhotoView, sort: 'name' }).indexOf('b'));
  assert.deepEqual(orderedPhotos({ ...summary, photoIndex: { x: { path: 'x' }, y: { path: 'y' } } }), ['x', 'y']);
});
test('day groups keep camera dates and filtered group counts, with undated photos trailing', () => {
  const view = { ...defaultPhotoView, group: 'day' as const };
  const groups = photoGroups(summary, ['b', 'no'], view);
  assert.deepEqual(groups.map(({ id, ids, total }) => ({ id, ids, total })), [{ id: '2026-11-03', ids: ['b'], total: 2 }, { id: 'undated', ids: ['no'], total: 1 }]);
  assert.deepEqual(sourceList(summary, 'photo', view).map(({ id }) => id), ['a', 'b', 'c', 'no']);
});
test('time gaps can join an outing across midnight, and custom view options are bounded', () => {
  const groups = photoGroups(summary, ['a', 'b', 'c', 'no'], { ...defaultPhotoView, group: 'gap' });
  assert.deepEqual(groups.map(({ ids }) => ids), [['a', 'b'], ['c'], ['no']]);
  assert.deepEqual(photoViewChange('photos-gap-360', defaultPhotoView), { group: 'gap', gapMinutes: 360 });
  assert.deepEqual(photoViewChange('photos-sort-name', defaultPhotoView), { sort: 'name' });
  assert.equal(validPhotoView({ gapMinutes: -1 }).gapMinutes, 120);
  assert.equal(validPhotoView(null).sort, 'capture');
  assert.ok(captureLabel('2026-11-02T14:39:00-05:00').includes('14:39') || captureLabel('2026-11-02T14:39:00-05:00').includes('2:39'));
});
