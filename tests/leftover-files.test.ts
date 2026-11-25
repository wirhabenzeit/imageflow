import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { acquireProjectLock } from '../desktop/persistence';
import { leftoverFiles } from '../desktop/leftover-files';
import { importIntoProject, loadProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import { copySample } from '../desktop/sample-book.mjs';
import { removeSources } from '../desktop/source-actions';
import { configureSourceAccess } from '../desktop/source-access';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { AssetFacts } from '../desktop/asset-facts';
import sharp from 'sharp';
import './persistence-root';

async function folderOf(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-leftover-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
const paths = async (...args: Parameters<typeof leftoverFiles>) => (await leftoverFiles(...args)).map(({ path }) => path).sort();

test('a file is left over only if nothing in the manifests, the session or an open editor names it', async (t) => {
  const root = await folderOf(t);
  const book = join(root, 'Book.imageflow');
  for (const name of ['photos', 'texts', 'files', 'template', 'photos/folder']) await mkdir(join(book, name), { recursive: true });
  for (const path of ['photos/used.jpg', 'photos/Köl.jpg'.normalize('NFD'), 'photos/UPPER.jpg', 'photos/left.jpg', 'photos/.hidden', 'photos/.imageflow-write-1.tmp', 'photos/folder/in.jpg',
    'texts/story.md', 'texts/old.md', 'texts/editing.md', 'files/route.gpx', 'files/undo.gpx', 'files/future.gpx', 'template/index.tsx']) await writeFile(join(book, path), path);
  await writeFile(join(root, 'outside.jpg'), 'outside');
  await symlink(join(root, 'outside.jpg'), join(book, 'photos/link.jpg'));
  const project = { texts: { a: 'texts/story.md' }, files: { r: { path: 'files/route.gpx', linked: false } }, fromANewerVersion: { deep: ['files/future.gpx'] } };
  await writeFile(join(book, 'project.json'), JSON.stringify(project));
  await writeFile(join(book, 'photos.json'), JSON.stringify({ a: { path: 'photos/used.jpg' }, b: { path: 'photos/Köl.jpg' }, c: { path: 'photos/upper.jpg' } }));
  const undo = { project: { files: { u: 'files/undo.gpx' } } };
  assert.deepEqual(await paths(book, [undo], [join(book, 'texts/editing.md')]), ['photos/left.jpg', 'texts/old.md']);
  assert.deepEqual(await paths(book, []), ['files/undo.gpx', 'photos/left.jpg', 'texts/editing.md', 'texts/old.md']);
  const [first] = await leftoverFiles(book, []);
  assert.ok(first.size > 0 && first.modified > 0);
  // Nothing can be told by a manifest that cannot be read, and a folder that is a link is not the book's.
  await writeFile(join(book, 'photos.json'), '{');
  assert.deepEqual(await paths(book, []), []);
  await writeFile(join(book, 'photos.json'), '{}');
  await rm(join(book, 'texts'), { recursive: true });
  await mkdir(join(root, 'elsewhere'));
  await writeFile(join(root, 'elsewhere/private.md'), 'private');
  await symlink(join(root, 'elsewhere'), join(book, 'texts'));
  assert.ok(!(await paths(book, [])).some((path) => path.startsWith('texts/')));
});

test('an undone import is left over only once the session that can redo it has ended (UI-010)', async (t) => {
  const root = await folderOf(t);
  const book = join(root, 'Book.imageflow'), cache = join(root, 'cache');
  await mkdir(cache);
  configureSourceStore(join(root, 'source-cache'));
  configureSourceAccess(join(root, 'source-access'));
  await copySample(resolve('sample/starter'), book);
  const release = await acquireProjectLock(book);
  t.after(async () => { await SourceStore.drain(); await AssetFacts.release(book); await release(); });
  const photo = join(root, 'Rigi.jpg');
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#225588' } }).jpeg().toFile(photo);
  const session = new ProjectSession(await loadProject(book, cache));
  t.after(async () => { await session.close(); });
  const before = await paths(book, session.states);
  const { book: imported } = await importIntoProject(session.book, { kind: 'photo', mode: 'copy' }, [photo]);
  session.record(imported, 'Import sources', true, false);
  const added = Object.values(imported.photoIndex).map((entry) => (entry as { path: string }).path).find((path) => path.includes('Rigi'))!;
  await session.undo('undo');
  assert.deepEqual(await paths(book, session.states), before, 'Redo needs it');
  await session.undo('redo');
  // Removed as an asset: Undo needs it.
  const id = Object.keys(session.book.photoIndex).find((key) => (session.book.photoIndex[key] as { path?: string }).path === added)!;
  session.record(await removeSources(session.book, ['photo:' + id]), 'Remove assets', true, false);
  assert.deepEqual(await paths(book, session.states), before);
  // Another session of the book has no such history.
  const reopened = new ProjectSession(await loadProject(book, cache, true));
  t.after(async () => { await reopened.close(); });
  assert.deepEqual(await paths(book, reopened.states), [...before, added].sort());
});
