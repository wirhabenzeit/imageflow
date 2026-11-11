import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createAuthoringService } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import type { BookPreview } from '../desktop/preview';
import { loadProject } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import type { AuthoringCheckResult } from '../src/authoring-check';
import type { RenderStatus } from '../src/desktop';
import { mm } from '../src/format';
import { p } from '../src/parameters';
import { PreviewError } from '../src/preview';
import { parseMcpArguments } from '../src/mcp-contract';
import type { PreviewRequest } from '../src/preview';

const layout = (label: string, parameters = {}) => ({ label, span: 'spread' as const, parameters, boxes: {}, elements: {} });
const status: Extract<RenderStatus, { state: 'ready' }> = {
  state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {},
  template: {
    version: '1', parameters: {}, spreads: { main: layout('Main', { heading: p.string({ label: 'Heading', default: '' }) }), chapter: layout('Chapter opening') },
    formatId: 'default', formats: { default: 'Default' },
    format: {
      label: 'Draft test', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) },
      safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
    },
  },
};
const saved = { schemaVersion: 1, title: 'Draft book', template: { id: 'test', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] };

type Rendered = { book: OpenProject; preview?: PreviewRequest };

// `fails` makes the renderer reject a book the way a layout that throws does: the template loaded, the book did not render.
async function fixture(t: TestContext, project: object = saved, fails?: (book: OpenProject) => boolean, writable = false) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-draft-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const folder = join(work, 'book');
  const cache = join(work, 'cache');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(cache);
  await writeFile(join(folder, 'project.json'), JSON.stringify(project));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'template/index.tsx'), 'export default {};');
  await writeFile(join(work, 'api.md'), '# API');
  const session = new ProjectSession(await loadProject(folder, cache, !writable));
  const changed: OpenProject[] = [];
  t.after(() => session.close());
  const renders: Rendered[] = [];
  const service = createAuthoringService({
    session: () => session, cache, docs: join(work, 'api.md'),
    check: (book, request, signal, index, draft) => checkProject(book, cache, request, async (snapshot, preview) => {
      renders.push({ book: snapshot, preview });
      if (fails?.(snapshot)) throw new PreviewError('render-failed', 'Heading rejected.', { template: status.template });
      if (!preview) return { status };
      const image: BookPreview = { width: 4, height: 2, widthMm: 200, heightMm: 100, bounds: 'trim', side: 'spread', page: { left: 1, right: 2 },
        spread: 'spread' in preview.target ? preview.target.spread : 'one', bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', status };
      return { status, preview: image };
    }, signal, index, undefined, draft),
    changed: (book) => { if (!writable) assert.fail('A draft must not change the open book.'); changed.push(book); },
    recovery: (message) => assert.fail('Unexpected save recovery: ' + message),
    import: async () => assert.fail('A draft must not import sources.'),
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    service(name, { project: session.handle, ...args }, new AbortController().signal);
  const revision = async () => ((await call('list_projects')).projects as { revision: string }[])[0].revision;
  return { folder, session, renders, changed, call, revision };
}

test('a draft renders an inserted layout by batch reference without saving or recording history', async (t) => {
  const { folder, session, renders, call, revision } = await fixture(t);
  const before = await readFile(join(folder, 'project.json'), 'utf8');
  const expectedRevision = await revision();
  const result = await call('check_book', {
    expectedRevision,
    draft: { operations: [{ op: 'insert_spread', definition: 'chapter', ref: 'chapter', after: 'one' }] },
    preview: { target: { spread: '$chapter' } },
  }) as AuthoringCheckResult;
  assert.equal(result.state, 'ready');
  assert.equal(result.revision, expectedRevision);
  const inserted = result.draft?.references?.chapter;
  assert.ok(inserted);
  assert.deepEqual({ ...result.draft, references: undefined, changes: undefined },
    { applied: true, committed: false, affectedSpreads: ['one', inserted], reflow: true, references: undefined, changes: undefined });
  assert.equal(result.image?.draft, true);
  assert.equal(result.image?.spread, inserted);
  const drafted = renders.at(-1)!;
  assert.deepEqual(drafted.book.project.spreads.map(({ id, definition }) => [id, definition]), [['one', 'main'], [inserted, 'chapter']]);
  assert.deepEqual(drafted.preview?.target, { spread: inserted });
  assert.equal(await readFile(join(folder, 'project.json'), 'utf8'), before);
  assert.deepEqual(session.history, { undo: undefined, redo: undefined });
  assert.equal(session.book.project.spreads.length, 1);
  // A later inspection describes the saved book, not the cached draft.
  const inspected = await call('inspect_book', { view: 'spreads' });
  assert.deepEqual((inspected.items as { id: string }[]).map(({ id }) => id), ['one']);
});

test('invalid drafts fail as request errors and stale drafts are not applied', async (t) => {
  const { renders, call, revision } = await fixture(t);
  const expectedRevision = await revision();
  await assert.rejects(call('check_book', { expectedRevision, draft: { operations: [{ op: 'remove_spread', spread: 'missing' }] } }),
    { code: 'SPREAD_NOT_FOUND', details: { operationIndex: 0 } });
  await assert.rejects(call('check_book', {
    expectedRevision, draft: { operations: [{ op: 'set_title', title: 'Draft title' }] }, preview: { target: { spread: '$nothing' } },
  }), { code: 'REFERENCE_NOT_FOUND' });
  const rendered = renders.length;
  const stale = await call('check_book', {
    expectedRevision: 'f'.repeat(64), draft: { operations: [{ op: 'set_title', title: 'Draft title' }] },
  }) as AuthoringCheckResult;
  assert.equal(stale.state, 'error');
  assert.deepEqual(stale.draft, { applied: false, committed: false });
  assert.equal(stale.diagnostics[0].code, 'revision-conflict');
  assert.equal(renders.length, rendered);
});

test('the check_book contract scopes batch references and revisions to drafts', () => {
  const project = 'handle';
  const expectedRevision = 'a'.repeat(64);
  const draft = { operations: [{ op: 'insert_spread', definition: 'chapter', ref: 'chapter' }] };
  assert.throws(() => parseMcpArguments('check_book', { project, preview: { target: { spread: '$chapter' } } }), /Batch references/);
  assert.throws(() => parseMcpArguments('check_book', { project, draft }), /Draft checks require/);
  assert.throws(() => parseMcpArguments('check_book', { project, expectedRevision, draft: { operations: [] } }));
  const parsed = parseMcpArguments('check_book', { project, expectedRevision, draft, preview: { target: { spread: '$chapter' } } });
  assert.deepEqual((parsed.args.preview as { target: unknown }).target, { spread: '$chapter' });
});

test('a draft can repair a saved book whose layout fails to render, and the repair can be committed and undone', async (t) => {
  const failing = { ...saved, spreads: [{ id: 'one', definition: 'main', params: { heading: 'Hello' } }] };
  const { folder, session, changed, call, revision } = await fixture(t, failing,
    (book) => book.project.spreads.some(({ params }) => params.heading === 'Hello'), true);
  const expectedRevision = await revision();
  const before = await call('check_book', { expectedRevision }) as AuthoringCheckResult;
  assert.equal(before.state, 'error');
  assert.equal(before.diagnostics[0].code, 'render-failed');
  // Context keeps the declarations needed to plan the repair.
  const context = await call('get_authoring_context');
  assert.ok((context.template as { spreads: Record<string, unknown> }).spreads.main);
  const repaired = await call('check_book', {
    expectedRevision, preview: { target: { spread: 'one' } },
    draft: { operations: [{ op: 'set_parameter', scope: 'spread', spread: 'one', key: 'heading', value: 'Recovered' }] },
  }) as AuthoringCheckResult;
  assert.equal(repaired.state, 'ready', JSON.stringify(repaired.diagnostics));
  assert.equal(repaired.draft?.applied, true);
  assert.deepEqual(repaired.draft?.changes, ['Updated heading']);
  assert.equal(repaired.image?.draft, true);
  const heading = async () => JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')).spreads[0].params.heading;
  assert.equal(await heading(), 'Hello');
  // The same operations commit against the failing saved book, using the declarations of the template that loaded.
  const committed = await call('apply_project_changes', {
    expectedRevision, idempotencyKey: 'repair', label: 'Repair heading',
    operations: [{ op: 'set_parameter', scope: 'spread', spread: 'one', key: 'heading', value: 'Recovered' }],
  });
  assert.equal(committed.committed, true, JSON.stringify(committed));
  assert.equal(await heading(), 'Recovered');
  assert.equal(changed.length, 1);
  assert.deepEqual(session.history, { undo: 'Repair heading', redo: undefined });
  const after = await call('check_book', { expectedRevision: committed.revision }) as AuthoringCheckResult;
  assert.equal(after.state, 'ready', JSON.stringify(after.diagnostics));
  await session.undo('undo');
  assert.equal(await heading(), 'Hello');
  assert.equal((await call('check_book') as AuthoringCheckResult).state, 'error');
});
