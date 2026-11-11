import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkProject } from '../desktop/check';
import { loadProject } from '../desktop/project';
import { captureProjectRevision } from '../desktop/revisions';
import type { RenderStatus } from '../src/desktop';
import { mm } from '../src/format';
import { PreviewError } from '../src/preview';
import { authoringErrorResult } from '../desktop/authoring-errors';

// Rendering itself is exercised by smoke-authoring-preview; these tests exercise the consistency boundary.
const status: Extract<RenderStatus, { state: 'ready' }> = {
  state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {},
  template: {
    version: '1', parameters: {}, spreads: {}, formatId: 'default', formats: {},
    format: {
      label: 'Check test', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) },
      safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
    },
  },
};

async function fixture(t: TestContext) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-check-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const folder = join(work, 'book');
  const cache = join(work, 'cache');
  await mkdir(cache);
  await cp(resolve('sample/whitewall'), folder, { recursive: true, filter: (path) => !path.includes('.imageflow') });
  return { book: await loadProject(folder, cache, true), cache, folder };
}

test('a reverted edit invalidates a running check and its private cache cannot contaminate the next check', async (t) => {
  const { book, cache, folder } = await fixture(t);
  const text = join(folder, 'texts/arrival.md');
  const original = await readFile(text);
  const revision = await captureProjectRevision(folder);
  let rejectedCache = '';
  const rejected = await checkProject(book, cache, {}, async (snapshot) => {
    rejectedCache = snapshot.cache;
    assert.equal(snapshot.readOnly, true);
    await writeFile(join(snapshot.cache, 'poisoned-rendition'), 'changed pixels');
    await writeFile(text, 'Changed during rendering');
    await writeFile(text, original);
    return { status };
  }, new AbortController().signal);
  assert.equal(await captureProjectRevision(folder), revision);
  assert.equal(rejected.state, 'error');
  assert.equal(rejected.diagnostics[0].code, 'source-changed');
  assert.equal(rejected.render, undefined);
  assert.equal(rejected.image, undefined);
  assert.deepEqual(await readdir(cache), []);
  const accepted = await checkProject(book, cache, { expectedRevision: revision }, async (snapshot) => {
    assert.notEqual(snapshot.cache, rejectedCache);
    assert.deepEqual(await readdir(snapshot.cache), []);
    return { status };
  }, new AbortController().signal);
  assert.equal(accepted.state, 'ready');
  assert.equal(accepted.revision, revision);
  assert.deepEqual(await readdir(cache), []);
  await assert.rejects(readdir(join(folder, '.imageflow')), { code: 'ENOENT' });
});

test('stale requests do not load or render a new book', async (t) => {
  const { book, cache } = await fixture(t);
  let rendered = false;
  const result = await checkProject(book, cache, { expectedRevision: '0'.repeat(64) }, async () => {
    rendered = true;
    return { status };
  }, new AbortController().signal);
  assert.equal(result.state, 'error');
  assert.equal(result.diagnostics[0].code, 'revision-conflict');
  assert.equal(result.checks.bundle, 'not-run');
  assert.equal(rendered, false);
  assert.deepEqual(await readdir(cache), []);
});

test('compile failures retain source locations and malformed project data is not misreported as a bundle failure', async (t) => {
  const { book, cache, folder } = await fixture(t);
  const render = async () => { assert.fail('Invalid input must not reach the renderer.'); };
  await writeFile(join(folder, 'template/index.tsx'), 'export default );');
  const compiled = await checkProject(book, cache, {}, render, new AbortController().signal);
  assert.equal(compiled.checks.bundle, 'failed');
  assert.equal(compiled.checks.layout, 'not-run');
  assert.equal(compiled.diagnostics[0].code, 'template-compile-error');
  assert.equal(compiled.diagnostics[0].location?.path, 'template/index.tsx');
  assert.equal(compiled.diagnostics[0].location?.line, 1);
  await writeFile(join(folder, 'project.json'), '{');
  const malformed = await checkProject(book, cache, {}, render, new AbortController().signal);
  assert.equal(malformed.checks.bundle, 'not-run');
  assert.equal(malformed.diagnostics[0].stage, 'project');
  assert.match(malformed.diagnostics[0].message, /invalid JSON/);
  assert.deepEqual(await readdir(cache), []);
});

test('cancelling during rendering cleans up the check cache', async (t) => {
  const { book, cache } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(checkProject(book, cache, {}, async (snapshot) => {
    await writeFile(join(snapshot.cache, 'rendition'), 'pixels');
    controller.abort();
    return { status };
  }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(await readdir(cache), []);
});

test('a render failure keeps its error identity when cancellation arrives concurrently', async (t) => {
  const { book, cache } = await fixture(t);
  const controller = new AbortController();
  const failure = new PreviewError('preview-capture-failed', 'Unable to capture the requested page.');
  await assert.rejects(checkProject(book, cache, {}, async () => {
    controller.abort(new Error('Request deadline elapsed.'));
    throw failure;
  }, controller.signal), (error) => {
    assert.equal(error, failure);
    assert.equal(authoringErrorResult(error, controller.signal).error.code, 'PREVIEW_CAPTURE_FAILED');
    return true;
  });
  assert.deepEqual(await readdir(cache), []);
});
