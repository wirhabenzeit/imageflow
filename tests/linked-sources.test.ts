import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { configureSourceStore, pruneSourceCache, SourceStore } from '../desktop/source-store';
import { approveSource, configureSourceAccess } from '../desktop/source-access';
import { configureRenditionCache } from '../desktop/rendition-cache';
import { photoFile } from '../desktop/photos';
import { isUnavailableSource } from '../src/source-diagnostics';
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
  configureSourceAccess(join(root, 'source-access'));
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

test('proof source warnings and page marking use diagnostic codes rather than unrelated wording', () => {
  assert.equal(isUnavailableSource({ code: 'template:missing-caption' }), false);
  assert.equal(isUnavailableSource({ code: 'layout-error' }), false);
  assert.equal(isUnavailableSource({}), false);
  assert.equal(isUnavailableSource({ code: 'source-unavailable' }), true);
  assert.equal(isUnavailableSource({ code: 'file-unreadable' }), true);
});

test('copied photos retain the original estimated capture date after import and reopen', async (t) => {
  const f = await fixture(t);
  const date = new Date('2020-04-05T12:34:56Z');
  await utimes(f.photo, date, date);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'copy' }, [f.photo]);
  const id = added.imported[0];
  assert.equal(added.book.photoIndex[id].captured, date.toISOString());
  assert.equal(added.book.photos.get(id)!.captured, date.toISOString());
  const reopened = await loadProject(f.folder, f.cache);
  assert.equal(reopened.photos.get(id)!.captured, date.toISOString());
  assert.equal(reopened.photos.get(id)!.capturedEstimated, true);
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
  assert.equal(session.history.undo, 'Rename', 'Relinking does not consume an Undo step');
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

test('unapproved manifests cannot load, hash, collect, copy or share external bytes, including after a book is duplicated', async (t) => {
  const f = await fixture(t);
  const marker = 'dummy-private-fixture';
  const secret = join(f.external, 'private.gpx');
  await writeFile(secret, marker);
  const files = structuredClone({ project: f.book.project, photoIndex: f.book.photoIndex });
  files.project.files.unselected = { path: secret, linked: true };
  files.project.texts.unselected = { path: f.text, linked: true };
  files.photoIndex.unselected = { path: f.photo, linked: true };
  const untrusted = await updateProject(f.book, files, true);
  for (const kind of ['photo', 'markdown', 'file']) assert.equal(untrusted.sources![kind + ':unselected'].state, 'unapproved');
  assert.equal(untrusted.files.unselected.text, undefined);
  assert.equal(untrusted.texts.unselected, undefined);
  assert.equal(untrusted.photos.has('unselected'), false);
  const before = await captureProjectInputs(f.folder);
  await writeFile(secret, 'changed-private-fixture');
  assert.deepEqual(await captureProjectInputs(f.folder), before, 'Unapproved target bytes never enter the revision hash');
  await assert.rejects(collectSources(untrusted), /Locate or restore/);
  await assert.rejects(saveDocumentCopy(untrusted, join(f.root, 'Rejected.imageflow'), true), /Locate or restore/);
  const withLinks = await saveDocumentCopy(untrusted, join(f.root, 'Links.imageflow'), false);
  assert.equal((await loadProject(withLinks, f.cache)).sources!['file:unselected'].state, 'unapproved');
  await assert.rejects(approveSource(f.folder, { key: 'file:unselected', kind: 'file', path: secret, linked: true }, ['.csv']), /accepted by the parameter/);
  const repaired = await relocateSource(untrusted, 'file:unselected', secret, false, ['.gpx']);
  assert.equal(repaired.files.unselected.text, 'changed-private-fixture');
  configureSourceAccess(join(f.root, 'source-access')); // Restart reads approvals from app-owned state.
  assert.equal((await loadProject(f.folder, f.cache)).files.unselected.text, 'changed-private-fixture');
  const clone = join(f.root, 'Downloaded.imageflow');
  await cp(f.folder, clone, { recursive: true });
  assert.equal((await loadProject(clone, f.cache)).sources!['file:unselected'].state, 'unapproved');
  await rm(secret); await symlink(f.file, secret);
  assert.equal((await loadProject(f.folder, f.cache)).sources!['file:unselected'].state, 'unapproved', 'A symlink cannot redirect an approved locator');
});

test('owned photos avoid persistent originals, allow large originals, and use private job snapshots plus cached previews', async (t) => {
  const f = await fixture(t);
  await configureRenditionCache(f.cache, join(f.root, 'renditions'));
  const index = f.book.photoIndex.shore;
  const actual = join(f.folder, index.path);
  assert.ok((await loadProject(f.folder, f.cache)).photos.get('shore')!.original.startsWith(f.folder));
  const content = join(f.root, 'source-cache/content');
  assert.ok((await readdir(content)).every((name) => !/\.(jpg|jpeg|png|webp)$/.test(name)), 'Normal open does not duplicate owned photos');
  // A valid JPEG with trailing padding models a panorama above the import limit without huge test pixels.
  const handle = await open(actual, 'r+');
  await handle.truncate(51 * 1024 * 1024); await handle.close();
  const book = await loadProject(f.folder, f.cache);
  assert.equal(book.sources!['photo:shore'].state, 'available');
  assert.ok((await captureProjectInputs(f.folder)).revision);
  const preview = await photoFile(book.photos.get('shore')!, 'preview');
  const jobCache = join(f.cache, 'job'); await mkdir(jobCache);
  const pinned = await loadProject(f.folder, jobCache, true, true);
  assert.ok(pinned.photos.get('shore')!.original.startsWith(jobCache));
  assert.notEqual(pinned.photos.get('shore')!.original, actual);
  const pinnedInfo = await stat(pinned.photos.get('shore')!.original);
  assert.equal(pinnedInfo.size, 51 * 1024 * 1024);
  const replacement = join(f.folder, 'replacement.jpg');
  await sharp({ create: { width: 60, height: 40, channels: 3, background: 'blue' } }).jpeg().toFile(replacement);
  await rename(replacement, actual);
  await assert.rejects(photoFile(book.photos.get('shore')!, 'thumb'), /original photo changed/);
  await rm(actual);
  const missing = await loadProject(f.folder, f.cache);
  assert.equal(missing.sources!['photo:shore'].state, 'missing');
  assert.equal(missing.sources!['photo:shore'].cached, true);
  assert.equal(missing.photos.get('shore')!.original, preview);
  assert.equal(missing.photos.get('shore')!.width, book.photos.get('shore')!.width);
});

test('stores share concurrent updates and bounded cleanup preserves open inputs while evicting closed snapshots', async (t) => {
  const f = await fixture(t);
  let book = (await importIntoProject(f.book, { kind: 'markdown', mode: 'link' }, [f.text])).book;
  book = (await importIntoProject(book, { kind: 'photo', mode: 'link' }, [f.photo])).book;
  const one = await SourceStore.forBook(f.folder, f.cache);
  const two = await SourceStore.forBook(f.folder, f.cache);
  const entries = sourceEntries(book).filter((entry) => entry.linked);
  await writeFile(f.text, '# A concurrent new edition');
  await sharp({ create: { width: 70, height: 50, channels: 3, background: 'green' } }).png().toFile(f.photo);
  const updates = await Promise.all(entries.map(async (entry, i) => {
    const store = i ? one : two;
    const result = await store.resolve(f.folder, entry); await store.settled();
    return { key: entry.key, digest: result.status.digest };
  }));
  const index = JSON.parse(await readFile(join(f.root, 'source-cache/books', (await readdir(join(f.root, 'source-cache/books')))[0]), 'utf8'));
  for (const update of updates) assert.equal(index[update.key].digest, update.digest, 'Both concurrent updates survive index publication');
  const snapshots = [...one.pins];
  const abandoned = join(f.root, 'source-cache/content/abandoned.tmp');
  const active = join(f.root, 'source-cache/content/active.tmp');
  await writeFile(abandoned, 'old interrupted write'); await utimes(abandoned, 1, 1);
  await writeFile(active, 'current write');
  await pruneSourceCache([f.folder], 0);
  await assert.rejects(stat(abandoned), { code: 'ENOENT' });
  await stat(active);
  for (const path of snapshots) await stat(path);
  await SourceStore.release(f.folder);
  await pruneSourceCache([f.folder], 0);
  for (const path of snapshots) await assert.rejects(stat(path), { code: 'ENOENT' });
  const reopened = await loadProject(f.folder, f.cache);
  assert.ok(entries.every((entry) => reopened.sources![entry.key].state === 'available'));
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

test('mixed imports infer every file type and use the book policy, with an explicit mode taking precedence', async (t) => {
  const f = await fixture(t);
  const files = { project: structuredClone(f.book.project), photoIndex: structuredClone(f.book.photoIndex) };
  files.project.importMode = 'link';
  const book = await updateProject(f.book, files);
  const mixed = await importIntoProject(book, {}, [f.photo, f.text, f.file]);
  assert.deepEqual(mixed.counts, { photos: 1, texts: 1, files: 0, skipped: 1, failed: 0 });
  const [photo, text] = mixed.imported;
  assert.equal(mixed.book.photoIndex[photo].linked, true);
  assert.deepEqual(mixed.book.project.texts[text], { path: f.text, linked: true });
  assert.equal(Object.keys(mixed.book.project.files).length, Object.keys(book.project.files).length);
  const copied = await importIntoProject(mixed.book, { mode: 'copy' }, [f.photo]);
  assert.equal(copied.book.photoIndex[copied.imported[0]].linked, undefined);
  assert.match(copied.book.photoIndex[copied.imported[0]].path, /^photos\//);
  const skipped = await importIntoProject(copied.book, {}, [f.file]);
  assert.equal(skipped.book, copied.book);
  assert.deepEqual(skipped.counts, { photos: 0, texts: 0, files: 0, skipped: 1, failed: 0 });
});

test('mixed imports skip invalid photos while keeping valid assets and reporting parameter files', async (t) => {
  const f = await fixture(t);
  const bad = join(f.external, 'bad.jpg');
  const disguised = join(f.external, 'disguised.png');
  const truncated = join(f.external, 'truncated.jpg');
  await writeFile(bad, 'not a photo');
  await writeFile(disguised, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const bytes = await sharp(f.photo).jpeg().toBuffer();
  await writeFile(truncated, bytes.subarray(0, bytes.length - 20));
  const result = await importIntoProject(f.book, {}, [bad, f.photo, disguised, truncated, f.text, f.file]);
  assert.deepEqual(result.counts, { photos: 1, texts: 1, files: 0, failed: 3, skipped: 1 });
  assert.equal(result.imported.length, 2);
  const file = await importIntoProject(result.book, { kind: 'file', accept: ['.gpx'] }, [f.file]);
  assert.equal(file.counts.files, 1);
});
test('failed imports do not leave newly created source directories behind', async (t) => {
  const f = await fixture(t);
  await rm(join(f.folder, 'texts'), { recursive: true, force: true });
  await assert.rejects(importIntoProject(f.book, { kind: 'markdown', target: { spread: 'gone', box: 'story' } }, [f.text]), /no longer exists/);
  await assert.rejects(stat(join(f.folder, 'texts')), { code: 'ENOENT' });
});
