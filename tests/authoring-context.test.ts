import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AuthoringError, createAuthoringService } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import { loadProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { RenderStatus } from '../src/desktop';
import { mm } from '../src/format';

const source = 'export default {};';
const project = { schemaVersion: 1, title: 'Context book', template: { id: 'test', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] };
const status: Extract<RenderStatus, { state: 'ready' }> = {
  state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {},
  template: {
    version: '1', parameters: {}, spreads: { main: { label: 'Main', span: 'spread', parameters: {}, boxes: {}, elements: {} } },
    formatId: 'default', formats: { default: 'Default' },
    format: {
      label: 'Context test', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) },
      safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 20, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
    },
  },
};

async function fixture(t: TestContext) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-context-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const folder = join(work, 'book');
  const cache = join(work, 'cache');
  const docs = join(work, 'api.md');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(cache);
  await writeFile(join(folder, 'project.json'), JSON.stringify(project));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'template/index.tsx'), source);
  await writeFile(docs, '# Template API reference');
  const session = new ProjectSession(await loadProject(folder, cache, true));
  const hooks: Parameters<typeof createAuthoringService>[0] = {
    session: () => session, cache, docs,
    check: (book, request, signal) => checkProject(book, cache, request, async () => ({ status }), signal),
    changed: () => assert.fail('Context must not mutate the session.'),
    recovery: () => assert.fail('Context must not save project files.'),
    import: async () => assert.fail('Context must not import sources.'),
  };
  const service = createAuthoringService(hooks);
  const call = (name: string, extra: Record<string, unknown> = {}) =>
    service(name, { project: session.handle, view: 'summary', ...extra }, new AbortController().signal);
  return { work, folder, docs, hooks, call };
}

for (const tool of ['get_authoring_context', 'inspect_book']) {
  for (const name of ['project.json', 'photos.json']) {
    test(tool + ' preserves diagnostics for malformed ' + name, async (t) => {
      const { folder, call } = await fixture(t);
      await writeFile(join(folder, name), '{ invalid JSON');
      const result = await call(tool);
      const diagnostics = result.diagnostics as AuthoringDiagnostic[];
      assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes('invalid JSON') && diagnostic.location?.path === name));
      assert.match(String(result.revision), /^[a-f0-9]{64}$/);
      if (tool === 'get_authoring_context') {
        assert.equal((result.sources as Record<string, { text: string }>)['template/index.tsx'].text, source);
        assert.equal(result.apiReference, '# Template API reference');
      }
    });

    for (const problem of ['missing', 'outside']) {
      test(tool + ' returns safe diagnostics for ' + problem + ' ' + name, async (t) => {
        const { work, folder, call } = await fixture(t);
        await rm(join(folder, name));
        if (problem === 'outside') {
          const outside = join(work, 'private.json');
          const secret = name === 'project.json' ? { ...project, title: 'PRIVATE_CONTENT_MUST_STAY_OUTSIDE' }
            : { private: { path: 'photos/private.jpg', caption: 'PRIVATE_CONTENT_MUST_STAY_OUTSIDE' } };
          await writeFile(outside, JSON.stringify(secret));
          await symlink(outside, join(folder, name));
        }
        const result = await call(tool, { view: 'sources' });
        assert.equal(result.revision, null);
        assert.ok((result.diagnostics as AuthoringDiagnostic[]).some((diagnostic) => diagnostic.code ===
          (problem === 'outside' ? 'source-outside-project' : 'source-missing')));
        assert.equal(JSON.stringify(result).includes('PRIVATE_CONTENT_MUST_STAY_OUTSIDE'), false);
      });
    }
  }

  test(tool + ' retains compile diagnostics while valid manifests remain inspectable', async (t) => {
    const { folder, call } = await fixture(t);
    const broken = 'export default );';
    await writeFile(join(folder, 'template/index.tsx'), broken);
    const result = await call(tool);
    assert.ok((result.diagnostics as AuthoringDiagnostic[]).some(({ code }) => code === 'template-compile-error'));
    assert.equal(result.template, undefined);
    if (tool === 'get_authoring_context') {
      assert.equal((result.sources as Record<string, { text: string }>)['template/index.tsx'].text, broken);
      assert.equal(result.apiReference, '# Template API reference');
    } else {
      assert.equal(result.title, 'Context book');
      assert.deepEqual((result.items as { boxes: unknown }[])[0].boxes, {});
    }
  });

  test(tool + ' rejects files changed after checking and before inspection', async (t) => {
    const { folder, hooks, call } = await fixture(t);
    const check = hooks.check;
    hooks.check = async (...args) => {
      const report = await check(...args);
      await rm(join(folder, 'photos.json'));
      return report;
    };
    await assert.rejects(call(tool), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
  });

  test(tool + ' rejects a different unavailable input after checking', async (t) => {
    const { folder, hooks, call } = await fixture(t);
    await rm(join(folder, 'project.json'));
    const check = hooks.check;
    hooks.check = async (...args) => {
      const report = await check(...args);
      await writeFile(join(folder, 'project.json'), JSON.stringify(project));
      await rm(join(folder, 'photos.json'));
      return report;
    };
    await assert.rejects(call(tool), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
  });
}

test('schema-invalid manifests preserve structured context findings', async (t) => {
  const { folder, call } = await fixture(t);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, schemaVersion: 99 }));
  await writeFile(join(folder, 'photos.json'), '[]');
  const result = await call('get_authoring_context');
  const diagnostics = result.diagnostics as AuthoringDiagnostic[];
  assert.ok(diagnostics.some((diagnostic) => diagnostic.location?.path === 'project.json'));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.location?.path === 'photos.json'));
  assert.equal(result.apiReference, '# Template API reference');
});

test('a template directory outside the project cannot expose its source or filenames', async (t) => {
  const { work, folder, call } = await fixture(t);
  await rm(join(folder, 'template'), { recursive: true });
  const outside = join(work, 'private-template');
  await mkdir(outside);
  await writeFile(join(outside, 'index.tsx'), 'PRIVATE_SOURCE_MUST_STAY_OUTSIDE');
  await writeFile(join(outside, 'PRIVATE_FILENAME_MUST_STAY_OUTSIDE.tsx'), 'private');
  await symlink(outside, join(folder, 'template'));
  const result = await call('get_authoring_context');
  assert.equal(result.revision, null);
  assert.deepEqual(result.sources, {});
  assert.deepEqual(result.templateFiles, []);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SOURCE_MUST_STAY_OUTSIDE'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_FILENAME_MUST_STAY_OUTSIDE'), false);
  assert.equal(result.apiReference, '# Template API reference');
});

for (const missingManifest of [false, true]) {
  test('context rejects source edits during inspection' + (missingManifest ? ' with an unavailable revision' : ''), async (t) => {
    const { folder, docs, hooks, call } = await fixture(t);
    if (missingManifest) await rm(join(folder, 'photos.json'));
    Object.defineProperty(hooks, 'docs', { get: () => {
      writeFileSync(join(folder, 'template/index.tsx'), 'export default { changed: true };');
      return docs;
    } });
    await assert.rejects(call('get_authoring_context'), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
  });
}

test('context rejects a reverted source edit even when a missing manifest prevents a complete revision', async (t) => {
  const { folder, docs, hooks, call } = await fixture(t);
  await rm(join(folder, 'photos.json'));
  Object.defineProperty(hooks, 'docs', { get: () => {
    writeFileSync(join(folder, 'template/index.tsx'), 'export default { temporary: true };');
    writeFileSync(join(folder, 'template/index.tsx'), source);
    return docs;
  } });
  await assert.rejects(call('get_authoring_context'), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
});

test('context rejects a changed readable manifest while another manifest remains unavailable', async (t) => {
  const { folder, docs, hooks, call } = await fixture(t);
  await rm(join(folder, 'photos.json'));
  Object.defineProperty(hooks, 'docs', { get: () => {
    writeFileSync(join(folder, 'project.json'), JSON.stringify({ ...project, title: 'Changed during inspection' }));
    return docs;
  } });
  await assert.rejects(call('get_authoring_context'), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
});
