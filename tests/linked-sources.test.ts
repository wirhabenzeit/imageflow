import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { configureSourceStore } from '../desktop/source-store';
import { importIntoProject, loadProject, updateProject } from '../desktop/project';
import { collectSources, relocateSource, relinkFolder, saveDocumentCopy } from '../desktop/source-actions';
import { captureProjectInputs } from '../desktop/revisions';
import { ProjectSession } from '../desktop/project-session';
import { sourceEntries } from '../src/source-locations';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-linked-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'Book.imageflow');
  const external = join(root, 'external');
  const cache = join(root, 'cache');
  await Promise.all([mkdir(external), mkdir(cache)]);
  configureSourceStore(join(root, 'source-cache'));
  await cp(resolve('sample/starter'), folder, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
  const photo = join(external, 'photo.png');
  const text = join(external, 'story.md');
  const file = join(external, 'route.gpx');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ff0000' } }).png().toFile(photo);
  await writeFile(text, '# External story\n\nFirst edition.');
  await writeFile(file, '<gpx><trk/></gpx>');
  return { root, folder, external, photo, text, file, cache, book: await loadProject(folder, cache) };
}

test('document default links all three source kinds while per-import copy remains possible', async (t) => {
  const f = await fixture(t);
  const policy = structuredClone({ project: f.book.project, photoIndex: f.book.photoIndex });
  policy.project.importMode = 'link';
  f.book = await updateProject(f.book, policy);
  const photo = await importIntoProject(f.book, { kind: 'photo' }, [f.photo]);
  const markdown = await importIntoProject(photo.book, { kind: 'markdown' }, [f.text]);
  const param = await importIntoProject(markdown.book, { kind: 'file', accept: ['.gpx'] }, [f.file]);
  const linked = sourceEntries(param.book).filter((entry) => entry.linked);
  assert.deepEqual(linked.map((entry) => entry.kind).sort(), ['file', 'markdown', 'photo']);
  const other = join(f.external, 'other.md');
  await writeFile(other, '# Copied exception');
  const copied = await importIntoProject(param.book, { kind: 'markdown', mode: 'copy' }, [other]);
  assert.equal(sourceEntries(copied.book).find((entry) => entry.id === copied.imported[0])?.linked, false);
  assert.equal(sourceEntries(copied.book).filter((entry) => entry.linked).length, 3);
});

test('atomic external replacements refresh dimensions and revisions without changing IDs, crops or immutable snapshots', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  const files = structuredClone({ project: added.book.project, photoIndex: added.book.photoIndex });
  files.project.spreads[1].boxes.hero = { photo: id, params: {}, crops: { story: { centerX: .3, centerY: .4, zoom: 1.8 } } };
  const first = await updateProject(added.book, files);
  const before = await captureProjectInputs(f.folder);
  const pinned = await readFile(first.photos.get(id)!.original);
  const replacement = join(f.external, 'replacement.png');
  await sharp({ create: { width: 80, height: 160, channels: 3, background: '#0000ff' } }).png().toFile(replacement);
  await rename(replacement, f.photo);
  const after = await captureProjectInputs(f.folder);
  assert.notEqual(before.revision, after.revision);
  const refreshed = await loadProject(f.folder, f.cache);
  assert.equal(refreshed.photos.get(id)!.height, 160);
  assert.equal(refreshed.photos.get(id)!.width, 80);
  assert.deepEqual(refreshed.project.spreads[1].boxes.hero.crops, first.project.spreads[1].boxes.hero.crops);
  assert.deepEqual(await readFile(first.photos.get(id)!.original), pinned);
  assert.notEqual(first.photos.get(id)!.key, refreshed.photos.get(id)!.key);
});

test('missing linked photos, Markdown and parameter files reopen with honest last-good status and collect refuses missing originals', async (t) => {
  const f = await fixture(t);
  let book = f.book;
  for (const [kind, path] of [['photo', f.photo], ['markdown', f.text], ['file', f.file]] as const) {
    book = (await importIntoProject(book, { kind, mode: 'link', accept: ['.gpx'] }, [path])).book;
  }
  const entries = sourceEntries(book).filter((entry) => entry.linked);
  const originals = entries.map((entry) => entry.path);
  for (const path of originals) await rm(path);
  const reopened = await loadProject(f.folder, f.cache);
  for (const entry of entries) {
    assert.equal(reopened.sources![entry.key].state, 'missing');
    assert.equal(reopened.sources![entry.key].cached, true);
  }
  assert.ok(reopened.photos.get(entries.find((entry) => entry.kind === 'photo')!.id));
  assert.match(reopened.texts[entries.find((entry) => entry.kind === 'markdown')!.id], /First edition/);
  const before = await readFile(join(f.folder, 'photos.json'));
  await assert.rejects(collectSources(reopened), /Cannot include all assets/);
  assert.deepEqual(await readFile(join(f.folder, 'photos.json')), before);
});

test('collection and Save a Copy include every kind, preserve identities, and leave external files untouched', async (t) => {
  const f = await fixture(t);
  let book = f.book;
  for (const [kind, path] of [['photo', f.photo], ['markdown', f.text], ['file', f.file]] as const) book = (await importIntoProject(book, { kind, mode: 'link', accept: ['.gpx'] }, [path])).book;
  const before = sourceEntries(book);
  const externalPhoto = await readFile(f.photo);
  const copy = await saveDocumentCopy(book, join(f.root, 'Portable.imageflow'), true);
  await rm(f.external, { recursive: true });
  const portable = await loadProject(copy, f.cache);
  assert.deepEqual(sourceEntries(portable).map((entry) => entry.key), before.map((entry) => entry.key));
  assert.ok(sourceEntries(portable).every((entry) => !entry.linked && portable.sources![entry.key].state === 'available'));
  await mkdir(f.external);
  await writeFile(f.photo, externalPhoto); await writeFile(f.text, '# Restored'); await writeFile(f.file, '<gpx/>');
  const collected = await collectSources(await loadProject(f.folder, f.cache));
  assert.ok(sourceEntries(collected).every((entry) => !entry.linked));
  assert.deepEqual(await readFile(f.photo), externalPhoto);
  assert.equal(collected.project.importMode, 'copy');
});

test('relinking repairs an ID across undo and batch matching refuses ambiguous candidates', async (t) => {
  const f = await fixture(t);
  let book = (await importIntoProject(f.book, { kind: 'markdown', mode: 'link' }, [f.text])).book;
  const entry = sourceEntries(book).find((entry) => entry.linked)!;
  const session = new ProjectSession(book);
  t.after(() => session.close());
  const files = structuredClone({ project: book.project, photoIndex: book.photoIndex });
  files.project.title = 'Layout edit';
  book = await session.save(files, 'Rename');
  const moved = join(f.external, 'moved.md');
  await rename(f.text, moved);
  book = await relocateSource(book, entry.key, moved);
  session.record(book, 'Relink', false);
  const undone = await session.undo('undo');
  assert.equal(sourceEntries(undone).find((item) => item.key === entry.key)!.path, moved);
  const candidates = join(f.root, 'candidates');
  await mkdir(join(candidates, 'a'), { recursive: true }); await mkdir(join(candidates, 'b'));
  await cp(moved, join(candidates, 'a', 'moved.md')); await cp(moved, join(candidates, 'b', 'moved.md'));
  await rm(moved);
  const result = await relinkFolder(await loadProject(f.folder, f.cache), candidates);
  assert.equal(result.repaired, 0);
  assert.deepEqual(result.ambiguous, [entry.key]);
});

test('explicit Copy may import an already linked original as a separate owned source', async (t) => {
  const f = await fixture(t);
  const linked = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const copied = await importIntoProject(linked.book, { kind: 'photo', mode: 'copy' }, [f.photo]);
  assert.notEqual(copied.imported[0], linked.imported[0]);
  assert.equal(copied.book.photoIndex[linked.imported[0]].linked, true);
  assert.equal(copied.book.photoIndex[copied.imported[0]].linked, undefined);
});

test('a saved copy may retain missing links explicitly and preserve the document import default', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'markdown', mode: 'link' }, [f.text]);
  const files = structuredClone({ project: added.book.project, photoIndex: added.book.photoIndex });
  files.project.importMode = 'link';
  const book = await updateProject(added.book, files);
  await rm(f.text);
  const destination = await saveDocumentCopy(book, join(f.root, 'With Links.imageflow'), false);
  const copy = await loadProject(destination, f.cache);
  const entry = sourceEntries(copy).find((entry) => entry.id === added.imported[0])!;
  assert.equal(entry.path, f.text);
  assert.equal(entry.linked, true);
  assert.equal(copy.project.importMode, 'link');
  assert.equal(copy.sources![entry.key].state, 'missing');
});

test('partial writes retain last-good content and damaged caches rebuild without blocking the rest of a book', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  const original = await readFile(f.photo);
  await writeFile(f.photo, original.subarray(0, 12));
  const partial = await loadProject(f.folder, f.cache);
  assert.equal(partial.sources!['photo:' + id].state, 'unreadable');
  assert.equal(partial.sources!['photo:' + id].cached, true);
  assert.equal(partial.photos.get(id)!.width, 120);
  await writeFile(f.photo, original);
  const restored = await loadProject(f.folder, f.cache);
  assert.equal(restored.sources!['photo:' + id].state, 'available');
  await writeFile(restored.photos.get(id)!.original, 'damaged derived cache');
  const repaired = await loadProject(f.folder, f.cache);
  assert.deepEqual(await readFile(repaired.photos.get(id)!.original), original);
  await rm(f.photo);
  await writeFile(repaired.photos.get(id)!.original, 'damaged derived cache');
  const missing = await loadProject(f.folder, f.cache);
  assert.equal(missing.sources!['photo:' + id].cached, false);
  assert.equal(missing.photos.has(id), false);
  assert.ok(missing.photoIndex[id]);
  assert.ok(missing.photos.has('shore'));
});

test('permission loss is an actionable source state, including inaccessible parent directories', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  try {
    await chmod(f.external, 0);
    const denied = await loadProject(f.folder, f.cache);
    assert.equal(denied.sources!['photo:' + id].state, 'denied');
    assert.equal(denied.sources!['photo:' + id].cached, true);
    assert.ok((await captureProjectInputs(f.folder)).revision);
    assert.ok(denied.photos.has('shore'));
  } finally { await chmod(f.external, 0o700); }
  assert.equal((await loadProject(f.folder, f.cache)).sources!['photo:' + id].state, 'available');
});
