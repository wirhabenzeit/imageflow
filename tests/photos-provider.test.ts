import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessProblem, capturedAt, photosFacts, photosFailure, photosProvider, photosRevisions } from '../desktop/providers/photos';
import type { PhotosPort } from '../desktop/providers/photos';
import { matchDragged, photosDrop, PhotosDropError, photosLocators } from '../desktop/photos-drop';
import { photosLibraryOf } from '../desktop/photos-library';
import { photosAssetURL, showInPhotos } from '../desktop/photos-show';
import { awayOriginal } from '../src/away-originals';
import type { SourceStatus } from '../src/source-locations';
import type { DraggedPhoto, PhotosAccess, PhotosFacts, PhotosLibrary } from '../desktop/photos-library';
import type { Materialized, SourceRef } from '../desktop/source-provider';
import type { PhotosLocator } from '../src/source-locator';
import { adoptedEntry, locatorOf, photosLocator, portableEntry, sharedEntry } from '../src/source-locator';
import { photoIndexSchema, bookFormatOf } from '../src/project';

// The Apple Photos provider (ADR 0013) against an in-memory stand-in for the PhotoKit addon. No Photos library is read.

const cloud = (n: number) => 'AAAA' + String(n).padStart(4, '0') + '-0000-4000-8000-000000000000:001:AbCd' + n;
const local = (n: number) => 'B0B0' + String(n).padStart(4, '0') + '-0000-4000-8000-000000000000/L0/001';

class FakeLibrary implements PhotosPort {
  access: PhotosAccess = 'authorized';
  photos = new Map<string, PhotosFacts & { cloud: string }>();
  failures = new Map<string, Error & { code?: string }>();
  cancelled: number[] = [];
  tracked: string[] = [];
  listener?: (locals: string[]) => void;
  /** Image requests wait for this when it is set. */
  gate?: Promise<void>;
  imageCalls = 0;
  add(n: number, facts: Partial<PhotosFacts> = {}) {
    this.photos.set(local(n), { cloud: cloud(n), width: 4032, height: 3024, created: Date.UTC(2026, 5, 1, 7, 30), offsetMinutes: 120, adjusted: null, base: 'compressed', filename: 'IMG_' + n + '.HEIC', type: 'public.heic', ...facts });
  }
  status() { return this.access; }
  async localIdentifiers(clouds: readonly string[]) { return clouds.map((id) => [...this.photos].find(([, photo]) => photo.cloud === id)?.[0] ?? null); }
  async facts(locals: readonly string[]) { return locals.map((id) => { const photo = this.photos.get(id); if (!photo) return null; const { cloud: _cloud, ...facts } = photo; return facts; }); }
  async image(id: string, { file, full, id: request }: { file: string; full: boolean; id: number }) {
    this.imageCalls++;
    if (this.gate) await this.gate;
    if (this.cancelled.includes(request)) throw Object.assign(new Error('Cancelled.'), { code: 'ImageFlowPhotos:3072' });
    const failure = this.failures.get(id);
    if (failure) throw failure;
    const photo = this.photos.get(id);
    if (!photo) throw Object.assign(new Error('Gone.'), { code: 'PHPhotosErrorDomain:3201' });
    await writeFile(file, (full ? 'full ' : 'preview ') + id);
    return full ? { width: photo.width, height: photo.height } : { width: 1400, height: 1050 };
  }
  cancel(id: number) { this.cancelled.push(id); }
  onChanges(listener: (locals: string[]) => void) { this.listener = listener; }
  track(locals: readonly string[]) { this.tracked = [...locals]; }
}

const ref = (id: string, n: number, withLocal = true): SourceRef<PhotosLocator> => ({ id, locator: { provider: 'photos', cloud: cloud(n), ...(withLocal ? { local: local(n) } : {}) } });
async function staging(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-photos-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'staging');
  await mkdir(folder);
  return folder;
}
const collect = async <T>(iterable: AsyncIterable<T>) => { const results: T[] = []; for await (const item of iterable) results.push(item); return results; };

test('a Photos locator keeps its cloud identifier portable and its local identifier on this Mac', () => {
  const entry = { photos: { cloud: cloud(1), local: local(1), name: 'IMG_1.HEIC' }, caption: 'Kept' };
  assert.deepEqual(locatorOf(entry), { provider: 'photos', cloud: cloud(1), local: local(1), name: 'IMG_1.HEIC' });
  assert.deepEqual(portableEntry(entry), { caption: 'Kept', photos: { cloud: cloud(1) } });
  assert.deepEqual(sharedEntry(entry), { caption: 'Kept', photos: { cloud: cloud(1), name: 'IMG_1.HEIC' } });
  // A pull keeps this Mac's local identifier of the same photo, and takes none from another Mac.
  assert.deepEqual(adoptedEntry(sharedEntry(entry), entry), entry);
  assert.deepEqual(adoptedEntry(sharedEntry(entry), { photos: { cloud: cloud(2), local: local(2) } }), { caption: 'Kept', photos: { cloud: cloud(1), name: 'IMG_1.HEIC' } });
  assert.equal(photosLocator.key({ provider: 'photos', cloud: cloud(1) }), cloud(1));
  assert.equal(photosLocator.reach, 'mac');
  // Identifiers that could become something else in a path or a log are refused.
  assert.equal(photosLocator.read({ photos: { cloud: '../../etc' } }), undefined);
  assert.deepEqual(photosLocator.read({ photos: { cloud: cloud(1), local: 'bad id\n', name: 'a/b' } }), { provider: 'photos', cloud: cloud(1) });
  // A book holding one is format 4, which builds that cannot read such photos refuse.
  const index = photoIndexSchema.parse({ 'ph-0123456789ab': { photos: { cloud: cloud(1) } } });
  assert.equal(bookFormatOf({ spreads: [] }, index), 4);
});

test('capture times, facts and revisions follow what Photos reports', () => {
  assert.deepEqual(capturedAt(Date.UTC(2026, 5, 1, 7, 30, 5), 120), { dateTime: '2026-06-01T09:30:05', offset: '+02:00' });
  assert.deepEqual(capturedAt(Date.UTC(2026, 0, 1, 12), -270), { dateTime: '2026-01-01T07:30:00', offset: '-04:30' });
  assert.equal(capturedAt(undefined, 0), undefined);
  const facts: PhotosFacts = { width: 4032, height: 3024, created: Date.UTC(2026, 5, 1, 7, 30), offsetMinutes: 0, latitude: 47.37, longitude: 8.54, adjusted: null, caption: 'At dawn', filename: 'IMG_1.HEIC', type: 'public.heic' };
  assert.deepEqual(photosFacts(facts), { width: 4032, height: 3024, captured: { dateTime: '2026-06-01T07:30:00', offset: '+00:00' },
    location: { latitude: 47.37, longitude: 8.54 }, provided: { caption: 'At dawn' }, extra: { type: 'public.heic', fileName: 'IMG_1.HEIC' } });
  const base = photosRevisions(facts);
  // A caption edit moves the revision only; an edit or a crop moves both; a revert is an edit of its own.
  const captioned = photosRevisions({ ...facts, caption: 'At noon' });
  assert.notEqual(captioned.revision, base.revision);
  assert.equal(captioned.contentRevision, base.contentRevision);
  const edited = photosRevisions({ ...facts, adjusted: 1_790_000_000_000, width: 3912, height: 2934 });
  assert.notEqual(edited.contentRevision, base.contentRevision);
  assert.notEqual(photosRevisions({ ...facts, adjusted: 1_790_000_100_000 }).contentRevision, photosRevisions({ ...facts, adjusted: 1_790_000_000_000 }).contentRevision);
  assert.equal(photosRevisions({ ...facts, caption: undefined }).revision, base.contentRevision);
});

test('PhotoKit failures become states the host knows', () => {
  const code = (value: string) => Object.assign(new Error('x'), { code: value });
  assert.equal(photosFailure(code('PHPhotosErrorDomain:3169')).state, 'offline');
  assert.equal(photosFailure(code('PHPhotosErrorDomain:3114')).problem, 'The Photos library is on a disk that is not connected.');
  assert.equal(photosFailure(code('PHPhotosErrorDomain:3201')).state, 'missing');
  assert.equal(photosFailure(code('ImageFlowPhotos:3311')).state, 'denied');
  assert.equal(photosFailure(new Error('Odd')).problem, 'Original unavailable: Odd');
  // A download that failed for the network, wrapped in PhotoKit's own iCloud errors.
  assert.equal(photosFailure(Object.assign(new Error('x'), { code: 'CloudPhotoLibraryErrorDomain:1005', underlying: 'NSURLErrorDomain:-1009' })).state, 'offline');
  assert.equal(accessProblem('authorized'), undefined);
  assert.equal(accessProblem('denied')?.state, 'denied');
  assert.equal(accessProblem('notDetermined')?.state, 'denied');
  assert.equal(accessProblem('unsupported-system')?.problem, 'Photos from Apple Photos need macOS 15.2 or later.');
  assert.equal(accessProblem(undefined)?.state, 'unreadable');
});

test('observe reports facts, finds a photo by its cloud identifier, and is denied without access', async () => {
  const library = new FakeLibrary();
  library.add(1, { caption: 'At dawn' });
  library.add(2);
  const provider = photosProvider(library);
  const stale: SourceRef<PhotosLocator> = { id: 'b', locator: { provider: 'photos', cloud: cloud(2), local: 'FFFF0000-0000-4000-8000-000000000000/L0/001' } };
  const [a, b, gone, bare] = await provider.observe('/book', [ref('a', 1), stale, ref('gone', 9), ref('bare', 1, false)]);
  assert.equal(a.state, 'available');
  assert.deepEqual(a.state === 'available' && a.facts?.provided, { caption: 'At dawn' });
  assert.equal(b.state, 'available');
  assert.deepEqual(gone, { state: 'missing', problem: 'No longer in the Photos library.' });
  assert.equal(bare.state, 'available');
  library.access = 'denied';
  const [denied] = await provider.observe('/book', [ref('a', 1)]);
  assert.equal(denied.state, 'denied');
  assert.deepEqual(provider.repairs('denied'), ['allow']);
  assert.deepEqual(provider.repairs('offline'), []);
  // Without the addon (another platform), every photo is unreadable rather than an error.
  const [none] = await photosProvider(undefined).observe('/book', [ref('a', 1)]);
  assert.equal(none.state, 'unreadable');
});

test('previews and originals are written into the staging folder with their revisions', async (t) => {
  const library = new FakeLibrary();
  for (const n of [1, 2, 3]) library.add(n);
  library.failures.set(local(3), Object.assign(new Error('No network'), { code: 'PHPhotosErrorDomain:3169' }));
  const provider = photosProvider(library);
  const folder = await staging(t);
  const signal = new AbortController().signal;
  const previews = await collect(provider.preview!('/book', [ref('a', 1), ref('b', 2), ref('c', 3), ref('gone', 9)], { staging: folder, signal }));
  const byId = new Map(previews.map((result) => [result.id, result]));
  const a = byId.get('a') as Extract<Materialized, { file: string }>;
  assert.equal(await readFile(a.file, 'utf8'), 'preview ' + local(1));
  assert.ok(a.file.startsWith(folder + '/'));
  assert.deepEqual(a.before, a.after);
  assert.equal(a.before.revision, photosRevisions(library.photos.get(local(1))!).revision);
  assert.deepEqual(byId.get('c'), { id: 'c', state: 'offline', problem: 'Not downloaded from iCloud, and iCloud cannot be reached now.' });
  assert.equal((byId.get('gone') as { state: string }).state, 'missing');
  const [original] = await collect(provider.materialize('/book', [ref('b', 2)], { staging: folder, signal }));
  assert.equal(await readFile((original as { file: string }).file, 'utf8'), 'full ' + local(2));
});

test('a photo edited while its picture was made reports the revisions before and after', async (t) => {
  const library = new FakeLibrary();
  library.add(1);
  let release!: () => void;
  library.gate = new Promise((resolve) => { release = resolve; });
  const provider = photosProvider(library);
  const results = collect(provider.materialize('/book', [ref('a', 1)], { staging: await staging(t), signal: new AbortController().signal }));
  while (!library.imageCalls) await new Promise((resolve) => setTimeout(resolve, 5));
  library.photos.get(local(1))!.adjusted = 1_790_000_000_000;
  release();
  const [result] = await results as Extract<Materialized, { file: string }>[];
  assert.notEqual(result.before.revision, result.after.revision);
});

test('an abort cancels the requests in flight and reports none of them', async (t) => {
  const library = new FakeLibrary();
  for (const n of [1, 2, 3, 4, 5]) library.add(n);
  let release!: () => void;
  library.gate = new Promise((resolve) => { release = resolve; });
  const provider = photosProvider(library);
  const controller = new AbortController();
  const results = collect(provider.materialize('/book', [1, 2, 3, 4, 5].map((n) => ref('p' + n, n)), { staging: await staging(t), signal: controller.signal }));
  while (library.imageCalls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  release();
  assert.deepEqual(await results, []);
  // Two originals at once: both were cancelled, and the other three never asked for.
  assert.equal(library.cancelled.length, 2);
  assert.equal(library.imageCalls, 2);
});

test('watch tracks the photos of every book and reports changes by photo', async () => {
  const library = new FakeLibrary();
  library.add(1); library.add(2);
  const provider = photosProvider(library);
  const first: string[][] = [], second: string[][] = [];
  const stopFirst = provider.watch('/one', [ref('a', 1)], (ids) => first.push(ids));
  provider.watch('/two', [ref('b', 2), ref('c', 1, false)], (ids) => second.push(ids));
  while (library.tracked.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(library.tracked.sort(), [local(1), local(2)]);
  library.listener!([local(1)]);
  assert.deepEqual(first, [['a']]);
  assert.deepEqual(second, [['c']]);
  // The library went away: every photo of every book is looked at again.
  library.listener!(['*']);
  assert.deepEqual(second.at(-1)!.sort(), ['b', 'c']);
  stopFirst();
  assert.deepEqual(library.tracked.sort(), [local(1), local(2)]);
});

// ---------- Drags from Photos

const libraryPath = '/Users/someone/Pictures/Photos Library.photoslibrary';
const derivative = (n: number) => libraryPath + '/resources/derivatives/B/B0B0' + n + '_1_105_c.jpeg';
class DragLibrary extends FakeLibrary {
  dragItems: DraggedPhoto[] = [];
  asked = 0;
  async requestAccess() { this.asked++; this.access = 'authorized'; return this.access; }
  dragged() { return { changeCount: 1, items: this.dragItems }; }
  async cloudIdentifiers(locals: readonly string[]) { return locals.map((id) => this.photos.get(id)?.cloud ?? null); }
}
const asLibrary = (library: DragLibrary) => library as unknown as PhotosLibrary;

test('paths inside a Photos library are found, and matched to the photos of the last drag', () => {
  assert.equal(photosLibraryOf(derivative(1)), libraryPath);
  assert.equal(photosLibraryOf('/Users/someone/Pictures/photo.jpg'), undefined);
  const items: DraggedPhoto[] = [{ localIdentifier: local(1), file: derivative(1), library: libraryPath }, { localIdentifier: local(2), file: derivative(2), library: libraryPath }];
  assert.deepEqual(matchDragged([derivative(2), derivative(1)], items).map((item) => item?.localIdentifier), [local(2), local(1)]);
  assert.deepEqual(matchDragged([derivative(3)], items), [undefined]);
});

test('a drop from Photos links the dragged photos and leaves other files to import', async () => {
  const library = new DragLibrary();
  library.add(1); library.add(2);
  library.access = 'notDetermined';
  library.dragItems = [{ localIdentifier: local(1), file: derivative(1), library: libraryPath }, { localIdentifier: local(2), file: derivative(2), library: libraryPath }];
  const allow = async () => 'denied' as const;
  const result = await photosDrop([derivative(1), '/tmp/other.jpg', derivative(2)], asLibrary(library), allow);
  assert.equal(library.asked, 1);
  assert.deepEqual(result.rest, ['/tmp/other.jpg']);
  assert.deepEqual(result.locators, [
    { provider: 'photos', cloud: cloud(1), local: local(1), name: 'IMG_1.HEIC' },
    { provider: 'photos', cloud: cloud(2), local: local(2), name: 'IMG_2.HEIC' }]);
  // Nothing from Photos: the drop is left as it is, and nothing is asked.
  assert.deepEqual(await photosDrop(['/tmp/a.jpg'], undefined, allow), { locators: [], rest: ['/tmp/a.jpg'] });
});

test('a drop from Photos that cannot be linked is refused, never imported as the small copy', async () => {
  const library = new DragLibrary();
  library.add(1);
  const allow = async () => 'denied' as const;
  // Not named by the last drag: a file picked from inside the library, or a drag that was another one.
  await assert.rejects(photosDrop([derivative(1)], asLibrary(library), allow), (error: Error) => error instanceof PhotosDropError && /Drag it from the Photos app/.test(error.message));
  library.dragItems = [{ localIdentifier: local(1), file: derivative(1), library: libraryPath }];
  // Access refused before: the user is asked to give it in System Settings, and the drop fails if they do not.
  library.access = 'denied';
  let asked: PhotosAccess | undefined;
  await assert.rejects(photosDrop([derivative(1)], asLibrary(library), async (access) => { asked = access; return 'denied'; }), /may not read the Photos library/);
  assert.equal(asked, 'denied');
  library.access = 'unsupported-system';
  await assert.rejects(photosDrop([derivative(1)], asLibrary(library), allow), /needs macOS 15.2/);
  await assert.rejects(photosDrop([derivative(1)], undefined, allow), /export them from Photos/);
  // A video dragged in: Photos reports no still photo for it.
  library.access = 'authorized';
  library.dragItems = [{ localIdentifier: local(7), file: derivative(7), library: libraryPath }];
  await assert.rejects(photosDrop([derivative(7)], asLibrary(library), allow), /only still photos/);
});

test('photos picked become locators in the order picked, without videos or repeats', async () => {
  const library = new DragLibrary();
  library.add(1); library.add(2);
  assert.deepEqual((await photosLocators(asLibrary(library), [local(2), local(7), local(1), local(2)])).map(({ cloud: id }) => id), [cloud(2), cloud(1)]);
});

test('a still photo of another Photos library is refused as such, not as a video', async () => {
  const library = new DragLibrary();
  library.dragItems = [{ localIdentifier: local(5), file: derivative(5), library: '/Volumes/Other/Old.photoslibrary', mediaType: 1 }];
  await assert.rejects(photosDrop([derivative(5)], asLibrary(library), async () => 'denied'), /other than the System Photo Library/);
  library.dragItems = [{ localIdentifier: local(6), file: derivative(6), library: libraryPath, mediaType: 2 }];
  await assert.rejects(photosDrop([derivative(6)], asLibrary(library), async () => 'denied'), /only still photos/);
});

test('Show in Photos opens Photos at the photo, by this Mac\'s identifier of it', async () => {
  const library = new DragLibrary();
  library.add(1);
  const opened: string[] = [];
  const open = async (url: string) => { opened.push(url); };
  // The locator's local identifier is another Mac's: the cloud identifier finds this Mac's.
  assert.equal(await showInPhotos(library, [{ provider: 'photos', cloud: cloud(1), local: local(9) }, { provider: 'photos', cloud: cloud(2) }], open),
    'Photos shows one photo at a time: showing the first of 2.');
  assert.deepEqual(opened, [photosAssetURL(local(1))]);
  assert.equal(photosAssetURL(local(1)), 'photos://asset?identifier=' + local(1).split('/')[0]);
  await assert.rejects(showInPhotos(library, [{ provider: 'photos', cloud: cloud(8) }], open), /not in the Photos library on this Mac/);
  library.access = 'denied';
  await assert.rejects(showInPhotos(library, [{ provider: 'photos', cloud: cloud(1) }], open), /may not read the Photos library/);
});

test('a photo of Photos that cannot be read here is away, not an error of its own', () => {
  const status = (state: SourceStatus['state']) => ({ kind: 'photo', id: 'a', key: 'photo:a', locator: { provider: 'photos', cloud: cloud(1) }, state, cached: true }) as unknown as SourceStatus;
  assert.equal(awayOriginal(status('missing')), 'photos');
  assert.equal(awayOriginal(status('offline')), 'photos');
  assert.equal(awayOriginal(status('denied')), 'photos');
  assert.equal(awayOriginal(status('unreadable')), undefined);
});
