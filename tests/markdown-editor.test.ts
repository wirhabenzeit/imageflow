import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MarkdownBuffer } from '../desktop/markdown-buffer';
import { readMarkdownFile, writeMarkdownFile } from '../desktop/markdown-file';
import { createMarkdownSource, relocateSource } from '../desktop/source-actions';
import { importIntoProject, loadProject, updateProject } from '../desktop/project';
import { configureSourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { textSourcePath } from '../desktop/document-actions';

function buffer(initial = 'Original') {
  let disk = initial;
  let failure = false;
  let writes = 0;
  const value = new MarkdownBuffer({ id: 'text', name: 'Story', path: '/story.md', external: false }, initial, {
    read: async () => disk,
    write: async (expected, text) => { assert.equal(disk, expected); if (failure) throw new Error('Disk full'); disk = text; writes++; },
  }, () => {}, 20);
  return { value, disk: () => disk, writes: () => writes, outside: (text: string) => { disk = text; }, fail: (next: boolean) => { failure = next; } };
}

test('autosave debounces input and ignores stale change messages', async (t) => {
  const f = buffer(); t.after(() => f.value.dispose());
  f.value.change('First', 1); f.value.change('Latest', 2); f.value.change('Stale', 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.disk(), 'Latest'); assert.equal(f.writes(), 1);
  assert.equal(f.value.state.dirty, false);
});

test('outside text reloads a clean buffer, but preserves a dirty buffer until explicitly resolved', async (t) => {
  const f = buffer(); t.after(() => f.value.dispose());
  f.outside('Clean outside edit'); await f.value.refresh();
  assert.equal(f.value.state.text, 'Clean outside edit');
  f.value.change('My edit', 1); f.outside('Another outside edit'); await f.value.flush();
  assert.equal(f.disk(), 'Another outside edit');
  assert.equal(f.value.state.text, 'My edit'); assert.equal(f.value.state.conflict, 'Another outside edit');
  await f.value.resolve('keep', 'Another outside edit');
  assert.equal(f.disk(), 'My edit'); assert.equal(f.value.state.dirty, false);
});

test('a keystroke based on text from before a clean outside reload must show a conflict', async (t) => {
  const f = buffer(); t.after(() => f.value.dispose());
  const oldBasis = f.value.state.basis;
  f.outside('Outside revision'); await f.value.refresh();
  assert.notEqual(f.value.state.basis, oldBasis);
  // The renderer has typed locally but has not received this poll's replacement yet.
  f.value.change('Typed from the original revision', 1, oldBasis);
  await f.value.refresh(); await f.value.flush();
  assert.equal(f.disk(), 'Outside revision');
  assert.equal(f.value.state.text, 'Typed from the original revision');
  assert.equal(f.value.state.conflict, 'Outside revision');
  await f.value.resolve('keep', 'Outside revision');
  assert.equal(f.disk(), 'Typed from the original revision');
});

test('typing based on an acknowledged outside reload saves normally', async (t) => {
  const f = buffer(); t.after(() => f.value.dispose());
  f.outside('Outside revision'); await f.value.refresh();
  f.value.change('Edit based on outside revision', 1, f.value.state.basis);
  await f.value.flush();
  assert.equal(f.disk(), 'Edit based on outside revision');
  assert.equal(f.value.state.conflict, undefined);
});

test('resolving a conflict does not overwrite an even newer outside edit', async (t) => {
  const f = buffer(); t.after(() => f.value.dispose());
  f.value.change('Mine', 1); f.outside('Theirs'); await f.value.flush();
  f.outside('Newer theirs'); await f.value.resolve('keep', 'Theirs');
  assert.equal(f.disk(), 'Newer theirs'); assert.equal(f.value.state.text, 'Mine');
  assert.equal(f.value.state.conflict, 'Newer theirs');
  await f.value.resolve('reload', 'Newer theirs');
  assert.equal(f.value.state.text, 'Newer theirs'); assert.equal(f.value.state.dirty, false);
});

test('save failures retain text and can be retried', async (t) => {
  const f = buffer(); t.after(() => f.value.dispose());
  f.fail(true); f.value.change('Pending', 1); await f.value.flush();
  assert.equal(f.disk(), 'Original'); assert.equal(f.value.state.text, 'Pending');
  assert.equal(f.value.state.error, 'Disk full'); assert.equal(f.value.state.dirty, true);
  f.fail(false); await f.value.flush();
  assert.equal(f.disk(), 'Pending'); assert.equal(f.value.state.error, undefined);
});

test('a newer edit during a slow save stays dirty until the next serialized save', async (t) => {
  let disk = 'Original'; let release!: () => void;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const value = new MarkdownBuffer({ id: 'x', name: 'x', path: '/x.md', external: false }, disk, {
    read: async () => disk,
    write: async (_expected, text) => { if (++writes === 1) { startedResolve(); await pending; } disk = text; },
  }, () => {}, 10000);
  t.after(() => value.dispose());
  value.change('First', 1); const first = value.flush(); await started;
  value.change('Second', 2); const second = value.flush(); release();
  await first; await second;
  assert.equal(disk, 'Second'); assert.equal(value.state.dirty, false); assert.equal(writes, 2);
});

test('an outside edit matching pending text counts as saved without rewriting it', async (t) => {
  const f = buffer(); t.after(() => f.value.dispose());
  f.value.change('Matching', 1); f.outside('Matching'); await f.value.flush();
  assert.equal(f.writes(), 0); assert.equal(f.value.state.dirty, false);
});

async function directory(t: { after(fn: () => Promise<void>): void }) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'if-markdown-')));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test('file saves publish complete UTF-8 text, preserve permissions, and reject changed bytes', async (t) => {
  const root = await directory(t); const path = join(root, 'story.md');
  await writeFile(path, 'Original'); await chmod(path, 0o640);
  await writeMarkdownFile(path, 'Original', '# Zürich\n\nA story.', async () => path);
  assert.equal(await readMarkdownFile(path), '# Zürich\n\nA story.');
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  await assert.rejects(writeMarkdownFile(path, 'Original', 'Lost edit', async () => path), /changed outside/);
  assert.equal(await readMarkdownFile(path), '# Zürich\n\nA story.');
  assert.deepEqual(await readdir(root), ['story.md']);
});

test('two app editors of the same original cannot silently overwrite each other', async (t) => {
  const root = await directory(t); const path = join(root, 'shared.md');
  await writeFile(path, 'Original');
  const results = await Promise.allSettled([
    writeMarkdownFile(path, 'Original', 'First editor', async () => path),
    writeMarkdownFile(path, 'Original', 'Second editor', async () => path),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await readFile(path, 'utf8'), results[0].status === 'fulfilled' ? 'First editor' : 'Second editor');
});

test('a source removed just before writing reports a friendly error without recreating it', async (t) => {
  const root = await directory(t); const path = join(root, 'story.md');
  await writeFile(path, 'Original'); const expected = await readMarkdownFile(path); await rm(path);
  await assert.rejects(writeMarkdownFile(path, expected, 'Pending draft', async () => path), (error: Error) => {
    assert.match(error.message, /source was moved or deleted/);
    assert.doesNotMatch(error.message, /ENOENT|ENOTDIR/);
    return true;
  });
  assert.deepEqual(await readdir(root), []);
});

test('a missing source keeps its draft, gives clear feedback, and saves after restoration', async (t) => {
  const root = await directory(t); const path = join(root, 'story.md');
  await writeFile(path, 'Original');
  const value = new MarkdownBuffer({ id: 'x', name: 'Story', path, external: false }, 'Original', {
    read: () => readMarkdownFile(path),
    write: (expected, text) => writeMarkdownFile(path, expected, text, async () => path),
  }, () => {}, 10000);
  t.after(() => value.dispose());
  value.change('Pending draft', 1); await rm(path); await value.flush();
  assert.equal(value.state.text, 'Pending draft'); assert.equal(value.state.dirty, true);
  assert.match(value.state.error!, /source was moved or deleted/);
  assert.doesNotMatch(value.state.error!, /ENOENT/);
  await value.refresh();
  assert.equal(value.state.text, 'Pending draft'); assert.match(value.state.error!, /source was moved or deleted/);
  await writeFile(path, 'Original'); await value.flush();
  assert.equal(await readFile(path, 'utf8'), 'Pending draft'); assert.equal(value.state.dirty, false);
  assert.equal(value.state.error, undefined);
});

test('external saves preserve the inode, creation time, ownership, permissions, hard links and extended attributes', async (t) => {
  const root = await directory(t); const path = join(root, 'original.md'); const alias = join(root, 'alias.md');
  await writeFile(path, 'Original'); await chmod(path, 0o640); await link(path, alias);
  if (process.platform === 'darwin') execFileSync('/usr/bin/xattr', ['-w', 'com.imageflow.editor-test', 'preserved', path]);
  const before = await stat(path, { bigint: true });
  await writeMarkdownFile(path, 'Original', 'Edited original', async () => path, true);
  const after = await stat(path, { bigint: true });
  for (const field of ['ino', 'dev', 'birthtimeNs', 'uid', 'gid', 'mode', 'nlink'] as const) assert.equal(after[field], before[field], field);
  assert.equal(await readFile(alias, 'utf8'), 'Edited original');
  if (process.platform === 'darwin') assert.equal(execFileSync('/usr/bin/xattr', ['-p', 'com.imageflow.editor-test', path], { encoding: 'utf8' }).trim(), 'preserved');
  // A shorter replacement must truncate the old tail while keeping the same original file.
  await writeMarkdownFile(path, 'Edited original', 'Short', async () => path, true);
  assert.equal(await readFile(alias, 'utf8'), 'Short');
  await assert.rejects(writeMarkdownFile(path, 'Original', 'Stale edit', async () => path, true), /changed outside/);
  assert.equal(await readFile(alias, 'utf8'), 'Short');
});

test('editors using two hard links to one external original serialize their writes', async (t) => {
  const root = await directory(t); const path = join(root, 'original.md'); const alias = join(root, 'alias.md');
  await writeFile(path, 'Original'); await link(path, alias);
  const results = await Promise.allSettled([
    writeMarkdownFile(path, 'Original', 'First editor', async () => path, true),
    writeMarkdownFile(alias, 'Original', 'Second editor', async () => alias, true),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await readFile(path, 'utf8'), await readFile(alias, 'utf8'));
});

test('invalid UTF-8, oversized files, symlinks, and a changed source target cannot be edited', async (t) => {
  const root = await directory(t); const path = join(root, 'story.md'); const link = join(root, 'link.md');
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readMarkdownFile(path), /UTF-8/);
  await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(readMarkdownFile(path), /smaller than 5 MB/);
  await writeFile(path, 'Original'); await symlink(path, link);
  await assert.rejects(readMarkdownFile(link));
  await assert.rejects(writeMarkdownFile(path, 'Original', 'New', async () => link), /location changed/);
  assert.equal(await readFile(path, 'utf8'), 'Original');
});

test('a read-only original cannot be replaced through a writable parent folder', async (t) => {
  const root = await directory(t); const path = join(root, 'story.md');
  await writeFile(path, 'Original'); await chmod(path, 0o444);
  await assert.rejects(writeMarkdownFile(path, 'Original', 'New', async () => path));
  assert.equal(await readFile(path, 'utf8'), 'Original');
});

test('creation registers an ordinary source, and copying an external source preserves placements and the original', async (t) => {
  const root = await directory(t); const folder = join(root, 'Book.imageflow'); const cache = join(root, 'cache');
  await mkdir(cache); configureSourceStore(join(root, 'sources')); configureSourceAccess(join(root, 'access'));
  await cp(resolve('sample/starter'), folder, { recursive: true, filter: (path) => !path.includes('/.imageflow') });
  const book = await loadProject(folder, cache);
  const created = await createMarkdownSource(book, 'Introduction');
  assert.equal(created.book.texts[created.id], '');
  assert.equal(typeof created.book.project.texts[created.id], 'string');
  await assert.rejects(createMarkdownSource(created.book, '../escape'), /without slashes/);
  const external = join(root, 'external.md'); await writeFile(external, 'External text');
  const imported = await importIntoProject(created.book, { kind: 'markdown', mode: 'link' }, [external]);
  const id = imported.imported[0];
  const files = structuredClone({ project: imported.book.project, photoIndex: imported.book.photoIndex });
  files.project.spreads[0].boxes.story = { text: id, params: {} };
  const placed = await updateProject(imported.book, files);
  const copied = await relocateSource(placed, 'markdown:' + id, undefined, true);
  assert.equal(copied.project.spreads[0].boxes.story.text, id);
  const copy = await textSourcePath(folder, copied.project.texts[id], id);
  await writeMarkdownFile(copy, 'External text', 'Copied edit', async () => copy);
  assert.equal(await readFile(external, 'utf8'), 'External text');
  assert.equal(await readFile(copy, 'utf8'), 'Copied edit');
});
