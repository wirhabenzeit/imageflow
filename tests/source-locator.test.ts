import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portablePhotos } from '../src/book-revision';
import { parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import { sourceEntries, sourceFile, sourceReach } from '../src/source-locations';
import { adoptedEntry, entryReach, lightroomLocator, linkedLocator, packageLocator, registerLocatorKind, sharedEntry } from '../src/source-locator';
import type { LocatorFields, LocatorKind, Reach } from '../src/source-locator';
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
    assert.equal(kind.key(locator), sourceFile(source)!.path);
    assert.equal(kind.provider === 'linked', sourceFile(source)!.linked);
    assert.equal(kind.name(locator), source.name);
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

test('a kind declares its reach, and only a kind of reach mac leaves part of its locator on its Mac', () => {
  assert.deepEqual([packageLocator.reach, linkedLocator.reach, lightroomLocator.reach], ['book', 'mac', 'mac']);
  assert.deepEqual(Object.values(photos).map(entryReach), ['book', 'mac']);
  assert.deepEqual(sourceEntries({ project: { ...project, texts: { own: 'texts/a.md', far: { path: '/Users/me/a.md', linked: true } } }, photoIndex: photos }).map(sourceReach), ['book', 'mac', 'book', 'mac']);
  // A kind whose `shared` and `adopt` would change the locator: they are asked only where the reach is `mac`.
  const kind = (provider: 'near' | 'far', reach: Reach): LocatorKind<{ provider: 'near' | 'far'; at: string }> => ({ provider, reach, fields: [provider],
    read: (entry) => typeof entry[provider] === 'string' ? { provider, at: entry[provider] } : undefined, write: ({ at }) => ({ [provider]: at }),
    portable: () => ({ [provider]: true }), shared: (locator) => ({ ...locator, at: 'shared' }), adopt: (shared, here) => here ?? { ...shared, at: 'unlocated' },
    key: ({ at }) => at, name: ({ at }) => at });
  const unregister = [registerLocatorKind(kind('near', 'mac')), registerLocatorKind(kind('far', 'online'))];
  try {
    assert.deepEqual(sharedEntry({ near: '/here', title: 'T' }), { near: 'shared', title: 'T' });
    assert.deepEqual(sharedEntry({ far: 'https://there', title: 'T' }), { far: 'https://there', title: 'T' });
    assert.deepEqual(adoptedEntry({ near: 'shared' }, { near: '/mine' }), { near: '/mine' });
    assert.deepEqual(adoptedEntry({ near: 'shared' }, undefined), { near: 'unlocated' });
    assert.deepEqual(adoptedEntry({ far: 'https://there' }, { far: 'https://elsewhere' }), { far: 'https://there' }, 'the snapshot’s, whole');
  } finally { unregister.forEach((remove) => remove()); }
});
