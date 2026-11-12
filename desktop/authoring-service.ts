import { sourcePath, sourceLinked } from '../src/source-locations';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { capabilities as templateCapabilities, runtimeExports } from '../src/runtime-exports';
import type { AuthoringCheckRequest, AuthoringCheckResult } from '../src/authoring-check';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { ImportRequest } from '../src/desktop';
import { applyProjectCommands, ProjectCommandError } from '../src/project-commands';
import { pageSequence } from '../src/format';
import { keptOutside } from '../src/layouts';
import { sourceUsage } from '../src/editing';
import { ProjectRevisionError } from './revisions';
import type { ProjectInputCapture, ProjectInputIndex } from './revisions';
import { loadProject, readProjectDocument, withProjectFiles } from './project';
import type { CheckDraft } from './check';
import type { PreviewRequest } from '../src/preview';
import type { InspectionRequest } from '../src/inspection';
import { photoExtensions } from './photos';
import type { OpenProject } from './project';
import type { ProjectSession } from './project-session';
import { CommittedProjectSaveError } from './persistence';
import { FixtureError, fixtureCases, fixtureLimits, fixtureRequestSchema, planFixtures } from '../src/fixtures';
import type { FixtureCell } from '../src/fixtures';
import type { FixtureCellReport, FixtureReport } from '../src/authoring-check';
import { cellReport, fixtureAssets, fixtureDraft, fixtureFindings, fixtureNotEvaluated } from './fixtures';

// Fixture checks share the bridge's two-minute call deadline with queueing, so they stop starting renders after this.
const fixtureBudgetMs = 60_000;

export class AuthoringError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
type Hooks = {
  session: () => ProjectSession | undefined;
  cache: string;
  docs: string;
  check: (book: OpenProject, request: AuthoringCheckRequest, signal: AbortSignal, index?: ProjectInputIndex, draft?: CheckDraft) => Promise<AuthoringCheckResult>;
  changed: (book: OpenProject) => void;
  recovery: (message: string) => void;
  import: (request: ImportRequest, paths: string[], base: OpenProject) => Promise<{ imported: string[] }>;
};

async function contained(root: string, path: string, allowed: string[]) {
  if (isAbsolute(path) || !allowed.some((prefix) => path.startsWith(prefix + '/'))) {
    throw new AuthoringError('PATH_NOT_ALLOWED', 'Use a relative path inside ' + allowed.join('/ or ') + '/.');
  }
  const actual = await realpath(resolve(root, path));
  const within = relative(root, actual);
  if (within.startsWith('..' + sep) || isAbsolute(within) ||
      !allowed.some((prefix) => within.startsWith(prefix + sep))) {
    throw new AuthoringError('PATH_NOT_ALLOWED', 'The source points outside the allowed project folder.');
  }
  return actual;
}

async function contextInputs(index: ProjectInputIndex, signal: AbortSignal): Promise<{ inputs?: ProjectInputCapture; failure?: string }> {
  try { return { inputs: await index.capture({ signal }) }; }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ProjectRevisionError)) throw error;
    if (error.code === 'source-changed') throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while preparing context. Check again.');
    return { failure: JSON.stringify([error.code, error.path]) };
  }
}

async function contextSource(folder: string, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const actual = await contained(folder, path, ['template', 'texts']);
  if (!['.ts', '.tsx', '.css', '.json', '.md'].includes(extname(actual))) throw new AuthoringError('SOURCE_TYPE_NOT_SUPPORTED', 'Context reads support TS, TSX, CSS, JSON and Markdown files.');
  const observe = async () => {
    const info = await stat(actual, { bigint: true });
    return { stamp: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'), size: info.size, regular: info.isFile() };
  };
  const before = await observe();
  if (!before.regular) throw new AuthoringError('SOURCE_TYPE_NOT_SUPPORTED', 'Context reads require regular source files.');
  if (before.size > 512_000n) throw new AuthoringError('SOURCE_TOO_LARGE', 'Read this source using your workspace tools; it exceeds 512 KB.');
  const bytes = await readFile(actual, { signal });
  if (before.stamp !== (await observe()).stamp || actual !== await contained(folder, path, ['template', 'texts'])) {
    throw new AuthoringError('SOURCE_CHANGED', 'Source ' + path + ' changed while preparing context.');
  }
  return { text: bytes.toString('utf8').slice(0, 32_000), sha256: createHash('sha256').update(bytes).digest('hex'),
    truncated: bytes.length > 32_000, observation: before.stamp };
}

async function contextTemplateFiles(folder: string) {
  const root = join(folder, 'template');
  if (await realpath(root) !== root) throw new AuthoringError('PATH_NOT_ALLOWED', 'The template folder points outside its expected location.');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(folder, join(entry.parentPath, entry.name))).sort().slice(0, 200);
}

function failureIdentity(error: unknown) {
  if (!(error instanceof Error)) return JSON.stringify([typeof error, String(error)]);
  return JSON.stringify([error.name, 'code' in error ? error.code : undefined, error.message]);
}

const settledState = (results: PromiseSettledResult<unknown>[]) => JSON.stringify(results.map((result) => result.status === 'fulfilled'
  ? ['fulfilled', result.value] : ['rejected', failureIdentity(result.reason)]));

function sameDocuments(before: PromiseSettledResult<{ source: Buffer }>[], after: PromiseSettledResult<{ source: Buffer }>[]) {
  return before.every((document, index) => {
    const current = after[index];
    if (document.status === 'fulfilled' && current.status === 'fulfilled') return document.value.source.equals(current.value.source);
    return document.status === 'rejected' && current.status === 'rejected' && failureIdentity(document.reason) === failureIdentity(current.reason);
  });
}

// Complete example templates shipped next to the API reference. The first line of each is its description.
async function templateExamples(reference: string) {
  const folder = join(dirname(reference), 'examples');
  const names = (await readdir(folder)).filter((name) => name.endsWith('.tsx')).sort();
  return Promise.all(names.map(async (name) => {
    const source = await readFile(join(folder, name), 'utf8');
    return { name: basename(name, '.tsx'), description: source.split('\n', 1)[0].replace(/^\/\/\s*/, ''), source };
  }));
}

export function createAuthoringService(hooks: Hooks) {
  let cachedCheck: { session: ProjectSession; inputs: ProjectInputCapture; result: AuthoringCheckResult } | undefined;
  const get = (handle: unknown) => {
    const session = hooks.session();
    if (!session || session.handle !== handle) throw new AuthoringError('PROJECT_CLOSED', 'This project is no longer open. Call list_projects for current handles.');
    return session;
  };
  const checkOnce = async (session: ProjectSession, signal: AbortSignal, request: AuthoringCheckRequest, fresh: boolean, draft?: CheckDraft,
    cacheMode: 'complete' | 'draft-base' = 'complete') => {
    signal.throwIfAborted();
    const before = await contextInputs(session.inputs, signal);
    const matches = cachedCheck?.session === session && before.inputs && cachedCheck.inputs.revision === before.inputs.revision &&
      cachedCheck.inputs.observation === before.inputs.observation;
    if (!matches) cachedCheck = undefined;
    // expectedRevision is checked before reuse. It constrains the inputs without changing a no-preview render.
    const expectedMatches = !request.expectedRevision || request.expectedRevision === before.inputs?.revision;
    // A draft can use cached declarations and defer its requested type check to the subsequent draft render.
    if (!fresh && !draft && !request.preview && !request.inspect && (!request.typescript || cacheMode === 'draft-base') && expectedMatches && cachedCheck) {
      get(session.handle);
      return { result: structuredClone(cachedCheck.result), watcherInvalidated: false };
    }
    if (fresh && !draft) cachedCheck = undefined;
    const result = await hooks.check(session.book, request, signal, session.inputs, draft);
    get(session.handle);
    const after = await contextInputs(session.inputs, signal);
    if (before.failure !== after.failure || before.inputs?.revision !== after.inputs?.revision ||
        before.inputs?.observation !== after.inputs?.observation || result.revision !== (after.inputs?.revision ?? null)) {
      if (before.inputs && after.inputs && before.inputs.revision === after.inputs.revision &&
          before.inputs.metadataObservation === after.inputs.metadataObservation && before.inputs.observation !== after.inputs.observation) {
        return { result, watcherInvalidated: true };
      }
      throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while checking. Check again.');
    }
    // A draft result describes unsaved state and must never answer a later check of the saved book.
    if (result.state === 'ready' && after.inputs && !draft && !request.inspect && !request.typescript) {
      const { image: _image, ...baseline } = result;
      cachedCheck = { session, inputs: after.inputs, result: structuredClone(baseline) };
    }
    return { result, watcherInvalidated: false };
  };
  const checked = async (session: ProjectSession, signal: AbortSignal, request: AuthoringCheckRequest = {}, fresh = false, draft?: CheckDraft,
    cacheMode: 'complete' | 'draft-base' = 'complete') => {
    const first = await checkOnce(session, signal, request, fresh, draft, cacheMode);
    if (!first.watcherInvalidated) return first.result;
    signal.throwIfAborted();
    cachedCheck = undefined;
    const retried = await checkOnce(session, signal, request, true, draft, cacheMode);
    if (retried.watcherInvalidated) throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while checking. Check again.');
    return retried.result;
  };
  const revision = async (session: ProjectSession, expected: unknown, signal: AbortSignal) => {
    const current = await session.inputs.capture({ signal });
    if (current.revision !== expected) throw new AuthoringError('REVISION_CONFLICT', 'Inputs changed. Inspect or check the book again before editing.', { currentRevision: current.revision });
    return current;
  };
  const prepareMutation = async (session: ProjectSession, expected: unknown, signal: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      const inputs = await revision(session, expected, signal);
      const report = await checked(session, signal, { expectedRevision: inputs.revision }, attempt > 0);
      // A saved book that fails to render can still be repaired with the declarations of the template that loaded.
      const template = report.render?.template ?? report.template;
      if (!template) return { report };
      const fresh = await loadProject(session.book.folder, hooks.cache, session.book.readOnly);
      const loaded = await revision(session, expected, signal);
      if (loaded.observation === inputs.observation) return { inputs, report, fresh, template };
      if (attempt === 0 && loaded.revision === inputs.revision && loaded.metadataObservation === inputs.metadataObservation) {
        signal.throwIfAborted();
        cachedCheck = undefined;
        continue;
      }
      throw new AuthoringError('SOURCE_CHANGED', 'Files changed while preparing the command. Check again.');
    }
  };
  // Renders the saved book with an unsaved command batch applied. The batch is planned against the same freshly
  // loaded, revision-verified book that is rendered, with the template declarations of that revision.
  const draftCheck = async (session: ProjectSession, signal: AbortSignal, expectedRevision: string, operations: unknown,
    preview: PreviewRequest | undefined, inspect?: InspectionRequest, typescript?: boolean) => {
    const base = await checked(session, signal, { expectedRevision, ...(typescript ? { typescript } : {}) }, false, undefined, 'draft-base');
    // A draft may repair a saved book whose render fails, as long as its template loaded at this revision.
    const template = base.revision === expectedRevision ? base.render?.template ?? base.template : undefined;
    if (!template) return { ...base, draft: { applied: false, committed: false } };
    const draft: CheckDraft = (book) => {
      let planned;
      try { planned = applyProjectCommands(book, template, operations); }
      catch (error) {
        if (error instanceof ProjectCommandError) throw new AuthoringError(error.code, error.message, { operationIndex: error.operationIndex });
        throw error;
      }
      let drafted;
      try { drafted = withProjectFiles(book, planned.files); }
      catch (error) { throw new AuthoringError('INVALID_OPERATION', error instanceof Error ? error.message : 'The draft is not a valid project.'); }
      let target = preview?.target;
      const resolve = (reference: string) => {
        if (!reference.startsWith('$')) return reference;
        const resolved = planned.references[reference.slice(1)];
        if (!resolved) throw new AuthoringError('REFERENCE_NOT_FOUND', 'The draft defines no batch reference ' + reference + '.');
        return resolved;
      };
      if (target && 'spread' in target) target = { ...target, spread: resolve(target.spread) };
      if (target && 'spreads' in target) target = { ...target, spreads: target.spreads.map(resolve) };
      return {
        book: drafted, preview: preview && target ? { ...preview, target } : undefined,
        inspect: inspect ? { ...inspect, spread: resolve(inspect.spread) } : undefined,
        summary: { applied: true, committed: false, changes: planned.changes, affectedSpreads: planned.affectedSpreads,
          references: planned.references, reflow: planned.reflow },
      };
    };
    const result = await checked(session, signal, { expectedRevision,
      ...(typescript && !base.typecheck ? { typescript } : {}) }, true, draft);
    // Draft commands change project data, never template code. Reuse this request's type results only after
    // the draft check verifies the same revision; changed inputs must discard them just as in checkProject.
    if (base.typecheck && result.revision === base.revision &&
        !result.diagnostics.some(({ code }) => code === 'source-changed' || code === 'revision-conflict')) {
      result.typecheck = base.typecheck;
      result.checks.typescript = base.checks.typescript;
      result.diagnostics.unshift(...base.diagnostics.filter(({ code }) => code.startsWith('typescript-')));
    }
    return result;
  };
  // Renders layouts with synthetic content in fixture books, one per format, from the declarations of the saved
  // revision. The saved book is checked as usual; fixture findings and images are reported separately from it.
  const fixtureCheck = async (session: ProjectSession, signal: AbortSignal, request: unknown, expectedRevision?: string,
    typescript?: boolean) => {
    const started = Date.now();
    const base = await checked(session, signal, { ...(expectedRevision ? { expectedRevision } : {}), ...(typescript ? { typescript } : {}) });
    const template = base.revision && !base.diagnostics.some(({ code }) => code === 'revision-conflict')
      ? base.render?.template ?? base.template : undefined;
    if (!template || !base.revision) return base;
    const parsed = fixtureRequestSchema.safeParse(request);
    if (!parsed.success) throw new AuthoringError('INVALID_FIXTURE_REQUEST', parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('\n'));
    let plan;
    try { plan = planFixtures(template, parsed.data); }
    catch (error) {
      if (error instanceof FixtureError) throw new AuthoringError(error.code, error.message);
      throw error;
    }
    const assets = await fixtureAssets(hooks.cache);
    const reports: FixtureCellReport[] = [];
    const findings: FixtureReport['diagnostics'] = [];
    const skipped = [...plan.skipped];
    const formats: string[] = [];
    let image: AuthoringCheckResult['image'];
    let renders = 0;
    const affordable = () => renders < fixtureLimits.isolationRenders && Date.now() - started < fixtureBudgetMs;
    for (const format of plan.formats) {
      if (!plan.cells.length) break;
      if (Date.now() - started >= fixtureBudgetMs) {
        skipped.push({ format, reason: 'The fixture time budget ran out before this format; check it separately.' });
        continue;
      }
      formats.push(format);
      const preview = plan.preview?.printFormat === format ? plan.preview : undefined;
      const previewRequest = (cells: FixtureCell[]): PreviewRequest | undefined => preview && cells.length ? {
        target: { spreads: cells.map(({ spread }) => spread), columns: preview.columns },
        bounds: preview.bounds, maxEdge: preview.maxEdge, format: preview.format, guides: preview.guides, labels: preview.labels } : undefined;
      const outcome = new Map<string, FixtureCellReport>();
      const unresolved = (cells: FixtureCell[], message: string) => {
        for (const cell of cells) outcome.set(cell.spread, { ...cellReport(cell, format, []), state: 'not-isolated', message });
      };
      // `isolating` is the reason recorded for these fixtures if the budget runs out before an isolation render starts.
      // The budget is checked at every isolation render, so a slow first half cannot carry the second past the deadline.
      const run = async (cells: FixtureCell[], shown?: FixtureCell[], isolating?: string): Promise<void> => {
        if (!cells.length) return;
        signal.throwIfAborted();
        if (isolating !== undefined) {
          if (!affordable()) return unresolved(cells, isolating);
          renders++;
        }
        const result = await checked(session, signal, { expectedRevision: base.revision! }, true,
          fixtureDraft(template, format, cells, assets, previewRequest(shown ?? [])));
        if (result.revision !== base.revision || result.diagnostics.some(({ code }) => code === 'revision-conflict' || code === 'source-changed')) {
          throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while rendering fixtures. Check again.');
        }
        if (result.state === 'ready') {
          const found = fixtureFindings(result.diagnostics, cells, format);
          findings.push(...found);
          for (const cell of cells) outcome.set(cell.spread, cellReport(cell, format, found));
          if (result.image) image = result.image;
          return;
        }
        const failures = fixtureFindings(result.diagnostics.filter(({ code }) => code === 'layout-render-failed'), cells, format);
        if (failures.length) {
          findings.push(...failures);
          const failed = new Map(failures.map((finding) => [finding.fixture.layout + '/' + finding.fixture.case, finding.message]));
          for (const cell of cells) {
            const message = failed.get(cell.layout + '/' + cell.case);
            if (message !== undefined) outcome.set(cell.spread, { ...cellReport(cell, format, failures), state: 'failed', message });
          }
          const rest = cells.filter(({ spread }) => !outcome.has(spread));
          if (!rest.length) return;
          return run(rest, shown?.filter((cell) => rest.includes(cell)), 'Rendered together with a failing fixture; the isolation budget ran out.');
        }
        // The fixture book failed without naming a layout, for example in anchors(): bisect within the budget.
        const message = result.diagnostics[0]?.message ?? 'The fixture book could not be rendered.';
        if (cells.length === 1) {
          outcome.set(cells[0].spread, { ...cellReport(cells[0], format, []), state: 'failed', errors: 1, codes: ['fixture-render-failed'], message });
          findings.push({ code: 'fixture-render-failed', stage: 'render', severity: 'error', message,
            location: { where: 'Fixture · ' + cells[0].label }, fixture: { layout: cells[0].layout, case: cells[0].case, format } });
          return;
        }
        const reason = 'A fixture book containing this fixture failed and the isolation budget ran out: ' + message;
        const half = Math.ceil(cells.length / 2);
        await run(cells.slice(0, half), undefined, reason);
        await run(cells.slice(half), undefined, reason);
      };
      await run(plan.cells, preview?.cells);
      // An image is still useful when isolation removed failing fixtures from the requested sheet.
      const shown = preview?.cells.filter(({ spread }) => ['passed', 'warnings', 'errors'].includes(outcome.get(spread)?.state ?? ''));
      if (preview && !image && shown?.length && Date.now() - started < fixtureBudgetMs) {
        const result = await checked(session, signal, { expectedRevision: base.revision }, true,
          fixtureDraft(template, format, shown, assets, previewRequest(shown)));
        if (result.revision !== base.revision) throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while rendering fixtures. Check again.');
        if (result.state === 'ready' && result.image) image = result.image;
      }
      reports.push(...plan.cells.map((cell) => outcome.get(cell.spread)!));
    }
    const count = (state: FixtureCellReport['state']) => reports.filter((report) => report.state === state).length;
    const report: FixtureReport = {
      synthetic: true, committed: false, revision: base.revision,
      matrix: { layouts: plan.layouts, formats, cases: plan.cases },
      coverage: { planned: reports.length, rendered: reports.length - count('failed') - count('not-isolated'),
        failed: count('failed'), notIsolated: count('not-isolated'), skipped },
      cells: reports, diagnostics: findings.slice(0, fixtureLimits.diagnostics),
      diagnosticsTruncated: findings.length > fixtureLimits.diagnostics, notEvaluated: fixtureNotEvaluated,
    };
    get(session.handle);
    return { ...base, checks: { ...base.checks, fixtures: !reports.length ? 'not-run' as const : count('not-isolated') ? 'failed' as const : 'completed' as const },
      fixtures: report, ...(image ? { image } : {}) };
  };
  return async (name: string, args: Record<string, any>, signal: AbortSignal): Promise<Record<string, unknown>> => {
    if (name === 'list_projects') {
      const session = hooks.session();
      if (!session) return { projects: [] };
      let current: string | null = null;
      try { current = (await session.inputs.capture({ signal })).revision; } catch { signal.throwIfAborted(); }
      return { projects: [{ project: session.handle, title: session.book.project.title, folder: session.book.folder,
        writable: !session.book.readOnly, revision: current, history: session.history }], scope: 'The currently open, authorized book. Handles expire when closed or reopened.' };
    }
    const session = get(args.project);
    if (name === 'check_book') {
      if (args.preview?.target?.page && !args.expectedRevision) throw new AuthoringError('REVISION_REQUIRED', 'Page-number previews require expectedRevision; spread IDs can be used without it.');
      if (args.fixtures) return fixtureCheck(session, signal, args.fixtures, args.expectedRevision, args.typescript);
      if (!args.draft) return checked(session, signal, { expectedRevision: args.expectedRevision, preview: args.preview,
        ...(args.inspect ? { inspect: args.inspect } : {}), ...(args.typescript !== undefined ? { typescript: args.typescript } : {}) }, true);
      return draftCheck(session, signal, args.expectedRevision, args.draft.operations, args.preview, args.inspect, args.typescript);
    }
    if (name === 'inspect_book' && args.view === 'elements') {
      const report = await checked(session, signal, { inspect: { spread: args.spread, box: args.box, element: args.element,
        offset: args.offset, limit: args.limit } });
      return { project: session.handle, revision: report.revision, state: report.state, diagnostics: report.diagnostics,
        checks: report.checks, ...report.render?.inspection };
    }
    if (name === 'get_authoring_context' || name === 'inspect_book') {
      const report = await checked(session, signal);
      const folder = session.book.folder;
      const before = await contextInputs(session.inputs, signal);
      if (report.revision !== (before.inputs?.revision ?? null)) throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while preparing context. Check again.');
      const reportedFailure = report.diagnostics.find(({ code }) => ['source-missing', 'source-outside-project', 'source-unreadable'].includes(code));
      if (before.failure && reportedFailure && before.failure !== JSON.stringify([reportedFailure.code, reportedFailure.location?.path])) {
        throw new AuthoringError('SOURCE_CHANGED', 'Unavailable inputs changed after checking. Check again.');
      }
      const readDocuments = () => Promise.allSettled([
        readProjectDocument(folder, 'project.json'), readProjectDocument(folder, 'photos.json'),
      ]);
      const documents = await readDocuments();
      const project = documents[0].status === 'fulfilled' ? documents[0].value.document : undefined;
      const photos = documents[1].status === 'fulfilled' ? documents[1].value.document : undefined;
      const diagnostics: AuthoringDiagnostic[] = report.diagnostics.map((diagnostic) => ({ ...diagnostic,
        ...(diagnostic.location ? { location: { ...diagnostic.location } } : {}) }));
      function unavailable(error: unknown, path: string) {
        if (error instanceof AuthoringError && error.code === 'SOURCE_CHANGED') throw error;
        const message = error instanceof Error ? error.message : String(error);
        const existing = diagnostics.find((diagnostic) => diagnostic.message === message);
        if (existing) existing.location = { ...existing.location, path };
        else diagnostics.push({ code: 'context-input-unavailable', stage: 'project', severity: 'error', message, location: { path } });
      }
      for (const [index, document] of documents.entries()) {
        if (document.status === 'rejected') unavailable(document.reason, index === 0 ? 'project.json' : 'photos.json');
      }
      const template = report.render?.template ?? report.template;
      let result: Record<string, unknown>;
      let verifySources: (() => Promise<void>) | undefined;
      if (name === 'get_authoring_context') {
        const sources: Record<string, { text: string; sha256: string; truncated: boolean }> = {};
        const requested: string[] = args.includeSource ?? ['template/index.tsx'];
        const readSources = () => Promise.allSettled(requested.map((path) => contextSource(folder, path, signal)));
        const sourceResults = await readSources();
        for (const [index, source] of sourceResults.entries()) {
          if (source.status === 'rejected') unavailable(source.reason, requested[index]);
          else {
            const { observation: _observation, ...content } = source.value;
            sources[requested[index]] = content;
          }
        }
        const files = await Promise.allSettled([contextTemplateFiles(folder)]);
        if (files[0].status === 'rejected') unavailable(files[0].reason, 'template');
        verifySources = async () => {
          if (settledState(sourceResults) !== settledState(await readSources()) ||
              settledState(files) !== settledState(await Promise.allSettled([contextTemplateFiles(folder)]))) {
            throw new AuthoringError('SOURCE_CHANGED', 'Sources changed while preparing context. Check again.');
          }
        };
        result = {
          project: session.handle, revision: report.revision, root: session.book.folder,
          workflow: ['Edit template/ TSX, CSS and assets directly with workspace tools.', 'Edit registered Markdown at its source location; linked Markdown stays outside the package.',
            'Call check_book with a spread preview after edits; images include whole-book text flow.',
            'Preview a new or unused layout before saving it: call check_book with draft.operations (an insert_spread with a ref) and target the preview at its $ref.',
            'Stress-test layouts with check_book fixtures: synthetic long, empty, portrait-photo and malformed-file content per format, with a coverage matrix and a bannered fixture contact sheet.',
            'Use apply_project_changes for project.json/photos.json; never edit these manifests while the app is open.',
            'Copy new content into inbox/ and call import_sources. Then assign returned IDs with a command batch.',
            'To start or extend a template, call get_authoring_context with includeExamples and copy the closest example layout.',
            'Use a layout family when layouts are variants of one design (template.layoutFamilies; family and variant on each layout); pickers should choose by variant tags, not hard-coded IDs. Switch variants with switch_layout and the layout ID.'],
          template, diagnostics, checks: report.checks, sources,
          templateFiles: files[0].status === 'fulfilled' ? files[0].value : [],
          apiReference: await readFile(hooks.docs, 'utf8'),
          ...(args.includeExamples ? { examples: await templateExamples(hooks.docs) } : {}),
          capabilities: { commands: true, dryRun: true, batchReferences: '$alias', sharedUndo: true, preview: ['page', 'spread'],
            maxPreviewEdge: 1600, typescript: true, printPreflight: false, draftPreview: true, contactSheets: true,
            fixtures: { cases: [...fixtureCases], maxLayouts: fixtureLimits.layouts, maxFormats: fixtureLimits.formats,
              maxFixturesPerFormat: fixtureLimits.cellsPerFormat, maxPreviewFixtures: fixtureLimits.previewCells },
            elementInspection: true, detailPreviews: true, maxContactSheetSpreads: 12,
            templateApi: { contract: 1, capabilities: [...templateCapabilities], exports: [...runtimeExports] },
            diagnostics: 'Stable codes with spread/box/element/source locations, measured details and suggested fixes.',
            draftProtection: 'All agent mutations wait until active human editors are closed or blurred.',
            imports: 'Only project/inbox paths. All selected files are validated before import; source files remain available to Undo.',
            idempotency: 'Up to 1000 successful requests for this open-project handle; replay returns the original result. Reopen expires the handle.' },
        };
      } else {
        const offset = args.offset ?? 0, limit = args.limit ?? 30;
        const sequence = template && project && pageSequence(project.spreads.map((spread) => template.spreads[spread.definition]?.span ?? 'spread'), template.format);
        const labels = project?.spreads.map((_, i) => Object.values(sequence?.spreads[i].page ?? {}).join('–')) ?? [];
        const usage = project ? sourceUsage(project, labels, template?.spreads) : { photo: {}, text: {} };
        const view = args.view ?? 'summary';
        const records = view === 'sources' ? [
          ...Object.entries(photos ?? {}).map(([id, source]) => ({ kind: 'photo', id, ...source, usage: usage.photo[id] ?? [] })),
          ...Object.entries(project?.texts ?? {}).map(([id, path]) => ({ kind: 'text', id, path: sourcePath(path), linked: sourceLinked(path), usage: usage.text[id] ?? [] })),
          ...Object.entries(project?.files ?? {}).map(([id, path]) => ({ kind: 'file', id, path: sourcePath(path), linked: sourceLinked(path) })),
        ] : project?.spreads.filter((spread) => !args.spread || spread.id === args.spread).map((spread) => ({ ...spread,
          page: sequence?.spreads[project.spreads.indexOf(spread)].page,
          kept: template ? keptOutside(spread, template.spreads) : [],
          ...(view === 'parameters' && template ? { declarations: template.spreads[spread.definition] } : {}),
        })) ?? [];
        result = { project: session.handle, revision: report.revision, title: project?.title, format: project?.format,
          pages: report.render?.pages, total: records.length, offset, items: records.slice(offset, offset + limit),
          nextOffset: offset + limit < records.length ? offset + limit : null,
          ...(view === 'parameters' ? { document: { values: project?.params, declarations: template?.parameters } } : {}),
          diagnostics, checks: report.checks, history: session.history };
      }
      await verifySources?.();
      const documentsAfter = await readDocuments();
      const after = await contextInputs(session.inputs, signal);
      if (!sameDocuments(documents, documentsAfter) || before.failure !== after.failure ||
          before.inputs?.revision !== after.inputs?.revision || before.inputs?.observation !== after.inputs?.observation) {
        throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while inspecting. Retry for current context.');
      }
      get(session.handle);
      return result;
    }
    if (name !== 'apply_project_changes' && name !== 'import_sources') throw new AuthoringError('UNKNOWN_TOOL', 'Unknown authoring tool.');
    if (session.book.readOnly) throw new AuthoringError('READ_ONLY', 'Create an editable project in ImageFlow first.');
    const request = JSON.stringify({ name, ...args });
    const receipt = session.receipts.get(args.idempotencyKey);
    if (receipt) {
      if (receipt.request !== request) throw new AuthoringError('IDEMPOTENCY_CONFLICT', 'This key was already used for a different request.');
      return { ...receipt.result, replayed: true };
    }
    if (session.receipts.size >= 1000) throw new AuthoringError('SESSION_LIMIT', 'This project session has reached 1000 requests. Reopen the book for a new handle.');
    const commit = async (save: () => Promise<unknown>) => {
      try { return { value: await save() }; }
      catch (error) {
        if (!(error instanceof CommittedProjectSaveError)) throw error;
        const result = { state: 'error', project: session.handle, committed: 'pending', revision: null,
          error: { code: 'SAVE_RECOVERY_REQUIRED', message: error.message } };
        session.receipts.set(args.idempotencyKey, { request, result });
        hooks.recovery(error.message);
        return { recovery: result };
      }
    };
    const { inputs, report, fresh, template } = await prepareMutation(session, args.expectedRevision, signal);
    if (!fresh || !inputs || !template) return { ...report, committed: false };
    signal.throwIfAborted();
    let result: Record<string, unknown>;
    if (name === 'apply_project_changes') {
      let planned;
      try { planned = applyProjectCommands(fresh, template, args.operations); }
      catch (error) {
        if (error instanceof ProjectCommandError) throw new AuthoringError(error.code, error.message, { operationIndex: error.operationIndex });
        throw error;
      }
      result = { state: 'ready', project: session.handle, revision: inputs.revision, changes: planned.changes,
        affectedSpreads: planned.affectedSpreads, references: planned.references, reflow: planned.reflow,
        committed: !args.dryRun, dryRun: !!args.dryRun };
      if (args.dryRun) return result;
      const saved = await commit(() => session.save(planned.files, args.label, fresh));
      if (saved.recovery) return saved.recovery;
    } else {
      const extensions = args.kind === 'photo' ? photoExtensions : new Set(args.kind === 'markdown' ? ['.md'] : args.accept);
      const paths: string[] = [];
      let size = 0;
      for (const path of args.paths as string[]) {
        const source = await contained(fresh.folder, path, ['inbox']);
        if (paths.includes(source)) throw new AuthoringError('DUPLICATE_IMPORT', 'Each import source must appear only once, including paths that resolve to the same file.');
        const info = await stat(source);
        if (!info.isFile() || !extensions.has(extname(source).toLowerCase())) throw new AuthoringError('INVALID_IMPORT', 'Every selected file must match the requested import kind.');
        size += info.size;
        if (size > 100 * 1024 * 1024) throw new AuthoringError('IMPORT_TOO_LARGE', 'Import batches are limited to 100 MB.');
        paths.push(source);
      }
      signal.throwIfAborted();
      let imported: { imported: string[] } | undefined;
      const saved = await commit(async () => { imported = await hooks.import({ kind: args.kind, accept: args.accept }, paths, fresh); });
      if (saved.recovery) return saved.recovery;
      result = { state: 'ready', project: session.handle, committed: true, revision: null,
        sources: imported!.imported.map((id, i) => ({ id, path: args.paths[i], kind: args.kind })) };
    }
    // Commit acknowledgement survives a disconnected client; retries cannot repeat a successful batch.
    result.revision = null;
    session.receipts.set(args.idempotencyKey, { request, result });
    hooks.changed(session.book);
    try { result.revision = (await session.inputs.capture()).revision; }
    catch { result.notice = 'The edit was committed, but files changed before a new revision could be captured. Check the book again.'; }
    result.history = session.history;
    return result;
  };
}
