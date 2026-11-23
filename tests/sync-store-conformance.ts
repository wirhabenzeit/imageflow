import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncStore } from '../desktop/sync-store';

/**
 * What every sync object store has to do (`SyncStore`, ADR 0012 section 2), as tests. A store registers the suite
 * with a factory that gives each test an empty store of its own:
 *
 *     storeConformance('s3', async (t) => new S3Store({ …, prefix: 'conformance/' + randomUUID() + '/' }));
 *
 * `many` is the number of objects in the listing test; raise it past a store's page size (1,000 for S3) to cover paging.
 * `copy` is optional in a store: its checks run where the store has it.
 */
export function storeConformance(name: string, make: (t: TestContext) => Promise<SyncStore>, { many = 40 }: { many?: number } = {}) {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const scratch = async (t: TestContext) => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'if-store-files-')));
    t.after(() => rm(folder, { recursive: true, force: true }));
    return folder;
  };
  const keys = async (store: SyncStore, prefix = '') => (await store.list(prefix)).map(({ key }) => key);
  const check = (title: string, run: (store: SyncStore, t: TestContext) => Promise<void>) =>
    test(name + ' store: ' + title, async (t) => run(await make(t), t));

  check('putIfAbsent stores bytes and files, and never replaces an object', async (store, t) => {
    const folder = await scratch(t);
    assert.deepEqual(await store.putIfAbsent('books/a/content/one', bytes('one')), { existed: false });
    assert.deepEqual(await store.get('books/a/content/one'), bytes('one'));
    assert.deepEqual(await store.putIfAbsent('books/a/content/one', bytes('another')), { existed: true });
    assert.deepEqual(await store.get('books/a/content/one'), bytes('one'), 'the first object stays');
    const file = join(folder, 'source.bin');
    await writeFile(file, 'from a file');
    assert.deepEqual(await store.putIfAbsent('books/a/originals/two.jpg', { file }), { existed: false });
    await writeFile(file, 'changed after the put');
    assert.deepEqual(await store.get('books/a/originals/two.jpg'), bytes('from a file'), 'the object is a copy, not the file');
    assert.deepEqual(await store.putIfAbsent('books/a/originals/two.jpg', { file }), { existed: true });
    assert.deepEqual(await store.get('books/a/originals/two.jpg'), bytes('from a file'));
    assert.deepEqual(await readFile(file), Buffer.from('changed after the put'), 'the source file is left alone');
    // The bytes handed in can be reused by the caller.
    const mutable = bytes('mutable');
    await store.putIfAbsent('books/a/content/three', mutable);
    mutable.fill(0);
    assert.deepEqual(await store.get('books/a/content/three'), bytes('mutable'));
    // An empty object is an object.
    assert.deepEqual(await store.putIfAbsent('books/a/content/empty', new Uint8Array()), { existed: false });
    assert.deepEqual(await store.get('books/a/content/empty'), new Uint8Array());
    assert.equal((await store.head('books/a/content/empty'))?.size, 0);
    // A checksum the caller already has is accepted.
    assert.deepEqual(await store.putIfAbsent('books/a/content/' + sha(bytes('hashed')), bytes('hashed'), { sha256: sha(bytes('hashed')) }), { existed: false });
    assert.deepEqual(await store.get('books/a/content/' + sha(bytes('hashed'))), bytes('hashed'));
  });

  check('putIfAbsent at once from several writers keeps exactly one object, whole', async (store) => {
    const writers = Array.from({ length: 8 }, (_, index) => bytes('writer ' + index + ' ' + 'x'.repeat(2000)));
    const results = await Promise.all(writers.map((value) => store.putIfAbsent('remote.json', value)));
    assert.equal(results.filter(({ existed }) => !existed).length, 1, 'one writer created it');
    const kept = await store.get('remote.json');
    assert.ok(kept && writers.some((value) => Buffer.from(value).equals(Buffer.from(kept))), 'and its object is there whole');
    assert.deepEqual(await keys(store), ['remote.json']);
  });

  check('get, head and download answer for a missing key without creating anything', async (store, t) => {
    const folder = await scratch(t);
    assert.equal(await store.get('books/a/content/missing'), undefined);
    assert.equal(await store.head('books/a/content/missing'), undefined);
    assert.equal(await store.download('books/a/content/missing', join(folder, 'nothing')), false);
    assert.deepEqual(await readdir(folder), [], 'no file and no temporary file');
    assert.deepEqual(await keys(store), []);
    assert.deepEqual(await store.listPrefixes(''), []);
    // A key under which other keys lie is not an object.
    await store.putIfAbsent('books/a/content/one', bytes('one'));
    assert.equal(await store.get('books/a'), undefined);
    assert.equal(await store.head('books/a/content'), undefined);
    assert.equal(await store.download('books/a', join(folder, 'nothing')), false);
  });

  check('download writes the object whole, replacing a file that is there', async (store, t) => {
    const folder = await scratch(t);
    const large = new Uint8Array(300_000).map((_, index) => index % 251);
    await store.putIfAbsent('books/a/originals/large.jpg', large);
    const destination = join(folder, 'large.jpg');
    await writeFile(destination, 'something else that was here');
    assert.equal(await store.download('books/a/originals/large.jpg', destination), true);
    assert.equal(sha(await readFile(destination)), sha(large));
    assert.deepEqual(await readdir(folder), ['large.jpg'], 'no temporary file stays');
    // What get returns is the caller's own.
    const first = await store.get('books/a/originals/large.jpg');
    first!.fill(0);
    assert.equal(sha((await store.get('books/a/originals/large.jpg'))!), sha(large));
  });

  check('head and list give sizes and the time of the last change', async (store, t) => {
    // An object's time is when it was stored, not the age of the file it came from (a photo taken years ago).
    const old = join(await scratch(t), 'old.jpg');
    await writeFile(old, 'old');
    await utimes(old, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const before = Date.now();
    await store.putIfAbsent('books/a/originals/old.jpg', { file: old });
    const recently = (time?: Date) => !!time && time.getTime() > before - 600_000;
    assert.ok(recently((await store.head('books/a/originals/old.jpg'))?.lastModified), 'a stored file');
    if (store.copy) {
      await store.copy('books/a/originals/old.jpg', 'books/a/originals/old-copy.jpg');
      assert.ok(recently((await store.head('books/a/originals/old-copy.jpg'))?.lastModified), 'a copy');
    }
    await store.delete(['books/a/originals/old.jpg', 'books/a/originals/old-copy.jpg']);
    await store.putIfAbsent('books/a/content/one', bytes('1'));
    await store.putIfAbsent('books/a/originals/two.jpg', bytes('22'));
    await store.putIfAbsent('books/ab/content/three', bytes('333'));
    await store.putIfAbsent('remote.json', bytes('{}'));
    const after = Date.now();
    const head = await store.head('books/a/originals/two.jpg');
    assert.equal(head?.size, 2);
    // Clocks of a store and this Mac differ a little; a time zone or unit mistake differs by far more.
    const recent = (time: Date) => time instanceof Date && time.getTime() > before - 600_000 && time.getTime() < after + 600_000;
    assert.ok(recent(head!.lastModified), String(head?.lastModified));
    const all = await store.list('');
    assert.deepEqual(all.map(({ key, size }) => [key, size]), [['books/a/content/one', 1], ['books/a/originals/two.jpg', 2], ['books/ab/content/three', 3], ['remote.json', 2]], 'sorted by key');
    assert.ok(all.every(({ lastModified }) => recent(lastModified)));
    // A prefix is the start of a key, not a folder.
    assert.deepEqual(await keys(store, 'books/a/'), ['books/a/content/one', 'books/a/originals/two.jpg']);
    assert.deepEqual(await keys(store, 'books/a'), ['books/a/content/one', 'books/a/originals/two.jpg', 'books/ab/content/three']);
    assert.deepEqual(await keys(store, 'books/a/originals/tw'), ['books/a/originals/two.jpg']);
    assert.deepEqual(await keys(store, 'books/a/originals/two.jpg'), ['books/a/originals/two.jpg']);
    assert.deepEqual(await keys(store, 'remote'), ['remote.json']);
    assert.deepEqual(await keys(store, 'books/b/'), []);
    assert.deepEqual(await keys(store, 'nothing/here/'), []);
    // Putting again does not renew an object that was kept.
    await store.putIfAbsent('books/a/content/one', bytes('other'));
    assert.equal((await store.head('books/a/content/one'))?.lastModified.getTime(), all[0].lastModified.getTime());
  });

  check('list returns every object of a large prefix', async (store) => {
    const wanted = Array.from({ length: many }, (_, index) => 'books/a/content/' + String(index).padStart(6, '0')).sort();
    for (let index = 0; index < wanted.length; index += 16) await Promise.all(wanted.slice(index, index + 16).map((key) => store.putIfAbsent(key, bytes(key))));
    await store.putIfAbsent('books/b/content/other', bytes('other'));
    const listed = await store.list('books/a/');
    assert.deepEqual(listed.map(({ key }) => key), wanted);
    assert.ok(listed.every(({ key, size }) => size === key.length));
    assert.deepEqual(await store.listPrefixes('books/'), ['books/a/', 'books/b/']);
  });

  check('listPrefixes gives the immediate child prefixes that hold an object', async (store) => {
    await store.putIfAbsent('remote.json', bytes('{}'));
    await store.putIfAbsent('books/a/snapshots/one.json', bytes('1'));
    await store.putIfAbsent('books/a/content/one', bytes('1'));
    await store.putIfAbsent('books/ab/content/one', bytes('1'));
    await store.putIfAbsent('books/b/deleted.json', bytes('{}'));
    await store.putIfAbsent('books/index', bytes('an object directly at the prefix'));
    assert.deepEqual(await store.listPrefixes(''), ['books/'], 'objects at the prefix itself are not prefixes');
    assert.deepEqual(await store.listPrefixes('books/'), ['books/a/', 'books/ab/', 'books/b/'], 'not their children');
    assert.deepEqual(await store.listPrefixes('books/a/'), ['books/a/content/', 'books/a/snapshots/']);
    assert.deepEqual(await store.listPrefixes('books/a'), ['books/a/', 'books/ab/'], 'a prefix is the start of a key');
    assert.deepEqual(await store.listPrefixes('books/b/'), []);
    assert.deepEqual(await store.listPrefixes('books/c/'), []);
    // A prefix whose last object is deleted is gone.
    await store.delete(['books/ab/content/one']);
    assert.deepEqual(await store.listPrefixes('books/'), ['books/a/', 'books/b/']);
  });

  check('copy, where the store has it, duplicates an object inside the store', async (store, t) => {
    if (!store.copy) { t.skip('this store has no copy'); return; }
    await store.putIfAbsent('books/a/originals/one.jpg', bytes('original'));
    assert.equal(await store.copy('books/a/originals/one.jpg', 'books/b/originals/one.jpg'), true);
    assert.deepEqual(await store.get('books/b/originals/one.jpg'), bytes('original'));
    assert.deepEqual(await store.get('books/a/originals/one.jpg'), bytes('original'), 'the source stays');
    assert.equal((await store.head('books/b/originals/one.jpg'))?.size, 8);
    assert.equal(await store.copy('books/a/originals/missing.jpg', 'books/b/originals/missing.jpg'), false);
    assert.deepEqual(await keys(store), ['books/a/originals/one.jpg', 'books/b/originals/one.jpg'], 'a missing source creates nothing');
    // Unlike a put, a copy replaces: callers copy content-addressed objects only.
    await store.putIfAbsent('books/a/originals/other.jpg', bytes('other'));
    assert.equal(await store.copy('books/a/originals/other.jpg', 'books/b/originals/one.jpg'), true);
    assert.deepEqual(await store.get('books/b/originals/one.jpg'), bytes('other'));
    // The copy is an object of its own.
    await store.delete(['books/a/originals/other.jpg']);
    assert.deepEqual(await store.get('books/b/originals/one.jpg'), bytes('other'));
  });

  check('delete removes the keys it is given and ignores missing ones', async (store) => {
    for (const key of ['books/a/content/one', 'books/a/content/two', 'books/a/deleted.json', 'books/b/content/one']) await store.putIfAbsent(key, bytes(key));
    await store.delete([]);
    await store.delete(['books/a/content/one', 'books/a/content/missing', 'books/a/content/two', 'books/c/content/never']);
    assert.deepEqual(await keys(store), ['books/a/deleted.json', 'books/b/content/one']);
    assert.equal(await store.get('books/a/content/one'), undefined);
    assert.equal(await store.head('books/a/content/two'), undefined);
    assert.deepEqual(await store.listPrefixes('books/a/'), []);
    await store.delete(['books/a/content/one']);
    // A deleted key can be stored again.
    assert.deepEqual(await store.putIfAbsent('books/a/content/one', bytes('again')), { existed: false });
    assert.deepEqual(await store.get('books/a/content/one'), bytes('again'));
    await store.delete(await keys(store));
    assert.deepEqual(await keys(store), []);
    assert.deepEqual(await store.listPrefixes(''), []);
  });

  check('an aborted transfer rejects and leaves nothing behind', async (store, t) => {
    const folder = await scratch(t);
    const file = join(folder, 'source.bin');
    await writeFile(file, 'x'.repeat(100_000));
    await store.putIfAbsent('books/a/content/there', bytes('there'));
    const controller = new AbortController();
    controller.abort(new Error('stopped by the user'));
    const { signal } = controller;
    await assert.rejects(store.putIfAbsent('books/a/content/aborted', bytes('aborted'), { signal }), /stopped by the user/);
    await assert.rejects(store.putIfAbsent('books/a/originals/aborted.jpg', { file }, { signal }), /stopped by the user/);
    await assert.rejects(store.get('books/a/content/there', { signal }), /stopped by the user/);
    await assert.rejects(store.download('books/a/content/there', join(folder, 'download'), { signal }), /stopped by the user/);
    assert.deepEqual(await keys(store), ['books/a/content/there'], 'nothing was stored');
    assert.deepEqual(await readdir(folder), ['source.bin'], 'and nothing was written');
    // The same calls go through with a signal that is not aborted.
    const live = new AbortController().signal;
    assert.deepEqual(await store.putIfAbsent('books/a/originals/aborted.jpg', { file }, { signal: live }), { existed: false });
    assert.deepEqual(await store.get('books/a/content/there', { signal: live }), bytes('there'));
    assert.equal(await store.download('books/a/content/there', join(folder, 'download'), { signal: live }), true);
  });

  check('transfers report their progress, ending at the size of the object', async (store, t) => {
    const folder = await scratch(t);
    const file = join(folder, 'source.bin');
    await writeFile(file, 'x'.repeat(100_000));
    const progress = () => {
      const seen: [number, number | undefined][] = [];
      const done = (size: number) => {
        assert.ok(seen.length > 0, 'reported at least once');
        assert.ok(seen.every(([transferred], index) => transferred >= (seen[index - 1]?.[0] ?? 0)), 'never backwards');
        assert.ok(seen.every(([, total]) => total === undefined || total === size));
        assert.equal(seen.at(-1)![0], size);
      };
      return { onProgress: (transferred: number, total?: number) => { seen.push([transferred, total]); }, done };
    };
    const put = progress();
    await store.putIfAbsent('books/a/originals/one.jpg', { file }, { onProgress: put.onProgress });
    put.done(100_000);
    const get = progress();
    await store.get('books/a/originals/one.jpg', { onProgress: get.onProgress });
    get.done(100_000);
    const download = progress();
    await store.download('books/a/originals/one.jpg', join(folder, 'download'), { onProgress: download.onProgress });
    download.done(100_000);
    assert.equal((await lstat(join(folder, 'download'))).size, 100_000);
  });

  check('keys that are not plain paths are refused', async (store, t) => {
    const folder = await scratch(t);
    for (const key of ['', '/', '/books/a', 'books//a', 'books/a/', 'books/../escape', '../escape', 'books/./a', 'books/.hidden', 'books\\a', 'x'.repeat(1025)]) {
      await assert.rejects(store.putIfAbsent(key, bytes('no')), /Not a sync store key/, key);
      await assert.rejects(store.get(key), /Not a sync store key/, key);
      await assert.rejects(store.head(key), /Not a sync store key/, key);
      await assert.rejects(store.download(key, join(folder, 'no')), /Not a sync store key/, key);
      if (store.copy) {
        await assert.rejects(store.copy(key, 'books/a/content/one'), /Not a sync store key/, key);
        await assert.rejects(store.copy('books/a/content/one', key), /Not a sync store key/, key);
      }
      await assert.rejects(store.delete([key]), /Not a sync store key/, key);
    }
    for (const prefix of ['/books/', 'books//', '../', 'books/../']) {
      await assert.rejects(store.list(prefix), /Not a sync store prefix/, prefix);
      await assert.rejects(store.listPrefixes(prefix), /Not a sync store prefix/, prefix);
    }
    assert.deepEqual(await keys(store), []);
    assert.deepEqual(await readdir(folder), []);
    // Names a sync service or a person may leave are keys: spaces, dots inside, upper case.
    await store.putIfAbsent('books/a/snapshots/One (1).json', bytes('{}'));
    assert.deepEqual(await keys(store, 'books/a/snapshots/'), ['books/a/snapshots/One (1).json']);
  });
}
