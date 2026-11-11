import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { updateProject } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import { projectSchema } from '../src/project';
import type { ProjectFiles } from '../src/project';

const filesOf = ({ project, photoIndex }: ProjectFiles): ProjectFiles => structuredClone({ project, photoIndex });
const withTitle = (book: ProjectFiles, title: string): ProjectFiles => {
  const files = filesOf(book);
  files.project.title = title;
  return files;
};

async function writeManifests(book: OpenProject) {
  const manifests = {
    'project.json': Buffer.from(JSON.stringify(book.project)),
    'photos.json': Buffer.from(JSON.stringify(book.photoIndex)),
  };
  await writeFile(join(book.folder, 'project.json'), manifests['project.json']);
  await writeFile(join(book.folder, 'photos.json'), manifests['photos.json']);
  return { ...book, manifests };
}

async function fixture(t: TestContext) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-history-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const book: OpenProject = {
    folder, cache: join(folder, 'cache'), readOnly: false,
    project: projectSchema.parse({ schemaVersion: 1, title: 'Original', template: { id: 'test', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] }),
    photoIndex: {}, assets: { files: new Map(), urls: {} }, photos: new Map(), texts: {}, files: {}, problems: [],
    manifests: { 'project.json': Buffer.alloc(0), 'photos.json': Buffer.alloc(0) },
  };
  const session = new ProjectSession(await writeManifests(book));
  t.after(() => session.close());
  return session;
}

test('UI and agent saves share named Undo and Redo entries', async (t) => {
  const session = await fixture(t);
  const handle = session.handle;
  await session.save(withTitle(session.book, 'Human'), 'Human title edit');
  await session.save(withTitle(session.book, 'Agent'), 'Agent title edit');
  assert.deepEqual(session.history, { undo: 'Agent title edit', redo: undefined });
  await session.undo('undo');
  assert.equal(session.book.project.title, 'Human');
  assert.deepEqual(session.history, { undo: 'Human title edit', redo: 'Agent title edit' });
  await session.undo('redo');
  assert.equal(session.book.project.title, 'Agent');
  await session.undo('undo');
  await session.undo('undo');
  assert.equal(session.book.project.title, 'Original');
  assert.equal(session.handle, handle);
  assert.equal(JSON.parse(await readFile(join(session.book.folder, 'project.json'), 'utf8')).title, 'Original');
});

test('a failed save from a freshly read base preserves the live session and its history', async (t) => {
  const session = await fixture(t);
  await session.save(withTitle(session.book, 'Human'), 'Human edit');
  const live = session.book;
  const fresh = { ...live, ...withTitle(live, 'External') };
  // The external base changes again before the prepared agent edit is saved.
  await writeManifests({ ...fresh, ...withTitle(fresh, 'Another external edit') });
  await assert.rejects(session.save(withTitle(fresh, 'Agent'), 'Agent edit', fresh), /changed on disk/);
  assert.equal(session.book, live);
  assert.equal(session.book.project.title, 'Human');
  assert.deepEqual(session.history, { undo: 'Human edit', redo: undefined });

  const currentBase = await writeManifests(fresh);
  await session.save(withTitle(currentBase, 'Agent'), 'Agent edit', currentBase);
  assert.equal(session.book.project.title, 'Agent');
  assert.deepEqual(session.history, { undo: 'Agent edit', redo: undefined });
  await session.undo('undo');
  assert.equal(session.book.project.title, 'External');
  assert.equal(session.history.undo, undefined);
});

test('failed Undo leaves both history stacks and the live book available for retry', async (t) => {
  const session = await fixture(t);
  await session.save(withTitle(session.book, 'Human'), 'Human edit');
  const live = session.book;
  await writeManifests({ ...live, ...withTitle(live, 'External') });
  await assert.rejects(session.undo('undo'), /changed on disk/);
  assert.equal(session.book, live);
  assert.deepEqual(session.history, { undo: 'Human edit', redo: undefined });
  await writeManifests(live);
  await session.undo('undo');
  assert.equal(session.book.project.title, 'Original');
  assert.equal(session.history.redo, 'Human edit');
});

test('content reloads preserve history while external manifest changes clear incompatible history', async (t) => {
  const session = await fixture(t);
  await session.save(withTitle(session.book, 'Human'), 'Human edit');
  session.adoptExternal({ ...session.book, texts: { note: 'Updated Markdown on disk' } });
  assert.equal(session.history.undo, 'Human edit');
  await session.undo('undo');
  assert.equal(session.history.redo, 'Human edit');
  session.adoptExternal({ ...session.book, ...withTitle(session.book, 'External') });
  assert.deepEqual(session.history, { undo: undefined, redo: undefined });
});

test('imported source registries and files survive earlier Undo and Redo', async (t) => {
  const session = await fixture(t);
  await session.save(withTitle(session.book, 'Human'), 'Human edit');
  await session.undo('undo');
  const importedFiles = filesOf(session.book);
  importedFiles.project.texts.note = 'texts/note.md';
  importedFiles.project.files.route = 'files/route.gpx';
  importedFiles.photoIndex.image = { path: 'photos/image.png', title: 'Imported image' };
  for (const directory of ['texts', 'files', 'photos']) await mkdir(join(session.book.folder, directory));
  await writeFile(join(session.book.folder, 'texts/note.md'), '# Imported note');
  await writeFile(join(session.book.folder, 'files/route.gpx'), '<gpx/>');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toFile(join(session.book.folder, 'photos/image.png'));
  const imported = await updateProject(session.book, importedFiles, true);
  session.record(imported, 'Import sources', false);
  assert.equal(session.history.redo, 'Human edit');

  await session.undo('redo');
  assert.equal(session.book.project.title, 'Human');
  await session.undo('undo');
  assert.equal(session.book.project.title, 'Original');
  assert.deepEqual(session.book.project.texts, { note: 'texts/note.md' });
  assert.deepEqual(session.book.project.files, { route: 'files/route.gpx' });
  assert.deepEqual(session.book.photoIndex.image, { path: 'photos/image.png', title: 'Imported image' });
  assert.equal(session.book.texts.note, '# Imported note');
  assert.equal(session.book.files.route.text, '<gpx/>');
  assert.equal(session.book.photos.has('image'), true);
  assert.deepEqual(session.book.problems, []);
});

test('closing a project session closes its input index', async (t) => {
  const session = await fixture(t);
  const inputs = session.inputs;
  await inputs.capture();
  session.close();
  session.close();
  await assert.rejects(inputs.capture());
});
