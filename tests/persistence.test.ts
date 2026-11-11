import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs, { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { acquireProjectLock, CommittedProjectSaveError, maximumManifestBytes, persistProjectManifests, recoverProjectSave } from '../desktop/persistence';
import type { ProjectLock, ProjectManifests } from '../desktop/persistence';
import { importIntoProject, loadProject, updateProject } from '../desktop/project';

const project = {
  schemaVersion: 1, title: 'Before', template: { id: 'test', version: '1' }, params: {}, texts: {}, files: {},
  spreads: [{ id: 'one', definition: 'photo', params: {}, boxes: {}, elements: {} }],
};
const before: ProjectManifests = { 'project.json': Buffer.from(JSON.stringify(project)), 'photos.json': Buffer.from('{}') };
const after: ProjectManifests = {
  'project.json': Buffer.from(JSON.stringify({ ...project, title: 'Saved together' })),
  'photos.json': Buffer.from(JSON.stringify({ picture: { path: 'photos/picture.jpg', title: 'A saved photo' } })),
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-persistence-')));
  const folder = join(root, 'Book');
  await mkdir(join(folder, 'template'), { recursive: true });
  await writeFile(join(folder, 'template/index.tsx'), 'export default {};\n');
  for (const name of ['project.json', 'photos.json'] as const) await writeFile(join(folder, name), before[name]);
  return { root, folder, cache: join(root, 'cache') };
}

async function manifests(folder: string) {
  return { 'project.json': await readFile(join(folder, 'project.json')), 'photos.json': await readFile(join(folder, 'photos.json')) };
}

const journalPath = (folder: string) => join(folder, '.imageflow/persistence/pending-save.json');

async function publishJournal(folder: string, original = before, intended = after) {
  await mkdir(join(folder, '.imageflow/persistence'), { recursive: true });
  await writeFile(journalPath(folder), JSON.stringify({
    version: 1, transaction: randomUUID(), manifests: Object.fromEntries((['project.json', 'photos.json'] as const).map((name) =>
      [name, { before: original[name].toString('base64'), after: intended[name].toString('base64') }])),
  }));
}

async function failPhotoPublication(run: () => Promise<unknown>, folder: string) {
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === join(folder, 'photos.json')) throw new Error('Injected interruption between manifest publications');
    return rename(source, destination);
  };
  try { await run(); }
  finally { fs.rename = rename; }
}

test('manifest persistence commits both files and removes only its completed journal', async () => {
  const { root, folder } = await fixture();
  try {
    await mkdir(join(folder, '.imageflow/persistence/abandoned'), { recursive: true });
    await writeFile(join(folder, '.imageflow/persistence/abandoned/notes'), 'preserve');
    await persistProjectManifests(folder, before, after);
    assert.deepEqual(await manifests(folder), after);
    await assert.rejects(lstat(journalPath(folder)), { code: 'ENOENT' });
    assert.equal(await readFile(join(folder, '.imageflow/persistence/abandoned/notes'), 'utf8'), 'preserve');
    await recoverProjectSave(folder);
    assert.deepEqual(await manifests(folder), after);
  } finally { await rm(root, { recursive: true }); }
});

test('interruption between publications leaves durable intent and load rolls forward before reading manifests', async () => {
  const { root, folder, cache } = await fixture();
  try {
    await failPhotoPublication(async () => {
      await assert.rejects(persistProjectManifests(folder, before, after), CommittedProjectSaveError);
    }, folder);
    assert.deepEqual(await manifests(folder), { 'project.json': after['project.json'], 'photos.json': before['photos.json'] });
    const journal = await readFile(journalPath(folder));
    await failPhotoPublication(async () => {
      await assert.rejects(recoverProjectSave(folder), /Injected interruption/);
    }, folder);
    assert.deepEqual(await readFile(journalPath(folder)), journal);
    const book = await loadProject(folder, cache);
    assert.equal(book.project.title, 'Saved together');
    assert.equal(book.photoIndex.picture.title, 'A saved photo');
    assert.deepEqual(book.manifests, after);
    await assert.rejects(lstat(journalPath(folder)), { code: 'ENOENT' });
    await recoverProjectSave(folder);
    assert.deepEqual(await manifests(folder), after);
  } finally { await rm(root, { recursive: true }); }
});

test('recovery checks both files for external changes before publishing and preserves collision evidence', async () => {
  const { root, folder } = await fixture();
  try {
    await publishJournal(folder);
    const outsideEdit = Buffer.from(JSON.stringify({ elsewhere: { path: 'photos/elsewhere.jpg' } }));
    await writeFile(join(folder, 'photos.json'), outsideEdit);
    const journal = await readFile(journalPath(folder));
    await assert.rejects(recoverProjectSave(folder), /photos.json changed outside ImageFlow/);
    assert.deepEqual(await manifests(folder), { 'project.json': before['project.json'], 'photos.json': outsideEdit });
    assert.deepEqual(await readFile(journalPath(folder)), journal);
    await rm(join(folder, 'photos.json'));
    await assert.rejects(recoverProjectSave(folder), /photos.json changed outside ImageFlow/);
    assert.deepEqual(await readFile(journalPath(folder)), journal);
    await writeFile(join(folder, 'photos.json'), before['photos.json']);
    await recoverProjectSave(folder);
    assert.deepEqual(await manifests(folder), after);
  } finally { await rm(root, { recursive: true }); }
});

test('a pending committed save blocks new persistence and unrelated changed data is never overwritten', async () => {
  const { root, folder } = await fixture();
  try {
    await publishJournal(folder);
    await assert.rejects(persistProjectManifests(folder, before, after), /previous project save needs recovery/);
    assert.deepEqual(await manifests(folder), before);
    await rm(journalPath(folder));
    const external = Buffer.from(JSON.stringify({ ...project, title: 'Written by someone else' }));
    await writeFile(join(folder, 'project.json'), external);
    await assert.rejects(persistProjectManifests(folder, before, after), /changed on disk/);
    assert.deepEqual(await readFile(join(folder, 'project.json')), external);
    await assert.rejects(lstat(journalPath(folder)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('read-only loading creates no internal folders and refuses recovery without changing project bytes', async () => {
  const { root, folder, cache } = await fixture();
  try {
    const book = await loadProject(folder, cache, true);
    assert.equal(book.readOnly, true);
    await assert.rejects(lstat(join(folder, '.imageflow')), { code: 'ENOENT' });
    await assert.rejects(lstat(cache), { code: 'ENOENT' });
    await publishJournal(folder);
    await writeFile(join(folder, 'project.json'), after['project.json']);
    const snapshot = await manifests(folder);
    const journal = await readFile(journalPath(folder));
    const entries = await readdir(folder, { recursive: true });
    await assert.rejects(loadProject(folder, cache, true), /Open it as a writable project to recover/);
    assert.deepEqual(await manifests(folder), snapshot);
    assert.deepEqual(await readFile(journalPath(folder)), journal);
    assert.deepEqual(await readdir(folder, { recursive: true }), entries);
    await assert.rejects(updateProject(book, { project: { ...book.project, title: 'Rejected' }, photoIndex: book.photoIndex }), /editable copy/);
  } finally { await rm(root, { recursive: true }); }
});

test('journal validation rejects extra paths, unknown versions, invalid bytes, invalid manifests, and oversized files', async () => {
  const { root, folder } = await fixture();
  try {
    await publishJournal(folder);
    const valid = JSON.parse(await readFile(journalPath(folder), 'utf8'));
    const invalid = [
      { ...valid, version: 3 },
      { ...valid, destination: '../outside' },
      { ...valid, manifests: { ...valid.manifests, '../outside': valid.manifests['project.json'] } },
      { ...valid, manifests: { ...valid.manifests, 'project.json': { before: '***', after: valid.manifests['project.json'].after } } },
      { ...valid, manifests: { ...valid.manifests, 'project.json': { before: Buffer.from('{}').toString('base64'), after: valid.manifests['project.json'].after } } },
    ];
    for (const journal of invalid) {
      const source = JSON.stringify(journal);
      await writeFile(journalPath(folder), source);
      await assert.rejects(recoverProjectSave(folder), /pending save|pending save journal/);
      assert.equal(await readFile(journalPath(folder), 'utf8'), source);
      assert.deepEqual(await manifests(folder), before);
    }
    await truncate(journalPath(folder), maximumManifestBytes * 6 + 1);
    await assert.rejects(recoverProjectSave(folder), /bounded regular file/);
    assert.deepEqual(await manifests(folder), before);
  } finally { await rm(root, { recursive: true }); }
});

test('journal and persistence directories cannot escape through symlinks', async () => {
  const { root, folder } = await fixture();
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'unchanged');
  try {
    await symlink(outside, join(folder, '.imageflow'));
    await assert.rejects(persistProjectManifests(folder, before, after), /real directory inside/);
    await rm(join(folder, '.imageflow'));
    await mkdir(join(folder, '.imageflow'));
    await symlink(outside, join(folder, '.imageflow/persistence'));
    await assert.rejects(recoverProjectSave(folder), /real directory inside/);
    await rm(join(folder, '.imageflow/persistence'));
    await mkdir(join(folder, '.imageflow/persistence'));
    await symlink(join(outside, 'keep'), journalPath(folder));
    await assert.rejects(recoverProjectSave(folder), { code: 'ELOOP' });
    assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'unchanged');
    assert.deepEqual(await readdir(outside), ['keep']);
    assert.deepEqual(await manifests(folder), before);
  } finally { await rm(root, { recursive: true }); }
});

test('updateProject uses recoverable publication and preserves untouched manifest source bytes', async () => {
  const { root, folder, cache } = await fixture();
  try {
    await writeFile(join(folder, 'photos.json'), ' \n{ }\n');
    const book = await loadProject(folder, cache);
    const next = await updateProject(book, { project: { ...book.project, title: 'Changed normally' }, photoIndex: book.photoIndex });
    assert.equal(next.project.title, 'Changed normally');
    assert.equal(await readFile(join(folder, 'photos.json'), 'utf8'), ' \n{ }\n');
    assert.deepEqual(next.manifests, await manifests(folder));
    await assert.rejects(lstat(journalPath(folder)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('title-only journal stores a guard for the unchanged photo manifest and retains paired recovery checks', async () => {
  const { root, folder } = await fixture();
  const photoBytes = Buffer.from(JSON.stringify({ large: { path: 'photos/large.jpg', caption: 'c'.repeat(2 * 1024 * 1024) } }));
  const original = { ...before, 'photos.json': photoBytes };
  const intended = { ...after, 'photos.json': photoBytes };
  const publish = fs.rename;
  try {
    await writeFile(join(folder, 'photos.json'), photoBytes);
    const unchanged = await lstat(join(folder, 'photos.json'));
    fs.rename = async () => { throw new Error('Interrupted before the title was published'); };
    await assert.rejects(persistProjectManifests(folder, original, intended), CommittedProjectSaveError);
    fs.rename = publish;
    const journalBytes = await readFile(journalPath(folder));
    assert.ok(journalBytes.length < 2048);
    const journal = JSON.parse(journalBytes.toString());
    assert.equal(journal.version, 2);
    assert.deepEqual(journal.manifests['photos.json'], { sha256: createHash('sha256').update(photoBytes).digest('hex') });
    const internal = join(folder, '.imageflow/persistence');
    for (const entry of await readdir(internal)) {
      if (entry.startsWith('save-')) assert.equal((await readdir(join(internal, entry))).includes('photos.json'), false);
    }
    await writeFile(join(folder, 'photos.json'), '{}');
    await assert.rejects(recoverProjectSave(folder), /photos.json changed outside ImageFlow/);
    assert.deepEqual(await readFile(join(folder, 'project.json')), before['project.json']);
    await writeFile(join(folder, 'photos.json'), photoBytes);
    const restored = await lstat(join(folder, 'photos.json'));
    await recoverProjectSave(folder);
    assert.deepEqual(await manifests(folder), intended);
    const recovered = await lstat(join(folder, 'photos.json'));
    assert.equal(recovered.ino, unchanged.ino);
    assert.equal(recovered.mtimeMs, restored.mtimeMs);
  } finally { fs.rename = publish; await rm(root, { recursive: true }); }
});

test('an unchanged manifest is rechecked after publishing its paired changed manifest', async () => {
  const { root, folder } = await fixture();
  const intended = { ...after, 'photos.json': before['photos.json'] };
  const publish = fs.rename;
  try {
    fs.rename = async (source, destination) => {
      await publish(source, destination);
      if (destination === join(folder, 'project.json')) await writeFile(join(folder, 'photos.json'), '{"external":{"path":"photos/other.jpg"}}');
    };
    await assert.rejects(persistProjectManifests(folder, before, intended), CommittedProjectSaveError);
    fs.rename = publish;
    assert.deepEqual(await readFile(join(folder, 'project.json')), intended['project.json']);
    await assert.rejects(recoverProjectSave(folder), /photos.json changed outside ImageFlow/);
    await writeFile(join(folder, 'photos.json'), before['photos.json']);
    await recoverProjectSave(folder);
    assert.deepEqual(await manifests(folder), intended);
  } finally { fs.rename = publish; await rm(root, { recursive: true }); }
});

test('an interrupted import preserves journal-referenced assets while a rejected precommit import cleans up', async () => {
  const { root, folder, cache } = await fixture();
  try {
    const source = join(root, 'picture.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#375b48' } }).png().toFile(source);
    const book = await loadProject(folder, cache);
    await failPhotoPublication(async () => {
      await assert.rejects(importIntoProject(book, { kind: 'photo', target: { spread: 'one', box: 'hero' } }, [source]), CommittedProjectSaveError);
    }, folder);
    const copied = await readdir(join(folder, 'photos'));
    assert.equal(copied.length, 1);
    const recovered = await loadProject(folder, cache);
    assert.equal(recovered.photos.size, 1);
    assert.ok(recovered.project.spreads[0].boxes.hero.photo);
    assert.deepEqual(await readdir(join(folder, 'photos')), copied);

    await writeFile(join(folder, 'project.json'), JSON.stringify({ ...recovered.project, title: 'An external edit' }));
    await assert.rejects(importIntoProject(recovered, { kind: 'photo' }, [source]), /changed on disk/);
    assert.deepEqual(await readdir(join(folder, 'photos')), copied);
  } finally { await rm(root, { recursive: true }); }
});

test('writer lock excludes another owner, releases idempotently, and preserves unknown ownership', async () => {
  const { root, folder } = await fixture();
  try {
    const release = await acquireProjectLock(folder);
    await assert.rejects(acquireProjectLock(folder), /already open for editing/);
    await release();
    await release();
    const nextRelease = await acquireProjectLock(folder);
    const path = join(folder, '.imageflow/writer.lock');
    const replacement = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() });
    await writeFile(path, replacement);
    await nextRelease();
    assert.equal(await readFile(path, 'utf8'), replacement);
  } finally { await rm(root, { recursive: true }); }
});

test('invalid lock ownership and an interrupted acquisition gate require explicit recovery', async () => {
  const { root, folder } = await fixture();
  try {
    await mkdir(join(folder, '.imageflow'));
    const lock = join(folder, '.imageflow/writer.lock');
    await writeFile(lock, 'unrecognized ownership');
    await assert.rejects(acquireProjectLock(folder), /writer lock is invalid/);
    assert.equal(await readFile(lock, 'utf8'), 'unrecognized ownership');
    await mkdir(join(folder, '.imageflow/writer-lock-acquire'));
    await writeFile(join(folder, '.imageflow/writer-lock-acquire/evidence'), 'keep');
    await assert.rejects(acquireProjectLock(folder), /acquisition is in progress or was interrupted/);
    assert.equal(await readFile(join(folder, '.imageflow/writer-lock-acquire/evidence'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true }); }
});

test('the original lock capability follows a renamed folder and releases ownership at its new path', async () => {
  const { root, folder } = await fixture();
  const moved = join(root, 'Moved book');
  try {
    const lock = await acquireProjectLock(folder);
    await rename(folder, moved);
    await assert.rejects(acquireProjectLock(moved), /already open for editing/);
    assert.equal(await lock.tryRelocate(moved), true);
    await lock();
    await assert.rejects(lstat(join(moved, '.imageflow/writer.lock')), { code: 'ENOENT' });
    await assert.rejects(lstat(folder), { code: 'ENOENT' });
    assert.equal(await lock.tryRelocate(moved), false);
    const next = await acquireProjectLock(moved);
    await next();
  } finally { await rm(root, { recursive: true }); }
});

test('relocation refuses copied lock files and hard-linked candidates while the original folder exists', async () => {
  const { root, folder } = await fixture();
  const candidate = join(root, 'Candidate');
  const moved = join(root, 'Moved book');
  try {
    const lock = await acquireProjectLock(folder);
    await mkdir(join(candidate, '.imageflow'), { recursive: true });
    await link(join(folder, '.imageflow/writer.lock'), join(candidate, '.imageflow/writer.lock'));
    assert.equal(await lock.tryRelocate(candidate), false);
    await rm(candidate, { recursive: true });
    await rename(folder, moved);
    await cp(moved, candidate, { recursive: true });
    assert.equal(await lock.tryRelocate(candidate), false);
    assert.equal(await lock.tryRelocate(moved), true);
    await lock();
    assert.ok(await lstat(join(candidate, '.imageflow/writer.lock')));
  } finally { await rm(root, { recursive: true }); }
});

test('release retires ownership after the project folder or lock file disappears', async () => {
  const { root, folder } = await fixture();
  try {
    const lock = await acquireProjectLock(folder);
    const owner = JSON.parse(await readFile(join(folder, '.imageflow/writer.lock'), 'utf8'));
    await rm(folder, { recursive: true });
    await lock();
    await assert.rejects(lstat(owner.endpoint), { code: 'ENOENT' });
    await mkdir(folder);
    const second = await acquireProjectLock(folder);
    await rm(join(folder, '.imageflow/writer.lock'));
    await second();
    const third = await acquireProjectLock(folder);
    await third();
  } finally { await rm(root, { recursive: true }); }
});

test('release retires its proof when a malformed lock record must be preserved', async () => {
  const { root, folder } = await fixture();
  try {
    const lock = await acquireProjectLock(folder);
    const path = join(folder, '.imageflow/writer.lock');
    const owner = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, 'malformed ownership evidence');
    await assert.rejects(lock(), /ownership was retired.*Preserve/);
    assert.equal(await readFile(path, 'utf8'), 'malformed ownership evidence');
    await assert.rejects(lstat(owner.endpoint), { code: 'ENOENT' });
    await lock();
    assert.equal(await lock.tryRelocate(folder), false);
  } finally { await rm(root, { recursive: true }); }
});

test('a permission failure reading the old record still retires the proof without deleting evidence', async () => {
  const { root, folder } = await fixture();
  const open = fs.open;
  try {
    const lock = await acquireProjectLock(folder);
    const path = join(folder, '.imageflow/writer.lock');
    const bytes = await readFile(path);
    const owner = JSON.parse(bytes.toString('utf8'));
    let denied = false;
    fs.open = async (...args) => {
      if (args[0] === path) {
        denied = true;
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      }
      return open(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(lock(), /ownership was retired/);
    assert.equal(denied, true);
    fs.open = open;
    syncBuiltinESMExports();
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(lstat(owner.endpoint), { code: 'ENOENT' });
    const replacement = await acquireProjectLock(folder);
    await replacement();
  } finally { fs.open = open; syncBuiltinESMExports(); await rm(root, { recursive: true }); }
});

test('a symlink replacing the internal directory cannot strand a live ownership proof', async () => {
  const { root, folder } = await fixture();
  try {
    const lock = await acquireProjectLock(folder);
    const internal = join(folder, '.imageflow');
    const evidence = join(folder, 'preserved-locks');
    const bytes = await readFile(join(internal, 'writer.lock'));
    const owner = JSON.parse(bytes.toString('utf8'));
    await rename(internal, evidence);
    await symlink(evidence, internal);
    await assert.rejects(lock(), /ownership was retired/);
    assert.equal((await lstat(internal)).isSymbolicLink(), true);
    assert.deepEqual(await readFile(join(evidence, 'writer.lock')), bytes);
    await assert.rejects(lstat(owner.endpoint), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('an invalid unrelated relocation candidate leaves the current owner exclusive', async () => {
  const { root, folder } = await fixture();
  const other = join(root, 'Other book');
  const lock = await acquireProjectLock(folder);
  try {
    await mkdir(join(other, '.imageflow'), { recursive: true });
    const path = join(other, '.imageflow/writer.lock');
    await writeFile(path, 'invalid unrelated metadata');
    assert.equal(await lock.tryRelocate(other), false);
    assert.equal(await readFile(path, 'utf8'), 'invalid unrelated metadata');
    await assert.rejects(acquireProjectLock(folder), /already open for editing/);
  } finally { await lock(); await rm(root, { recursive: true }); }
});

test('a moved project can be left for another book and reopened while the same process remains alive', async () => {
  const { root, folder } = await fixture();
  const moved = join(root, 'Moved book');
  const other = join(root, 'Other book');
  try {
    const first = await acquireProjectLock(folder);
    const owner = JSON.parse(await readFile(join(folder, '.imageflow/writer.lock'), 'utf8'));
    await rename(folder, moved);
    await mkdir(other);
    const second = await acquireProjectLock(other);
    assert.equal(await first.tryRelocate(other), false);
    await first();
    const reopened = await acquireProjectLock(moved);
    const current = JSON.parse(await readFile(join(moved, '.imageflow/writer.lock'), 'utf8'));
    assert.equal(current.pid, owner.pid);
    assert.notEqual(current.token, owner.token);
    assert.deepEqual(JSON.parse(await readFile(join(moved, '.imageflow/writer-stale-' + owner.token + '.json'), 'utf8')), owner);
    await second();
    await reopened();
  } finally { await rm(root, { recursive: true }); }
});

test('a live ownership proof excludes contenders even when its recorded process ID is stale', async () => {
  const { root, folder } = await fixture();
  const lock = await acquireProjectLock(folder);
  try {
    const path = join(folder, '.imageflow/writer.lock');
    const owner = JSON.parse(await readFile(path, 'utf8'));
    owner.pid = 2147483647;
    await writeFile(path, JSON.stringify(owner));
    await assert.rejects(acquireProjectLock(folder), /already open for editing/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), owner);
  } finally { await lock(); await rm(root, { recursive: true }); }
});

test('permission errors contacting an owner fail closed and preserve its lock', async () => {
  const { root, folder } = await fixture();
  const lock = await acquireProjectLock(folder);
  const connect = net.createConnection;
  try {
    const path = join(folder, '.imageflow/writer.lock');
    const owner = await readFile(path);
    net.createConnection = (() => {
      const socket = new net.Socket();
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('Permission denied'), { code: 'EACCES' })));
      return socket;
    }) as typeof net.createConnection;
    await assert.rejects(acquireProjectLock(folder), /could not contact.*EACCES/);
    assert.deepEqual(await readFile(path), owner);
    net.createConnection = connect;
    await assert.rejects(acquireProjectLock(folder), /already open for editing/);
  } finally { net.createConnection = connect; await lock(); await rm(root, { recursive: true }); }
});

test('legacy locks require manual resolution for live process IDs and reclaim only proven dead IDs', async () => {
  const { root, folder } = await fixture();
  try {
    await mkdir(join(folder, '.imageflow'));
    const path = join(folder, '.imageflow/writer.lock');
    const owner = { version: 1, pid: process.pid, token: randomUUID() };
    await writeFile(path, JSON.stringify(owner));
    await assert.rejects(acquireProjectLock(folder), /legacy writer lock.*live or reused process ID/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), owner);
    owner.pid = 2147483647;
    await writeFile(path, JSON.stringify(owner));
    const lock = await acquireProjectLock(folder);
    assert.deepEqual(JSON.parse(await readFile(join(folder, '.imageflow/writer-stale-' + owner.token + '.json'), 'utf8')), owner);
    await lock();
  } finally { await rm(root, { recursive: true }); }
});

function firstMessage(child: ChildProcess) {
  return new Promise<{ locked?: boolean; error?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Lock subprocess did not respond.')), 5000);
    child.once('message', (message) => { clearTimeout(timeout); resolve(message as { locked?: boolean; error?: string }); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

test('separate processes contend for one writer lock and a crashed owner is recovered without discarding its record', async () => {
  const { root, folder } = await fixture();
  await mkdir(resolve('.build'), { recursive: true });
  const output = await mkdtemp(join(resolve('.build'), 'persistence-lock-'));
  const helper = join(output, 'lock.mjs');
  let child: ChildProcess | undefined;
  try {
    await build({ stdin: { contents: `
      import { acquireProjectLock } from './desktop/persistence';
      try {
        const release = await acquireProjectLock(process.argv[2]);
        process.on('message', async () => { await release(); process.exit(0); });
        process.send({ locked: true });
      } catch (error) { process.send({ error: error.message }); process.exitCode = 1; }
    `, resolveDir: resolve('.') }, outfile: helper, bundle: true, packages: 'external', platform: 'node', format: 'esm' });
    const release = await acquireProjectLock(folder);
    child = fork(helper, [folder], { silent: true });
    assert.match((await firstMessage(child)).error ?? '', /already open for editing/);
    await exited(child);
    await release();
    child = fork(helper, [folder], { silent: true });
    assert.equal((await firstMessage(child)).locked, true);
    await assert.rejects(acquireProjectLock(folder), /already open for editing/);
    const old = JSON.parse(await readFile(join(folder, '.imageflow/writer.lock'), 'utf8'));
    child.kill('SIGKILL');
    await exited(child);
    const claims = await Promise.allSettled([acquireProjectLock(folder), acquireProjectLock(folder)]);
    const winners = claims.filter((claim): claim is PromiseFulfilledResult<ProjectLock> => claim.status === 'fulfilled');
    assert.equal(winners.length, 1);
    assert.equal(claims.filter(({ status }) => status === 'rejected').length, 1);
    const preserved = JSON.parse(await readFile(join(folder, '.imageflow/writer-stale-' + old.token + '.json'), 'utf8'));
    assert.deepEqual(preserved, old);
    await winners[0].value();
  } finally {
    child?.kill('SIGKILL');
    if (child) await exited(child);
    await rm(root, { recursive: true });
    await rm(output, { recursive: true });
  }
});
