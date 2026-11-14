import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { photoDetails } from '../desktop/photos';
import { importIntoProject, loadProject, renderData, updateProject } from '../desktop/project';
import { configureSourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { captureMetadata, exifDateTime, exifOffset } from '../src/photo-metadata';
import { photoIndexSchema } from '../src/project';
import { projectOperationsSchema } from '../src/project-commands';

type Exif = Parameters<ReturnType<typeof sharp>['withExif']>[0];
const jpeg = (exif?: Exif, width = 60, height = 40) => {
  const image = sharp({ create: { width, height, channels: 3, background: '#8a9' } }).jpeg();
  return (exif ? image.withExif(exif) : image).toBuffer();
};
const exifOf = async (exif?: Exif) => (await sharp(await jpeg(exif)).metadata()).exif;
const full: Exif = {
  IFD0: { Make: 'FUJIFILM', Model: 'X-T5' },
  IFD2: { DateTimeOriginal: '2024:06:01 18:20:30', OffsetTimeOriginal: '+02:00' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '46/1 33/1 36/1', GPSLongitudeRef: 'E', GPSLongitude: '7/1 58/1 30/1' },
};

test('capture time, offset, GPS and camera are normalized from EXIF', async () => {
  assert.deepEqual(captureMetadata(await exifOf(full)), {
    captured: { dateTime: '2024-06-01T18:20:30', offset: '+02:00' },
    location: { latitude: 46.56, longitude: 7.975 },
    camera: { make: 'FUJIFILM', model: 'X-T5' },
  });
  // South and west are negative. A missing offset is an unknown time zone, not UTC.
  assert.deepEqual(captureMetadata(await exifOf({ IFD2: { DateTimeOriginal: '2023:12:31 23:59:59' },
    IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '70/1 30/1 0/1' } })), {
    captured: { dateTime: '2023-12-31T23:59:59', offset: null },
    location: { latitude: -33.85, longitude: -70.5 },
  });
  // Only the digitized time: used, with its own offset.
  assert.deepEqual(captureMetadata(await exifOf({ IFD2: { DateTimeDigitized: '2020:02:29 08:00:00', OffsetTimeDigitized: '-05:00' } })).captured,
    { dateTime: '2020-02-29T08:00:00', offset: '-05:00' });
});

test('missing, stripped, placeholder and out-of-range metadata is left out, never guessed', async () => {
  assert.deepEqual(captureMetadata(undefined), {});
  assert.deepEqual(captureMetadata(await exifOf()), {});
  assert.deepEqual(captureMetadata(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), {});
  // Truncated EXIF: whatever cannot be read is dropped without throwing.
  const truncated = (await exifOf(full))!;
  for (const length of [10, 30, 60, 120, truncated.length - 20]) assert.doesNotThrow(() => captureMetadata(truncated.subarray(0, length)));
  assert.deepEqual(captureMetadata(await exifOf({ IFD2: { DateTimeOriginal: '0000:00:00 00:00:00', OffsetTimeOriginal: '+02:00' },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '95/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '7/1 0/1 0/1' }, IFD0: { Make: '   ' } })), {});
  // No hemisphere, a zero denominator or a void fix: no location. A modification time alone is no capture time.
  assert.equal(captureMetadata(await exifOf({ IFD3: { GPSLatitude: '46/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '7/1 0/1 0/1' } })).location, undefined);
  assert.equal(captureMetadata(await exifOf({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '46/0 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '7/1 0/1 0/1' } })).location, undefined);
  assert.equal(captureMetadata(await exifOf({ IFD3: { GPSStatus: 'V', GPSLatitudeRef: 'N', GPSLatitude: '46/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '7/1 0/1 0/1' } })).location, undefined);
  assert.equal(captureMetadata(await exifOf({ IFD0: { DateTime: '2024:06:01 18:20:30' } })).captured, undefined);
  assert.equal(exifDateTime('2023:02:29 10:00:00'), undefined);
  assert.equal(exifDateTime('2024:13:01 10:00:00'), undefined);
  assert.equal(exifOffset('+15:00'), null);
  assert.equal(exifOffset('-00:00'), '+00:00');
  assert.equal(exifOffset('2 hours'), null);
});

test('photos import and load with capture metadata, existing books get it, and a replaced linked source refreshes it', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-capture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureSourceStore(join(root, 'source-cache'));
  configureSourceAccess(join(root, 'source-access'));
  const folder = join(root, 'Book.imageflow');
  const cache = join(root, 'cache');
  const external = join(root, 'external');
  await Promise.all([mkdir(cache), mkdir(external)]);
  await cp(resolve('sample/starter'), folder, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
  const owned = join(external, 'owned.jpg');
  const linked = join(external, 'linked.jpg');
  await writeFile(owned, await jpeg(full));
  await writeFile(linked, await jpeg({ IFD0: { Model: 'Phone' } }));
  // A photo without EXIF still imports and renders.
  const plain = join(external, 'plain.png');
  await sharp({ create: { width: 30, height: 30, channels: 3, background: '#000' } }).png().toFile(plain);
  assert.equal('captured' in await photoDetails(plain), false);

  let book = await loadProject(folder, cache);
  book = (await importIntoProject(book, { kind: 'photo', mode: 'copy' }, [owned, plain])).book;
  book = (await importIntoProject(book, { kind: 'photo', mode: 'link' }, [linked])).book;
  const linkedId = Object.entries(book.photoIndex).find(([, photo]) => photo.linked)![0];
  // Nothing extracted is written to photos.json: it is read from the files each time the book opens.
  const index = JSON.parse(await readFile(join(folder, 'photos.json'), 'utf8'));
  assert.equal(JSON.stringify(index).includes('FUJIFILM'), false);
  const reopened = await loadProject(folder, cache);
  const ownedPhoto = [...reopened.photos.entries()].find(([, photo]) => photo.camera?.make === 'FUJIFILM');
  assert.ok(ownedPhoto, 'the copied photo has its camera');
  assert.deepEqual(ownedPhoto[1].captured, { dateTime: '2024-06-01T18:20:30', offset: '+02:00' });
  const data = renderData(reopened, 'id', 'export');
  assert.deepEqual(data.photos[ownedPhoto[0]].location, { latitude: 46.56, longitude: 7.975 });
  assert.deepEqual(data.photos[linkedId].camera, { model: 'Phone' });
  assert.equal(data.photos[linkedId].captured, undefined);

  // User-written metadata is kept beside it, and saving the book changes nothing about the extracted fields.
  const files = structuredClone({ project: reopened.project, photoIndex: reopened.photoIndex });
  files.photoIndex[ownedPhoto[0]].caption = 'Lake';
  const saved = await updateProject(reopened, files);
  assert.equal(saved.photos.get(ownedPhoto[0])!.caption, 'Lake');
  assert.equal(saved.photos.get(ownedPhoto[0])!.camera?.model, 'X-T5');

  // Replacing the linked original refreshes its metadata on the next load, under the same photo ID.
  const replacement = join(external, 'replacement.jpg');
  await writeFile(replacement, await jpeg({ IFD0: { Make: 'Leica', Model: 'Q3' }, IFD2: { DateTimeOriginal: '2025:01:02 03:04:05' } }));
  await rename(replacement, linked);
  const refreshed = await loadProject(folder, cache);
  assert.deepEqual(refreshed.photos.get(linkedId)!.camera, { make: 'Leica', model: 'Q3' });
  assert.deepEqual(refreshed.photos.get(linkedId)!.captured, { dateTime: '2025-01-02T03:04:05', offset: null });
});

test('extracted fields are read-only: photos.json and set_photo_metadata reject writes instead of dropping them', () => {
  const parsed = photoIndexSchema.safeParse({ p1: { path: 'photos/a.jpg', captured: { dateTime: '2024-01-01T00:00:00', offset: null } } });
  assert.equal(parsed.success, false);
  assert.match(parsed.error!.issues[0].message, /captured is read from the photo file and is read-only/);
  assert.equal(photoIndexSchema.safeParse({ p1: { path: 'photos/a.jpg', caption: 'ok' } }).success, true);
  for (const values of [{ location: { latitude: 1, longitude: 2 } }, { camera: { make: 'X' } }]) {
    assert.equal(projectOperationsSchema.safeParse([{ op: 'set_photo_metadata', photo: 'p1', values }]).success, false);
  }
});
