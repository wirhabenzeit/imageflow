import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createAuthoringService, requestFingerprint } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import { CommittedProjectSaveError, ledgerLimits, readSaveLedger, recoverProjectSave } from '../desktop/persistence';
import { loadProject } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import { captureProjectInputs } from '../desktop/revisions';
import { saveDocumentCopy } from '../desktop/source-actions';
import type { RenderStatus } from '../src/desktop';
import { mm } from '../src/format';
import { p } from '../src/parameters';
import { checkedOutput } from './mcp-output-check';

const layout = (label: string, parameters = {}) => ({ label, span: 'spread' as const, parameters, boxes: {}, elements: {} });
const status: Extract<RenderStatus, { state: 'ready' }> = {
  state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {}, anchors: [],
  template: {
    version: '1', parameters: {}, spreads: { main: layout('Main', { heading: p.string({ label: 'Heading', default: '' }) }), chapter: layout('Chapter opening') },
    formatId: 'default', formats: { default: 'Default' },
    format: {
      label: 'Ledger test', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) },
      safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 40, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
    },
  },
};
const saved = { schemaVersion: 1, title: 'Ledger book', template: { id: 'test', version: '1' }, spreads: [{ id: 'one', definition: 'main', params: { heading: 'Hello' } }] };
const ledgerPath = (folder: string) => join(folder, '.imageflow/history/ledger.jsonl');
const journalPath = (folder: string) => join(folder, '.imageflow/persistence/pending-save.json');

async function book(t: TestContext) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-ledger-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const folder = join(work, 'Book.imageflow');
  const cache = join(work, 'cache');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(cache);
  await writeFile(join(folder, 'project.json'), JSON.stringify(saved));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'template/index.tsx'), 'export default {};');
  return { work, folder, cache };
}

/** An open book as the app holds it: a session with its own handle and an authoring service with one client. */
async function open(t: TestContext, folder: string, cache: string, client = { name: 'test-agent', session: crypto.randomUUID() }) {
  const session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  const service = createAuthoringService({
    session: () => session, cache, docs: resolve('docs'),
    check: (book, request, signal, index, draft) => checkProject(book, cache, request, async () => ({ status }), signal, index, undefined, draft),
    changed: () => {}, recovery: () => {}, import: async () => assert.fail('No imports in this test.'),
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    service(name, { project: session.handle, ...args }, new AbortController().signal, client).then((result) => checkedOutput(name, result));
  const revision = async () => ((await call('list_projects')).projects as { revision: string }[])[0].revision;
  return { session, call, revision, client };
}

const insertChapter = { op: 'insert_spread', definition: 'chapter', ref: 'chapter', after: 'one' };
const spreads = async (folder: string) => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads as { definition: string }[];
const filesOf = (book: OpenProject) => structuredClone({ project: book.project, photoIndex: book.photoIndex });

test('a committed agent batch is found and replayed by its key after the reply is lost and the book reopens', async (t) => {
  const { folder, cache } = await book(t);
  const first = await open(t, folder, cache);
  const expectedRevision = await first.revision();
  const request = { expectedRevision, idempotencyKey: 'add-chapter', label: 'Add chapter', operations: [insertChapter] };
  // The reply to this call is lost: the agent never sees its checkpoint.
  const lost = await first.call('apply_project_changes', request);
  assert.equal(lost.committed, true);
  assert.equal(typeof lost.checkpointId, 'string');
  assert.equal(lost.requestFingerprint, requestFingerprint('apply_project_changes', { ...request, dryRun: false }));
  first.session.close();

  // Reopen with a fresh handle and make a UI edit.
  const second = await open(t, folder, cache, { name: 'test-agent', session: crypto.randomUUID() });
  const files = filesOf(second.session.book);
  files.project.title = 'Edited in the app';
  await second.session.save(files, 'Rename book');

  const found = await second.call('list_book_checkpoints', { idempotencyKey: 'add-chapter' });
  assert.equal((found.checkpoints as unknown[]).length, 1);
  const [record] = found.checkpoints as { checkpointId: string; origin: string; mcp: { session: string; changes: string[] } }[];
  assert.equal(record.checkpointId, lost.checkpointId);
  assert.equal(record.origin, 'mcp');
  assert.equal(record.mcp.session, first.client.session, 'The save keeps the session that committed it');

  // Retrying the exact request with its original revision returns the original checkpoint without applying it again.
  const retried = await second.call('apply_project_changes', request);
  assert.equal(retried.replayed, true);
  assert.equal(retried.checkpointId, lost.checkpointId);
  assert.deepEqual(retried.changes, lost.changes);
  assert.equal((await spreads(folder)).filter(({ definition }) => definition === 'chapter').length, 1);

  const all = await second.call('list_book_checkpoints');
  const listed = all.checkpoints as { label: string; origin: string; mcp?: { idempotencyKey: string } }[];
  assert.deepEqual(listed.map(({ label, origin }) => [label, origin]), [['Rename book', 'app'], ['Add chapter', 'mcp']]);
  assert.equal(listed.filter(({ mcp }) => mcp?.idempotencyKey === 'add-chapter').length, 1);
  assert.deepEqual(all.changedOutsideSinceLatest, []);

  await assert.rejects(second.call('apply_project_changes', { ...request, operations: [{ ...insertChapter, ref: 'other' }] }),
    (error: { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(second.call('import_sources', { expectedRevision, idempotencyKey: 'add-chapter', kind: 'photo', paths: ['inbox/a.jpg'] }),
    (error: { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('dry runs, no-op batches and failures before commit add no checkpoints', async (t) => {
  const { folder, cache } = await book(t);
  const agent = await open(t, folder, cache);
  const expectedRevision = await agent.revision();
  const dry = await agent.call('apply_project_changes', { expectedRevision, idempotencyKey: 'dry', label: 'Dry', operations: [insertChapter], dryRun: true });
  assert.equal(dry.committed, false);
  // Setting a value to what is saved changes nothing.
  const noop = await agent.call('apply_project_changes', { expectedRevision, idempotencyKey: 'noop', label: 'Nothing',
    operations: [{ op: 'set_parameter', scope: 'spread', spread: 'one', key: 'heading', value: 'Hello' }] });
  assert.equal(noop.committed, true);
  assert.equal(noop.checkpointId, null);
  await assert.rejects(agent.call('apply_project_changes', { expectedRevision: 'a'.repeat(64), idempotencyKey: 'stale', label: 'Stale', operations: [insertChapter] }),
    (error: { code?: string }) => error.code === 'REVISION_CONFLICT');
  await writeFile(join(folder, 'project.json'), JSON.stringify({ ...saved, title: 'Changed on disk' }));
  const files = filesOf(agent.session.book);
  files.project.title = 'Rejected';
  await assert.rejects(agent.session.save(files, 'Rejected'), /changed on disk/);
  assert.deepEqual((await readSaveLedger(folder)).records, []);
  const looked = await agent.call('list_book_checkpoints', { idempotencyKey: 'dry' });
  assert.deepEqual(looked.checkpoints, []);
  assert.match(String(looked.notice), /inspect the book/);
});

test('an outside edit is reported before the next save, then as a gap between checkpoints', async (t) => {
  const { folder, cache } = await book(t);
  let session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  let files = filesOf(session.book);
  files.project.title = 'First save';
  await session.save(files, 'First save');
  await writeFile(join(folder, 'project.json'), JSON.stringify({ ...saved, title: 'Outside' }));
  const ledger = await readSaveLedger(folder);
  assert.equal(ledger.records.length, 1);
  assert.notEqual(ledger.current['project.json'], ledger.records[0].manifests['project.json'].after);
  assert.equal(ledger.current['photos.json'], ledger.records[0].manifests['photos.json'].after);

  session.close();
  session = new ProjectSession(await loadProject(folder, cache));
  files = filesOf(session.book);
  files.photoIndex = {};
  files.project.spreads.push({ id: 'two', definition: 'main' } as never);
  await session.save(files, 'Second save');
  const [one, two] = (await readSaveLedger(folder)).records;
  assert.notEqual(two.manifests['project.json'].before, one.manifests['project.json'].after, 'The gap is visible');
  assert.equal(two.manifests['photos.json'].before, one.manifests['photos.json'].after);
  // The second save is credited only with its own change, starting from the outside edit.
  assert.equal(two.manifests['project.json'].before, (await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify({ ...saved, title: 'Outside' })).digest('hex'));
});

async function interruptedSave(t: TestContext) {
  const { folder, cache } = await book(t);
  // Earlier history that recovery must keep.
  const session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  let files = filesOf(session.book);
  files.project.title = 'Earlier';
  await session.save(files, 'Earlier save');
  files = filesOf(session.book);
  files.project.title = 'Interrupted';
  const rename = fs.rename;
  fs.rename = async () => { throw new Error('Interrupted before publication'); };
  try { await assert.rejects(session.save(files, 'Interrupted save'), CommittedProjectSaveError); }
  finally { fs.rename = rename; }
  const journal = JSON.parse(await readFile(journalPath(folder), 'utf8')) as { version: number; transaction: string; checkpoint: string };
  assert.equal(journal.version, 3);
  return { folder, cache, journal };
}

async function recoveredTwice(folder: string, cache: string, transaction: string) {
  await recoverProjectSave(folder);
  await recoverProjectSave(folder);
  const reopened = await loadProject(folder, cache);
  assert.equal(reopened.project.title, 'Interrupted');
  const { records, unreadable } = await readSaveLedger(folder);
  assert.equal(unreadable, 0);
  assert.deepEqual(records.map(({ label }) => label), ['Earlier save', 'Interrupted save']);
  assert.equal(records.filter(({ checkpoint }) => checkpoint === transaction).length, 1);
}

test('recovery completes an append interrupted mid-line exactly once', async (t) => {
  const { folder, cache, journal } = await interruptedSave(t);
  await fs.appendFile(ledgerPath(folder), journal.checkpoint.slice(0, Math.floor(journal.checkpoint.length / 2)));
  await recoveredTwice(folder, cache, journal.transaction);
});

test('recovery keeps a durable record whose journal was not yet removed', async (t) => {
  const { folder, cache, journal } = await interruptedSave(t);
  await fs.appendFile(ledgerPath(folder), journal.checkpoint + '\n');
  await recoveredTwice(folder, cache, journal.transaction);
});

test('an unrelated unterminated tail is sealed instead of blocking saves', async (t) => {
  const { folder, cache } = await book(t);
  const session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  await mkdir(join(folder, '.imageflow/history'), { recursive: true });
  await writeFile(ledgerPath(folder), 'not a record');
  const files = filesOf(session.book);
  files.project.title = 'Saved anyway';
  await session.save(files, 'Saved anyway');
  const { records, unreadable } = await readSaveLedger(folder);
  assert.equal(unreadable, 1);
  assert.deepEqual(records.map(({ label }) => label), ['Saved anyway']);
});

test('the ledger is pruned to its newest records, and an expired key is no longer retained', async (t) => {
  const { folder, cache } = await book(t);
  const limits = { ...ledgerLimits };
  ledgerLimits.bytes = 4096;
  ledgerLimits.retainedBytes = 2048;
  t.after(() => Object.assign(ledgerLimits, limits));
  const agent = await open(t, folder, cache);
  const committed = await agent.call('apply_project_changes', { expectedRevision: await agent.revision(), idempotencyKey: 'early', label: 'Early batch', operations: [insertChapter] });
  for (let i = 0; i < 16; i++) {
    const files = filesOf(agent.session.book);
    files.project.title = 'Title ' + i;
    await agent.session.save(files, 'Rename ' + i);
  }
  const { size } = await fs.stat(ledgerPath(folder));
  assert.ok(size <= ledgerLimits.bytes, 'The ledger stays within its bound');
  const { records } = await readSaveLedger(folder);
  assert.equal(records.at(-1)!.label, 'Rename 15');
  assert.ok(!records.some(({ checkpoint }) => checkpoint === committed.checkpointId));
  const looked = await agent.call('list_book_checkpoints', { idempotencyKey: 'early' });
  assert.deepEqual(looked.checkpoints, []);
  assert.ok((await readdir(join(folder, '.imageflow/history'))).every((name) => name === 'ledger.jsonl'));
});

/** The prototype shared by every FileHandle, to simulate the file system under a live save. */
async function fileHandlePrototype(folder: string) {
  const handle = await fs.open(join(folder, 'photos.json'), 'r');
  try { return Object.getPrototypeOf(handle) as { write: (...args: any[]) => Promise<{ bytesWritten: number }>; read: (...args: any[]) => Promise<{ bytesRead: number }> }; }
  finally { await handle.close(); }
}

test('a short write during a live save still leaves a complete record before the journal is removed', async (t) => {
  const { folder, cache } = await book(t);
  const session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  const prototype = await fileHandlePrototype(folder);
  const write = prototype.write;
  let short = 0;
  // A nearly full disk: each write of a buffer accepts only part of it.
  prototype.write = function (this: unknown, buffer: Buffer, offset = 0, length = buffer.length - offset, position?: number) {
    if (length > 1) { short++; length = Math.ceil(length / 3); }
    return write.call(this, buffer, offset, length, position);
  };
  const files = filesOf(session.book);
  files.project.title = 'Short writes';
  try { await session.save(files, 'Short writes'); }
  finally { prototype.write = write; }
  assert.ok(short > 0, 'The ledger append went through FileHandle.write');
  await assert.rejects(fs.stat(journalPath(folder)), { code: 'ENOENT' });
  const { records, unreadable } = await readSaveLedger(folder);
  assert.equal(unreadable, 0);
  assert.deepEqual(records.map(({ label }) => label), ['Short writes']);
});

test('an unreadable history fails the receipt lookup before a batch commits', async (t) => {
  const { folder, cache } = await book(t);
  const agent = await open(t, folder, cache);
  const request = { expectedRevision: await agent.revision(), idempotencyKey: 'blocked', label: 'Blocked batch', operations: [insertChapter] };
  // Not a directory: validation fails instead of reading as an empty history.
  await mkdir(join(folder, '.imageflow'), { recursive: true });
  await writeFile(join(folder, '.imageflow/history'), 'not a folder');
  await assert.rejects(readSaveLedger(folder));
  await assert.rejects(agent.call('apply_project_changes', request), (error: { code?: string }) => error.code === 'HISTORY_UNAVAILABLE');
  await assert.rejects(agent.call('list_book_checkpoints'));
  assert.equal((await spreads(folder)).length, 1);
  await assert.rejects(fs.stat(journalPath(folder)), { code: 'ENOENT' });

  if (process.getuid?.() === 0) return;
  // A folder that can't be searched.
  await rm(join(folder, '.imageflow/history'));
  await mkdir(join(folder, '.imageflow/history/locked'), { recursive: true });
  await fs.chmod(join(folder, '.imageflow'), 0o000);
  t.after(() => fs.chmod(join(folder, '.imageflow'), 0o700).catch(() => {}));
  await assert.rejects(agent.call('apply_project_changes', request), (error: { code?: string }) => error.code === 'HISTORY_UNAVAILABLE');
  await fs.chmod(join(folder, '.imageflow'), 0o700);
  assert.equal((await spreads(folder)).length, 1);
});

test('an oversized ledger is pruned and read from its newest records with bounded reads', async (t) => {
  const { folder, cache } = await book(t);
  const limits = { ...ledgerLimits };
  ledgerLimits.bytes = 4096;
  ledgerLimits.retainedBytes = 2048;
  t.after(() => Object.assign(ledgerLimits, limits));
  const session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  let files = filesOf(session.book);
  files.project.title = 'Before growth';
  await session.save(files, 'Before growth');
  // Grown to 1 MiB outside ImageFlow, for example in a restored backup, with the newest record last.
  const record = await readFile(ledgerPath(folder), 'utf8');
  await writeFile(ledgerPath(folder), ('x'.repeat(1023) + '\n').repeat(1024) + record);
  assert.deepEqual((await readSaveLedger(folder)).records.map(({ label }) => label), ['Before growth']);

  const prototype = await fileHandlePrototype(folder);
  const read = prototype.read;
  let largest = 0;
  prototype.read = function (this: unknown, ...args: any[]) {
    const length = typeof args[2] === 'number' ? args[2] : 0;
    largest = Math.max(largest, length);
    return read.apply(this, args);
  };
  files = filesOf(session.book);
  files.project.title = 'After growth';
  try { await session.save(files, 'After growth'); }
  finally { prototype.read = read; }
  assert.ok(largest <= 64 * 1024, 'Pruning read ' + largest + ' bytes at once');
  const { size } = await fs.stat(ledgerPath(folder));
  assert.ok(size <= ledgerLimits.retainedBytes);
  // Filler lines that still fit the retained window are kept and skipped as unreadable.
  const { records } = await readSaveLedger(folder);
  assert.deepEqual(records.map(({ label }) => label), ['Before growth', 'After growth']);
});

test('checkpoints page newest first', async (t) => {
  const { folder, cache } = await book(t);
  const agent = await open(t, folder, cache);
  for (let i = 0; i < 5; i++) {
    const files = filesOf(agent.session.book);
    files.project.title = 'Title ' + i;
    await agent.session.save(files, 'Rename ' + i);
  }
  const first = await agent.call('list_book_checkpoints', { limit: 3 });
  assert.deepEqual((first.checkpoints as { label: string }[]).map(({ label }) => label), ['Rename 4', 'Rename 3', 'Rename 2']);
  const second = await agent.call('list_book_checkpoints', { limit: 3, cursor: first.nextCursor });
  assert.deepEqual((second.checkpoints as { label: string }[]).map(({ label }) => label), ['Rename 1', 'Rename 0']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.retained, 5);
});

test('a Git repository in the book changes neither its revision nor its copies', async (t) => {
  const { work, folder, cache } = await book(t);
  for (const repository of [join(folder, '.git'), join(folder, 'template/.git')]) {
    await mkdir(join(repository, 'objects'), { recursive: true });
    await writeFile(join(repository, 'HEAD'), 'ref: refs/heads/main\n');
  }
  const before = await captureProjectInputs(folder);
  await writeFile(join(folder, 'template/.git/objects/commit'), 'a new commit');
  await writeFile(join(folder, '.git/objects/commit'), 'a new commit');
  assert.equal((await captureProjectInputs(folder)).revision, before.revision);
  await writeFile(join(folder, 'template/index.tsx'), 'export default { changed: true };');
  assert.notEqual((await captureProjectInputs(folder)).revision, before.revision);

  const session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  const files = filesOf(session.book);
  files.project.title = 'Has history';
  await session.save(files, 'Has history');
  const copy = await saveDocumentCopy(session.book, join(work, 'Copy.imageflow'), false);
  const entries = await readdir(copy, { recursive: true });
  assert.ok(!entries.some((entry) => entry.split('/').includes('.git')), entries.join(', '));
  assert.deepEqual((await readSaveLedger(copy)).records, []);
});
