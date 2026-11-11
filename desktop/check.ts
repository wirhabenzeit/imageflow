import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { authoringCheckSchema } from '../src/authoring-check';
import type { AuthoringCheckResult } from '../src/authoring-check';
import type { AuthoringDiagnostic } from '../src/authoring';
import type { RenderStatus } from '../src/desktop';
import type { PreviewRequest } from '../src/preview';
import { PreviewError } from '../src/preview';
import { captureProjectInputs, ProjectRevisionError } from './revisions';
import { loadProject, TemplateCompileError } from './project';
import type { OpenProject } from './project';
import type { BookPreview } from './preview';

type ReadyStatus = Extract<RenderStatus, { state: 'ready' }>;
type RenderCheck = (book: OpenProject, preview: PreviewRequest | undefined, signal: AbortSignal) => Promise<{
  status: ReadyStatus; preview?: BookPreview;
}>;

/** Read-only authoring check. The app supplies a private, temporary render session.
 * A check never adopts its disk reload into the editor or changes its Undo history.
 * Inputs are checked again after rendering; changed inputs invalidate the entire result.
 */
export async function checkProject(
  source: OpenProject, fallbackCache: string, request: unknown, render: RenderCheck, signal: AbortSignal,
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
  let inputs: Awaited<ReturnType<typeof captureProjectInputs>> | undefined;
  const inputsMatch = async () => {
    const current = await captureProjectInputs(source.folder, { signal });
    return inputs && current.revision === inputs.revision && current.observation === inputs.observation;
  };
  try {
    signal.throwIfAborted();
    inputs = await captureProjectInputs(source.folder, { signal });
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
    result.checks.bundle = 'passed';
    phase = 'render';
    const checked = await render(book, parsed.data.preview, signal);
    if (!await inputsMatch()) {
      throw new ProjectRevisionError('source-changed');
    }
    signal.throwIfAborted();
    result.state = 'ready';
    result.render = checked.status;
    result.checks.layout = 'completed';
    result.diagnostics = (['error', 'warning'] as const).flatMap((severity) =>
      checked.status[severity === 'error' ? 'errors' : 'warnings'].map((issue): AuthoringDiagnostic => ({
        code: severity === 'error' ? 'layout-error' : 'layout-warning', stage: 'render', severity,
        message: issue.message, location: { spread: issue.spread, where: issue.where },
      })));
    if (checked.preview) {
      const { bytes, mimeType, status: _status, ...metadata } = checked.preview;
      result.image = { ...metadata, mimeType, data: Buffer.from(bytes).toString('base64') };
    }
    return result;
  } catch (error) {
    // Cancellation must not replace a compiler/source/render failure that already occurred.
    if (signal.aborted) throw error;
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
    if (privateCache) await rm(privateCache, { recursive: true, force: true }).catch(() => {});
  }
}
