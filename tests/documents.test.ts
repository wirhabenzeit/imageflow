import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocument, documentIdentity, RecentDocuments } from '../desktop/documents';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-documents-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const starter = join(root, 'starter');
  await mkdir(join(starter, '.imageflow/persistence'), { recursive: true });
  await mkdir(join(starter, 'template'));
  await writeFile(join(starter, 'project.json'), JSON.stringify({ title: 'Starter', spreads: [{ id: 'one' }] }));
  await writeFile(join(starter, 'photos.json'), '{}');
  await writeFile(join(starter, 'template/index.tsx'), 'Owned template');
  await writeFile(join(starter, '.imageflow/persistence/pending-save.json'), 'Starter bookkeeping is never copied');
  return { root, starter };
}

test('a new package owns its template and never replaces an existing document', async (t) => {
  const { root, starter } = await fixture(t);
  const folder = await createDocument(join(root, 'Senja'), starter);
  assert.equal(folder, join(root, 'Senja.imageflow'));
  assert.equal(JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).title, 'Senja');
  assert.equal(await readFile(join(folder, 'template/index.tsx'), 'utf8'), 'Owned template');
  assert.ok(!(await readdir(folder)).includes('.imageflow'));
  await writeFile(join(starter, 'template/index.tsx'), 'New starter version');
  assert.equal(await readFile(join(folder, 'template/index.tsx'), 'utf8'), 'Owned template');
  await assert.rejects(createDocument(folder, starter), { code: 'EEXIST' });
  assert.equal(await readFile(join(folder, 'template/index.tsx'), 'utf8'), 'Owned template');
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('.imageflow-create-')));
});

test('document identity follows a move and aliases but distinguishes a Finder duplicate', async (t) => {
  const { root, starter } = await fixture(t);
  const folder = await createDocument(join(root, 'Book'), starter);
  const first = await documentIdentity(folder);
  const alias = join(root, 'Alias.imageflow');
  await symlink(folder, alias);
  assert.deepEqual(await documentIdentity(alias), first);
  const moved = join(root, 'Moved.imageflow');
  await rename(folder, moved);
  assert.equal((await documentIdentity(moved)).identity, first.identity);
  const duplicate = join(root, 'Copy.imageflow');
  await cp(moved, duplicate, { recursive: true });
  assert.notEqual((await documentIdentity(duplicate)).identity, first.identity);
});

test('recent books survive restart, expose missing paths, recover moves, and removal never deletes documents', async (t) => {
  const { root, starter } = await fixture(t);
  const book = await createDocument(join(root, 'Book'), starter);
  const file = join(root, 'app/recents.json');
  const store = new RecentDocuments(file);
  await store.load();
  await store.remember(book, 'My book');
  await store.refresh(book, 'Edited title', 'data:image/jpeg;base64,Y292ZXI=');
  const [{ id }] = await store.list();
  const restored = new RecentDocuments(file);
  await restored.load();
  assert.equal((await restored.list())[0].title, 'Edited title');
  assert.equal((await restored.list())[0].cover, 'data:image/jpeg;base64,Y292ZXI=');
  const moved = join(root, 'Moved.imageflow');
  await rename(book, moved);
  assert.equal((await restored.list())[0].available, false);
  await restored.remember(moved, 'Located', id);
  assert.equal((await restored.list()).length, 1);
  assert.equal((await restored.list())[0].available, true);
  assert.equal((await restored.list())[0].id, id);
  await restored.remove(id);
  assert.deepEqual(await restored.list(), []);
  assert.equal(JSON.parse(await readFile(join(moved, 'project.json'), 'utf8')).title, 'Book');
});
