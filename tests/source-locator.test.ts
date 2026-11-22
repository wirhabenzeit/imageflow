import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portablePhotos } from '../src/book-revision';
import { parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import { sourceEntries } from '../src/source-locations';
import { linkedLocator, packageLocator } from '../src/source-locator';
import type { LocatorFields } from '../src/source-locator';
import { portableManifests, projectManifests } from '../src/sync-snapshot';

// The `package` and `linked` locators must describe today's photos.json entries exactly as the code that reads `path` and `linked`
// directly does, so that code can move behind it without a visible change (ADR 0011).
const photos = parseDocument(photoIndexSchema, {
  owned: { path: 'photos/ph-0123456789ab-Segla.jpg', title: 'Segla' },
  linked: { path: '/Volumes/Photos/Norway/DSC_0042.jpg', linked: true, caption: 'Fjord' },
}, 'photos.json');
const project = parseDocument(projectSchema, { schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [] }, 'project.json');
// Exactly one of the two claims an entry.
const kindOf = (entry: LocatorFields) => {
  const [owned, linked] = [packageLocator.read(entry), linkedLocator.read(entry)];
  assert.equal(!owned, !!linked);
  // One shape for the assertions below; each kind only ever gets its own locators.
  return (linked ? { kind: linkedLocator, locator: linked } : { kind: packageLocator, locator: owned }) as { kind: typeof linkedLocator; locator: ReturnType<typeof linkedLocator.read> & {} };
};
const read = Object.fromEntries(Object.entries(photos).map(([id, entry]) => [id, kindOf(entry)]));

test('a photos.json entry reads as a package or a linked locator and writes back the same fields', () => {
  assert.deepEqual(read.owned.locator, { provider: 'package', path: 'photos/ph-0123456789ab-Segla.jpg' });
  assert.deepEqual(read.linked.locator, { provider: 'linked', path: '/Volumes/Photos/Norway/DSC_0042.jpg' });
  for (const [id, entry] of Object.entries(photos)) {
    const { title: _title, caption: _caption, ...own } = entry;
    const { kind, locator } = read[id];
    assert.deepEqual(kind.write(locator), own);
    assert.equal(Object.keys(own).every((key) => kind.fields.includes(key)), true);
  }
  for (const kind of [packageLocator, linkedLocator]) assert.equal(kind.read({ lightroom: { catalog: 'c', uuid: 'u' } }), undefined);
});

test('the locators agree with sourceEntries on path, linked and name', () => {
  for (const source of sourceEntries({ project, photoIndex: photos })) {
    const { kind, locator } = read[source.id];
    assert.equal(kind.key(locator), source.path);
    assert.equal(kind.provider === 'linked', source.linked);
  }
  assert.equal(read.owned.kind.name(read.owned.locator), 'Segla.jpg');
  assert.equal(read.linked.kind.name(read.linked.locator), 'DSC_0042.jpg');
});

test('the portable form is what the book-state revision hashes today', () => {
  const portable = portablePhotos(photos);
  for (const [id, entry] of Object.entries(photos)) {
    const { path: _path, linked: _linked, ...rest } = entry;
    assert.deepEqual({ ...rest, ...read[id].kind.portable(read[id].locator) }, portable[id]);
  }
});

test('the shared and adopted forms are what a sync snapshot carries and a pull writes today', () => {
  const snapshot = portableManifests(project, photos);
  for (const id of Object.keys(photos)) {
    assert.equal(read[id].kind.shared(read[id].locator).path, (snapshot.photos[id] as { path: string }).path);
  }
  const here = { linked: { path: '/Users/me/Pictures/DSC_0042.jpg', linked: true as const } };
  for (const local of [here, {}]) {
    const pulled = projectManifests(snapshot, { photos: local }).photos as Record<string, { path: string }>;
    for (const id of Object.keys(photos)) {
      const { kind, locator } = read[id];
      const mine = (local as Record<string, LocatorFields>)[id];
      // The host hands in this Mac's locator only when it is of the same provider.
      assert.equal(kind.adopt(kind.shared(locator), mine ? kind.read(mine) : undefined).path, pulled[id].path);
    }
  }
});
