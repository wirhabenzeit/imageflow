import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import fs, { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkedOutput } from './mcp-output-check';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { AuthoringError, compactDiagnostics, compactRender, createAuthoringService, isReferenceCall } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import { importIntoProject, loadProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import { templateHash } from '../desktop/template-library';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { RenderStatus } from '../src/desktop';
import { mm } from '../src/format';
import { PreviewError } from '../src/preview';
import { docTopics } from '../src/doc-topics';
import './persistence-root';

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
  const docs = join(work, 'docs');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(cache);
  await writeFile(join(folder, 'project.json'), JSON.stringify(project));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'template/index.tsx'), source);
  await cp(resolve('docs/template-api'), join(docs, 'template-api'), { recursive: true });
  await mkdir(join(docs, 'examples'));
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
    service(name, { project: session.handle, view: 'summary', ...extra }, new AbortController().signal).then((result) => checkedOutput(name, result));
  return { work, folder, docs, hooks, session, call };
}

function countChecks(hooks: Parameters<typeof createAuthoringService>[0]) {
  const check = hooks.check;
  let count = 0;
  hooks.check = (...args) => { count++; return check(...args); };
  return () => count;
}

test('context and summary distinguish saved library provenance from the current authored template', async (t) => {
  const { folder, call } = await fixture(t);
  const hash = await templateHash(join(folder, 'template'));
  const saved = { ...project.template, hash };
  await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, template: saved }));
  for (const tool of ['get_authoring_context', 'inspect_book']) {
    const result = await call(tool);
    assert.deepEqual(result.templateIdentity, {
      saved, current: { id: null, version: '1', hash }, matchesSavedHash: true,
    });
  }
  // Generated tooling is outside authored template identity, as it is in the library.
  await mkdir(join(folder, 'template/.imageflow-sdk'));
  await writeFile(join(folder, 'template/.imageflow-sdk/index.d.ts'), '// generated');
  for (const tool of ['get_authoring_context', 'inspect_book']) {
    assert.equal(((await call(tool)).templateIdentity as { matchesSavedHash: boolean }).matchesSavedHash, true);
  }
  // A source edit does not rewrite provenance, even before the app's loaded book has refreshed.
  await writeFile(join(folder, 'template/index.tsx'), 'export default { edited: true };');
  const editedHash = await templateHash(join(folder, 'template'));
  assert.notEqual(editedHash, hash);
  for (const tool of ['get_authoring_context', 'inspect_book']) {
    const { note, ...identity } = (await call(tool)).templateIdentity as { note?: string };
    assert.deepEqual(identity, {
      saved, current: { id: null, version: '1', hash: editedHash }, matchesSavedHash: false,
    });
    // A mismatch says what it means and that nothing updates the saved hash (API-004).
    assert.match(note ?? '', /renders and exports its own copy, and nothing updates saved\.hash/);
  }
});

test('a fork names the template it was copied from and opens in a book made from that template (API-003)', async (t) => {
  const { folder, hooks, call, session } = await fixture(t);
  const hash = await templateHash(join(folder, 'template'));
  await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, template: { ...project.template, hash: '0'.repeat(64) } }));
  const forked = { ...status, template: { ...status.template, id: 'field-book', basedOn: { id: 'test', version: '1' } } };
  hooks.check = (book, request, signal, index) => checkProject(book, hooks.cache, request, async () => ({ status: forked }), signal, index);
  const identity = (await call('get_authoring_context')).templateIdentity as Record<string, any>;
  assert.deepEqual(identity.current, { id: 'field-book', version: '1', hash, basedOn: { id: 'test', version: '1' } });
  assert.equal(identity.matchesSavedHash, false);
  assert.doesNotMatch(identity.note, /give it an id of its own/);
  // The same edits without basedOn suggest it.
  session.inputs.invalidate('template/index.tsx');
  hooks.check = (book, request, signal, index) => checkProject(book, hooks.cache, request,
    async () => ({ status: { ...status, template: { ...status.template, id: 'test' } } }), signal, index);
  assert.match(((await call('get_authoring_context')).templateIdentity as { note: string }).note, /give it an id of its own and name the original as basedOn/);
});

test('books without saved provenance do not claim an unchanged library template', async (t) => {
  const { folder, call } = await fixture(t);
  for (const tool of ['get_authoring_context', 'inspect_book']) {
    assert.deepEqual((await call(tool)).templateIdentity, {
      saved: project.template, current: { id: null, version: '1', hash: await templateHash(join(folder, 'template')) },
      matchesSavedHash: null,
    });
  }
});

test('saved identity is distinct from declarations in the currently checked template', async (t) => {
  const { hooks, call } = await fixture(t);
  hooks.check = (book, request, signal, index) => checkProject(book, book.cache, request, async () => ({
    status: { ...status, template: { ...status.template, id: 'test', version: '2', label: 'Edited template' } },
  }), signal, index);
  const result = await call('get_authoring_context');
  const identity = result.templateIdentity as { saved: typeof project.template; current: { id: string; version: string } };
  assert.deepEqual(identity.saved, project.template);
  assert.equal(identity.current.id, 'test');
  assert.equal(identity.current.version, '2');
});

test('context verifies the whole template hash even without source reads or a complete revision', async (t) => {
  const { folder, docs, hooks, call } = await fixture(t);
  await rm(join(folder, 'photos.json'));
  await writeFile(join(folder, 'template/artwork.svg'), '<svg/>');
  Object.defineProperty(hooks, 'docs', { get: () => {
    writeFileSync(join(folder, 'template/artwork.svg'), '<svg><path/></svg>');
    return docs;
  } });
  await assert.rejects(call('get_authoring_context', { includeSource: [] }),
    (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
});

test('paginated inspections and context reuse the template hash without rereading large assets', async (t) => {
  const { folder, call } = await fixture(t);
  const asset = join(folder, 'template/artwork.bin');
  await writeFile(asset, Buffer.alloc(2 * 1024 * 1024, 1));
  const original = readFile;
  let reads = 0;
  const patched = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
    if (args[0] === asset) reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const first = await call('inspect_book', { view: 'spreads', limit: 1 });
    assert.ok(reads > 0, 'The initial hash reads the asset');
    const initialReads = reads;
    await call('inspect_book', { view: 'spreads', offset: 1, limit: 1 });
    const context = await call('get_authoring_context');
    assert.deepEqual(context.templateIdentity, first.templateIdentity);
    assert.equal(reads, initialReads, 'Unchanged requests only reconcile metadata');
    await writeFile(asset, Buffer.alloc(2 * 1024 * 1024, 2));
    const changed = await call('inspect_book');
    assert.notDeepEqual(changed.templateIdentity, first.templateIdentity);
    assert.ok(reads > initialReads, 'Changed assets are rehashed');
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cached template hashes include library files omitted from project revisions', async (t) => {
  const { folder, call } = await fixture(t);
  const directory = join(folder, 'template/artwork.tmp');
  await mkdir(directory);
  const first = await call('inspect_book');
  // Revision capture ignores this directory, but it is part of library identity, even when initially empty.
  const path = join(directory, 'image.svg');
  await writeFile(path, '<svg/>');
  const added = await call('inspect_book');
  assert.equal(added.revision, first.revision);
  assert.notDeepEqual(added.templateIdentity, first.templateIdentity);
  await writeFile(path, '<svg><path/></svg>');
  const edited = await call('inspect_book');
  assert.equal(edited.revision, first.revision);
  assert.notDeepEqual(edited.templateIdentity, added.templateIdentity);
});

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
      const result = await call(tool, tool === 'get_authoring_context' ? { includeSource: ['template/index.tsx'], includeTemplate: true } : {});
      const diagnostics = result.diagnostics as AuthoringDiagnostic[];
      assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes('invalid JSON') && diagnostic.location?.path === name));
      assert.match(String(result.revision), /^[a-f0-9]{64}$/);
      if (tool === 'get_authoring_context') {
        assert.equal((result.sources as Record<string, { text: string }>)['template/index.tsx'].text, source);
        assert.deepEqual((result.topics as { id: string }[]).map(({ id }) => id), docTopics.map(({ id }) => id));
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
    const result = await call(tool, tool === 'get_authoring_context' ? { includeSource: ['template/index.tsx'], includeTemplate: true } : { view: 'spreads' });
    assert.ok((result.diagnostics as AuthoringDiagnostic[]).some(({ code }) => code === 'template-compile-error'));
    assert.equal(result.template, undefined);
    assert.deepEqual(result.templateIdentity, {
      saved: project.template, current: { id: null, version: null, hash: await templateHash(join(folder, 'template')) },
      matchesSavedHash: null,
    });
    if (tool === 'get_authoring_context') {
      assert.equal((result.sources as Record<string, { text: string }>)['template/index.tsx'].text, broken);
      assert.deepEqual((result.topics as { id: string }[]).map(({ id }) => id), docTopics.map(({ id }) => id));
    } else {
      assert.equal(result.title, 'Context book');
      assert.deepEqual((result.items as { boxes: unknown }[])[0].boxes, {});
      const summary = await call(tool, { view: 'summary' });
      assert.equal(summary.items, undefined, 'the summary counts the spreads without listing them (F-017 follow-up)');
      assert.equal(summary.total, (result.items as unknown[]).length);
    }
  });

  test(tool + ' rejects files that keep changing after checking and before inspection', async (t) => {
    const { folder, hooks, call } = await fixture(t);
    const check = hooks.check;
    let checks = 0;
    hooks.check = async (...args) => {
      const report = await check(...args);
      checks++;
      if (checks % 2) await rm(join(folder, 'photos.json'));
      else await writeFile(join(folder, 'photos.json'), '{}');
      return report;
    };
    await assert.rejects(call(tool), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED' &&
      (error.details as { attempts?: number }).attempts === 4);
  });

  test(tool + ' retries a file changed once after checking and reports the inputs as they are now', async (t) => {
    const { folder, hooks, call } = await fixture(t);
    const check = hooks.check;
    let checks = 0;
    hooks.check = async (...args) => {
      const report = await check(...args);
      if (!checks++) await rm(join(folder, 'photos.json'));
      return report;
    };
    const result = await call(tool);
    assert.ok(checks >= 2);
    assert.ok((result.diagnostics as AuthoringDiagnostic[]).some((diagnostic) => diagnostic.location?.path === 'photos.json'));
  });

  test(tool + ' rejects unavailable inputs that keep changing after checking', async (t) => {
    const { folder, hooks, call } = await fixture(t);
    await rm(join(folder, 'project.json'));
    const check = hooks.check;
    let checks = 0;
    hooks.check = async (...args) => {
      const report = await check(...args);
      const [missing, restored] = checks++ % 2 ? ['project.json', 'photos.json'] : ['photos.json', 'project.json'];
      await writeFile(join(folder, restored), restored === 'project.json' ? JSON.stringify(project) : '{}');
      await rm(join(folder, missing));
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
  assert.deepEqual((result.topics as { id: string }[]).map(({ id }) => id), docTopics.map(({ id }) => id));
});

test('a template directory outside the project cannot expose its source or filenames', async (t) => {
  const { work, folder, call } = await fixture(t);
  await rm(join(folder, 'template'), { recursive: true });
  const outside = join(work, 'private-template');
  await mkdir(outside);
  await writeFile(join(outside, 'index.tsx'), 'PRIVATE_SOURCE_MUST_STAY_OUTSIDE');
  await writeFile(join(outside, 'PRIVATE_FILENAME_MUST_STAY_OUTSIDE.tsx'), 'private');
  await symlink(outside, join(folder, 'template'));
  const result = await call('get_authoring_context', { includeSource: ['template/index.tsx'], includeTemplate: true });
  assert.equal(result.revision, null);
  assert.deepEqual(result.sources, {});
  assert.deepEqual(result.templateFiles, []);
  assert.deepEqual(result.templateIdentity, {
    saved: project.template, current: { id: null, version: null, hash: null }, matchesSavedHash: null,
  });
  assert.equal(JSON.stringify(result).includes('PRIVATE_SOURCE_MUST_STAY_OUTSIDE'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_FILENAME_MUST_STAY_OUTSIDE'), false);
  assert.deepEqual((result.topics as { id: string }[]).map(({ id }) => id), docTopics.map(({ id }) => id));
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
  let edits = 0;
  Object.defineProperty(hooks, 'docs', { get: () => {
    writeFileSync(join(folder, 'project.json'), JSON.stringify({ ...project, title: 'Changed during inspection ' + ++edits }));
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
  session.save = async () => assert.fail('A conflicting revision must not save.');
  await assert.rejects(call('apply_project_changes', { expectedRevision: '0'.repeat(64), idempotencyKey: 'conflict',
    label: 'Change title', operations: [{ op: 'set_title', title: 'Changed' }] }),
  (error) => error instanceof AuthoringError && error.code === 'REVISION_CONFLICT');
  assert.equal(checks(), 1);
});

test('a dry run against a revision that has since changed is planned at the current revision', async (t) => {
  const { call, session } = await fixture(t);
  session.book.readOnly = false;
  session.save = async () => assert.fail('A dry run must not save.');
  const current = (await session.inputs.capture()).revision;
  const result = await call('apply_project_changes', { expectedRevision: '0'.repeat(64), idempotencyKey: 'moved',
    label: 'Change title', dryRun: true, operations: [{ op: 'set_title', title: 'Changed' }] });
  assert.equal(result.committed, false);
  assert.equal(result.revision, current);
  assert.deepEqual(result.revisionMoved, { expectedRevision: '0'.repeat(64), revision: current });
  assert.match(result.notice as string, /planned at the current revision/);
  assert.equal(session.receipts.size, 0);
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

test('continued watcher churn is rejected after four calls of two full attempts, naming what changed', async (t) => {
  const { hooks, call, session } = await fixture(t);
  const check = hooks.check;
  let attempts = 0;
  hooks.check = async (...args) => {
    const result = await check(...args);
    attempts++;
    session.inputs.invalidate('template/index.tsx');
    return result;
  };
  await assert.rejects(call('check_book'), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED' &&
    /template\/index\.tsx/.test(error.message) && (error.details as { changedInputs?: string[] }).changedInputs?.[0] === 'template/index.tsx');
  assert.equal(attempts, 8);
});

test('a check that saw a text change while the user edits is repeated once the book is quiet', async (t) => {
  const { hooks, call, session } = await fixture(t);
  const check = hooks.check;
  let attempts = 0;
  hooks.check = async (...args) => {
    const result = await check(...args);
    if (++attempts <= 3) session.inputs.invalidate('texts/one.md');
    return result;
  };
  const result = await call('check_book');
  assert.equal(result.state, 'ready');
  assert.equal(attempts, 4);
});

test('calls stand while the user saves the book during every check, and say which revision they are of (API-007)', async (t) => {
  const { folder, hooks, call, session } = await fixture(t);
  const check = hooks.check;
  let saves = 0, checks = 0;
  // The app saves project.json during the render, as while the user drags photos.
  hooks.check = (book, request, signal, index, draft) => {
    checks++;
    return checkProject(book, hooks.cache, request, async () => {
      await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, title: 'Saved ' + ++saves }));
      session.inputs.invalidate('project.json');
      return { status };
    }, signal, index, undefined, draft);
  };
  const before = (await session.inputs.capture()).revision;
  const checked = await call('check_book');
  assert.equal(checks, 1, 'nothing is checked again');
  assert.equal(checked.revision, before);
  assert.deepEqual(checked.superseded, { revision: (await session.inputs.capture()).revision });
  // Reads are of the book as it is now, with the report of the revision that was checked.
  for (const name of ['inspect_book', 'get_authoring_context']) {
    const was = (await session.inputs.capture()).revision;
    const read = await call(name);
    const now = (await session.inputs.capture()).revision;
    assert.notEqual(now, was);
    assert.equal(read.revision, now);
    assert.equal(read.checkedRevision, was);
    if (name === 'inspect_book') { assert.equal(read.title, 'Saved ' + saves); assert.equal(read.pages, 2); }
  }
  assert.equal(checks, 3);
  // A superseded check answers no later one, and a commit still needs the revision of now.
  hooks.check = check;
  assert.equal((await call('check_book')).superseded, undefined);
  session.book.readOnly = false;
  await assert.rejects(call('apply_project_changes', { label: 'Old', operations: [{ op: 'set_title', title: 'Must not save' }], expectedRevision: before, idempotencyKey: 'old' }),
    (error) => error instanceof AuthoringError && error.code === 'REVISION_CONFLICT');
});

test('a read of a book whose format was changed during its check is checked again in that format (API-007)', async (t) => {
  const { folder, hooks, call, session } = await fixture(t);
  const save = (format?: string) => writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, format }));
  // The second is the Undo of a first choice: the book is back in the template's own format.
  for (const [from, to] of [['small', 'large'], ['large', undefined]]) for (const name of ['inspect_book', 'get_authoring_context']) {
    await save(from);
    session.inputs.invalidate('project.json');
    let checks = 0;
    hooks.check = (book, request, signal, index, draft) => checkProject(book, hooks.cache, request, async (snapshot) => {
      const formatId = snapshot.project.format ?? 'small';
      if (!checks++) { await save(to); session.inputs.invalidate('project.json'); }
      return { status: { ...status, template: { ...status.template, formatId, formats: { small: 'Small', large: 'Large' } } } };
    }, signal, index, undefined, draft);
    const read = await call(name);
    assert.equal(checks, 2);
    assert.equal(read.checkedRevision, undefined);
    assert.equal(read.revision, (await session.inputs.capture()).revision);
    if (name === 'inspect_book') assert.equal(read.format, to);
    else assert.equal((read.template as { formatId: string }).formatId, to ?? 'small');
  }
});

test('a template edit while the book is saved still rejects the check', async (t) => {
  const { folder, hooks, call } = await fixture(t);
  let edits = 0;
  hooks.check = (book, request, signal, index, draft) => checkProject(book, hooks.cache, request, async () => {
    await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, title: 'Saved ' + ++edits }));
    await writeFile(join(folder, 'template/index.tsx'), source + '\n// ' + edits);
    return { status };
  }, signal, index, undefined, draft);
  await assert.rejects(call('check_book'), (error) => error instanceof AuthoringError && error.code === 'SOURCE_CHANGED');
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
    // Each of the four attempts checks twice: once before the reload and once after it.
    assert.equal(checks(), 8);
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
  await writeFile(join(work, 'docs/examples', 'b-grid.tsx'), '// A grid.\nexport default {};\n');
  await writeFile(join(work, 'docs/examples', 'a-minimal.tsx'), '// The smallest template.\nexport default {};\n');
  await writeFile(join(work, 'docs/examples', 'notes.md'), 'Not an example.');
  const plain = await call('get_authoring_context');
  // Examples are always listed; only requested ones carry their source.
  assert.deepEqual(plain.examples, [{ name: 'a-minimal', description: 'The smallest template.' }, { name: 'b-grid', description: 'A grid.' }]);
  const api = (plain.capabilities as { templateApi: { contract: number; baseline: string[]; capabilities: string[]; exports: string[] } }).templateApi;
  assert.equal(api.contract, 1);
  assert.ok(api.capabilities.includes('anchors') && api.exports.includes('geometry'));
  // Agents can distinguish guaranteed features from later extensions without writing redundant requires lists.
  assert.ok(['single-pages', 'page-layouts', 'document-editors', 'editor-context', 'editor-network', 'rendered-images'].every((name) => api.baseline.includes(name)));
  assert.ok(api.baseline.every((name) => api.capabilities.includes(name)));
  // Editing on the page joined the baseline before the first release (ADR 0008).
  assert.ok(api.capabilities.includes('inline-editors') && api.baseline.includes('inline-editors'));
  assert.ok(api.capabilities.includes('inline-text') && api.baseline.includes('inline-text'));
  const withExamples = await call('get_authoring_context', { includeExamples: true });
  assert.deepEqual(withExamples.examples, [
    { name: 'a-minimal', description: 'The smallest template.', source: '// The smallest template.\nexport default {};\n' },
    { name: 'b-grid', description: 'A grid.', source: '// A grid.\nexport default {};\n' },
  ]);
  const one = await call('get_authoring_context', { includeExamples: ['b-grid'] });
  assert.deepEqual(one.examples, [{ name: 'b-grid', description: 'A grid.', source: '// A grid.\nexport default {};\n' }]);
  const listed = await call('get_authoring_context', { includeExamples: ['b-grid'], includeTemplate: true });
  assert.deepEqual(listed.examples, [
    { name: 'a-minimal', description: 'The smallest template.' },
    { name: 'b-grid', description: 'A grid.', source: '// A grid.\nexport default {};\n' },
  ]);
  await assert.rejects(call('get_authoring_context', { includeExamples: ['missing'] }),
    (error) => error instanceof AuthoringError && error.code === 'EXAMPLE_NOT_FOUND' && error.message.includes('a-minimal, b-grid'));
});

test('a call for topics, examples or sources returns just those unless includeTemplate is true (API-001)', async (t) => {
  const { call, hooks } = await fixture(t);
  hooks.docs = resolve('docs');
  const full = await call('get_authoring_context');
  const requested = await call('get_authoring_context', { docs: ['authoring-workflow'], includeSource: ['template/index.tsx'] });
  for (const field of ['template', 'templateFiles', 'topics', 'capabilities']) {
    assert.ok(field in full, field + ' is in the full context');
    assert.equal(field in requested, false, field + ' is left out of a call for topics');
  }
  assert.deepEqual(requested.examples, []);
  assert.equal(requested.revision, full.revision);
  assert.deepEqual(requested.templateIdentity, full.templateIdentity);
  assert.equal((requested.sources as Record<string, { text: string }>)['template/index.tsx'].text, source);
  const docs = JSON.stringify(requested.docs).length;
  assert.ok(JSON.stringify(requested).length < docs + 2_000, 'a call for one topic adds little beyond the topic');
  const both = await call('get_authoring_context', { docs: ['authoring-workflow'], includeTemplate: true });
  assert.deepEqual(both.template, full.template);
  assert.deepEqual(both.topics, full.topics);
});

test('a call for topics or examples alone does not look at the book (API-009)', async (t) => {
  const { call, hooks, session } = await fixture(t);
  hooks.docs = resolve('docs');
  hooks.check = async () => assert.fail('A call for topics must not check the book.');
  session.inputs.capture = async () => assert.fail('A call for topics must not read the book.');
  const requested = await call('get_authoring_context', { docs: ['authoring-workflow'], includeExamples: ['minimal'] });
  assert.deepEqual(Object.keys(requested).sort(), ['docs', 'examples', 'guide', 'project', 'root']);
  assert.deepEqual((requested.examples as { name: string }[]).map(({ name }) => name), ['minimal']);
  await assert.rejects(call('get_authoring_context', { docs: ['authoring-workflow'], project: 'closed' }),
    (error) => error instanceof AuthoringError && error.code === 'PROJECT_CLOSED');
  assert.equal(isReferenceCall('get_authoring_context', {}), false);
  assert.equal(isReferenceCall('get_authoring_context', { docs: [] }), false);
  assert.equal(isReferenceCall('get_authoring_context', { docs: ['authoring-workflow'], includeSource: ['template/index.tsx'] }), false);
  assert.equal(isReferenceCall('get_authoring_context', { docs: ['authoring-workflow'], includeTemplate: true }), false);
  assert.equal(isReferenceCall('inspect_book', { docs: ['authoring-workflow'] }), false);
});

test('context lists reference topics and returns only the requested ones', async (t) => {
  const { call } = await fixture(t);
  const plain = await call('get_authoring_context');
  assert.equal(plain.docs, undefined);
  assert.equal(plain.apiReference, undefined);
  assert.equal(plain.workflow, undefined);
  const topics = plain.topics as { id: string; title: string; summary: string; bytes: number }[];
  assert.deepEqual(topics.map(({ id, title, summary }) => ({ id, title, summary })), docTopics);
  for (const topic of topics) {
    assert.equal(topic.bytes, (await stat(resolve('docs/template-api', topic.id + '.md'))).size);
  }
  const requested = await call('get_authoring_context', { docs: ['list-parameters', 'authoring-workflow'] });
  assert.deepEqual(Object.keys(requested.docs as object), ['list-parameters', 'authoring-workflow']);
  assert.equal((requested.docs as Record<string, string>)['list-parameters'], await readFile(resolve('docs/template-api/list-parameters.md'), 'utf8'));
  await assert.rejects(call('get_authoring_context', { docs: ['nope'] }),
    (error) => error instanceof AuthoringError && error.code === 'DOC_NOT_FOUND' && error.message.includes('authoring-workflow'));
});

test('context returns no source by default and lists generated template folders and fonts once', async (t) => {
  const { folder, call } = await fixture(t);
  await mkdir(join(folder, 'template/vendor/modules'), { recursive: true });
  await writeFile(join(folder, 'template/vendor/manifest.json'), '{}');
  await writeFile(join(folder, 'template/vendor/modules/m0.js'), '');
  await mkdir(join(folder, 'template/.imageflow-sdk'));
  await writeFile(join(folder, 'template/.imageflow-sdk/index.d.ts'), '');
  await mkdir(join(folder, 'template/fonts'));
  await writeFile(join(folder, 'template/fonts/a-400.woff2'), '');
  await writeFile(join(folder, 'template/fonts/a-OFL.txt'), '');
  const result = await call('get_authoring_context');
  assert.deepEqual(result.sources, {});
  assert.deepEqual(result.templateFiles, ['template/.imageflow-sdk/', 'template/fonts/', 'template/index.tsx', 'template/vendor/']);
  const read = await call('get_authoring_context', { includeSource: ['template/index.tsx'] });
  assert.equal((read.sources as Record<string, { text: string }>)['template/index.tsx'].text, source);
});

// The context lists the reference instead of embedding it. Everything except the book's own declarations, sources and
// diagnostics stays within this budget, so the starter book's context stays near 8k tokens (scripts/smoke-mcp-context.mjs).
test('context outside the book declarations stays within its size budget', async (t) => {
  const { hooks, call } = await fixture(t);
  hooks.docs = resolve('docs');
  const { template: _template, sources: _sources, diagnostics: _diagnostics, ...rest } = await call('get_authoring_context');
  const bytes = JSON.stringify(rest).length;
  assert.ok(bytes <= 12_000, 'Context without declarations uses ' + bytes + ' bytes.');
  assert.ok((rest.examples as { source?: string }[]).length >= 6 && (rest.examples as { source?: string }[]).every(({ source }) => source === undefined));
});

test('parameter inspection reports each visible page declaration instead of hidden spread declarations', async (t) => {
  const { folder, hooks } = await fixture(t);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ ...project, schemaVersion: 2,
    spreads: [{ id: 'one', definition: 'main', split: true, pages: {
      left: { definition: 'photo', params: { title: 'Left' } }, right: { params: {} },
    } }],
  }));
  const pageStatus = structuredClone(status);
  pageStatus.template.spreads.photo = { label: 'Photo page', span: 'page', parameters: {}, boxes: {}, elements: {} };
  hooks.check = (book, request, signal, index) => checkProject(book, hooks.cache, request, async () => ({ status: pageStatus }), signal, index);
  const session = hooks.session()!;
  const service = createAuthoringService(hooks);
  const result = await service('inspect_book', { project: session.handle, view: 'parameters' }, new AbortController().signal);
  const item = (result.items as Record<string, unknown>[])[0];
  assert.equal(item.declarations, undefined);
  assert.deepEqual(item.pageDeclarations, { left: pageStatus.template.spreads.photo, right: null });
});

test('checks omit repeated template declarations unless requested and retain them in authoring context', async (t) => {
  const { call } = await fixture(t);
  const compact = await call('check_book');
  assert.equal(compact.template, undefined);
  assert.equal((compact.render as Record<string, unknown>).template, undefined);
  const full = await call('check_book', { includeTemplate: true });
  assert.deepEqual((full.render as Record<string, unknown>).template, status.template);
  assert.deepEqual((await call('get_authoring_context')).template, status.template);
});

test('check replies count the book-wide render lists and list only the addressed spreads unless included (API-005)', () => {
  const render: Extract<RenderStatus, { state: 'ready' }> = { ...status,
    units: [{ side: 'left', spread: 'one', where: 'Page 1' }, { side: 'right', spread: 'two', where: 'Page 2' }],
    errors: [{ message: 'Repeated in diagnostics' }],
    flow: { 'one:body': { part: 1, parts: 2 }, 'two:body': { part: 2, parts: 2 }, 'two:left:body': { part: 1, parts: 1 } },
    anchors: [{ id: 'a', spread: 'one', page: 1, side: 'left' }, { id: 'b', spread: 'two', page: 2, side: 'right' }] };
  const overview = compactRender(render, {}, {});
  assert.deepEqual(overview.counts, { units: 2, flow: 3, anchors: 2 });
  assert.equal('units' in overview || 'flow' in overview || 'anchors' in overview || 'errors' in overview || 'template' in overview, false);
  const previewed = compactRender(render, { image: { spread: 'two' } }, {});
  assert.deepEqual(previewed.units, [render.units[1]]);
  assert.deepEqual(previewed.flow, { 'two:body': render.flow['two:body'], 'two:left:body': render.flow['two:left:body'] });
  assert.deepEqual(previewed.anchors, [render.anchors[1]]);
  const drafted = compactRender(render, { draft: { affectedSpreads: ['one'] } }, { inspect: { spread: '$new' } });
  assert.deepEqual(drafted.units, [render.units[0]]);
  const everywhere = compactRender(render, { draft: { affectedSpreads: ['one', 'two'] } }, {});
  assert.equal('units' in everywhere || 'flow' in everywhere || 'anchors' in everywhere, false, 'a document setting lists no spreads');
  assert.deepEqual(compactRender(render, { image: { spread: 'two' }, draft: { affectedSpreads: ['one', 'two'] } }, {}).units, [render.units[1]]);
  const included = compactRender(render, { image: { spread: 'two' } }, { include: ['anchors'] });
  assert.deepEqual(included.anchors, render.anchors);
  assert.deepEqual(included.units, [render.units[1]]);
});

test('a finding in many places names the first few and counts them, unless all are asked for (API-014)', async (t) => {
  const { hooks, call } = await fixture(t);
  const errors = Array.from({ length: 32 }, (_, n) => ({ message: 'Original unavailable', code: 'source-unavailable', spread: 'one', where: 'Pages 1–2', box: 'b' + n, source: 'p' + n,
    sourceKind: 'photo' as const, problem: 'Offline', away: 'catalog' as const }));
  hooks.check = (book, request, signal, index) => checkProject(book, hooks.cache, request, async () => ({ status: { ...status, errors } }), signal, index);
  for (const name of ['check_book', 'inspect_book', 'get_authoring_context']) {
    const [finding, ...rest] = (await call(name)).diagnostics as AuthoringDiagnostic[];
    assert.deepEqual(rest, []);
    assert.equal(finding.severity, 'warning');
    assert.deepEqual(finding.details, { reason: 'catalog', originals: 32, placed: 32, places: 32 });
    assert.deepEqual(finding.occurrences!.map(({ box }) => box), ['b0', 'b1', 'b2']);
  }
  const [all] = (await call('check_book', { include: ['occurrences'] })).diagnostics as AuthoringDiagnostic[];
  assert.equal(all.occurrences!.length, 32);
  assert.deepEqual(compactDiagnostics([{ ...all, occurrences: all.occurrences!.slice(0, 3) }])[0].details, all.details, 'three places are all of them');
});

test('inspection reports a split sheet\'s merge layout as restoreDefinition and lists sources by kind (F-017)', async (t) => {
  const { folder, session, call } = await fixture(t);
  const manifest = { ...project, texts: { a: 'texts/a.md', b: 'texts/b.md' }, files: { route: 'files/route.gpx' },
    spreads: [{ id: 'one', definition: 'main' }, { id: 'two', definition: 'main', split: true, pages: { left: { definition: 'main' } } }] };
  await mkdir(join(folder, 'texts')); await mkdir(join(folder, 'files'));
  await Promise.all([writeFile(join(folder, 'texts/a.md'), 'A'), writeFile(join(folder, 'texts/b.md'), 'B'), writeFile(join(folder, 'files/route.gpx'), '<gpx/>'),
    writeFile(join(folder, 'project.json'), JSON.stringify(manifest))]);
  session.adoptExternal(await loadProject(folder, join(folder, '..', 'cache'), true));
  const spreads = (await call('inspect_book', { view: 'spreads' })).items as Record<string, unknown>[];
  assert.equal(spreads[0].definition, 'main');
  assert.equal(spreads[0].restoreDefinition, undefined);
  assert.equal(spreads[1].definition, undefined, 'a split sheet does not report its merge layout as shown');
  assert.equal(spreads[1].restoreDefinition, 'main');
  const texts = await call('inspect_book', { view: 'sources', kind: 'text' });
  assert.deepEqual(texts.counts, { photo: 0, text: 2, file: 1 });
  assert.deepEqual((texts.items as { kind: string }[]).map(({ kind }) => kind), ['text', 'text']);
  assert.equal(texts.total, 2);
});
