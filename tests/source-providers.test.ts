import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
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
