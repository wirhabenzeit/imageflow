import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { approveSource, configureSourceAccess } from '../desktop/source-access';
import { linkedProvider, packageProvider } from '../desktop/providers/files';
import type { Materialized } from '../desktop/source-provider';
import { photoDetails } from '../desktop/photos';
import { fileStamp } from '../desktop/file-stamp';
import { importIntoProject, loadProject } from '../desktop/project';
import { AssetFacts } from '../desktop/asset-facts';
import { copySample } from '../desktop/sample-book.mjs';
import './persistence-root';

// What the provider refactor (ADR 0011) moves and must not change.
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-providers-')));
  const folder = join(root, 'Book.imageflow');
  t.after(async () => {
    await SourceStore.drain();
    await AssetFacts.release(folder);
    await SourceStore.drain();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const external = join(root, 'external');
  const cache = join(root, 'cache');
  await Promise.all([mkdir(external), mkdir(cache)]);
  configureSourceStore(join(root, 'source-cache'));
  configureSourceAccess(join(root, 'source-access'));
  await copySample(resolve('sample/starter'), folder);
  const picture = async (name: string, background: string) => {
    const path = join(external, name);
    await sharp({ create: { width: 120, height: 80, channels: 3, background } }).png().toFile(path);
    return path;
  };
  return { root, folder, external, cache, picture, book: await loadProject(folder, cache) };
}

test('a rendition of a file read in place is keyed by its path and stamp', async (t) => {
  const f = await fixture(t);
  const photo = await f.picture('photo.png', '#ff0000');
  const details = await photoDetails(photo);
  const stamp = fileStamp(await stat(photo, { bigint: true }));
  assert.equal(details.key, sha256([photo, stamp, 'rendition-3'].join(':')));
  assert.equal(details.observation, stamp);
  const { book, imported } = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [photo]);
  assert.equal(book.photos.get(imported[0])!.key, details.key);
  assert.equal(book.photos.get(imported[0])!.observation, stamp);
});

test('an export load reads owned and linked photos from private copies named by their content', async (t) => {
  const f = await fixture(t);
  const linked = await f.picture('linked.png', '#ff0000');
  const copied = await f.picture('copied.png', '#00ff00');
  let { book, imported: [linkedId] } = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [linked]);
  const added = await importIntoProject(book, { kind: 'photo', mode: 'copy' }, [copied]);
  book = added.book;
  const ownedId = added.imported[0];
  const job = join(f.cache, 'job'); await mkdir(job);
  const pinned = await loadProject(f.folder, job, true, true);
  for (const [id, original] of [[linkedId, linked], [ownedId, join(f.folder, book.photoIndex[ownedId].path)]]) {
    const photo = pinned.photos.get(id)!;
    const digest = sha256(await readFile(original));
    assert.equal(dirname(photo.original), await realpath(join(job, 'pinned-sources')));
    assert.equal(basename(photo.original), digest + '.png');
    assert.equal(photo.key, sha256(digest + ':rendition-3'));
    assert.equal(pinned.sources![`photo:${id}`].state, 'available');
    assert.equal(pinned.sources![`photo:${id}`].digest, digest);
  }
  // The copy belongs to the job: replacing the original leaves it as it was, and the editor still reads in place.
  const before = await readFile(pinned.photos.get(linkedId)!.original);
  const replacement = await f.picture('replacement.png', '#0000ff');
  await rename(replacement, linked);
  assert.deepEqual(await readFile(pinned.photos.get(linkedId)!.original), before);
  const editor = await loadProject(f.folder, f.cache);
  assert.equal(editor.photos.get(linkedId)!.original, linked);
  assert.equal(editor.photos.get(ownedId)!.original, join(f.folder, book.photoIndex[ownedId].path));
});

const linkedRef = (id: string, path: string, revision?: string) => ({ id, locator: { provider: 'linked' as const, path }, ...(revision ? { known: { revision } } : {}) });
const all = async (results: AsyncIterable<Materialized>) => { const list: Materialized[] = []; for await (const result of results) list.push(result); return list; };
const never = new AbortController().signal;
const modified = async (path: string) => new Date(Number((await stat(path, { bigint: true })).mtimeMs)).toISOString();

test('the file providers report a file to read in place, or why there is none', async (t) => {
  const f = await fixture(t);
  const photo = await f.picture('photo.png', '#ff0000');
  const stamp = async (path: string) => fileStamp(await stat(path, { bigint: true }));
  // A linked file is read only once it was chosen for this book and this photo.
  assert.deepEqual(await linkedProvider.observe(f.folder, [linkedRef('a', photo)]), [{ state: 'unapproved', problem: 'Locate this original to approve access on this Mac.' }]);
  await approveSource(f.folder, { key: 'photo:a', kind: 'photo', path: photo, linked: true });
  const [observed, other, missing] = await linkedProvider.observe(f.folder, [linkedRef('a', photo), linkedRef('b', photo), linkedRef('a', join(f.external, 'gone.png'))]);
  assert.deepEqual(observed, { state: 'available', revisions: { revision: await stamp(photo) }, modified: await modified(photo), file: photo });
  assert.equal(other.state, 'unapproved');
  assert.equal(missing.state, 'unapproved', 'An approval is for one path');
  await rm(photo);
  assert.deepEqual(await linkedProvider.observe(f.folder, [linkedRef('a', photo)]), [{ state: 'missing', problem: 'Original missing: ' + photo }]);

  // A photo in the package needs no approval, and must be inside photos/.
  const { book, imported: [id] } = await importIntoProject(f.book, { kind: 'photo', mode: 'copy' }, [await f.picture('owned.png', '#00ff00')]);
  const path = book.photoIndex[id].path;
  const owned = (path: string) => ({ id, locator: { provider: 'package' as const, path } });
  assert.deepEqual(await packageProvider.observe(f.folder, [owned(path)]),
    [{ state: 'available', revisions: { revision: await stamp(join(f.folder, path)) }, modified: await modified(join(f.folder, path)), file: join(f.folder, path) }]);
  assert.deepEqual(await packageProvider.observe(f.folder, [owned('photos/none.png'), owned('project.json')]), [
    { state: 'missing', problem: 'Missing project file: photos/none.png' },
    { state: 'unreadable', problem: 'Original unavailable: Source must be inside photos/.' }]);
  await chmod(join(f.folder, path), 0o000);
  // Reading its metadata needs no permission; copying it does.
  const [denied] = await all(packageProvider.materialize(f.folder, [owned(path)], { staging: f.cache, signal: never }));
  await chmod(join(f.folder, path), 0o644);
  if (process.getuid?.() !== 0) assert.deepEqual(denied, { id, state: 'denied', problem: 'Access denied' });
});

test('a materialized file is a private copy with the revision before and after, and one failure leaves the others', async (t) => {
  const f = await fixture(t);
  const [first, second] = [await f.picture('first.png', '#ff0000'), await f.picture('second.png', '#00ff00')];
  // An approval needs the file to exist; it is removed afterwards.
  await writeFile(join(f.external, 'gone.png'), '');
  for (const [id, path] of [['a', first], ['b', join(f.external, 'gone.png')], ['c', second]]) {
    await approveSource(f.folder, { key: 'photo:' + id, kind: 'photo', path, linked: true });
  }
  await rm(join(f.external, 'gone.png'));
  const staging = join(f.cache, 'staging'); await mkdir(staging);
  const results = await all(linkedProvider.materialize(f.folder, [linkedRef('a', first), linkedRef('b', join(f.external, 'gone.png')), linkedRef('c', second)], { staging, signal: never }));
  assert.deepEqual(results.map(({ id }) => id), ['a', 'b', 'c']);
  assert.deepEqual(results[1], { id: 'b', state: 'missing', problem: 'Original missing: ' + join(f.external, 'gone.png') });
  for (const [result, original] of [[results[0], first], [results[2], second]] as const) {
    assert.ok('file' in result);
    assert.equal(dirname(result.file), staging);
    assert.deepEqual(await readFile(result.file), await readFile(original));
    assert.deepEqual(result.before, { revision: fileStamp(await stat(original, { bigint: true })) });
    assert.deepEqual(result.after, result.before);
  }
  // Nothing is produced once the host cancelled.
  const cancelled = new AbortController(); cancelled.abort();
  assert.deepEqual(await all(linkedProvider.materialize(f.folder, [linkedRef('a', first)], { staging, signal: cancelled.signal })), []);
  assert.equal((await readdir(staging)).length, 2);
});

test('linked files are watched where they are: a change, a replacement and a file that comes back', async (t) => {
  const f = await fixture(t);
  const [kept, edited, replaced] = [await f.picture('kept.png', '#ff0000'), await f.picture('edited.png', '#00ff00'), await f.picture('replaced.png', '#0000ff')];
  const away = join(f.external, 'away.png');
  await writeFile(away, await readFile(kept));
  for (const [id, path] of [['kept', kept], ['edited', edited], ['replaced', replaced], ['away', away]]) await approveSource(f.folder, { key: 'photo:' + id, kind: 'photo', path, linked: true });
  await rm(away);
  const stamp = async (path: string) => fileStamp(await stat(path, { bigint: true }));
  const reported: string[] = [];
  let wake = () => {};
  const next = (id: string) => new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('No change reported for ' + id)), 15_000);
    const check = () => { if (reported.includes(id)) { clearTimeout(timer); done(); } else wake = check; };
    check();
  });
  // The host hands in what it last observed; a file that was unavailable then has no revision.
  const stop = linkedProvider.watch(f.folder, [linkedRef('kept', kept, await stamp(kept)), linkedRef('edited', edited, await stamp(edited)),
    linkedRef('replaced', replaced, await stamp(replaced)), linkedRef('away', away)], (ids) => { reported.push(...ids); wake(); });
  t.after(async () => stop());
  await sharp({ create: { width: 60, height: 40, channels: 3, background: '#ffffff' } }).png().toFile(edited);
  await next('edited');
  const replacement = await f.picture('replacement.png', '#ffff00');
  await rename(replacement, replaced);
  await next('replaced');
  await writeFile(away, await readFile(kept));
  await next('away');
  assert.equal(reported.includes('kept'), false);
  stop();
  const count = reported.length;
  await writeFile(kept, await readFile(edited));
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(reported.length, count, 'Nothing is reported after the watch stopped');
});

test('a watch started after a file changed reports it at once', async (t) => {
  const f = await fixture(t);
  const photo = await f.picture('photo.png', '#ff0000');
  await approveSource(f.folder, { key: 'photo:a', kind: 'photo', path: photo, linked: true });
  const before = fileStamp(await stat(photo, { bigint: true }));
  await sharp({ create: { width: 60, height: 40, channels: 3, background: '#ffffff' } }).png().toFile(photo);
  const reported = await new Promise<string[]>((done) => { const stop = linkedProvider.watch(f.folder, [linkedRef('a', photo, before)], (ids) => { stop(); done(ids); }); });
  assert.deepEqual(reported, ['a']);
});
