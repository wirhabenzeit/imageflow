import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectSummary } from '../src/desktop';
import { projectSchema } from '../src/project';
import { captureFact, captureLabel, captureWallTime, defaultPhotoView, isPhotoViewCommand, orderedPhotos, photoGroups, photoViewChange, propertyCommand, propertyCommands, shownMarks, showsProperty, validPhotoView } from '../src/photo-view';
import { propertySpec, readPhotoMarks, sourceProperties } from '../src/source-properties';
import { sourceList } from '../src/source-items';
const summary: ProjectSummary = { id: 'x', folder: 'Book', photos: {}, photoSizes: {}, texts: {},
  project: projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [] }),
  photoIndex: { b: { path: 'b.jpg', title: 'Photo 10' }, no: { path: 'no.jpg' }, a: { path: 'a.jpg', title: 'Photo 2' }, c: { path: 'c.jpg' } },
  photoDates: { b: { captured: '2026-11-03T00:20:00+02:00' }, a: { captured: '2026-11-02T23:50:00+02:00' }, c: { captured: '2026-11-03T07:00:00+02:00' } } };
test('capture sorting uses camera wall time, stable undated import order, and natural name sorting', () => {
  assert.deepEqual(orderedPhotos(summary), ['a', 'b', 'c', 'no']);
  assert.deepEqual(orderedPhotos(summary, { ...defaultPhotoView, sort: 'import' }), ['b', 'no', 'a', 'c']);
  assert.ok(orderedPhotos(summary, { ...defaultPhotoView, sort: 'name' }).indexOf('a') < orderedPhotos(summary, { ...defaultPhotoView, sort: 'name' }).indexOf('b'));
  assert.deepEqual(orderedPhotos({ ...summary, photoIndex: { x: { path: 'x' }, y: { path: 'y' } }, photoDates: {} }), ['x', 'y']);
});
test('mixed camera offsets, unknown offsets, and estimated mtimes use consistent local dates and gaps', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Zurich';
  try {
    const mixed = { ...summary, photoIndex: { camera: { path: 'camera.jpg' }, phone: { path: 'phone.jpg' }, file: { path: 'file.jpg' } },
      photoDates: {
        camera: { captured: '2026-07-05T01:00:00' },
        phone: { captured: '2026-07-05T01:15:00+02:00' },
        file: { captured: '2026-07-04T23:30:00.000Z', capturedEstimated: true },
      } };
    assert.deepEqual(orderedPhotos(mixed), ['camera', 'phone', 'file']);
    const ids = Object.keys(mixed.photoIndex);
    assert.deepEqual(photoGroups(mixed, ids, { ...defaultPhotoView, group: 'gap' }).map(group => group.ids), [['camera', 'phone', 'file']]);
    assert.equal(photoGroups(mixed, ids, { ...defaultPhotoView, group: 'day' })[0].id, '2026-07-05');
    const local = captureWallTime(mixed.photoDates.file.captured, true)!;
    assert.equal(local, '2026-07-05T01:30:00');
    assert.equal(captureLabel(mixed.photoDates.file.captured, true), captureLabel(local));
    assert.equal(captureFact(mixed.photoDates.file)?.value, new Date(local + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }));
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
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
test('a view saved before the marks takes each property\'s default, and keeps only toggles of declared properties', () => {
  const before = validPhotoView({ sort: 'name', group: 'none', gapMinutes: 120, showTime: true, showSource: true });
  assert.equal('sourceProps' in before, false);
  assert.equal(showsProperty(before, propertySpec('lightroom:rating')!), true);
  assert.equal(showsProperty(before, propertySpec('lightroom:flag')!), true);
  assert.equal(showsProperty(before, propertySpec('lightroom:color')!), false);
  assert.equal(showsProperty(before, propertySpec('photos:favorite')!), true);
  // A property a later build declares, or a value that is no boolean, is dropped.
  const saved = validPhotoView({ sourceProps: { 'lightroom:rating': false, 'lightroom:color': true, 'lightroom:stacks': true, 'photos:favorite': 'yes' } });
  assert.deepEqual(saved.sourceProps, { 'lightroom:rating': false, 'lightroom:color': true });
  assert.equal(validPhotoView({ sourceProps: ['lightroom:rating'] }).sourceProps, undefined);
  assert.equal(validPhotoView({ sourceProps: null }).sourceProps, undefined);
});
test('each declared property has a toggle command, which flips what is shown and keeps the other toggles', () => {
  const specs = sourceProperties.flatMap(({ properties }) => properties);
  assert.deepEqual(specs.map(({ id }) => propertyCommand(id)), [...propertyCommands]);
  for (const id of propertyCommands) assert.ok(isPhotoViewCommand(id), id);
  assert.deepEqual(photoViewChange('photos-show-lightroom-color', defaultPhotoView), { sourceProps: { 'lightroom:color': true } });
  const view = validPhotoView({ ...defaultPhotoView, ...photoViewChange('photos-show-lightroom-rating', defaultPhotoView) });
  assert.deepEqual(view.sourceProps, { 'lightroom:rating': false });
  assert.deepEqual(photoViewChange('photos-show-photos-favorite', view), { sourceProps: { 'lightroom:rating': false, 'photos:favorite': false } });
  assert.deepEqual(photoViewChange('photos-show-lightroom-rating', view), { sourceProps: { 'lightroom:rating': true } });
  // The commands before the marks are as they were.
  assert.deepEqual(photoViewChange('photos-show-source', defaultPhotoView), { showSource: false });
  assert.deepEqual(photoViewChange('photos-show-time', defaultPhotoView), { showTime: true });
});
test('the thumbnails show the marks whose properties are toggled on', () => {
  const marks = readPhotoMarks('lightroom', { rating: 3, flag: 'reject', color: 'blue' });
  assert.deepEqual(shownMarks(defaultPhotoView, marks).map(({ spec }) => spec.id), ['lightroom:rating', 'lightroom:flag']);
  assert.deepEqual(shownMarks({ ...defaultPhotoView, sourceProps: { 'lightroom:flag': false, 'lightroom:color': true } }, marks).map(({ spec }) => spec.id),
    ['lightroom:rating', 'lightroom:color']);
});
