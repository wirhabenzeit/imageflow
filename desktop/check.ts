import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { awayDiagnostics, takeAway } from '../src/away-originals';
import { authoringCheckSchema } from '../src/authoring-check';
import type { AuthoringCheckResult, AuthoringDraftSummary } from '../src/authoring-check';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { Issue, RenderStatus } from '../src/desktop';
import type { PreviewRequest } from '../src/preview';
import { PreviewError, spreadByPrefix } from '../src/preview';
import { captureProjectInputs, ProjectRevisionError } from './revisions';
import type { ProjectInputIndex } from './revisions';
import type { CheckRenditionCache } from './check-cache';
import { placedPhotos } from './materialized-photos';
import { loadProject, TemplateCompileError } from './project';
import type { OpenProject } from './project';
import type { BookPreview } from './preview';
import type { InspectionRequest } from '../src/inspection';
import type { Typecheck, TypecheckResult } from './typecheck';
import { templateLocation } from './source-location';

type ReadyStatus = Extract<RenderStatus, { state: 'ready' }>;
// A book saved every few moments is loaded again this often before its check is given up.
const loadAttempts = 3;

type RenderCheck = (book: OpenProject, preview: PreviewRequest | undefined, signal: AbortSignal, inspect?: InspectionRequest, cover?: true) => Promise<{
  status: ReadyStatus; preview?: BookPreview;
}>;

/** Applies an unsaved command batch to the freshly loaded book. It may rewrite the preview request, for example to
 * resolve a batch reference to the ID of an inserted spread. */
export type CheckDraft = (book: OpenProject) => {
  book: OpenProject; preview?: PreviewRequest; inspect?: InspectionRequest;
  // A command draft reports its planned changes. A synthetic fixture book has none and marks its image instead.
  summary?: AuthoringDraftSummary; fixture?: true;
};

function diagnostic(issue: Issue, severity: 'error' | 'warning'): AuthoringDiagnostic {
  const { message, code, spread, cover, where, box, element, page, source, parameter, details, suggestion } = issue;
  const location = Object.fromEntries(Object.entries({ spread, cover, box, element, page, source, parameter, where })
    .filter(([, value]) => value !== undefined && value !== ''));
  return {
    code: code ?? (severity === 'error' ? 'layout-error' : 'layout-warning'), stage: 'render', severity, message,
    ...(Object.keys(location).length ? { location } : {}),
    ...(details && Object.keys(details).length ? { details } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

/** Placed photos drawn as empty frames because their previews are still being fetched: one finding for all of them. */
function loadingPreviews(book: OpenProject): AuthoringDiagnostic[] {
  const photos = [...placedPhotos(book)].filter((id) => book.sources?.['photo:' + id]?.pending);
  if (!photos.length) return [];
  return [{ code: 'photo-preview-loading', stage: 'render', severity: 'warning',
    message: photos.length === 1 ? 'The preview of a placed photo is still loading. It is drawn as an empty frame of its size.'
      : 'The previews of ' + photos.length + ' placed photos are still loading. They are drawn as empty frames of their size.',
    details: { photos: photos.length }, suggestion: 'The layout is checked, the resolution of these photos is not. Check again once ImageFlow has loaded them.' }];
}

/** Read-only authoring check. The app supplies a private, temporary render session.
 * A check never adopts its disk reload into the editor or changes its Undo history.
 * Inputs are checked again after rendering; changed files invalidate the entire result. A save of the manifests meanwhile
 * does not, nor do photos that change in their source: the book is drawn as it was loaded, and the result says that the
 * revision it is of has been superseded (API-007).
 */
export async function checkProject(
  source: OpenProject, fallbackCache: string, request: unknown, render: RenderCheck, signal: AbortSignal, index?: ProjectInputIndex,
  renditions?: CheckRenditionCache, draft?: CheckDraft, typecheck?: Typecheck,
): Promise<AuthoringCheckResult> {
  const result: AuthoringCheckResult = {
    state: 'error', revision: null, diagnostics: [],
    checks: { bundle: 'not-run', declarations: 'not-run', layout: 'not-run', typescript: 'not-run', fixtures: 'not-run', print: 'not-run' },
  };
  const parsed = authoringCheckSchema.safeParse(request);
  if (!parsed.success) {
    result.diagnostics.push({ code: 'invalid-check-request', stage: 'project', severity: 'error',
      message: parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('\n') });
    return result;
  }
  let phase: 'project' | 'template' | 'render' = 'project';
  let privateCache: string | undefined;
  let retainedCache = false;
  let inputs: Awaited<ReturnType<typeof captureProjectInputs>> | undefined;
  let types: TypecheckResult | undefined;
  // An invalid draft is the caller's request error, not a check finding.
  let draftError: unknown;
  let loaded: OpenProject | undefined;
  const capture = () => index ? index.capture({ signal }) : captureProjectInputs(source.folder, { signal });
  const inputsMatch = async () => {
    const current = await capture();
    return inputs && current.revision === inputs.revision && current.observation === inputs.observation;
  };
  // Whether what was loaded is of the captured inputs, and whether a book loaded from them is still drawn as it was.
  const filesMatch = async () => (await capture()).files === inputs?.files;
  const stillDrawn = async () => {
    const current = await capture();
    if (!inputs || current.files !== inputs.files) return false;
    if (current.revision !== inputs.revision) result.superseded = { revision: current.revision };
    return true;
  };
  try {
    signal.throwIfAborted();
    inputs = await capture();
    result.revision = inputs.revision;
    if (parsed.data.expectedRevision && parsed.data.expectedRevision !== result.revision) {
      result.diagnostics.push({ code: 'revision-conflict', stage: 'project', severity: 'error',
        message: 'The project inputs changed. Inspect the current revision before requesting an exact-revision check.' });
      return result;
    }
    if (parsed.data.typescript) {
      if (!typecheck) throw new Error('The installed template type checker is unavailable.');
      types = await typecheck(source.folder, signal);
      result.checks.typescript = types.diagnostics.length ? 'failed' : 'passed';
      const { diagnostics: _diagnostics, ...coverage } = types;
      result.typecheck = coverage;
      if (!await filesMatch()) throw new ProjectRevisionError('source-changed');
    }
    phase = 'template';
    // A rejected check may have read changed photo bytes. Never let its renditions poison a later check.
    privateCache = await mkdtemp(join(fallbackCache, 'check-'));
    // Photos are read where they are, as in the editor: copying, hashing and decoding every photo cost each check about
    // 8 s for a book of 163 linked photos (F-037). Their renditions are keyed by the original's stamp and made only
    // while it is unchanged, and the inputs, photo stamps included, are compared again after rendering.
    // Nor does it wait for previews of photos without a file: an import of a thousand takes minutes (API-009).
    let book: OpenProject;
    for (let attempt = 1; ; attempt++) {
      book = await loadProject(source.folder, privateCache, true, false, { previews: 'none', signal });
      const current = await capture();
      if (current.content === inputs.content) break;
      // A save of the manifests during the load: the book is loaded as it is now, unless an exact revision was asked for.
      if (attempt === loadAttempts || parsed.data.expectedRevision || current.files !== inputs.files) throw new ProjectRevisionError('source-changed');
      inputs = current;
      result.revision = current.revision;
    }
    loaded = book;
    const photoKeys = new Set([...book.photos.values()].map((photo) => photo.key));
    await renditions?.seed(privateCache, photoKeys);
    result.checks.bundle = 'passed';
    phase = 'render';
    let rendered = book;
    let preview: PreviewRequest | undefined = parsed.data.preview;
    let inspect = parsed.data.inspect;
    let fixture = false;
    if (draft) {
      // Command errors propagate to the caller; the draft never reaches the editor or disk.
      let planned: ReturnType<CheckDraft>;
      try { planned = draft(book); }
      catch (error) { draftError = error; throw error; }
      rendered = planned.book;
      preview = planned.preview;
      inspect = planned.inspect ? { offset: 0, limit: 30, ...planned.inspect } : undefined;
      if (planned.summary) result.draft = planned.summary;
      fixture = !!planned.fixture;
    }
    // Looked up before anything is drawn: a wrong spread costs no render of the book (API-023).
    const spreadIds = rendered.project.spreads.map(({ id }) => id);
    if (preview && 'spread' in preview.target) preview = { ...preview, target: { ...preview.target, spread: spreadByPrefix(spreadIds, preview.target.spread) } };
    if (preview && 'spreads' in preview.target) preview = { ...preview, target: { ...preview.target, spreads: preview.target.spreads.map((id) => spreadByPrefix(spreadIds, id)) } };
    if (inspect?.spread) inspect = { ...inspect, spread: spreadByPrefix(spreadIds, inspect.spread) };
    const checked = await render(rendered, preview, signal, inspect, parsed.data.cover);
    if (!await stillDrawn()) {
      throw new ProjectRevisionError('source-changed');
    }
    signal.throwIfAborted();
    result.state = 'ready';
    result.render = checked.status;
    result.checks.declarations = 'passed';
    result.checks.layout = 'completed';
    const found = takeAway(checked.status);
    result.diagnostics = [
      ...types?.diagnostics ?? [],
      // Originals that are elsewhere are one finding with its places, not one per photo and box (#308); `render` keeps each.
      ...found.errors.map((issue) => diagnostic(issue, 'error')),
      ...found.warnings.map((issue) => diagnostic(issue, 'warning')),
      ...awayDiagnostics(found.notes),
      ...loadingPreviews(rendered),
    ];
    if (checked.preview) {
      const { bytes, mimeType, status: _status, ...metadata } = checked.preview;
      result.image = { ...metadata, mimeType, data: Buffer.from(bytes).toString('base64'), ...(fixture ? { fixture: true as const } : draft ? { draft: true as const } : {}) };
    }
    retainedCache = await renditions?.retain(privateCache, photoKeys) ?? false;
    return result;
  } catch (error) {
    // Cancellation must not replace a compiler/source/render failure that already occurred.
    if (signal.aborted || (draftError !== undefined && error === draftError)) throw error;
    if (error instanceof TemplateCompileError) {
      result.checks.bundle = 'failed';
      result.diagnostics = error.diagnostics;
    }
    else {
      const previewFailure = error instanceof PreviewError &&
        ['invalid-preview-request', 'preview-target-not-found', 'preview-capture-failed', 'cover-unavailable'].includes(error.code);
      if (phase === 'render' && !(error instanceof ProjectRevisionError)) {
        result.checks.layout = previewFailure
          ? error.code === 'preview-capture-failed' ? 'completed' : 'not-run'
          : 'failed';
      }
      if (error instanceof PreviewError && error.template) {
        result.template = error.template;
        result.checks.declarations = 'passed';
      }
      const failure = error instanceof PreviewError ? error.failure : undefined;
      if (failure?.layoutFailures) {
        // Each layout that failed is named with its spread and, when the source map has it, the template line that threw.
        // A fixture book uses this to render its other fixtures without the failing ones.
        result.diagnostics = failure.layoutFailures.map(({ spread, page, message, stack }) => {
          const at = templateLocation(stack, loaded);
          return { code: 'layout-render-failed', stage: 'render' as const, severity: 'error' as const, message,
            location: { spread, ...(page ? { page } : {}), ...at },
            suggestion: 'Fix the layout code' + (at ? ' at ' + at.path + ':' + at.line : '') + ' so it renders one <Spread> for this content; ' +
              'guard empty, long or malformed inputs, or change the spread\'s parameters or layout.' };
        });
      } else if (failure?.declarationIssues) {
        result.checks.declarations = 'failed';
        result.diagnostics = failure.declarationIssues.map(({ path, message }) => ({
          code: path === 'id' ? 'template-id-mismatch' : 'template-declaration-invalid', stage: 'template' as const, severity: 'error' as const,
          message: (path ? path + ': ' : '') + message, location: { path: 'template/index.tsx', ...(path ? { declaration: path } : {}) },
          suggestion: path === 'id' ? 'Use the template ID that project.json names, or, for a fork with an ID of its own, name that template as basedOn: { id, version }.'
            : 'Change the declaration at ' + (path || 'the template root') + ' in the default export of template/index.tsx so it satisfies the template API.',
        }));
      } else {
        const at = templateLocation(failure?.stack, loaded);
        result.diagnostics = [{
          code: error instanceof ProjectRevisionError || error instanceof PreviewError ? error.code : 'authoring-check-failed',
          stage: error instanceof ProjectRevisionError ? 'project' : previewFailure ? 'preview' : phase === 'template' ? 'project' : phase,
          severity: 'error', message: error instanceof Error ? error.message : String(error),
          ...(error instanceof ProjectRevisionError && error.path ? { location: { path: error.path } } : at ? { location: at } : {}),
        }];
      }
    }
    // Compiler/render failures are only attributable to the captured revision if inputs stayed stable.
    if (result.revision) {
      try {
        if (loaded ? !await stillDrawn() : !await inputsMatch()) {
          delete result.template;
          result.diagnostics = [{ code: 'source-changed', stage: 'project', severity: 'error',
            message: 'Project inputs changed during this check. Run it again for current diagnostics.' }];
        }
      } catch (captureError) {
        if (signal.aborted) throw error;
        delete result.template;
        result.diagnostics = [{ code: 'source-changed', stage: 'project', severity: 'error',
          message: 'Project inputs could not be verified after the check: ' +
            (captureError instanceof Error ? captureError.message : String(captureError)) }];
      }
    }
    if (result.diagnostics.some(({ code }) => code === 'source-changed')) {
      delete result.typecheck;
      result.checks.typescript = 'not-run';
    } else if (types) result.diagnostics.unshift(...types.diagnostics);
    return result;
  } finally {
    // The app also removes its cache root at shutdown. Cleanup must not replace a useful check result.
    if (privateCache && !retainedCache) await rm(privateCache, { recursive: true, force: true }).catch(() => {});
  }
}
