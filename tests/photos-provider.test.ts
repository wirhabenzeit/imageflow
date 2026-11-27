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

test('the capture time is at the offset the original records, and at this Mac\'s only as a marked guess', () => {
  // An iPhone photo taken at 11:28:15 in Kyrgyzstan (+06:00), linked on a Mac in Central European Summer Time.
  const created = Date.UTC(2026, 6, 14, 5, 28, 15);
  const facts: PhotosFacts = { width: 4032, height: 3024, created, adjusted: null, filename: 'IMG_1.HEIC', type: 'public.heic' };
  assert.deepEqual(capturedAt(created, 360), { dateTime: '2026-07-14T11:28:15', offset: '+06:00' });
  const own = photosFacts({ ...facts, offsetMinutes: 360 });
  assert.deepEqual(own.captured, { dateTime: '2026-07-14T11:28:15', offset: '+06:00' });
  assert.deepEqual(own.extra, { type: 'public.heic', fileName: 'IMG_1.HEIC' });
  // Before the original was read, or for one that records no offset: this Mac's, marked as a guess.
  const guessed = photosFacts({ ...facts, offsetMinutes: 120, offsetGuessed: true });
  assert.deepEqual(guessed.captured, { dateTime: '2026-07-14T07:28:15', offset: '+02:00' });
  assert.deepEqual(guessed.extra, { type: 'public.heic', fileName: 'IMG_1.HEIC', offsetGuessed: true });
  // The same instant either way, and no revision of the photo.
  assert.equal(new Date(own.captured!.dateTime + own.captured!.offset).getTime(), new Date(guessed.captured!.dateTime + guessed.captured!.offset).getTime());
  assert.deepEqual(photosRevisions({ ...facts, offsetMinutes: 360 }), photosRevisions({ ...facts, offsetMinutes: 120, offsetGuessed: true }));
  // No creation date: no capture time, and no guess to mark.
  assert.deepEqual(photosFacts({ ...facts, created: undefined, offsetGuessed: true }).extra, { type: 'public.heic', fileName: 'IMG_1.HEIC' });
});

test('a photo whose own offset was read is reported as changed and then observed at that offset', async () => {
  const library = new FakeLibrary();
  library.add(1, { created: Date.UTC(2026, 6, 14, 5, 28, 15), offsetMinutes: 120, offsetGuessed: true });
  const provider = photosProvider(library);
  const [before] = await provider.observe('/book', [ref('a', 1)]);
  assert.deepEqual(before.state === 'available' && before.facts?.captured, { dateTime: '2026-07-14T07:28:15', offset: '+02:00' });
  const reported: string[][] = [];
  provider.watch('/book', [ref('a', 1)], (ids) => reported.push(ids));
  while (!library.tracked.length) await new Promise((resolve) => setTimeout(resolve, 5));
  // The addon read the original's EXIF in the background, and reports the photo as changed.
  Object.assign(library.photos.get(local(1))!, { offsetMinutes: 360, offsetGuessed: undefined });
  library.listener!([local(1)]);
  assert.deepEqual(reported, [['a']]);
  const [after] = await provider.observe('/book', [ref('a', 1)]);
  assert.ok(after.state === 'available' && before.state === 'available');
  assert.deepEqual(after.facts?.captured, { dateTime: '2026-07-14T11:28:15', offset: '+06:00' });
  assert.equal(after.facts?.extra?.offsetGuessed, undefined);
  assert.deepEqual(after.revisions, before.revisions, 'no new preview for it');
});

test('an offset read before any book watched the photo is reported once a book watches it', async () => {
  const library = new FakeLibrary();
  library.add(1, { created: Date.UTC(2026, 6, 14, 5, 28, 15), offsetMinutes: 120, offsetGuessed: true });
  library.add(2, { created: Date.UTC(2026, 6, 14, 5, 28, 15), offsetMinutes: 120, offsetGuessed: true });
  const provider = photosProvider(library);
  // Observed (dropped from Photos, say), and its offset read before the book watches it.
  await provider.observe('/book', [ref('a', 1)]);
  assert.ok(library.listener, 'listening before the addon reads offsets');
  library.listener!([local(1)]);
  const reported: string[][] = [];
  provider.watch('/book', [ref('a', 1), ref('b', 2)], (ids) => reported.push(ids));
  while (!library.tracked.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(reported, [['a']]);
  // A second book that starts to watch the same photo while the first does is told too.
  provider.watch('/other', [ref('c', 1)], (ids) => reported.push(ids));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reported, [['a'], ['c']]);
  // A change both books watch is reported to each, and to neither again by a later watch of another photo.
  library.listener!([local(1)]);
  assert.deepEqual(reported, [['a'], ['c'], ['a'], ['c']]);
});

test('a favourite is a fact of the photo and no revision of it', () => {
  const facts: PhotosFacts = { width: 4032, height: 3024, adjusted: null, filename: 'IMG_1.HEIC', type: 'public.heic' };
  assert.deepEqual(photosFacts({ ...facts, favorite: true }).extra, { type: 'public.heic', fileName: 'IMG_1.HEIC', favorite: true });
  // An unmarked photo keeps no key for it.
  assert.deepEqual(photosFacts({ ...facts, favorite: false }).extra, { type: 'public.heic', fileName: 'IMG_1.HEIC' });
  assert.deepEqual(photosFacts(facts).extra, { type: 'public.heic', fileName: 'IMG_1.HEIC' });
  // A heart tapped in Photos keeps the full-resolution download the revision keys.
  assert.deepEqual(photosRevisions({ ...facts, favorite: true }), photosRevisions(facts));
  assert.deepEqual(photosRevisions({ ...facts, caption: 'At dawn', favorite: true }), photosRevisions({ ...facts, caption: 'At dawn' }));
});

test('PhotoKit failures become states the host knows', () => {
  const code = (value: string) => Object.assign(new Error('x'), { code: value });
  assert.equal(photosFailure(code('PHPhotosErrorDomain:3169')).state, 'offline');
  assert.equal(photosFailure(code('PHPhotosErrorDomain:3114')).problem, 'The Photos library is on a disk that is not connected.');
  assert.equal(photosFailure(code('PHPhotosErrorDomain:3201')).state, 'missing');
  assert.equal(photosFailure(code('ImageFlowPhotos:3311')).state, 'denied');
  assert.equal(photosFailure(new Error('Odd')).problem, 'Original unavailable: Odd');
  // The library failing as a whole says so, and what may help.
  const silent = photosFailure(Object.assign(new Error('The operation couldn’t be completed. (Cocoa error -1.)'), { code: 'NSCocoaErrorDomain:-1' }));
  assert.equal(silent.state, 'unreadable');
  assert.match(silent.problem, /^Photos did not answer \(.*Cocoa error -1.*\)\. .*opening ImageFlow again/);
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
  assert.equal(b.state === 'available' && b.facts?.extra?.favorite, undefined);
  assert.deepEqual(gone, { state: 'missing', problem: 'No longer in the Photos library.' });
  assert.equal(bare.state, 'available');
  // A photo this Mac never had (no local identifier of its own, as one a sync brought) is not in its library, not gone.
  const [never] = await provider.observe('/book', [ref('never', 9, false)]);
  assert.deepEqual(never, { state: 'missing', problem: 'Not in this Mac’s Photos library.' });
  library.access = 'denied';
  const [denied] = await provider.observe('/book', [ref('a', 1)]);
  assert.equal(denied.state, 'denied');
  assert.deepEqual(provider.repairs('denied'), ['allow']);
  assert.deepEqual(provider.repairs('offline'), []);
  // Without the addon (another platform), every photo is unreadable rather than an error.
  const [none] = await photosProvider(undefined).observe('/book', [ref('a', 1)]);
  assert.equal(none.state, 'unreadable');
});

test('observe carries a favourite in the facts, at the revisions it had before', async () => {
  const library = new FakeLibrary();
  library.add(1);
  const provider = photosProvider(library);
  const [before] = await provider.observe('/book', [ref('a', 1)]);
  library.photos.get(local(1))!.favorite = true;
  const [after] = await provider.observe('/book', [ref('a', 1)]);
  assert.ok(before.state === 'available' && after.state === 'available');
  assert.deepEqual(after.facts?.extra, { type: 'public.heic', fileName: 'IMG_1.HEIC', favorite: true });
  assert.deepEqual(after.revisions, before.revisions);
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

/** A timer the test runs by hand, for `photosProvider`'s `repeat`. */
function manualTimer() {
  const timer = { runs: [] as (() => void)[], started: 0, stopped: 0,
    repeat: (run: () => void) => { timer.started++; timer.runs.push(run); return () => { timer.stopped++; timer.runs = timer.runs.filter((one) => one !== run); }; },
    /** Runs every timer once, and lets what it started settle. */
    async tick() { for (const run of timer.runs) run(); await settle(); },
  };
  return timer;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** A library whose cloud lookups are counted, and fail while `failing` is set. */
function countingLibrary() {
  const library = new FakeLibrary();
  const counts = { lookups: 0, failing: false };
  const lookup = library.localIdentifiers.bind(library);
  library.localIdentifiers = async (clouds) => { counts.lookups++; if (counts.failing) throw new Error('Photos is busy.'); return lookup(clouds); };
  return { library, counts };
}

test('a watched photo this library does not have is looked for again, and reported once Photos has it', async (t) => {
  const { library, counts } = countingLibrary();
  library.add(1);
  const timer = manualTimer();
  const provider = photosProvider(library, { repeat: timer.repeat });
  const reported: string[][] = [];
  const stop = provider.watch('/book', [ref('a', 1), ref('late', 2, false)], (ids) => reported.push(ids));
  t.after(stop);
  await settle();
  assert.deepEqual(library.tracked, [local(1)]);
  assert.equal(timer.runs.length, 1);
  const first = counts.lookups;
  await timer.tick();
  await timer.tick();
  assert.equal(counts.lookups, first + 2);
  assert.deepEqual(reported, [], 'nothing to report while Photos does not have it');
  // iCloud Photos brought it: reported as changed, tracked from then on, and not looked for any more.
  library.add(2);
  await timer.tick();
  assert.deepEqual(reported, [['late']]);
  assert.deepEqual(library.tracked.sort(), [local(1), local(2)]);
  assert.deepEqual(timer.runs, []);
  library.listener!([local(2)]);
  assert.deepEqual(reported.at(-1), ['late']);
});

test('a watched photo is not looked for again once its book stops watching, nor while access is denied', async () => {
  const { library, counts } = countingLibrary();
  const timer = manualTimer();
  const provider = photosProvider(library, { repeat: timer.repeat });
  const stop = provider.watch('/book', [ref('late', 2, false)], () => {});
  await settle();
  await timer.tick();
  const before = counts.lookups;
  library.access = 'denied';
  await timer.tick();
  assert.equal(counts.lookups, before);
  library.access = 'authorized';
  await timer.tick();
  assert.equal(counts.lookups, before + 1);
  stop();
  assert.equal(timer.stopped, 1);
  assert.deepEqual(timer.runs, []);
});

test('a watch whose first lookup fails looks for every photo again', async (t) => {
  const { library, counts } = countingLibrary();
  library.add(1);
  // The photo has a local identifier the library doesn't know, so the first lookup asks for its cloud identifier: it fails.
  library.photos.set('stale', library.photos.get(local(1))!);
  library.photos.delete(local(1));
  counts.failing = true;
  const timer = manualTimer();
  const reported: string[][] = [];
  const stop = photosProvider(library, { repeat: timer.repeat }).watch('/book', [ref('a', 1)], (ids) => reported.push(ids));
  t.after(stop);
  await settle();
  assert.equal(counts.lookups, 1);
  assert.equal(timer.runs.length, 1, 'looked for again although the first lookup failed');
  // Failing again changes nothing; once Photos answers, the photo is reported and tracked.
  await timer.tick();
  assert.deepEqual(reported, []);
  counts.failing = false;
  await timer.tick();
  assert.deepEqual(reported, [['a']]);
  assert.deepEqual(library.tracked, ['stale']);
  assert.deepEqual(timer.runs, []);
});

test('a watch stopped while a lookup is under way reports nothing and tracks nothing', async () => {
  const { library } = countingLibrary();
  const timer = manualTimer();
  const provider = photosProvider(library, { repeat: timer.repeat });
  const reported: string[][] = [];
  const stop = provider.watch('/book', [ref('late', 2, false)], (ids) => reported.push(ids));
  await settle();
  // The lookup again waits for Photos; the book stops watching meanwhile, then Photos answers with the photo.
  let answer!: () => void;
  const lookup = library.localIdentifiers.bind(library);
  library.localIdentifiers = async (clouds) => { await new Promise<void>((resolve) => { answer = resolve; }); return lookup(clouds); };
  for (const run of timer.runs) run();
  await settle();
  stop();
  library.add(2);
  answer();
  await settle();
  assert.deepEqual(reported, []);
  assert.deepEqual(library.tracked, []);
  assert.deepEqual(timer.runs, []);
  // Nor does a first lookup that finishes after the book stopped watching start a timer.
  let first!: () => void;
  library.localIdentifiers = async (clouds) => { await new Promise<void>((resolve) => { first = resolve; }); return lookup(clouds); };
  library.photos.clear();
  const late: string[][] = [];
  const stopEarly = provider.watch('/other', [ref('late', 2, false)], (ids) => late.push(ids));
  await settle();
  stopEarly();
  first();
  await settle();
  assert.equal(timer.started, 1);
  assert.deepEqual(late, []);
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
