import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { AuthoringError, createAuthoringService } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import { importIntoProject, loadProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { RenderStatus } from '../src/desktop';
import { mm } from '../src/format';
import { PreviewError } from '../src/preview';

const source = 'export default {};';
const project = { schemaVersion: 1, title: 'Context book', template: { id: 'test', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] };
const status: Extract<RenderStatus, { state: 'ready' }> = {
  state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {}, anchors: [],
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
  t.after(() => session.close());
  const hooks: Parameters<typeof createAuthoringService>[0] = {
    session: () => session, cache, docs,
    check: (book, request, signal, index) => checkProject(book, cache, request, async () => ({ status }), signal, index),
    changed: () => assert.fail('Context must not mutate the session.'),
    recovery: () => assert.fail('Context must not save project files.'),
    import: async () => assert.fail('Context must not import sources.'),
  };
  const service = createAuthoringService(hooks);
  const call = (name: string, extra: Record<string, unknown> = {}) =>
    service(name, { project: session.handle, view: 'summary', ...extra }, new AbortController().signal);
  return { work, folder, docs, hooks, session, call };
}

function countChecks(hooks: Parameters<typeof createAuthoringService>[0]) {
  const check = hooks.check;
  let count = 0;
  hooks.check = (...args) => { count++; return check(...args); };
  return () => count;
}

for (const code of ['typescript-error', 'typescript-timeout']) {
  test(code + ' results do not enter the context or inspection cache', async (t) => {
    const { hooks, call } = await fixture(t);
    hooks.check = (book, request, signal, index, draft) => checkProject(book, book.cache, request,
      async () => ({ status }), signal, index, undefined, draft, async () => ({
        files: ['template/index.tsx'], totalDiagnostics: 1, truncated: false, elapsedMs: 10,
        diagnostics: [{ code, stage: 'template', severity: 'error', message: 'Type check finding.' }],
      }));
    for (const tool of ['get_authoring_context', 'inspect_book']) {
      const typed = await call('check_book', { typescript: true });
      assert.equal((typed.checks as { typescript: string }).typescript, 'failed');
      const plain = await call(tool);
      assert.equal((plain.checks as { typescript: string }).typescript, 'not-run');
      assert.ok(!(plain.diagnostics as AuthoringDiagnostic[]).some((finding) => finding.code === code));
      assert.equal(plain.typecheck, undefined);
    }
  });
}

function changeDuringMutationPreparation(
  hooks: Parameters<typeof createAuthoringService>[0], session: ProjectSession, change: () => void | Promise<void>,
) {
  const check = hooks.check;
  const capture = session.inputs.capture.bind(session.inputs);
  let capturesAfterCheck: number | undefined;
  hooks.check = async (...args) => {
    capturesAfterCheck = undefined;
    const report = await check(...args);
    capturesAfterCheck = 0;
    return report;
  };
  session.inputs.capture = async (options) => {
    // The first capture after a check verifies its result. The second verifies the freshly loaded mutation base.
    if (capturesAfterCheck !== undefined && ++capturesAfterCheck === 2) await change();
    return capture(options);
  };
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

test('unchanged context and inspection requests share a validated no-preview check', async (t) => {
  const { hooks, call } = await fixture(t);
  const checks = countChecks(hooks);
  const context = await call('get_authoring_context');
  const inspected = await call('inspect_book');
  await call('get_authoring_context', { includeSource: [] });
  assert.equal(context.revision, inspected.revision);
  assert.equal(checks(), 1);
});

test('explicit checks always run fresh and seed whole-book reports for unchanged inspections', async (t) => {
  const { hooks, call } = await fixture(t);
  const checks = countChecks(hooks);
  const first = await call('check_book');
  await call('inspect_book');
  assert.equal(checks(), 1);
  await call('check_book', { expectedRevision: first.revision });
  await call('inspect_book');
  assert.equal(checks(), 2);
  await call('check_book', { preview: { target: { spread: 'one' } } });
  await call('inspect_book');
  assert.equal(checks(), 3);
});

test('cached checks cannot satisfy a conflicting expected revision', async (t) => {
  const { hooks, call, session } = await fixture(t);
  const checks = countChecks(hooks);
  await call('inspect_book');
  session.book.readOnly = false;
  await assert.rejects(call('apply_project_changes', { expectedRevision: '0'.repeat(64), idempotencyKey: 'conflict',
    label: 'Change title', dryRun: true, operations: [{ op: 'set_title', title: 'Changed' }] }),
  (error) => error instanceof AuthoringError && error.code === 'REVISION_CONFLICT');
  assert.equal(checks(), 1);
});

test('metadata changes and watcher invalidation prevent stale check reuse', async (t) => {
  const { hooks, call, session, folder } = await fixture(t);
  const checks = countChecks(hooks);
  const path = join(folder, 'template/index.tsx');
  const timestamp = new Date('2024-02-20T00:00:00Z');
  await utimes(path, timestamp, timestamp);
  const first = await call('inspect_book');
  const before = await stat(path);
  const replacement = source.replace('{}', '[]');
  await writeFile(path, replacement);
  await utimes(path, timestamp, timestamp);
  const after = await stat(path);
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeMs, after.mtimeMs);
  const changed = await call('inspect_book');
  assert.notEqual(changed.revision, first.revision);
  assert.equal(checks(), 2);
  session.inputs.invalidate('template/index.tsx');
  await call('inspect_book');
  assert.equal(checks(), 3);
  await writeFile(path, source);
  await utimes(path, timestamp, timestamp);
  const restored = await call('inspect_book');
  assert.equal(restored.revision, first.revision);
  assert.equal(checks(), 4);
});

test('failed compiles remain inspectable and are rechecked after source repair', async (t) => {
  const { hooks, call, folder } = await fixture(t);
  const checks = countChecks(hooks);
  await writeFile(join(folder, 'template/index.tsx'), 'export default );');
  const failed = await call('get_authoring_context');
  await call('inspect_book');
  assert.equal(checks(), 2);
  assert.ok((failed.diagnostics as AuthoringDiagnostic[]).some(({ code }) => code === 'template-compile-error'));
  await writeFile(join(folder, 'template/index.tsx'), source);
  await call('get_authoring_context');
  await call('inspect_book');
  assert.equal(checks(), 3);
});

test('a mutation reuses the validated baseline and invalidates it after saving', async (t) => {
  const { hooks, call, session } = await fixture(t);
  const checks = countChecks(hooks);
  const context = await call('inspect_book');
  session.book.readOnly = false;
  hooks.changed = () => {};
  const applied = await call('apply_project_changes', { expectedRevision: context.revision, idempotencyKey: 'title-change',
    label: 'Agent title edit', operations: [{ op: 'set_title', title: 'Changed by agent' }] });
  assert.equal(applied.committed, true);
  assert.equal(checks(), 1);
  assert.equal(session.history.undo, 'Agent title edit');
  const updated = await call('inspect_book');
  assert.equal(updated.title, 'Changed by agent');
  assert.notEqual(updated.revision, context.revision);
  assert.equal(checks(), 2);
});

test('listing and unchanged inspections share indexed photo digests across checks', async (t) => {
  const { hooks, call, session, folder } = await fixture(t);
  const checks = countChecks(hooks);
  await mkdir(join(folder, 'photos'));
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toFile(join(folder, 'photos/image.png'));
  await writeFile(join(folder, 'photos.json'), JSON.stringify({ image: { path: 'photos/image.png' } }));
  await call('list_projects');
  const photoBytes = session.inputs.metrics.photoBytesHashed;
  assert.ok(photoBytes > 0);
  await call('inspect_book');
  await call('get_authoring_context');
  await call('list_projects');
  await call('check_book');
  assert.equal(checks(), 2);
  assert.equal(session.inputs.metrics.photoBytesHashed, photoBytes);
});

test('a delayed watcher event gets one fresh attempt and preserves compiler diagnostics', async (t) => {
  const { hooks, call, session, folder } = await fixture(t);
  await writeFile(join(folder, 'template/index.tsx'), 'export default );');
  const check = hooks.check;
  let attempts = 0;
  hooks.check = async (...args) => {
    const result = await check(...args);
    if (++attempts === 1) session.inputs.invalidate('template/index.tsx');
    return result;
  };
  const result = await call('check_book');
  assert.equal(attempts, 2);
  assert.equal((result.checks as { bundle: string }).bundle, 'failed');
  assert.ok((result.diagnostics as AuthoringDiagnostic[]).some(({ code, location }) => code === 'template-compile-error' && location?.line === 1));
});

test('continued watcher churn is rejected after two full attempts', async (t) => {
  const { hooks, call, session } = await fixture(t);
  const check = hooks.check;
  let attempts = 0;
  hooks.check = async (...args) => {
    const result = await check(...args);
    attempts++;
    session.inputs.invalidate('template/index.tsx');
    return result;
  };
  await assert.rejects(call('check_book'), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
  assert.equal(attempts, 2);
});

test('a watcher retry preserves the requested revision and preview target', async (t) => {
  const { hooks, call, session } = await fixture(t);
  const expectedRevision = (await session.inputs.capture()).revision;
  const preview = { target: { spread: 'one' }, maxEdge: 300 };
  const check = hooks.check;
  const requests: unknown[] = [];
  hooks.check = async (...args) => {
    requests.push(structuredClone(args[1]));
    const result = await check(...args);
    if (requests.length === 1) session.inputs.invalidate('template/index.tsx');
    return result;
  };
  const result = await call('check_book', { expectedRevision, preview });
  assert.equal(result.state, 'ready');
  assert.deepEqual(requests, [{ expectedRevision, preview }, { expectedRevision, preview }]);
});

test('cancellation during watcher churn cannot start a retry', async (t) => {
  const { hooks, session } = await fixture(t);
  const check = hooks.check;
  const controller = new AbortController();
  const reason = new Error('Cancelled by the caller');
  let attempts = 0;
  hooks.check = async (...args) => {
    const result = await check(...args);
    attempts++;
    session.inputs.invalidate('template/index.tsx');
    controller.abort(reason);
    return result;
  };
  const service = createAuthoringService(hooks);
  await assert.rejects(service('check_book', { project: session.handle }, controller.signal), (error) => error === reason);
  assert.equal(attempts, 1);
});

test('a successful preview seeds inspection without retaining or returning its image', async (t) => {
  const { hooks, call } = await fixture(t);
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const check = hooks.check;
  hooks.check = async (...args) => {
    const result = await check(...args);
    if (args[1].preview && result.state === 'ready') result.image = {
      width: 8, height: 8, widthMm: 200, heightMm: 100, bounds: 'trim', spread: 'one', side: 'spread',
      page: { left: 1, right: 2 }, mimeType: 'image/png', data: bytes.toString('base64'),
    };
    return result;
  };
  const checks = countChecks(hooks);
  const preview = await call('check_book', { preview: { target: { spread: 'one' }, maxEdge: 8 } });
  assert.ok(preview.image);
  const inspected = await call('inspect_book');
  const context = await call('get_authoring_context');
  assert.equal(inspected.image, undefined);
  assert.equal(context.image, undefined);
  assert.equal(checks(), 1);
});

test('a rejected preview target cannot seed a cached whole-book report', async (t) => {
  const { hooks, call } = await fixture(t);
  const check = hooks.check;
  hooks.check = (book, request, signal, index) => request.preview
    ? checkProject(book, book.cache, request, async () => { throw new PreviewError('preview-target-not-found', 'The requested spread is missing.'); }, signal, index)
    : check(book, request, signal, index);
  const checks = countChecks(hooks);
  await call('inspect_book');
  const failed = await call('check_book', { preview: { target: { spread: 'missing' } } });
  assert.equal(failed.state, 'error');
  await call('inspect_book');
  assert.equal(checks(), 3);
});

for (const operation of ['apply_project_changes', 'import_sources']) {
  test(operation + ' retries only preparation after a delayed event and commits once', async (t) => {
    const { hooks, call, session, folder } = await fixture(t);
    session.book.readOnly = false;
    hooks.changed = () => {};
    let saved = 0;
    const save = session.save.bind(session);
    session.save = async (...args) => { saved++; return save(...args); };
    let imported = 0;
    hooks.import = async (request, paths, base) => {
      imported++;
      const result = await importIntoProject(base, request, paths);
      session.adoptExternal(base);
      session.record(result.book, 'Import sources', false);
      return { imported: result.imported };
    };
    await mkdir(join(folder, 'inbox'));
    await writeFile(join(folder, 'inbox/note.md'), '# Imported note');
    const expectedRevision = (await session.inputs.capture()).revision;
    let events = 0;
    changeDuringMutationPreparation(hooks, session, () => {
      if (++events === 1) session.inputs.invalidate('project.json');
    });
    const checks = countChecks(hooks);
    const args = operation === 'apply_project_changes'
      ? { label: 'Change title', operations: [{ op: 'set_title', title: 'One saved command' }] }
      : { kind: 'markdown', paths: ['inbox/note.md'] };
    const result = await call(operation, { ...args, expectedRevision, idempotencyKey: 'prepared-once' });
    assert.equal(result.committed, true);
    assert.equal(checks(), 2);
    assert.equal(saved, operation === 'apply_project_changes' ? 1 : 0);
    assert.equal(imported, operation === 'import_sources' ? 1 : 0);
    assert.equal(session.receipts.size, 1);
    if (operation === 'apply_project_changes') assert.equal(session.book.project.title, 'One saved command');
    else {
      assert.equal(Object.keys(session.book.project.texts).length, 1);
      assert.equal((await readdir(join(folder, 'texts'))).length, 1);
    }
  });

  test(operation + ' rejects repeated preparation churn without side effects', async (t) => {
    const { hooks, call, session, folder } = await fixture(t);
    session.book.readOnly = false;
    let writes = 0;
    session.save = async () => { writes++; assert.fail('Unstable preparation must not save.'); };
    hooks.import = async () => { writes++; assert.fail('Unstable preparation must not import.'); };
    await mkdir(join(folder, 'inbox'));
    await writeFile(join(folder, 'inbox/note.md'), '# Imported note');
    const expectedRevision = (await session.inputs.capture()).revision;
    changeDuringMutationPreparation(hooks, session, () => session.inputs.invalidate('project.json'));
    const checks = countChecks(hooks);
    const args = operation === 'apply_project_changes'
      ? { label: 'Change title', operations: [{ op: 'set_title', title: 'Must not save' }] }
      : { kind: 'markdown', paths: ['inbox/note.md'] };
    await assert.rejects(call(operation, { ...args, expectedRevision, idempotencyKey: 'unstable-preparation' }),
      (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
    assert.equal(checks(), 2);
    assert.equal(writes, 0);
    assert.equal(session.receipts.size, 0);
    assert.equal(session.book.project.title, 'Context book');
  });
}

test('actual input changes during preparation reject the command without retrying or saving', async (t) => {
  const { hooks, call, session, folder } = await fixture(t);
  session.book.readOnly = false;
  let saved = 0;
  session.save = async () => { saved++; assert.fail('Changed inputs must not be saved.'); };
  const expectedRevision = (await session.inputs.capture()).revision;
  changeDuringMutationPreparation(hooks, session, async () => {
    await writeFile(join(folder, 'template/index.tsx'), 'export default { changed: true };');
    session.inputs.invalidate('template/index.tsx');
  });
  const checks = countChecks(hooks);
  await assert.rejects(call('apply_project_changes', { expectedRevision, idempotencyKey: 'changed-preparation',
    label: 'Change title', operations: [{ op: 'set_title', title: 'Must not save' }] }),
  (error) => error instanceof AuthoringError && error.code === 'REVISION_CONFLICT');
  assert.equal(checks(), 1);
  assert.equal(saved, 0);
  assert.equal(session.receipts.size, 0);
});

test('context reports the installed template API and returns shipped examples on request', async (t) => {
  const { work, call } = await fixture(t);
  await mkdir(join(work, 'examples'));
  await writeFile(join(work, 'examples', 'b-grid.tsx'), '// A grid.\nexport default {};\n');
  await writeFile(join(work, 'examples', 'a-minimal.tsx'), '// The smallest template.\nexport default {};\n');
  await writeFile(join(work, 'examples', 'notes.md'), 'Not an example.');
  const plain = await call('get_authoring_context');
  assert.equal(plain.examples, undefined);
  const api = (plain.capabilities as { templateApi: { contract: number; baseline: string[]; capabilities: string[]; exports: string[] } }).templateApi;
  assert.equal(api.contract, 1);
  assert.ok(api.capabilities.includes('anchors') && api.exports.includes('geometry'));
  // Agents can distinguish guaranteed features from later extensions without writing redundant requires lists.
  assert.ok(['single-pages', 'document-editors', 'editor-context', 'editor-network', 'rendered-images'].every((name) => api.baseline.includes(name)));
  assert.ok(api.baseline.every((name) => api.capabilities.includes(name)));
  // Editing on the page joined the baseline before the first release (ADR 0008).
  assert.ok(api.capabilities.includes('inline-editors') && api.baseline.includes('inline-editors'));
  const withExamples = await call('get_authoring_context', { includeExamples: true });
  assert.deepEqual(withExamples.examples, [
    { name: 'a-minimal', description: 'The smallest template.', source: '// The smallest template.\nexport default {};\n' },
    { name: 'b-grid', description: 'A grid.', source: '// A grid.\nexport default {};\n' },
  ]);
});
