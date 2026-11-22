import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portablePhotos } from '../src/book-revision';
import { bookFormatOf, parseDocument, photoIndexSchema, projectSchema } from '../src/project';
import { photoName, sourceEntries, sourceFile, sourceProvider } from '../src/source-locations';
import { adoptedEntry, lightroomLocator, locatorOf, portableEntry, readLocator, relocatedEntry, sharedEntry } from '../src/source-locator';
import { portableManifests, projectManifests } from '../src/sync-snapshot';

// The `lightroom` locator of ADR 0011, section 1: `{ lightroom: { catalog, uuid, name? } }` in photos.json. This build
// reads it everywhere (renderer, sync, MCP), not only where its provider runs.

const catalog = 'C0FFEE00-0000-4000-8000-000000000001';
const uuid = '6A0D2D52-0D4E-4B1E-9B9B-8F2E9C5E4D1A';
const project = parseDocument(projectSchema, { schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [] }, 'project.json');

test('an entry reads as a Lightroom locator and writes back the same fields', () => {
  const entry = { lightroom: { catalog, uuid, name: 'DSC_0042.ARW' }, caption: 'Fjord' };
  const locator = readLocator(entry);
  assert.deepEqual(locator, { provider: 'lightroom', catalog, uuid, name: 'DSC_0042.ARW' });
  assert.deepEqual(lightroomLocator.write(locator as never), { lightroom: entry.lightroom });
  assert.deepEqual(lightroomLocator.write({ provider: 'lightroom', catalog, uuid }), { lightroom: { catalog, uuid } }, 'no name, no key');
  // A name that is not a plain file name is left out; identifiers that are not Lightroom's are not read at all.
  assert.deepEqual(readLocator({ lightroom: { catalog, uuid, name: '../../etc/passwd' } }), { provider: 'lightroom', catalog, uuid });
  for (const bad of [{ catalog: '../x', uuid }, { catalog, uuid: 'a b' }, { catalog, uuid: 7 }, { catalog }, null, 'x', { catalog: 'short', uuid }]) {
    assert.equal(readLocator({ lightroom: bad }), undefined, JSON.stringify(bad));
  }
  // A Lightroom entry is never a file, and a file entry never a Lightroom one.
  assert.equal(lightroomLocator.read({ path: 'photos/a.jpg' }), undefined);
  assert.equal(locatorOf({ path: 'photos/a.jpg', lightroom: { catalog, uuid } }).provider, 'package', 'a path wins: older builds read it');
  assert.equal(lightroomLocator.key({ provider: 'lightroom', catalog, uuid }), lightroomLocator.key({ provider: 'lightroom', catalog: catalog.toLowerCase(), uuid: uuid.toLowerCase() }));
});

test('a book holding Lightroom photos is format 4, and lists them by name without a file', () => {
  const photos = parseDocument(photoIndexSchema, { lr: { lightroom: { catalog, uuid, name: 'DSC_0042.ARW' } }, own: { path: 'photos/a.jpg' } }, 'photos.json');
  assert.equal(bookFormatOf(project, photos), 4);
  const [entry] = sourceEntries({ project, photoIndex: { lr: photos.lr } });
  assert.equal(entry.name, 'DSC_0042.ARW');
  assert.equal(sourceFile(entry), undefined);
  assert.equal(sourceProvider(entry), 'lightroom');
  assert.equal(photoName({ photoIndex: photos }, 'lr'), 'DSC_0042.ARW');
  assert.equal(photoName({ photoIndex: { lr: { ...photos.lr, title: 'Mine' } }, photoProvided: { lr: { title: 'Lightroom title' } } }, 'lr'), 'Mine');
  assert.equal(photoName({ photoIndex: photos, photoProvided: { lr: { title: 'Lightroom title' } } }, 'lr'), 'Lightroom title');
});

test('the portable, shared and adopted forms are the same on every Mac', () => {
  // Typed as photos.json entries are once read: the locator's fields are opaque to the host's type.
  const photos = { lr: { lightroom: { catalog, uuid, name: 'DSC_0042.ARW' }, title: 'T' } } as Record<string, never> & { lr: { lightroom: { catalog: string; uuid: string; name: string }; title: string } };
  assert.deepEqual(portableEntry(photos.lr), { lightroom: { catalog, uuid }, title: 'T' }, 'the name is a hint and not counted');
  assert.deepEqual(portablePhotos(photos).lr, { lightroom: { catalog, uuid }, title: 'T' });
  assert.deepEqual(portablePhotos({ lr: { ...photos.lr, lightroom: { ...photos.lr.lightroom, name: 'other.dng' } } } as never), portablePhotos(photos));
  assert.deepEqual(sharedEntry(photos.lr), photos.lr);
  const snapshot = portableManifests(project, photos);
  assert.deepEqual(snapshot.photos.lr, photos.lr);
  assert.deepEqual(projectManifests(snapshot, { photos: {} }).photos.lr, photos.lr);
  assert.deepEqual(adoptedEntry(photos.lr, { path: 'photos/x.jpg' }), photos.lr);
  // Copy into Book replaces the locator's fields only.
  assert.deepEqual(relocatedEntry(photos.lr, { provider: 'package', path: 'photos/ph-1-a.jpg' } as never), { title: 'T', path: 'photos/ph-1-a.jpg' });
});
