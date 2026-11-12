import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocument, documentIdentity, RecentDocuments } from '../desktop/documents';
import { templateFolder, textSourcePath } from '../desktop/document-actions';
import { approveSource } from '../desktop/source-access';

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
  await assert.rejects(createDocument(folder, starter), /A book named “Senja.imageflow” already exists there. Choose another name/);
  assert.equal(await readFile(join(folder, 'template/index.tsx'), 'utf8'), 'Owned template');
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('.imageflow-create-')));
});

test('recents accept restored packages at the saved path and retain their recent identity', async (t) => {
  const { root, starter } = await fixture(t);
  const book = await createDocument(join(root, 'Restored'), starter);
  const file = join(root, 'recents.json');
  const store = new RecentDocuments(file);
  await store.remember(book, 'Original');
  const [original] = await store.list();
  // Simulate a restored package or a remounted volume without relying on inode allocation.
  const entries = JSON.parse(await readFile(file, 'utf8'));
  entries[0].identity = 'previous-device:previous-inode';
  await writeFile(file, JSON.stringify(entries));
  const restored = new RecentDocuments(file);
  await restored.load();
  assert.equal((await restored.list())[0].available, true);
  await restored.remember(book, 'Restored', original.id);
  const [updated] = await restored.list();
  assert.equal(updated.id, original.id);
  assert.equal((await restored.get(original.id)).identity, (await documentIdentity(book)).identity);
  assert.equal((await restored.list()).length, 1);
});

test('an oversized or malformed cover cannot discard recent books across restart', async (t) => {
  const { root, starter } = await fixture(t);
  const first = await createDocument(join(root, 'One'), starter);
  const second = await createDocument(join(root, 'Two'), starter);
  const file = join(root, 'recents.json');
  const store = new RecentDocuments(file);
  await store.remember(first, 'One'); await store.remember(second, 'Two');
  await store.refresh(first, 'One', 'small cover');
  await store.refresh(first, 'Renamed', 'x'.repeat(300_001));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.find((entry: { path: string }) => entry.path === first).cover, 'small cover');
  saved[0].cover = 'x'.repeat(300_001);
  saved.push({ id: 'malformed entry' });
  await writeFile(file, JSON.stringify(saved));
  const restored = new RecentDocuments(file);
  await restored.load();
  const recent = await restored.list();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].cover, undefined);
  assert.equal(recent.find((entry) => entry.path === first)?.title, 'Renamed');
});

test('document editing actions reject escaped, executable and non-file Markdown and symlinked templates', async (t) => {
  const { root, starter } = await fixture(t);
  const book = await createDocument(join(root, 'Safe'), starter);
  await mkdir(join(book, 'texts'));
  await writeFile(join(book, 'texts/good.md'), '# Hello');
  assert.equal(await textSourcePath(book, 'texts/good.md'), join(book, 'texts/good.md'));
  assert.equal(await templateFolder(book), join(book, 'template'));
  await writeFile(join(book, 'texts/run.command'), 'echo should-not-run');
  await symlink(join(book, 'texts/run.command'), join(book, 'texts/script.md'));
  await mkdir(join(book, 'texts/folder.md'));
  await writeFile(join(book, 'outside.md'), '# Outside texts');
  await symlink(join(book, 'outside.md'), join(book, 'texts/escape.md'));
  for (const source of ['texts/run.command', 'texts/script.md', 'texts/folder.md', 'outside.md', 'texts/escape.md']) {
    await assert.rejects(textSourcePath(book, source));
  }
  await rename(join(book, 'template'), join(book, 'real-template'));
  await symlink(join(book, 'real-template'), join(book, 'template'));
  await assert.rejects(templateFolder(book), /real directory inside/);
  await rm(join(book, 'template'));
  await symlink(starter, join(book, 'template'));
  await assert.rejects(templateFolder(book), /real directory inside/);
});

test('linked text editing allows selected external Markdown while rejecting scripts, bundles and self-links', async (t) => {
  const { root, starter } = await fixture(t);
  const book = await createDocument(join(root, 'Linked'), starter);
  const markdown = join(root, 'external.md');
  await writeFile(markdown, '# External');
  await assert.rejects(textSourcePath(book, { path: markdown, linked: true }), /approve access/);
  await approveSource(book, { key: 'markdown:editor', kind: 'markdown', path: markdown, linked: true });
  assert.equal(await textSourcePath(book, { path: markdown, linked: true }), markdown);
  const script = join(root, 'run.command');
  await writeFile(script, 'echo should-not-run');
  const alias = join(root, 'script.md');
  await symlink(script, alias);
  const bundle = join(root, 'Bundle.md');
  await mkdir(bundle);
  for (const path of [script, alias, bundle, join(book, 'project.json')]) {
    await assert.rejects(textSourcePath(book, { path, linked: true }));
  }
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
