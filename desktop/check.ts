import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { authoringCheckSchema } from '../src/authoring-check';
import type { AuthoringCheckResult, AuthoringDraftSummary } from '../src/authoring-check';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { Issue, RenderStatus } from '../src/desktop';
import type { PreviewRequest } from '../src/preview';
import { PreviewError } from '../src/preview';
import { captureProjectInputs, ProjectRevisionError } from './revisions';
import type { ProjectInputIndex } from './revisions';
import type { CheckRenditionCache } from './check-cache';
import { loadProject, TemplateCompileError } from './project';
import type { OpenProject } from './project';
import type { BookPreview } from './preview';

type ReadyStatus = Extract<RenderStatus, { state: 'ready' }>;
type RenderCheck = (book: OpenProject, preview: PreviewRequest | undefined, signal: AbortSignal) => Promise<{
  status: ReadyStatus; preview?: BookPreview;
}>;

/** Applies an unsaved command batch to the freshly loaded book. It may rewrite the preview request, for example to
 * resolve a batch reference to the ID of an inserted spread. */
export type CheckDraft = (book: OpenProject) => { book: OpenProject; preview?: PreviewRequest; summary: AuthoringDraftSummary };

function diagnostic(issue: Issue, severity: 'error' | 'warning'): AuthoringDiagnostic {
  const { message, code, spread, where, box, element, source, parameter, details, suggestion } = issue;
  const location = Object.fromEntries(Object.entries({ spread, box, element, source, parameter, where })
    .filter(([, value]) => value !== undefined && value !== ''));
  return {
    code: code ?? (severity === 'error' ? 'layout-error' : 'layout-warning'), stage: 'render', severity, message,
    ...(Object.keys(location).length ? { location } : {}),
    ...(details && Object.keys(details).length ? { details } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

/** Read-only authoring check. The app supplies a private, temporary render session.
 * A check never adopts its disk reload into the editor or changes its Undo history.
 * Inputs are checked again after rendering; changed inputs invalidate the entire result.
 */
export async function checkProject(
  source: OpenProject, fallbackCache: string, request: unknown, render: RenderCheck, signal: AbortSignal, index?: ProjectInputIndex,
  renditions?: CheckRenditionCache, draft?: CheckDraft,
): Promise<AuthoringCheckResult> {
  const result: AuthoringCheckResult = {
    state: 'error', revision: null, diagnostics: [],
    checks: { bundle: 'not-run', layout: 'not-run', typescript: 'not-run', print: 'not-run' },
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
  // An invalid draft is the caller's request error, not a check finding.
  let draftError: unknown;
  const capture = () => index ? index.capture({ signal }) : captureProjectInputs(source.folder, { signal });
  const inputsMatch = async () => {
    const current = await capture();
    return inputs && current.revision === inputs.revision && current.observation === inputs.observation;
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
    phase = 'template';
    // A rejected check may have read changed photo bytes. Never let its renditions poison a later check.
    privateCache = await mkdtemp(join(fallbackCache, 'check-'));
    const book = await loadProject(source.folder, privateCache, true);
    if (!await inputsMatch()) {
      throw new ProjectRevisionError('source-changed');
    }
    const photoKeys = new Set([...book.photos.values()].map((photo) => photo.key));
    await renditions?.seed(privateCache, photoKeys);
    result.checks.bundle = 'passed';
    phase = 'render';
    let rendered = book;
    let preview: PreviewRequest | undefined = parsed.data.preview;
    if (draft) {
      // Command errors propagate to the caller; the draft never reaches the editor or disk.
      let planned: ReturnType<CheckDraft>;
      try { planned = draft(book); }
      catch (error) { draftError = error; throw error; }
      rendered = planned.book;
      preview = planned.preview;
      result.draft = planned.summary;
    }
    const checked = await render(rendered, preview, signal);
    if (!await inputsMatch()) {
      throw new ProjectRevisionError('source-changed');
    }
    signal.throwIfAborted();
    result.state = 'ready';
    result.render = checked.status;
    result.checks.layout = 'completed';
    result.diagnostics = [
      ...checked.status.errors.map((issue) => diagnostic(issue, 'error')),
      ...checked.status.warnings.map((issue) => diagnostic(issue, 'warning')),
    ];
    if (checked.preview) {
      const { bytes, mimeType, status: _status, ...metadata } = checked.preview;
      result.image = { ...metadata, mimeType, data: Buffer.from(bytes).toString('base64'), ...(draft ? { draft: true as const } : {}) };
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
        ['invalid-preview-request', 'preview-target-not-found', 'preview-capture-failed'].includes(error.code);
      if (phase === 'render' && !(error instanceof ProjectRevisionError)) {
        result.checks.layout = previewFailure
          ? error.code === 'preview-capture-failed' ? 'completed' : 'not-run'
          : 'failed';
      }
      result.diagnostics = [{
        code: error instanceof ProjectRevisionError || error instanceof PreviewError ? error.code : 'authoring-check-failed',
        stage: error instanceof ProjectRevisionError ? 'project' : previewFailure ? 'preview' : phase === 'template' ? 'project' : phase,
        severity: 'error', message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ProjectRevisionError && error.path ? { location: { path: error.path } } : {}),
      }];
    }
    // Compiler/render failures are only attributable to the captured revision if inputs stayed stable.
    if (result.revision) {
      try {
        if (!await inputsMatch()) {
          result.diagnostics = [{ code: 'source-changed', stage: 'project', severity: 'error',
            message: 'Project inputs changed during this check. Run it again for current diagnostics.' }];
        }
      } catch (captureError) {
        if (signal.aborted) throw error;
        result.diagnostics = [{ code: 'source-changed', stage: 'project', severity: 'error',
          message: 'Project inputs could not be verified after the check: ' +
            (captureError instanceof Error ? captureError.message : String(captureError)) }];
      }
    }
    return result;
  } finally {
    // The app also removes its cache root at shutdown. Cleanup must not replace a useful check result.
    if (privateCache && !retainedCache) await rm(privateCache, { recursive: true, force: true }).catch(() => {});
  }
}
