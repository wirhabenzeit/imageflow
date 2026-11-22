import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portablePhotos } from '../src/book-revision';
import { parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import { sourceEntries } from '../src/source-locations';
import { localLocator } from '../src/source-locator';
import { portableManifests, projectManifests } from '../src/sync-snapshot';

// The `local` locator must describe today's photos.json entries exactly as the code that reads `path` and `linked`
// directly does, so that code can move behind it without a visible change (ADR 0011).
const photos = parseDocument(photoIndexSchema, {
  owned: { path: 'photos/ph-0123456789ab-Segla.jpg', title: 'Segla' },
  linked: { path: '/Volumes/Photos/Norway/DSC_0042.jpg', linked: true, caption: 'Fjord' },
}, 'photos.json');
const project = parseDocument(projectSchema, { schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [] }, 'project.json');
const locators = Object.fromEntries(Object.entries(photos).map(([id, entry]) => [id, localLocator.read(entry)!]));

test('a photos.json entry reads as a local locator and writes back the same fields', () => {
  assert.deepEqual(locators.owned, { provider: 'local', path: 'photos/ph-0123456789ab-Segla.jpg', linked: false });
  assert.deepEqual(locators.linked, { provider: 'local', path: '/Volumes/Photos/Norway/DSC_0042.jpg', linked: true });
  for (const [id, entry] of Object.entries(photos)) {
    const { title: _title, caption: _caption, ...own } = entry;
    assert.deepEqual(localLocator.write(locators[id]), own);
    assert.deepEqual(Object.keys(own).every((key) => localLocator.fields.includes(key)), true);
  }
  assert.equal(localLocator.read({ lightroom: { catalog: 'c', uuid: 'u' } }), undefined);
});

test('the locator agrees with sourceEntries on path, linked and name', () => {
  for (const source of sourceEntries({ project, photoIndex: photos })) {
    const locator = locators[source.id];
    assert.equal(localLocator.key(locator), source.path);
    assert.equal(localLocator.owned(locator), !source.linked);
  }
  assert.equal(localLocator.name(locators.owned), 'Segla.jpg');
  assert.equal(localLocator.name(locators.linked), 'DSC_0042.jpg');
});

test('the portable form is what the book-state revision hashes today', () => {
  const portable = portablePhotos(photos);
  for (const [id, entry] of Object.entries(photos)) {
    const { path: _path, linked: _linked, ...rest } = entry;
    assert.deepEqual({ ...rest, ...localLocator.portable(locators[id]) }, portable[id]);
  }
});

test('the shared and adopted forms are what a sync snapshot carries and a pull writes today', () => {
  const snapshot = portableManifests(project, photos);
  for (const id of Object.keys(photos)) {
    assert.equal(localLocator.shared(locators[id]).path, (snapshot.photos[id] as { path: string }).path);
  }
  const here = { linked: { path: '/Users/me/Pictures/DSC_0042.jpg', linked: true as const } };
  for (const local of [here, {}]) {
    const pulled = projectManifests(snapshot, { photos: local }).photos as Record<string, { path: string }>;
    for (const id of Object.keys(photos)) {
      const mine = (local as Record<string, { path: string }>)[id];
      const adopted = localLocator.adopt(localLocator.shared(locators[id]), mine ? localLocator.read(mine) : undefined);
      assert.equal(adopted.path, pulled[id].path);
    }
  }
});
