import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { configureSourceStore, pruneSourceCache, SourceStore } from '../desktop/source-store';
import { approveSource, configureSourceAccess } from '../desktop/source-access';
import { configureRenditionCache } from '../desktop/rendition-cache';
import { photoFile } from '../desktop/photos';
import { isUnavailableSource } from '../src/source-diagnostics';
import { importIntoProject, loadProject, projectSummary, renderData, updateProject } from '../desktop/project';
import { collectSources, relocateSource, relinkFolder, removeSources, renameSource, saveDocumentCopy } from '../desktop/source-actions';
import { captureBookStateRevision, captureProjectInputs } from '../desktop/revisions';
import { AssetFacts, readAssetFacts } from '../desktop/asset-facts';
import { configureProxyStore } from '../desktop/proxy-store';
import { acquireProjectLock, readSaveLedger, recoverProjectSave } from '../desktop/persistence';
import { ProjectSession } from '../desktop/project-session';
import { sourceEntries, sourceFile } from '../src/source-locations';
import { copySample } from '../desktop/sample-book.mjs';
import { unlocatedPath } from '../src/source-locator';
import { updateSyncState } from '../desktop/sync-pull';
import './persistence-root';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-linked-')));
  const folder = join(root, 'Book.imageflow');
  // Background digests keep writing the source registry, and an open book's asset facts flush on release. Hooks run in
  // the order they were added, so this one runs before `writable`'s release: finish both writers here, then remove the
  // folder, retrying a directory a late write still filled.
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
  const linked = sourceEntries(param.book).filter((entry) => !!sourceFile(entry)?.linked);
  assert.deepEqual(linked.map((entry) => entry.kind).sort(), ['file', 'markdown', 'photo']);
  const other = join(f.external, 'other.md');
  await writeFile(other, '# Copied exception');
  const copied = await importIntoProject(param.book, { kind: 'markdown', mode: 'copy' }, [other]);
  assert.equal(sourceFile(sourceEntries(copied.book).find((entry) => entry.id === copied.imported[0])!)?.linked, false);
  assert.equal(sourceEntries(copied.book).filter((entry) => !!sourceFile(entry)?.linked).length, 3);
});

test('a HEIC photo is imported as a stored JPEG copy, also into a book that links its files (UI-013)', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t);
  const policy = structuredClone({ project: f.book.project, photoIndex: f.book.photoIndex });
  policy.project.importMode = 'link';
  f.book = await updateProject(f.book, policy);
  const jpeg = join(f.external, 'source.jpg');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#2060a0' } }).jpeg().toFile(jpeg);
  const heic = join(f.external, 'IMG_0001.HEIC');
  // macOS writes HEIC itself; the test makes one as an iPhone would hand it over.
  const { execFileSync } = await import('node:child_process');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', jpeg, '--out', heic], { stdio: 'ignore' });
  const old = new Date('2024-05-01T10:00:00Z');
  await utimes(heic, old, old);
  const conversions = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('imageflow-heic-')).sort();
  const before = await conversions();
  const result = await importIntoProject(f.book, { kind: 'photo' }, [heic]);
  assert.equal(result.counts.photos, 1);
  assert.equal(result.counts.converted, 1);
  const entry = sourceEntries(result.book).find((item) => item.id === result.imported[0])!;
  const file = sourceFile(entry)!;
  assert.equal(file.linked, false);
  assert.match(file.path, /^photos\/ph-[0-9a-f-]+-IMG_0001\.jpg$/);
  assert.equal(result.book.photoIndex[entry.id].title, 'IMG_0001');
  const stored = join(f.folder, file.path);
  assert.equal((await sharp(stored).metadata()).format, 'jpeg');
  assert.equal((await stat(stored)).mtime.getTime(), old.getTime());
  // The JPEG made on the way is not left behind.
  assert.deepEqual(await conversions(), before);
});

test('a large linked import checks photos concurrently, keeps the chosen order and reports progress', async (t) => {
  const f = await fixture(t);
  const paths: string[] = [];
  for (let index = 0; index < 20; index++) {
    const path = join(f.external, 'p' + String(index).padStart(2, '0') + '.png');
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#00' + String(index).padStart(2, '0') + '00' } }).png().toFile(path);
    paths.push(path);
  }
  const broken = join(f.external, 'broken.png');
  await writeFile(broken, 'not a png');
  const steps: { done: number; total: number; saving?: boolean }[] = [];
  const result = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [...paths.slice(0, 10), broken, join(f.external, 'story.md'), ...paths.slice(10)],
    (step) => steps.push(step));
  assert.deepEqual(result.counts, { photos: 20, texts: 0, files: 0, skipped: 1, failed: 1 });
  assert.deepEqual(result.imported.map((id) => result.book.photoIndex[id].path), paths);
  assert.ok(result.imported.every((id) => result.book.photos.has(id)), 'every linked photo is approved and loads');
  assert.deepEqual(steps.filter((step) => !step.saving).map((step) => step.done), Array.from({ length: 23 }, (_, index) => index));
  assert.ok(steps.every((step) => step.saving || step.total === 22));
  assert.deepEqual(steps.at(-1), { done: 20, total: 20, saving: true });
});

test('proof source warnings and page marking use diagnostic codes rather than unrelated wording', () => {
  assert.equal(isUnavailableSource({ code: 'template:missing-caption' }), false);
  assert.equal(isUnavailableSource({ code: 'layout-error' }), false);
  assert.equal(isUnavailableSource({}), false);
  assert.equal(isUnavailableSource({ code: 'source-unavailable' }), true);
  assert.equal(isUnavailableSource({ code: 'file-unreadable' }), true);
});

test('copied photos keep the original file time as their estimated capture date, without writing it to photos.json', async (t) => {
  const f = await fixture(t);
  const date = new Date('2020-04-05T12:34:56Z');
  await utimes(f.photo, date, date);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'copy' }, [f.photo]);
  const id = added.imported[0];
  assert.equal('captured' in added.book.photoIndex[id], false);
  assert.equal('capturedEstimated' in added.book.photoIndex[id], false);
  assert.equal(added.book.photos.get(id)!.captured, undefined);
  assert.equal(added.book.photos.get(id)!.estimatedCapture, date.toISOString());
  const reopened = await loadProject(f.folder, f.cache);
  assert.equal(reopened.photos.get(id)!.estimatedCapture, date.toISOString());
  assert.deepEqual(projectSummary(reopened, 'x').photoDates?.[id], { captured: date.toISOString(), capturedEstimated: true });
  // Templates never see the estimate.
  assert.equal('estimatedCapture' in renderData(reopened, 'x', 'export').photos[id], false);
});

test('atomic external replacements refresh dimensions and revisions without changing IDs, crops or immutable snapshots', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  const files = structuredClone({ project: added.book.project, photoIndex: added.book.photoIndex });
  files.project.spreads[1].boxes.hero = { photo: id, params: {}, crops: { story: { centerX: .3, centerY: .4, zoom: 1.8 } } };
  const first = await updateProject(added.book, files);
  const before = await captureProjectInputs(f.folder);
  // The editor reads a linked photo where it is: no copy that a re-export (from Lightroom, say) would bypass.
  assert.equal(first.photos.get(id)!.original, f.photo);
  await photoFile(first.photos.get(id)!, 'thumb');
  const replacement = join(f.external, 'replacement.png');
  await sharp({ create: { width: 80, height: 160, channels: 3, background: '#0000ff' } }).png().toFile(replacement);
  await rename(replacement, f.photo);
  const after = await captureProjectInputs(f.folder);
  assert.notEqual(before.revision, after.revision);
  const refreshed = await loadProject(f.folder, f.cache);
  assert.equal(refreshed.photos.get(id)!.height, 160);
  assert.equal(refreshed.photos.get(id)!.width, 80);
  assert.deepEqual(refreshed.project.spreads[1].boxes.hero.crops, first.project.spreads[1].boxes.hero.crops);
  // Renditions name the file they were made from, so the earlier version's are never shown for the new one.
  assert.notEqual(first.photos.get(id)!.key, refreshed.photos.get(id)!.key);
  // A rendition not made yet cannot be made from the new file under the earlier version's key.
  await assert.rejects(photoFile(first.photos.get(id)!, 'preview'), /original photo changed/);
  // Checks and exports read a private copy for the whole job.
  const jobCache = join(f.cache, 'job'); await mkdir(jobCache);
  const job = await loadProject(f.folder, jobCache, true, true);
  assert.ok(job.photos.get(id)!.original.startsWith(jobCache));
  assert.equal(job.photos.get(id)!.width, 80);
});

test('missing linked photos, Markdown and parameter files reopen with honest last-good status and collect refuses missing originals', async (t) => {
  const f = await fixture(t);
  let book = f.book;
  for (const [kind, path] of [['photo', f.photo], ['markdown', f.text], ['file', f.file]] as const) {
    book = (await importIntoProject(book, { kind, mode: 'link', accept: ['.gpx'] }, [path])).book;
  }
  const entries = sourceEntries(book).filter((entry) => !!sourceFile(entry)?.linked);
  const originals = entries.map((entry) => sourceFile(entry)!.path);
  // A photo shown in the editor has a preview, which stands in for a missing original, as for the book's own photos.
  await photoFile(book.photos.get(entries.find((entry) => entry.kind === 'photo')!.id)!, 'preview');
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
  assert.ok(sourceEntries(portable).every((entry) => !sourceFile(entry)?.linked && portable.sources![entry.key].state === 'available'));
  await mkdir(f.external);
  await writeFile(f.photo, externalPhoto); await writeFile(f.text, '# Restored'); await writeFile(f.file, '<gpx/>');
  const collected = await collectSources(await loadProject(f.folder, f.cache));
  assert.ok(sourceEntries(collected).every((entry) => !sourceFile(entry)?.linked));
  assert.deepEqual(await readFile(f.photo), externalPhoto);
  assert.equal(collected.project.importMode, 'copy');
});

test('relinking repairs an ID across undo and batch matching refuses ambiguous candidates', async (t) => {
  const f = await fixture(t);
  let book = (await importIntoProject(f.book, { kind: 'markdown', mode: 'link' }, [f.text])).book;
  const entry = sourceEntries(book).find((entry) => !!sourceFile(entry)?.linked)!;
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
  assert.equal(sourceFile(sourceEntries(undone).find((item) => item.key === entry.key)!)!.path, moved);
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
  const actual = join(f.folder, index.path!);
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
  const entries = sourceEntries(book).filter((entry) => !!sourceFile(entry)?.linked);
  await writeFile(f.text, '# A concurrent new edition');
  await sharp({ create: { width: 70, height: 50, channels: 3, background: 'green' } }).png().toFile(f.photo);
  const updates = await Promise.all(entries.map(async (entry, i) => {
    const store = i ? one : two;
    const result = await store.resolve(f.folder, entry); await store.settled();
    return { key: entry.key, digest: result.status.digest ?? (entry.kind === 'photo' ? createHash('sha256').update(await readFile(f.photo)).digest('hex') : undefined) };
  }));
  // A linked photo read in place has its digest recorded in the background.
  await one.digested();
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
  // The most recently opened book keeps the snapshots its index names over the limit, so its next open copies nothing
  // again. Superseded snapshots of changed originals are not named and go.
  const current = Object.values(index as Record<string, { snapshot: string }>).map(({ snapshot }) => snapshot);
  await pruneSourceCache([f.folder], 0);
  for (const path of current) await stat(path);
  for (const path of snapshots.filter((path) => !current.includes(path))) await assert.rejects(stat(path), { code: 'ENOENT' });
  // Once another book was opened more recently, the limit applies to them.
  await pruneSourceCache([f.root], 0);
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
  assert.equal(sourceFile(entry)!.path, f.text);
  assert.equal(sourceFile(entry)!.linked, true);
  assert.equal(copy.project.importMode, 'link');
  assert.equal(copy.sources![entry.key].state, 'missing');
});

test('partial writes retain last-good content and damaged caches rebuild without blocking the rest of a book', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  const original = await readFile(f.photo);
  const first = await photoFile(added.book.photos.get(id)!, 'preview');
  await writeFile(f.photo, original.subarray(0, 12));
  const partial = await loadProject(f.folder, f.cache);
  assert.equal(partial.sources!['photo:' + id].state, 'unreadable');
  assert.equal(partial.sources!['photo:' + id].cached, true);
  assert.equal(partial.photos.get(id)!.width, 120);
  await writeFile(f.photo, original);
  const restored = await loadProject(f.folder, f.cache);
  assert.equal(restored.sources!['photo:' + id].state, 'available');
  // The rewritten file is another version: until it has a preview, the earlier version's stands in for it.
  await rm(f.photo);
  const fallback = await loadProject(f.folder, f.cache);
  assert.equal(fallback.sources!['photo:' + id].cached, true);
  assert.equal(fallback.photos.get(id)!.original, first);
  // A damaged preview never stands in for a missing original.
  await writeFile(f.photo, original);
  const preview = await photoFile((await loadProject(f.folder, f.cache)).photos.get(id)!, 'preview');
  await rm(f.photo);
  await writeFile(preview, 'damaged derived cache');
  await writeFile(first, 'damaged derived cache');
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
  await photoFile(added.book.photos.get(id)!, 'preview');
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
  assert.match(copied.book.photoIndex[copied.imported[0]].path!, /^photos\//);
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

test('files of types the template accepts import as files without a kind; other files are still skipped', async (t) => {
  const f = await fixture(t);
  const other = join(f.external, 'notes.csv');
  await writeFile(other, 'a,b');
  const result = await importIntoProject(f.book, { accept: ['.gpx'] }, [f.file, other, f.text]);
  assert.deepEqual(result.counts, { photos: 0, texts: 1, files: 1, skipped: 1, failed: 0 });
  assert.match(result.book.project.files[result.imported[0]] as string, /^files\/fl-[a-f0-9-]{12}-route\.gpx$/);
  const plain = await importIntoProject(f.book, {}, [f.file]);
  assert.deepEqual(plain.counts, { photos: 0, texts: 0, files: 0, skipped: 1, failed: 0 });
});

test('removing an assigned file clears its assignments in one undoable edit that keeps the copied bytes', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'file', accept: ['.gpx'] }, [f.file]);
  const [id] = added.imported;
  const session = new ProjectSession(added.book);
  t.after(() => session.close());
  const assigned = structuredClone({ project: added.book.project, photoIndex: added.book.photoIndex });
  assigned.project.params.track = id;
  const spread = assigned.project.spreads[0];
  spread.elements.route = { params: { track: id, tracks: [{ id: 'a', track: id, name: 'Ride' }, { id: 'b', track: 'other' }] } };
  const book = await session.save(assigned, 'Assign');
  const path = join(f.folder, book.project.files[id] as string);
  const removed = await removeSources(book, ['file:' + id]);
  session.record(removed, 'Remove assets', true, false);
  assert.equal(removed.project.files[id], undefined);
  assert.equal(removed.project.params.track, undefined);
  assert.deepEqual(removed.project.spreads[0].elements.route.params, { tracks: [{ id: 'a', name: 'Ride' }, { id: 'b', track: 'other' }] });
  assert.equal(await readFile(path, 'utf8'), '<gpx><trk/></gpx>', 'The copied file stays for Undo');
  const undone = await session.undo('undo');
  assert.equal(undone.project.files[id], book.project.files[id]);
  assert.equal(undone.project.params.track, id);
  assert.deepEqual(undone.project.spreads[0].elements.route.params, assigned.project.spreads[0].elements.route.params);
  const redone = await session.undo('redo');
  assert.equal(redone.project.files[id], undefined);
  assert.equal(redone.project.params.track, undefined);
});

test('restart migration restores approvals and cached photos from all legacy device records', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  const entry = sourceEntries(added.book).find((entry) => entry.id === id)!;
  const store = await SourceStore.forBook(f.folder, f.cache);
  await store.settled();
  const access = join(f.root, 'source-access');
  const indices = join(f.root, 'source-cache/books');
  const { sourceBookKey } = await import('../desktop/source-access');
  const key = await sourceBookKey(f.folder);
  if (!key.startsWith('volume-')) return t.skip('The test directory is on a volume without a UUID');
  const info = await stat(f.folder, { bigint: true });
  const legacy = `999999-${info.ino}-${info.birthtimeNs}.json`;
  await rename(join(access, key + '.json'), join(access, legacy));
  await rename(join(indices, key + '.json'), join(indices, legacy));
  // A partial registry created after the reboot must not hide the old photo approvals.
  await writeFile(join(access, `999998-${info.ino}-${info.birthtimeNs}.json`), JSON.stringify({
    'markdown:other': { path: f.text },
  }));
  configureSourceAccess(access);
  configureSourceStore(join(f.root, 'source-cache'));
  const reopened = await loadProject(f.folder, f.cache);
  assert.equal(reopened.sources![entry.key].state, 'available');
  const migrated = JSON.parse(await readFile(join(access, key + '.json'), 'utf8'));
  assert.equal(migrated[entry.key].path, f.photo);
  assert.equal(migrated['markdown:other'].path, f.text);
  await stat(join(access, legacy)); // Rollback data is preserved.
  await photoFile(reopened.photos.get(id)!, 'preview');
  await rm(f.photo);
  const missing = await loadProject(f.folder, f.cache);
  assert.equal(missing.sources![entry.key].state, 'missing');
  assert.equal(missing.sources![entry.key].cached, true);
  assert.ok(missing.photos.has(id));
});

test('Locate Folder reapproves exact originals with no approvals or cache, but never same-name replacements', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  // The import's background digest still writes the source registry. Configuring the store again below forgets that
  // store, so nothing would wait for it later and its write could land while the test's folder is removed.
  await SourceStore.drain();
  await rm(join(f.root, 'source-access'), { recursive: true });
  await rm(join(f.root, 'source-cache'), { recursive: true });
  configureSourceAccess(join(f.root, 'source-access'));
  configureSourceStore(join(f.root, 'source-cache'));
  const unavailable = await loadProject(f.folder, f.cache);
  assert.equal(unavailable.sources!['photo:' + id].state, 'unapproved');
  const other = join(f.root, 'other'); await mkdir(other);
  await cp(f.photo, join(other, 'photo.png'));
  assert.equal((await relinkFolder(unavailable, other)).repaired, 0);
  const repaired = await relinkFolder(unavailable, f.external);
  assert.equal(repaired.repaired, 1);
  assert.equal(repaired.book.sources!['photo:' + id].state, 'available');
  assert.equal(repaired.book.photoIndex[id].path, f.photo);
});

test('Locate Folder finds a moved linked photo by the digest recorded after it was read in place', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  // Opening reads the photo in place; its digest follows in the background.
  await (await SourceStore.forBook(f.folder, f.cache)).digested();
  const moved = join(f.root, 'moved'); await mkdir(moved);
  await rename(f.photo, join(moved, 'photo.png'));
  const missing = await loadProject(f.folder, f.cache);
  assert.equal(missing.sources!['photo:' + id].state, 'missing');
  const repaired = await relinkFolder(missing, moved);
  assert.equal(repaired.repaired, 1);
  assert.equal(repaired.book.photoIndex[id].path, join(moved, 'photo.png'));
});

test('a file stored in the book is renamed in place, keeping its ID, extension and assignments (F-027)', async (t) => {
  const f = await fixture(t);
  const decomposed = join(f.external, '2026-08-22 Söng Kul.gpx');
  await writeFile(decomposed, '<gpx><trk/></gpx>');
  const added = await importIntoProject(f.book, { kind: 'file', mode: 'copy', accept: ['.gpx'] }, [decomposed]);
  const [id] = added.imported;
  const stored = added.book.project.files[id] as string;
  assert.equal(stored, 'files/' + id + '-2026-08-22 Söng Kul.gpx', 'the umlaut survives the copy (F-026)');
  const session = new ProjectSession(added.book);
  t.after(() => session.close());
  const assigned = structuredClone({ project: added.book.project, photoIndex: added.book.photoIndex });
  assigned.project.params.track = id;
  const book = await session.save(assigned, 'Assign');

  const renamed = await renameSource(book, 'file:' + id, 'Stage 05: Song Kul');
  assert.equal(renamed.project.files[id], 'files/' + id + '-Stage 05- Song Kul.gpx', 'unsafe characters replaced, extension kept');
  assert.equal(renamed.project.params.track, id);
  assert.equal(await readFile(join(f.folder, renamed.project.files[id] as string), 'utf8'), '<gpx><trk/></gpx>');
  await assert.rejects(readFile(join(f.folder, stored)), 'the copy moved rather than duplicated');
  session.record(renamed, 'Source location changed', false);
  // Undoing an earlier edit keeps the current path, so it never points at the old name.
  const undone = await session.undo('undo');
  assert.equal(undone.project.files[id], renamed.project.files[id]);
  assert.equal(undone.project.params.track, undefined);

  assert.equal(await renameSource(undone, 'file:' + id, 'Stage 05- Song Kul.gpx'), undone, 'the same name is no change');
  await writeFile(join(f.folder, 'files', id + '-Taken.gpx'), 'x');
  await assert.rejects(renameSource(undone, 'file:' + id, 'Taken'), /already has this name/);
  await assert.rejects(renameSource(undone, 'file:' + id, '  '), /Enter a name/);
  const linked = await importIntoProject(undone, { kind: 'file', mode: 'link', accept: ['.gpx'] }, [f.file]);
  await assert.rejects(renameSource(linked.book, 'file:' + linked.imported[0], 'Other'), /keeps the name of its original/);

  // A change of case renames the file itself. On a case-sensitive volume, another file that differs only in case is
  // a different file and is never replaced.
  const recased = await renameSource(linked.book, 'file:' + id, 'stage 05- song kul');
  assert.equal(recased.project.files[id], 'files/' + id + '-stage 05- song kul.gpx');
  assert.equal(await readFile(join(f.folder, recased.project.files[id] as string), 'utf8'), '<gpx><trk/></gpx>');
  const other = join(f.folder, 'files', id + '-STAGE 05- SONG KUL.gpx');
  const sensitive = await stat(other).then(() => false, () => true);
  if (sensitive) {
    await writeFile(other, 'another file');
    await assert.rejects(renameSource(recased, 'file:' + id, 'STAGE 05- SONG KUL'), /already has this name/);
    assert.equal(await readFile(other, 'utf8'), 'another file');
  }

  // A registered asset that is a link to another asset's file is not renamed: that would move the other file.
  const target = join(f.folder, 'files', id + '-target.gpx');
  await writeFile(target, 'the other asset');
  const files = structuredClone({ project: recased.project, photoIndex: recased.photoIndex });
  files.project.files.linkedEntry = 'files/linkedEntry-link.gpx';
  await symlink(target, join(f.folder, 'files', 'linkedEntry-link.gpx'));
  const withLink = await updateProject(recased, files, true);
  await assert.rejects(renameSource(withLink, 'file:linkedEntry', 'Moved'), /is a link/);
  assert.equal(await readFile(target, 'utf8'), 'the other asset');

  // A files folder replaced by a link to somewhere else is not renamed into, nor is anything there renamed.
  const outside = join(f.root, 'outside');
  await rename(join(f.folder, 'files'), outside);
  await symlink(outside, join(f.folder, 'files'));
  await assert.rejects(renameSource(withLink, 'file:' + id, 'Escaped'), /book’s own folder|must be inside|points outside/);
  assert.equal(await readFile(join(outside, id + '-stage 05- song kul.gpx'), 'utf8'), '<gpx><trk/></gpx>');
});

test('importing photos the book already holds, linked or copied, adds nothing under the book’s policy (F-044)', async (t) => {
  const f = await fixture(t);
  // The book copies by default; its photo was linked explicitly earlier.
  const linked = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const again = await importIntoProject(linked.book, { kind: 'photo' }, [f.photo]);
  assert.equal(again.book, linked.book, 'Nothing changes');
  assert.deepEqual(again.imported, linked.imported);
  assert.equal(again.counts.existing, 1);
  assert.equal(again.counts.photos, 0);
  assert.equal(again.copied.length, 0);
  // A copied photo is recognised by its bytes, wherever the original is now; new photos in the same import are added.
  const other = join(f.external, 'other.png');
  await sharp({ create: { width: 90, height: 60, channels: 3, background: '#00ff00' } }).png().toFile(other);
  const copied = await importIntoProject(linked.book, { kind: 'photo', mode: 'copy' }, [other]);
  const moved = join(f.external, 'moved'); await mkdir(moved);
  await cp(other, join(moved, 'other.png'));
  const fresh = join(f.external, 'fresh.png');
  await sharp({ create: { width: 70, height: 50, channels: 3, background: '#0000ff' } }).png().toFile(fresh);
  const mixed = await importIntoProject(copied.book, { kind: 'photo' }, [join(moved, 'other.png'), f.photo, fresh]);
  assert.equal(mixed.counts.existing, 2);
  assert.equal(mixed.counts.photos, 1);
  assert.deepEqual(mixed.imported.slice(0, 2), [copied.imported[0], linked.imported[0]]);
  assert.equal(Object.keys(mixed.book.photoIndex).length, Object.keys(copied.book.photoIndex).length + 1);
});

test('an import is one Undo step that removes the sources it added (F-044)', async (t) => {
  const f = await fixture(t);
  const session = new ProjectSession(f.book);
  t.after(() => session.close());
  const added = await importIntoProject(f.book, { kind: 'photo' }, [f.photo]);
  session.record(added.book, 'Import sources', true, false);
  assert.equal(session.history.undo, 'Import sources');
  const undone = await session.undo('undo');
  assert.equal(undone.photoIndex[added.imported[0]], undefined);
  const redone = await session.undo('redo');
  assert.ok(redone.photoIndex[added.imported[0]]);
});

// assets-meta.json (ADR 0010): derived facts that live outside the save journal, ledger and portable revision.
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function writable(t: { after: (fn: () => Promise<void>) => void }, f: { folder: string }) {
  const release = await acquireProjectLock(f.folder);
  t.after(async () => { await AssetFacts.release(f.folder); await release(); });
}
async function settleFacts(f: { folder: string; cache: string }) {
  await (await SourceStore.forBook(f.folder, f.cache)).digested();
  await (await AssetFacts.forBook(f.folder)).flush();
}
const readMeta = async (folder: string) => JSON.parse(await readFile(join(folder, 'assets-meta.json'), 'utf8')) as { version: number; assets: Record<string, Record<string, unknown>> };
const stagingFiles = async (folder: string) => (await readdir(folder)).filter((name) => name.startsWith('.imageflow-write-'));

test('background digests update assets-meta.json without a new revision, ledger record or pending journal', async (t) => {
  const f = await fixture(t);
  await writable(t, f);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const id = added.imported[0];
  const records = (await readSaveLedger(f.folder)).records.length;
  const portable = await captureBookStateRevision(f.folder);
  const local = (await captureProjectInputs(f.folder)).revision;
  await loadProject(f.folder, f.cache);
  await settleFacts(f);
  const meta = await readMeta(f.folder);
  assert.equal(meta.version, 1);
  // The sample book's copied photos are recorded as well.
  assert.ok(Object.keys(meta.assets).length > 1 && id in meta.assets);
  assert.equal(meta.assets[id].digest, sha(await readFile(f.photo)));
  assert.equal(meta.assets[id].width, 120);
  assert.equal(meta.assets[id].height, 80);
  assert.ok(!Number.isNaN(Date.parse(meta.assets[id].verified as string)));
  // Nothing user-authored moved: not the portable revision, not the local render-input revision, not the ledger.
  assert.equal(await captureBookStateRevision(f.folder), portable);
  assert.equal((await captureProjectInputs(f.folder)).revision, local);
  assert.equal((await readSaveLedger(f.folder)).records.length, records);
  await recoverProjectSave(f.folder, { readOnly: true });
  assert.deepEqual(await stagingFiles(f.folder), []);
  // Unchanged facts are not written again.
  const before = await stat(join(f.folder, 'assets-meta.json'), { bigint: true });
  await loadProject(f.folder, f.cache);
  await settleFacts(f);
  assert.equal((await stat(join(f.folder, 'assets-meta.json'), { bigint: true })).ino, before.ino);
  assert.equal((await readMeta(f.folder)).assets[id].verified, meta.assets[id].verified);
});

test('copied photos get facts too, and an in-place replacement refreshes the digest and dimensions', async (t) => {
  const f = await fixture(t);
  await writable(t, f);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const [id] = added.imported;
  await loadProject(f.folder, f.cache);
  await settleFacts(f);
  const first = (await readMeta(f.folder)).assets[id];
  assert.equal(first.digest, sha(await readFile(f.photo)));
  const replacement = join(f.external, 'replacement.png');
  await sharp({ create: { width: 80, height: 160, channels: 3, background: '#0000ff' } }).png().toFile(replacement);
  await rename(replacement, f.photo);
  const records = (await readSaveLedger(f.folder)).records.length;
  await loadProject(f.folder, f.cache);
  await settleFacts(f);
  const second = (await readMeta(f.folder)).assets[id];
  assert.equal(second.digest, sha(await readFile(f.photo)));
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual([second.width, second.height], [80, 160]);
  assert.equal((await readSaveLedger(f.folder)).records.length, records);
  // A photo that left the book leaves the facts too.
  const stripped = structuredClone({ project: added.book.project, photoIndex: added.book.photoIndex });
  delete stripped.photoIndex[id];
  const next = await updateProject(await loadProject(f.folder, f.cache), stripped, true);
  assert.ok(!next.photos.has(id));
  await (await AssetFacts.forBook(f.folder)).flush();
  assert.equal(id in (await readMeta(f.folder)).assets, false);
});

test('a missing original keeps its state and print blocking but still lays out from assets-meta.json', async (t) => {
  const f = await fixture(t);
  await writable(t, f);
  const taken = join(f.external, 'dated.jpg');
  await sharp({ create: { width: 90, height: 60, channels: 3, background: '#00ff00' } })
    .withExif({ IFD2: { DateTimeOriginal: '2024:06:01 18:20:30', OffsetTimeOriginal: '+02:00' } }).jpeg().toFile(taken);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [taken]);
  const [id] = added.imported;
  await loadProject(f.folder, f.cache);
  await settleFacts(f);
  await rm(taken);
  const missing = await loadProject(f.folder, f.cache, true);
  assert.equal(missing.sources!['photo:' + id].state, 'missing');
  assert.ok(missing.sources!['photo:' + id].problem);
  assert.equal(missing.photos.has(id), false, 'the photo itself stays missing, so its boxes stay empty and export is blocked');
  assert.equal(id in renderData(missing, 'x', 'export').photos, false);
  const summary = projectSummary(missing, 'x');
  assert.deepEqual(summary.photoSizes[id], { width: 90, height: 60 });
  assert.deepEqual(summary.photoDates?.[id], { captured: '2024-06-01T18:20:30+02:00' });
});

test('an invalid assets-meta.json is ignored while opening and regenerated by the writer', async (t) => {
  const f = await fixture(t);
  await writable(t, f);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const [id] = added.imported;
  await writeFile(join(f.folder, 'assets-meta.json'), '{ "version": 7, "assets": ');
  assert.deepEqual(await readAssetFacts(f.folder), {});
  await AssetFacts.release(f.folder);
  const reopened = await loadProject(f.folder, f.cache);
  assert.ok(reopened.photos.has(id));
  await settleFacts(f);
  assert.equal((await readMeta(f.folder)).assets[id].digest, sha(await readFile(f.photo)));
  await writeFile(join(f.folder, 'assets-meta.json'), JSON.stringify({ version: 1, assets: { [id]: { digest: 'nope', width: 1, height: 1, verified: 'x' } } }));
  assert.deepEqual(await readAssetFacts(f.folder), {});
});

test('a book opened without the writer lock only reads assets-meta.json', async (t) => {
  const f = await fixture(t);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const [id] = added.imported;
  await loadProject(f.folder, f.cache, true);
  await settleFacts(f);
  await assert.rejects(stat(join(f.folder, 'assets-meta.json')), { code: 'ENOENT' });
  assert.deepEqual(await stagingFiles(f.folder), []);
  const existing = { version: 1, assets: { [id]: { digest: 'a'.repeat(64), width: 5, height: 6, verified: '2026-01-01T00:00:00.000Z' } } };
  await writeFile(join(f.folder, 'assets-meta.json'), JSON.stringify(existing));
  assert.deepEqual((await readAssetFacts(f.folder))[id].width, 5);
  await AssetFacts.release(f.folder);
});

test('Save a Copy carries assets-meta.json along, since it is keyed by asset ID and regenerates anyway', async (t) => {
  const f = await fixture(t);
  await writable(t, f);
  const added = await importIntoProject(f.book, { kind: 'photo', mode: 'link' }, [f.photo]);
  const [id] = added.imported;
  await loadProject(f.folder, f.cache);
  await settleFacts(f);
  const copied = await saveDocumentCopy(await loadProject(f.folder, f.cache), join(f.root, 'Copy.imageflow'), true);
  assert.equal((await readMeta(copied)).assets[id].digest, sha(await readFile(f.photo)));
});

// Sync proxies (ADR 0010, #249): a book opened on a second Mac shows pulled proxies for originals that are not there.
async function secondMac(t: { after: (fn: () => Promise<void>) => void }, f: { root: string; folder: string; cache: string; external: string }) {
  const taken = join(f.external, 'dated.jpg');
  await sharp({ create: { width: 90, height: 60, channels: 3, background: '#00ff00' } })
    .withExif({ IFD2: { DateTimeOriginal: '2024:06:01 18:20:30', OffsetTimeOriginal: '+02:00' } }).jpeg().toFile(taken);
  // Mac A: a linked photo and the sample's owned photos, with their facts in assets-meta.json.
  const release = await acquireProjectLock(f.folder);
  const added = await importIntoProject(await loadProject(f.folder, f.cache), { kind: 'photo', mode: 'link' }, [taken]);
  const [linked] = added.imported;
  await loadProject(f.folder, f.cache);
  await settleFacts(f);
  const facts = (await readMeta(f.folder)).assets;
  await AssetFacts.release(f.folder);
  await release();
  await SourceStore.drain();
  // Mac B: fresh source store, approvals and rendition cache; the owned original is not downloaded yet.
  configureSourceStore(join(f.root, 'mac-b', 'source-cache'));
  configureSourceAccess(join(f.root, 'mac-b', 'source-access'));
  const cache = join(f.root, 'mac-b', 'cache');
  await mkdir(cache, { recursive: true });
  await configureRenditionCache(cache, join(f.root, 'mac-b', 'Cache', 'renditions'));
  const proxies = await configureProxyStore(join(f.root, 'mac-b', 'Cache', 'proxies'));
  t.after(async () => { configureProxyStore(undefined); });
  const owned = join(f.folder, added.book.photoIndex.shore.path!);
  await rm(owned);
  return { taken, linked, facts, cache, proxies, owned };
}
const proxyOf = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#0000ff' } }).jpeg().toBuffer();

test('a second Mac renders pulled proxies with the originals\u2019 size and capture data, and print stays blocked', async (t) => {
  const f = await fixture(t);
  const mac = await secondMac(t, f);
  // Proxies are smaller than the originals and have another aspect ratio, so the layout facts visibly come from assets-meta.json.
  const linkedProxy = await mac.proxies.put(mac.facts[mac.linked].digest as string, await proxyOf(40, 40));
  const ownedProxy = await mac.proxies.put(mac.facts.shore.digest as string, await proxyOf(30, 50));
  const release = await acquireProjectLock(f.folder);
  t.after(async () => { await AssetFacts.release(f.folder); await release(); });
  const book = await loadProject(f.folder, mac.cache);
  for (const [id, state, proxy] of [[mac.linked, 'unapproved', linkedProxy], ['shore', 'missing', ownedProxy]] as const) {
    const source = book.sources!['photo:' + id];
    assert.equal(source.state, state, 'the source keeps its honest state');
    assert.equal(source.cached, true, 'shown like a cached preview, which the render frame reports as source-unavailable for print');
    // Nothing says that these originals are elsewhere: the linked path may be a file here that needs approval, and no
    // sync record says that the owned file was never here. Both stay findings, though a preview stands in (#308).
    assert.ok(source.problem);
    assert.equal(source.away, undefined);
    const photo = book.photos.get(id)!;
    assert.equal(photo.original, proxy);
    assert.ok(photo.problem);
    assert.deepEqual([photo.width, photo.height], [mac.facts[id].width, mac.facts[id].height]);
    const rendered = renderData(book, 'x', 'edit').photos[id];
    assert.deepEqual([rendered.width, rendered.height], [mac.facts[id].width, mac.facts[id].height]);
    assert.ok(rendered.src.endsWith('/photo/' + id));
    // The canvas draws renditions of the proxy.
    const preview = await photoFile(photo, 'preview');
    assert.equal((await sharp(preview).metadata()).width, (await sharp(proxy).metadata()).width);
  }
  assert.deepEqual([book.photos.get(mac.linked)!.width, book.photos.get(mac.linked)!.height], [90, 60]);
  // Another load looks the proxy up again, which touches its times for LRU pruning: the open book still draws it, and
  // its renditions are reused rather than made again.
  const thumbless = book.photos.get('shore')!;
  const again = await loadProject(f.folder, mac.cache, true);
  assert.equal(again.photos.get(mac.linked)!.key, book.photos.get(mac.linked)!.key);
  await photoFile(thumbless, 'thumb');
  // A proof export never enlarges a proxy to the original's size.
  const exported = await photoFile(book.photos.get(mac.linked)!, 'export', 80);
  assert.ok((await sharp(exported).metadata()).width! <= 40);
  assert.deepEqual(book.photos.get(mac.linked)!.captured, { dateTime: '2024-06-01T18:20:30', offset: '+02:00' });
  assert.deepEqual(projectSummary(book, 'x').photoDates?.[mac.linked], { captured: '2024-06-01T18:20:30+02:00' });
  assert.equal(book.unavailablePhotos?.[mac.linked], undefined);
  // Layout and crop edits work on a proxy-backed photo.
  const files = structuredClone({ project: book.project, photoIndex: book.photoIndex });
  const spread = files.project.spreads.find(({ boxes }) => Object.values(boxes).some((box) => box.photo === 'shore'))!;
  const [boxId] = Object.entries(spread.boxes).find(([, box]) => box.photo === 'shore')!;
  spread.boxes[boxId] = { ...spread.boxes[boxId], photo: mac.linked, crops: { [spread.definition]: { centerX: 0.4, centerY: 0.6, zoom: 2 } } };
  const edited = await updateProject(book, files, true);
  assert.equal(edited.project.spreads.find(({ id }) => id === spread.id)!.boxes[boxId].photo, mac.linked);
  assert.equal(edited.photos.get(mac.linked)!.original, linkedProxy);
  // Export loads pin the book: a proxy stands in there too, still marked unavailable, so print is blocked and the
  // proof PDF marks its pages.
  const job = join(mac.cache, 'job'); await mkdir(job);
  const pinned = await loadProject(f.folder, job, true, true);
  assert.equal(pinned.sources!['photo:' + mac.linked].state, 'unapproved');
  assert.equal(pinned.sources!['photo:' + mac.linked].cached, true);
  assert.equal(pinned.photos.get(mac.linked)!.original, linkedProxy);
  // Collecting never reads a proxy: the originals are required.
  await assert.rejects(collectSources(edited, ['photo:' + mac.linked]), /Cannot include/);
  await assert.rejects(collectSources(edited, ['photo:shore']), /Cannot include/);
  // Once the owned original arrives, it is used again and the proxy is ignored.
  await sharp({ create: { width: mac.facts.shore.width as number, height: mac.facts.shore.height as number, channels: 3, background: 'white' } }).jpeg().toFile(mac.owned);
  const restored = await loadProject(f.folder, mac.cache, true);
  assert.equal(restored.sources!['photo:shore'].state, 'available');
  assert.equal(restored.photos.get('shore')!.original, mac.owned);
});

test('an original that is elsewhere is told from one that needs approval or is missing, from what this Mac knows alone (#308)', async (t) => {
  const f = await fixture(t);
  const mac = await secondMac(t, f);
  const release = await acquireProjectLock(f.folder);
  t.after(async () => { await AssetFacts.release(f.folder); await release(); });
  const relocate = async (path: string) => {
    const index = JSON.parse(await readFile(join(f.folder, 'photos.json'), 'utf8'));
    index[mac.linked].path = path;
    await writeFile(join(f.folder, 'photos.json'), JSON.stringify(index, null, 2) + '\n');
  };
  const sources = async () => (await loadProject(f.folder, mac.cache)).sources!;
  // Without a preview the photo is not on the page at all: the placeholder of a pull asks to be located like any path.
  await relocate(unlocatedPath('dated.jpg'));
  let linked = (await sources())['photo:' + mac.linked];
  assert.deepEqual([linked.state, linked.away, linked.problem], ['unapproved', undefined, 'Locate this original to approve access on this Mac.']);
  await mac.proxies.put(mac.facts[mac.linked].digest as string, await proxyOf(40, 40));
  await mac.proxies.put(mac.facts.shore.digest as string, await proxyOf(30, 50));
  linked = (await sources())['photo:' + mac.linked];
  assert.deepEqual([linked.state, linked.cached, linked.away, linked.problem], ['unapproved', true, 'other-mac', 'Original on another Mac']);
  assert.deepEqual(linked.repairs, ['locate', 'locate-folder']);
  // A path that was never approved here is a file that needs approval, also with a preview at hand, and is never read.
  await relocate(mac.taken);
  linked = (await sources())['photo:' + mac.linked];
  assert.deepEqual([linked.state, linked.away], ['unapproved', undefined]);
  // An owned original is on its way only if this Mac's own sync record says it never had that version.
  const record = (localDigests: Record<string, string> | undefined) => updateSyncState(f.folder, () => ({ version: 1, lastSynced: { commitId: randomUUID(),
    bookStateRevision: 'a'.repeat(64), stateDigest: 'b'.repeat(64), photoDigests: { shore: mac.facts.shore.digest as string }, ...(localDigests ? { localDigests } : {}) } }));
  assert.equal((await sources())['photo:shore'].away, undefined);
  await record({});
  const shore = (await sources())['photo:shore'];
  assert.deepEqual([shore.state, shore.cached, shore.away, shore.problem], ['missing', true, 'not-downloaded', 'Original not downloaded yet']);
  await record({ shore: mac.facts.shore.digest as string });
  assert.equal((await sources())['photo:shore'].away, undefined, 'this Mac had it: it is missing here');
  await record(undefined);
  assert.equal((await sources())['photo:shore'].away, undefined, 'an older record does not say');
});

test('an unapproved linked photo without a synced proxy exposes nothing from its path on this Mac', async (t) => {
  const f = await fixture(t);
  const mac = await secondMac(t, f);
  // The foreign path holds a readable photo, and a proxy exists for another digest only.
  await mac.proxies.put('f'.repeat(64), await proxyOf(40, 40));
  const book = await loadProject(f.folder, mac.cache, true);
  const source = book.sources!['photo:' + mac.linked];
  assert.equal(source.state, 'unapproved');
  assert.equal(source.cached, false);
  assert.equal(book.photos.has(mac.linked), false);
  assert.equal(mac.linked in renderData(book, 'x', 'edit').photos, false);
  assert.equal(mac.linked in renderData(book, 'x', 'export').photos, false);
  for (const photo of book.photos.values()) assert.notEqual(photo.original, mac.taken);
  // Its layout facts still come from assets-meta.json alone.
  assert.deepEqual(projectSummary(book, 'x').photoSizes[mac.linked], { width: 90, height: 60 });
  // A missing owned photo without a proxy stays empty too.
  assert.equal(book.photos.has('shore'), false);
  assert.equal(book.sources!['photo:shore'].state, 'missing');
});
