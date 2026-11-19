import { authoringSnapshotState } from './authoring-sdk';
import { layoutFootprint } from '../src/layouts';
import { sourcePath, sourceLinked } from '../src/source-locations';
import { DependencyInstallError } from './dependency-install';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { capabilities as templateCapabilities, contract1Capabilities, runtimeExports } from '../src/runtime-exports';
import type { AuthoringCheckRequest, AuthoringCheckResult } from '../src/authoring-check';
import { checksCover } from '../src/authoring-check';
import { coverLayoutsFor, resolveCover } from '../src/cover';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { ActiveBookEditor, ImportRequest } from '../src/desktop';
import { applyProjectCommands, ProjectCommandError } from '../src/project-commands';
import { pageLabel, pageSequence } from '../src/format';
import { keptOutside } from '../src/layouts';
import { sourceUsage } from '../src/editing';
import { ProjectRevisionError } from './revisions';
import type { ProjectInputCapture, ProjectInputIndex } from './revisions';
import { loadProject, readProjectDocument, withProjectFiles } from './project';
import type { CheckDraft } from './check';
import type { PreviewRequest } from '../src/preview';
import type { InspectionRequest } from '../src/inspection';
import { photoExtensions } from './photos';
import { captureFields } from '../src/photo-metadata';
import type { CaptureMetadata } from '../src/photo-metadata';

const captureOf = (photo: CaptureMetadata | undefined) =>
  Object.fromEntries(captureFields.flatMap((field) => photo?.[field] ? [[field, photo[field]]] : [])) as CaptureMetadata;
import type { OpenProject } from './project';
import type { ProjectSession } from './project-session';
import { changedBetween, CommittedProjectSaveError, readSaveLedger } from './persistence';
import type { CheckpointRecord, SaveCheckpoint } from './persistence';
import type { McpClientSession } from './mcp-connection';
import { coverFixturePlan, FixtureError, fixtureCases, fixtureFits, fixtureLimits, fixtureRequestSchema, planFixtures } from '../src/fixtures';
import type { FixtureCell } from '../src/fixtures';
import type { FixtureCellReport, FixtureReport } from '../src/authoring-check';
import { cellReport, fixtureAssets, fixtureDraft, fixtureFindings, fixtureNotEvaluated, mergeFormatFindings } from './fixtures';
import { templateFiles, templateHash } from './template-library';
import { docTopics } from '../src/doc-topics';

// Fixture checks share the bridge's two-minute call deadline with queueing, so they stop starting renders after this.
const fixtureBudgetMs = 60_000;

const omitDefinition = <T extends { definition: string }>({ definition: _definition, ...rest }: T) => rest;

export class AuthoringError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
type Hooks = {
  session: () => ProjectSession | undefined;
  activeEditor?: () => ActiveBookEditor | undefined;
  cache: string;
  // The app's docs folder: template API topics in template-api/ (listed in topics.json) and example templates in examples/.
  docs: string;
  check: (book: OpenProject, request: AuthoringCheckRequest, signal: AbortSignal, index?: ProjectInputIndex, draft?: CheckDraft) => Promise<AuthoringCheckResult>;
  changed: (book: OpenProject) => void;
  recovery: (message: string) => void;
  import: (request: ImportRequest, paths: string[], base: OpenProject, checkpoint?: SaveCheckpoint) => Promise<{ imported: string[] }>;
  // Installs the template's packages outside the book and rebuilds template/vendor/ (ADR 0006).
  dependencies?: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  // The installed app's authoring SDK, to tell whether the template's .imageflow-sdk snapshot is current.
  authoringTypes?: () => string | undefined;
};

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;

/**
 * Identifies a write request across sessions (docs/mcp.md): the SHA-256 of the JSON text of { arguments, tool }, with
 * object keys sorted at every level and no whitespace. Arguments are the validated tool arguments, so a label is
 * trimmed, without project, idempotencyKey and dryRun.
 */
export function requestFingerprint(tool: string, args: Record<string, unknown>) {
  const { project: _project, idempotencyKey: _key, dryRun: _dryRun, ...rest } = args;
  return createHash('sha256').update(JSON.stringify(canonical({ tool, arguments: rest }))).digest('hex');
}

const manifestNames = ['project.json', 'photos.json'] as const;
const startOf = (record: CheckpointRecord) =>
  Object.fromEntries(manifestNames.map((name) => [name, record.manifests[name].before])) as Record<typeof manifestNames[number], string>;
function checkpointView(record: CheckpointRecord, outside: string[]) {
  return {
    checkpointId: record.checkpoint, time: record.time, origin: record.origin, label: record.label,
    changed: manifestNames.filter((name) => record.manifests[name].before !== record.manifests[name].after),
    ...(outside.length ? { changedOutsideBefore: outside } : {}),
    ...(record.mcp ? { mcp: record.mcp } : {}),
  };
}

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

// Generated folders (the saved dependency bundle and the authoring SDK) are listed once, not file by file.
const generatedTemplateFolders = ['template/vendor/', 'template/.imageflow-sdk/'];

async function contextTemplateFiles(folder: string) {
  const root = join(folder, 'template');
  if (await realpath(root) !== root) throw new AuthoringError('PATH_NOT_ALLOWED', 'The template folder points outside its expected location.');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'));
  const listed = new Set(files.map((path) => generatedTemplateFolders.find((prefix) => path.startsWith(prefix)) ?? path));
  return [...listed].sort().slice(0, 200);
}

async function templateObservation(folder: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const root = join(folder, 'template');
  const files = await templateFiles(root);
  const stamps = [];
  for (const file of files) {
    signal.throwIfAborted();
    const info = await lstat(join(root, file), { bigint: true });
    if (!info.isFile()) throw new AuthoringError('SOURCE_CHANGED', 'Template files changed while inspecting.');
    stamps.push([file, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'));
  }
  return { files, key: JSON.stringify(stamps) };
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
// Every example is listed; only the requested ones carry their source.
async function templateExamples(docs: string, include: boolean | string[] | undefined) {
  const folder = join(docs, 'examples');
  const names = (await readdir(folder)).filter((name) => name.endsWith('.tsx')).sort();
  const examples = await Promise.all(names.map(async (name) => {
    const source = await readFile(join(folder, name), 'utf8');
    return { name: basename(name, '.tsx'), description: source.split('\n', 1)[0].replace(/^\/\/\s*/, ''), source };
  }));
  const wanted = Array.isArray(include) ? new Set(include) : undefined;
  const missing = [...wanted ?? []].filter((name) => !examples.some((example) => example.name === name));
  if (missing.length) {
    throw new AuthoringError('EXAMPLE_NOT_FOUND', 'No example named ' + missing.join(', ') + '. Examples: ' + examples.map(({ name }) => name).join(', ') + '.');
  }
  return examples.map(({ source, ...example }) => include === true || wanted?.has(example.name) ? { ...example, source } : example);
}

// The template API reference, one Markdown file per topic. The context lists the topics; agents request the ones they need.
async function referenceTopics(docs: string, requested: string[]) {
  const folder = join(docs, 'template-api');
  const topics = await Promise.all(docTopics.map(async (topic) => ({ ...topic, bytes: (await stat(join(folder, topic.id + '.md'))).size })));
  const missing = requested.filter((id) => !topics.some((topic) => topic.id === id));
  if (missing.length) {
    throw new AuthoringError('DOC_NOT_FOUND', 'No reference topic ' + missing.join(', ') + '. Topics: ' + topics.map(({ id }) => id).join(', ') + '.');
  }
  const texts = await Promise.all(requested.map((id) => readFile(join(folder, id + '.md'), 'utf8')));
  return { topics, docs: Object.fromEntries(requested.map((id, index) => [id, texts[index]])) };
}

const contextGuide = 'Start with docs: ["authoring-workflow"]. Use docs for topics, includeExamples for examples and includeSource for files. ' +
  'Edit template/ in the workspace. Save book edits with apply_project_changes and verify with check_book.';

export function createAuthoringService(hooks: Hooks) {
  // Calls without a connection, such as tests, share one session for this service.
  const unattached: McpClientSession = { name: 'MCP client', session: randomUUID() };
  let cachedCheck: { session: ProjectSession; inputs: ProjectInputCapture; result: AuthoringCheckResult } | undefined;
  let cachedTemplateHash: { session: ProjectSession; observation: string; files: string; hash: string } | undefined;
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
    const coverCheck = checksCover(request);
    // A draft can use cached declarations and defer its requested type check to the subsequent draft render.
    if (!fresh && !draft && !coverCheck && !request.preview && !request.inspect && (!request.typescript || cacheMode === 'draft-base') && expectedMatches && cachedCheck) {
      get(session.handle);
      return { result: structuredClone(cachedCheck.result), watcherInvalidated: false };
    }
    if (fresh && !draft && !coverCheck) cachedCheck = undefined;
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
    if (result.state === 'ready' && after.inputs && !draft && !coverCheck && !request.inspect && !request.typescript) {
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
    preview: PreviewRequest | undefined, inspect?: InspectionRequest, typescript?: boolean, cover?: true) => {
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
        inspect: inspect?.spread ? { ...inspect, spread: resolve(inspect.spread) } : inspect,
        summary: { applied: true, committed: false, changes: planned.changes, affectedSpreads: planned.affectedSpreads,
          ...(planned.affectedCover ? { affectedCover: true } : {}), references: planned.references, reflow: planned.reflow },
      };
    };
    const result = await checked(session, signal, { expectedRevision, ...(cover ? { cover } : {}),
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
    if (parsed.data.cover) {
      const { cover, cases = [...fixtureCases] } = parsed.data;
      let plan;
      try { plan = coverFixturePlan(template, cover, cases); }
      catch (error) {
        if (error instanceof FixtureError) throw new AuthoringError(error.code, error.message);
        throw error;
      }
      const { format, cells, skipped } = plan;
      const assets = await fixtureAssets(hooks.cache);
      const results: FixtureCellReport[] = [], diagnostics: FixtureReport['diagnostics'] = [];
      let failed = 0, notIsolated = 0;
      for (const cell of cells) {
        if (Date.now() - started >= fixtureBudgetMs) {
          notIsolated++;
          results.push({ ...cellReport(cell, format, []), state: 'not-isolated', message: 'The fixture time budget ran out.' });
          continue;
        }
        const result = await checked(session, signal, { expectedRevision: base.revision }, true,
          fixtureDraft(template, format, [cell], assets, undefined, cover.pages));
        if (result.revision !== base.revision || result.diagnostics.some(({ code }) => code === 'source-changed' || code === 'revision-conflict')) {
          throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while rendering fixtures. Check again.');
        }
        const own = result.diagnostics.filter((finding) => finding.code !== 'photo-resolution-low').map((finding) => ({
          ...finding, location: { ...finding.location, cover: true as const, where: 'Fixture · ' + cell.label },
          fixture: { layout: cell.layout, case: cell.case, format },
        }));
        diagnostics.push(...own);
        const summary = cellReport(cell, format, own);
        if (result.state === 'error') {
          failed++;
          results.push({ ...summary, state: 'failed' });
        } else results.push(summary);
      }
      return { ...base, checks: { ...base.checks, fixtures: !cells.length ? 'not-run' : notIsolated ? 'failed' : 'completed' },
        fixtures: {
          cover: { interiorPages: cover.pages }, synthetic: true, committed: false, revision: base.revision,
          matrix: { layouts: [cover.layout], formats: [format], cases },
          coverage: { planned: cells.length, rendered: cells.length - failed - notIsolated, failed, notIsolated, skipped },
          cells: results, diagnostics: diagnostics.slice(0, fixtureLimits.diagnostics),
          diagnosticsTruncated: diagnostics.length > fixtureLimits.diagnostics,
          notEvaluated: ['Interior layout and page sequence.', 'Photo resolution with the book’s actual originals.', 'Print preflight.'],
        } } satisfies AuthoringCheckResult;
    }
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
      // Each format renders the layouts that fit it (planFixtures reports the rest as skipped).
      const fitting = plan.cells.filter((cell) => fixtureFits(template, cell.layout, format));
      const planned = plan.preview?.printFormat === format ? plan.preview : undefined;
      const preview = planned && { ...planned, cells: planned.cells.filter((cell) => fitting.some(({ spread }) => spread === cell.spread)) };
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
      await run(fitting, preview?.cells);
      // An image is still useful when isolation removed failing fixtures from the requested sheet.
      const shown = preview?.cells.filter(({ spread }) => ['passed', 'warnings', 'errors'].includes(outcome.get(spread)?.state ?? ''));
      if (preview && !image && shown?.length && Date.now() - started < fixtureBudgetMs) {
        const result = await checked(session, signal, { expectedRevision: base.revision }, true,
          fixtureDraft(template, format, shown, assets, previewRequest(shown)));
        if (result.revision !== base.revision) throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while rendering fixtures. Check again.');
        if (result.state === 'ready' && result.image) image = result.image;
      }
      reports.push(...fitting.map((cell) => outcome.get(cell.spread)!));
    }
    const count = (state: FixtureCellReport['state']) => reports.filter((report) => report.state === state).length;
    const listed = mergeFormatFindings(findings);
    const report: FixtureReport = {
      synthetic: true, committed: false, revision: base.revision,
      matrix: { layouts: plan.layouts, formats, cases: plan.cases },
      coverage: { planned: reports.length, rendered: reports.length - count('failed') - count('not-isolated'),
        failed: count('failed'), notIsolated: count('not-isolated'), skipped },
      cells: reports, diagnostics: listed.slice(0, fixtureLimits.diagnostics),
      diagnosticsTruncated: listed.length > fixtureLimits.diagnostics, notEvaluated: fixtureNotEvaluated,
    };
    get(session.handle);
    return { ...base, checks: { ...base.checks, fixtures: !reports.length ? 'not-run' as const : count('not-isolated') ? 'failed' as const : 'completed' as const },
      fixtures: report, ...(image ? { image } : {}) };
  };
  /** The newest retained checkpoint committed with this key, from any earlier session on this book. */
  const retainedReceipt = async (session: ProjectSession, key: string) => {
    let ledger;
    try { ledger = await readSaveLedger(session.book.folder); }
    catch (error) {
      // Without the history a retried request could commit twice, so nothing is applied.
      throw new AuthoringError('HISTORY_UNAVAILABLE', 'Could not read the book history in .imageflow/history (' +
        (error instanceof Error ? error.message : String(error)) + '). No changes were made. Make the folder and its ledger.jsonl readable and writable, then retry.');
    }
    return ledger.records.findLast((record) => record.mcp?.idempotencyKey === key);
  };
  const ledgerReplay = async (session: ProjectSession, name: string, args: Record<string, any>, record: CheckpointRecord, signal: AbortSignal) => {
    let revision: string | null = null;
    try { revision = (await session.inputs.capture({ signal })).revision; } catch { signal.throwIfAborted(); }
    const mcp = record.mcp!;
    return { state: 'ready', project: session.handle, committed: true, replayed: true, revision,
      checkpointId: record.checkpoint, requestFingerprint: mcp.requestFingerprint,
      ...(name === 'apply_project_changes'
        ? { dryRun: false, changes: mcp.changes ?? [], affectedSpreads: mcp.affectedSpreads ?? [],
          ...(mcp.affectedCover ? { affectedCover: true } : {}), references: mcp.references ?? {} }
        : { sources: (mcp.sources ?? []).map((id, i) => ({ id, path: args.paths[i], kind: args.kind })) }),
      notice: 'This request was already committed at ' + record.time + ' and was not applied again. The book may have changed since; inspect it before the next edit.' +
        (mcp.truncated ? ' The recorded change list was shortened.' : ''),
      history: session.history };
  };
  return async (name: string, args: Record<string, any>, signal: AbortSignal, client: McpClientSession = unattached): Promise<Record<string, unknown>> => {
    if (name === 'list_projects') {
      const session = hooks.session();
      if (!session) return { projects: [] };
      let current: string | null = null;
      try { current = (await session.inputs.capture({ signal })).revision; } catch { signal.throwIfAborted(); }
      return { projects: [{ project: session.handle, title: session.book.project.title, folder: session.book.folder,
        writable: !session.book.readOnly, revision: current, history: session.history }], scope: 'The currently open, authorized book. Handles expire when closed or reopened.' };
    }
    const session = get(args.project);
    if (name === 'list_book_checkpoints') {
      const ledger = await readSaveLedger(session.book.folder);
      signal.throwIfAborted();
      get(session.handle);
      const { records } = ledger;
      const matching = records.map((record, i) => ({ record, outside: changedBetween(records[i - 1]?.manifests, startOf(record)) }))
        .filter(({ record }) => !args.idempotencyKey || record.mcp?.idempotencyKey === args.idempotencyKey).reverse();
      const start = args.cursor ? matching.findIndex(({ record }) => record.checkpoint === args.cursor) + 1 : 0;
      if (args.cursor && !start) throw new AuthoringError('CURSOR_EXPIRED', 'That checkpoint is no longer retained. List again without cursor.');
      const limit = args.limit ?? 20;
      const page = matching.slice(start, start + limit);
      return { project: session.handle, checkpoints: page.map(({ record, outside }) => checkpointView(record, outside)),
        nextCursor: start + limit < matching.length ? page.at(-1)!.record.checkpoint : null,
        retained: records.length, oldest: records[0]?.time ?? null,
        changedOutsideSinceLatest: records.length ? changedBetween(records.at(-1)!.manifests, ledger.current) : [],
        ...(ledger.unreadable ? { unreadable: ledger.unreadable } : {}),
        ...(args.idempotencyKey && !matching.length ? { notice: 'No retained checkpoint has this idempotencyKey. That does not show the request failed; inspect the book before submitting another edit.' } : {}) };
    }
    if (name === 'check_book') {
      if (typeof args.preview?.target?.page === 'number' && !args.expectedRevision) throw new AuthoringError('REVISION_REQUIRED', 'Page-number previews require expectedRevision; spread IDs can be used without it.');
      const report = args.fixtures
        ? await fixtureCheck(session, signal, args.fixtures, args.expectedRevision, args.typescript)
        : !args.draft
          ? await checked(session, signal, { expectedRevision: args.expectedRevision, preview: args.preview, ...(args.cover ? { cover: args.cover } : {}),
            ...(args.inspect ? { inspect: args.inspect } : {}), ...(args.typescript !== undefined ? { typescript: args.typescript } : {}) }, true)
          : await draftCheck(session, signal, args.expectedRevision, args.draft.operations, args.preview, args.inspect, args.typescript, args.cover);
      if (args.includeTemplate) return report;
      // Keep full declarations in the internal check cache for planning and context, not in every agent reply.
      const { template: _template, render, ...compact } = report;
      if (!render) return compact;
      const { template: _renderTemplate, ...renderSummary } = render;
      return { ...compact, render: renderSummary };
    }
    if (name === 'inspect_book' && args.view === 'elements') {
      const report = await checked(session, signal, { inspect: { spread: args.spread, cover: args.cover, page: args.page, box: args.box, element: args.element,
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
      // This is the library's authored-file hash, not the saved provenance or a source-file/revision digest.
      // Reconcile the library's complete file set: revision capture skips e.g. *.tmp files that the library hashes.
      const observed = await Promise.allSettled([templateObservation(folder, signal)]);
      const observation = observed[0].status === 'fulfilled' ? observed[0].value : undefined;
      const reuseHash = observation && before.inputs && cachedTemplateHash?.session === session &&
        cachedTemplateHash.observation === before.inputs.observation && cachedTemplateHash.files === observation.key;
      const hashes = await Promise.allSettled([observed[0].status === 'rejected' ? Promise.reject(observed[0].reason)
        : reuseHash ? Promise.resolve(cachedTemplateHash!.hash) : templateHash(join(folder, 'template'), observed[0].value.files, signal)]);
      signal.throwIfAborted();
      if (hashes[0].status === 'rejected') unavailable(hashes[0].reason, 'template');
      const currentHash = hashes[0].status === 'fulfilled' ? hashes[0].value : null;
      const templateIdentity = {
        saved: project?.template ?? null,
        current: { id: template?.id ?? null, version: template?.version ?? null, hash: currentHash },
        matchesSavedHash: project?.template.hash && currentHash ? project.template.hash === currentHash : null,
      };
      let result: Record<string, unknown>;
      let verifySources: (() => Promise<void>) | undefined;
      if (name === 'get_authoring_context') {
        const sources: Record<string, { text: string; sha256: string; truncated: boolean }> = {};
        const requested: string[] = args.includeSource ?? [];
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
        const reference = await referenceTopics(hooks.docs, [...new Set<string>(args.docs ?? [])]);
        const types = hooks.authoringTypes?.();
        const sdkState = types ? await authoringSnapshotState(join(folder, 'template'), types).catch(() => undefined) : undefined;
        result = {
          project: session.handle, revision: report.revision, root: session.book.folder, guide: contextGuide,
          template, templateIdentity, diagnostics, checks: report.checks, sources,
          templateFiles: files[0].status === 'fulfilled' ? files[0].value : [],
          topics: reference.topics,
          ...(args.docs?.length ? { docs: reference.docs } : {}),
          examples: await templateExamples(hooks.docs, args.includeExamples),
          ...(sdkState ? { sdk: { snapshot: sdkState, ...(sdkState === 'stale' ? { notice: 'template/.imageflow-sdk is from an earlier ImageFlow version and lacks newer API declarations, so editor tooling may flag code that renders fine. Type checks here use the installed SDK. Call rebuild_dependencies to refresh it.' } : {}) } } : {}),
          capabilities: { commands: true, dryRun: true, batchReferences: '$alias', sharedUndo: true, preview: ['page', 'spread'],
            maxPreviewEdge: 1600, typescript: true, printPreflight: false, draftPreview: true, contactSheets: true,
            fixtures: { cases: [...fixtureCases], maxLayouts: fixtureLimits.layouts, maxFormats: fixtureLimits.formats,
              maxFixturesPerFormat: fixtureLimits.cellsPerFormat, maxPreviewFixtures: fixtureLimits.previewCells },
            pageAddressing: true, pagePairInsertion: true, elementInspection: true, detailPreviews: true, maxContactSheetSpreads: 12,
            templateApi: { contract: 1, baseline: [...contract1Capabilities], capabilities: [...templateCapabilities], exports: [...runtimeExports] },
            diagnostics: 'Codes, locations, measurements and suggested fixes.',
            draftProtection: 'Active editors block saves and imports (EDIT_IN_PROGRESS). Dry runs and checks can read saved inputs.',
            imports: 'Use project/inbox. Files are validated together and kept for Undo.',
            idempotency: 'Replay up to 1000 successful requests per open handle. After reopening, the same request returns its retained checkpoint. Find keys with list_book_checkpoints.' },
        };
      } else {
        const offset = args.offset ?? 0, limit = args.limit ?? 30;
        const sequence = template && project && pageSequence(project.spreads.map((spread) => layoutFootprint(spread, template.spreads)), template.format);
        const labels = project?.spreads.map((_, i) => pageLabel(sequence?.spreads[i].page ?? {})) ?? [];
        const sourcePlaces = (places: import('../src/editing').SourcePlace[] = []) => places.map(({ cover, spread, pages }) =>
          cover ? { cover, pages } : { spread, pages });
        const view = args.view ?? 'summary';
        const coverFormat = template?.coverFormats && Object.hasOwn(template.coverFormats, template.formatId) &&
          (!project?.format || !Object.keys(template.formats).length || project.format === template.formatId)
          ? template.coverFormats[template.formatId] : undefined;
        const cover = template && sequence ? resolveCover({ interior: template.format, cover: coverFormat }, sequence.count) : undefined;
        const savedCover = project?.cover;
        const availableCover = cover?.status === 'unavailable' ? undefined : cover;
        const coverLayouts = availableCover && template ? coverLayoutsFor(template.coverLayouts, template.formatId) : {};
        const coverLayout = savedCover && Object.hasOwn(coverLayouts, savedCover.definition) ? coverLayouts[savedCover.definition] : undefined;
        const usage = project ? sourceUsage(project, labels, template?.spreads, Object.keys(coverLayout?.boxes ?? {})) : { photo: {}, text: {} };
        if (view === 'cover' && !availableCover && !savedCover) {
          throw new AuthoringError('COVER_UNAVAILABLE', 'The active format has no exterior cover.');
        }
        let records: Record<string, unknown>[] = view === 'sources' ? [
          // Capture time, location and camera come from the loaded photo file, next to what photos.json records.
          ...Object.entries(photos ?? {}).map(([id, source]) => ({ kind: 'photo', id, ...source, ...captureOf(session.book.photos.get(id)), usage: sourcePlaces(usage.photo[id]) })),
          ...Object.entries(project?.texts ?? {}).map(([id, path]) => ({ kind: 'text', id, path: sourcePath(path), linked: sourceLinked(path), usage: sourcePlaces(usage.text[id]) })),
          ...Object.entries(project?.files ?? {}).map(([id, path]) => ({ kind: 'file', id, path: sourcePath(path), linked: sourceLinked(path) })),
        ] : view === 'cover' ? (project?.cover ? [project.cover] : [])
          : project?.spreads.filter((spread) => !args.spread || spread.id === args.spread).map((spread) => ({ ...omitDefinition(spread),
          // A sheet shown as pages displays pages.left/right.definition. Its own definition only names the spread-wide
          // layout a merge restores, so it is not reported as `definition`, which reads as what is shown (F-017).
          ...(spread.split ? { restoreDefinition: spread.definition } : { definition: spread.definition }),
          page: sequence?.spreads[project.spreads.findIndex(({ id }) => id === spread.id)].page,
          kept: template ? keptOutside(spread, template.spreads) : [],
          ...(view === 'parameters' && template ? spread.split ? {
            pageDeclarations: Object.fromEntries(['left', 'right'].map(side => [side,
              template.spreads[spread.pages?.[side as 'left' | 'right']?.definition ?? ''] ?? null])),
          } : { declarations: template.spreads[spread.definition] } : {}),
        })) ?? [];
        // The summary is the book at a glance: its spreads are counted, and listed by the spreads view.
        // Sources are counted per kind, and can be listed one kind at a time.
        const counts = view === 'sources' ? { photo: 0, text: 0, file: 0, ...Object.fromEntries(['photo', 'text', 'file'].map((kind) =>
          [kind, records.filter((record) => (record as { kind?: string }).kind === kind).length])) } : undefined;
        if (view === 'sources' && args.kind) records = records.filter((record) => (record as { kind?: string }).kind === args.kind);
        const listed = view === 'summary' ? {} : { offset, items: records.slice(offset, offset + limit), nextOffset: offset + limit < records.length ? offset + limit : null,
          ...(counts ? { counts } : {}) };
        result = { project: session.handle, revision: report.revision, title: project?.title, format: project?.format, templateIdentity,
          pages: report.render?.pages, total: records.length, ...listed,
          ...((view === 'summary' || view === 'cover') && (availableCover || savedCover) ? {
            cover: { ...(availableCover ?? { status: 'unavailable', reason: 'The active format has no exterior cover.' }),
              layout: savedCover?.definition ?? null, ...(view === 'cover' ? { artwork: savedCover ?? null } : {}) },
          } : {}),
          ...(view === 'parameters' ? { document: { values: project?.params, declarations: template?.parameters } } : {}),
          diagnostics, checks: report.checks, history: session.history };
      }
      await verifySources?.();
      const observedAfter = await Promise.allSettled([templateObservation(folder, signal)]);
      signal.throwIfAborted();
      // A complete input capture supplies the content/race guard below. Keep the second byte read for recovery.
      const hashesAfter = before.inputs ? hashes : await Promise.allSettled([templateHash(join(folder, 'template'), undefined, signal)]);
      signal.throwIfAborted();
      if (settledState(observed) !== settledState(observedAfter) || settledState(hashes) !== settledState(hashesAfter)) {
        throw new AuthoringError('SOURCE_CHANGED', 'Template files changed while inspecting. Retry for current context.');
      }
      const documentsAfter = await readDocuments();
      const after = await contextInputs(session.inputs, signal);
      if (!sameDocuments(documents, documentsAfter) || before.failure !== after.failure ||
          before.inputs?.revision !== after.inputs?.revision || before.inputs?.observation !== after.inputs?.observation) {
        throw new AuthoringError('SOURCE_CHANGED', 'Inputs changed while inspecting. Retry for current context.');
      }
      get(session.handle);
      if (currentHash && observation && after.inputs) {
        cachedTemplateHash = { session, observation: after.inputs.observation, files: observation.key, hash: currentHash };
      } else cachedTemplateHash = undefined;
      if (name === 'inspect_book' && args.view === 'summary') {
        const activeEditor = hooks.activeEditor?.();
        if (activeEditor) result.activeEditor = activeEditor;
      }
      return result;
    }
    if (name === 'rebuild_dependencies') {
      if (session.book.readOnly) throw new AuthoringError('READ_ONLY', 'Create an editable project in ImageFlow first.');
      if (!hooks.dependencies) throw new AuthoringError('UNKNOWN_TOOL', 'Rebuilding dependencies is not available here.');
      try { return { project: session.handle, ...await hooks.dependencies(signal) }; }
      catch (error) {
        if (error instanceof DependencyInstallError) throw new AuthoringError(error.code.toUpperCase().replaceAll('-', '_'), error.message);
        throw error;
      }
    }
    if (name !== 'apply_project_changes' && name !== 'import_sources') throw new AuthoringError('UNKNOWN_TOOL', 'Unknown authoring tool.');
    if (session.book.readOnly) throw new AuthoringError('READ_ONLY', 'Create an editable project in ImageFlow first.');
    const request = JSON.stringify({ name, ...args });
    const receipt = session.receipts.get(args.idempotencyKey);
    if (receipt) {
      if (receipt.request !== request) throw new AuthoringError('IDEMPOTENCY_CONFLICT', 'This key was already used for a different request.');
      return { ...receipt.result, replayed: true };
    }
    const fingerprint = requestFingerprint(name, args);
    // A key committed in an earlier session on this book is answered before its revision precondition, which the
    // committed request itself changed.
    if (!args.dryRun) {
      const retained = await retainedReceipt(session, args.idempotencyKey);
      signal.throwIfAborted();
      if (retained) {
        if (retained.mcp!.tool !== name || retained.mcp!.requestFingerprint !== fingerprint) {
          throw new AuthoringError('IDEMPOTENCY_CONFLICT', 'This key was already used for a different request in this book.', { checkpointId: retained.checkpoint });
        }
        return await ledgerReplay(session, name, args, retained, signal);
      }
    }
    if (session.receipts.size >= 1000) throw new AuthoringError('SESSION_LIMIT', 'This project session has reached 1000 requests. Reopen the book for a new handle.');
    const checkpoint: SaveCheckpoint = { origin: 'mcp', label: name === 'apply_project_changes' ? args.label : 'Import sources',
      mcp: { tool: name, idempotencyKey: args.idempotencyKey, requestFingerprint: fingerprint, session: client.session, client: client.name } };
    const commit = async (save: () => Promise<unknown>) => {
      try { return { value: await save() }; }
      catch (error) {
        if (!(error instanceof CommittedProjectSaveError)) throw error;
        const result = { state: 'error', project: session.handle, committed: 'pending', revision: null,
          checkpointId: checkpoint.id ?? null, requestFingerprint: fingerprint,
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
        ...(planned.affectedCover ? { affectedCover: true } : {}),
        committed: !args.dryRun, dryRun: !!args.dryRun };
      if (args.dryRun) return result;
      Object.assign(checkpoint.mcp!, { changes: planned.changes, affectedSpreads: planned.affectedSpreads, references: planned.references,
        ...(planned.affectedCover ? { affectedCover: true } : {}) });
      const saved = await commit(() => session.save(planned.files, args.label, fresh, checkpoint));
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
      const saved = await commit(async () => { imported = await hooks.import({ kind: args.kind, accept: args.accept }, paths, fresh, checkpoint); });
      if (saved.recovery) return saved.recovery;
      result = { state: 'ready', project: session.handle, committed: true, revision: null,
        sources: imported!.imported.map((id, i) => ({ id, path: args.paths[i], kind: args.kind })) };
    }
    // Commit acknowledgement survives a disconnected client; retries cannot repeat a successful batch.
    result.revision = null;
    result.checkpointId = checkpoint.id ?? null;
    result.requestFingerprint = fingerprint;
    session.receipts.set(args.idempotencyKey, { request, result });
    hooks.changed(session.book);
    try { result.revision = (await session.inputs.capture()).revision; }
    catch { result.notice = 'The edit was committed, but files changed before a new revision could be captured. Check the book again.'; }
    result.history = session.history;
    return result;
  };
}
