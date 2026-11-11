import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import { photoExtensions } from './photos';
import type { OpenProject } from './project';
import type { ProjectSession } from './project-session';
import { CommittedProjectSaveError } from './persistence';

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

export function createAuthoringService(hooks: Hooks) {
  let cachedCheck: { session: ProjectSession; inputs: ProjectInputCapture; result: AuthoringCheckResult } | undefined;
  const get = (handle: unknown) => {
    const session = hooks.session();
    if (!session || session.handle !== handle) throw new AuthoringError('PROJECT_CLOSED', 'This project is no longer open. Call list_projects for current handles.');
    return session;
  };
  const checkOnce = async (session: ProjectSession, signal: AbortSignal, request: AuthoringCheckRequest, fresh: boolean, draft?: CheckDraft) => {
    signal.throwIfAborted();
    const before = await contextInputs(session.inputs, signal);
    const matches = cachedCheck?.session === session && before.inputs && cachedCheck.inputs.revision === before.inputs.revision &&
      cachedCheck.inputs.observation === before.inputs.observation;
    if (!matches) cachedCheck = undefined;
    // expectedRevision is checked before reuse. It constrains the inputs without changing a no-preview render.
    const expectedMatches = !request.expectedRevision || request.expectedRevision === before.inputs?.revision;
    if (!fresh && !draft && !request.preview && expectedMatches && cachedCheck) {
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
    if (result.state === 'ready' && after.inputs && !draft) {
      const { image: _image, ...baseline } = result;
      cachedCheck = { session, inputs: after.inputs, result: structuredClone(baseline) };
    }
    return { result, watcherInvalidated: false };
  };
  const checked = async (session: ProjectSession, signal: AbortSignal, request: AuthoringCheckRequest = {}, fresh = false, draft?: CheckDraft) => {
    const first = await checkOnce(session, signal, request, fresh, draft);
    if (!first.watcherInvalidated) return first.result;
    signal.throwIfAborted();
    cachedCheck = undefined;
    const retried = await checkOnce(session, signal, request, true, draft);
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
      if (report.state !== 'ready' || !report.render) return { report };
      const fresh = await loadProject(session.book.folder, hooks.cache, session.book.readOnly);
      const loaded = await revision(session, expected, signal);
      if (loaded.observation === inputs.observation) return { inputs, report, fresh };
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
    preview: PreviewRequest | undefined) => {
    const base = await checked(session, signal, { expectedRevision });
    if (base.state !== 'ready' || !base.render) return { ...base, draft: { applied: false, committed: false } };
    const template = base.render.template;
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
      if (target && 'spread' in target && target.spread.startsWith('$')) {
        const resolved = planned.references[target.spread.slice(1)];
        if (!resolved) throw new AuthoringError('REFERENCE_NOT_FOUND', 'The draft defines no batch reference ' + target.spread + '.');
        target = { ...target, spread: resolved };
      }
      return {
        book: drafted, preview: preview && target ? { ...preview, target } : undefined,
        summary: { applied: true, committed: false, changes: planned.changes, affectedSpreads: planned.affectedSpreads,
          references: planned.references, reflow: planned.reflow },
      };
    };
    return checked(session, signal, { expectedRevision }, true, draft);
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
      if (!args.draft) return checked(session, signal, { expectedRevision: args.expectedRevision, preview: args.preview }, true);
      return draftCheck(session, signal, args.expectedRevision, args.draft.operations, args.preview);
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
      const template = report.render?.template;
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
          workflow: ['Edit template/ TSX, CSS and assets directly with workspace tools.', 'Edit existing texts/ Markdown directly.',
            'Call check_book with a spread preview after edits; images include whole-book text flow.',
            'Preview a new or unused layout before saving it: call check_book with draft.operations (an insert_spread with a ref) and target the preview at its $ref.',
            'Use apply_project_changes for project.json/photos.json; never edit these manifests while the app is open.',
            'Copy new content into inbox/ and call import_sources. Then assign returned IDs with a command batch.'],
          template, diagnostics, checks: report.checks, sources,
          templateFiles: files[0].status === 'fulfilled' ? files[0].value : [],
          apiReference: await readFile(hooks.docs, 'utf8'),
          capabilities: { commands: true, dryRun: true, batchReferences: '$alias', sharedUndo: true, preview: ['page', 'spread'],
            maxPreviewEdge: 1600, typescript: false, printPreflight: false, draftPreview: true, fixtures: false, contactSheets: false,
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
          ...Object.entries(project?.texts ?? {}).map(([id, path]) => ({ kind: 'text', id, path, usage: usage.text[id] ?? [] })),
          ...Object.entries(project?.files ?? {}).map(([id, path]) => ({ kind: 'file', id, path })),
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
    const { inputs, report, fresh } = await prepareMutation(session, args.expectedRevision, signal);
    if (!fresh || !inputs || !report.render) return { ...report, committed: false };
    signal.throwIfAborted();
    let result: Record<string, unknown>;
    if (name === 'apply_project_changes') {
      let planned;
      try { planned = applyProjectCommands(fresh, report.render.template, args.operations); }
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
