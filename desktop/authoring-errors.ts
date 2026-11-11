import { AuthoringError } from './authoring-service';
import { AuthoringQueueError, isAuthoringCancellation } from './authoring-queue';
import { TemplateCompileError } from './project';
import { ProjectRevisionError } from './revisions';
import { PreviewError } from '../src/preview';

type AuthoringErrorResult = { state: 'error'; error: { code: string; message: string; [key: string]: unknown } };

export function authoringErrorResult(error: unknown, signal: AbortSignal): AuthoringErrorResult {
  if (isAuthoringCancellation(error, signal)) {
    return { state: 'error', error: { code: 'CANCELLED', message: 'The request was cancelled.' } };
  }
  if (error instanceof AuthoringError) {
    return { state: 'error', error: { ...error.details, code: error.code, message: error.message } };
  }
  if (error instanceof AuthoringQueueError) {
    return { state: 'error', error: { code: error.code, message: error.message } };
  }
  if (error instanceof ProjectRevisionError) {
    return { state: 'error', error: {
      code: error.code.toUpperCase().replaceAll('-', '_'), message: error.message,
      ...(error.path !== undefined ? { path: error.path } : {}),
    } };
  }
  if (error instanceof TemplateCompileError) {
    return { state: 'error', error: { code: 'TEMPLATE_COMPILE_ERROR', message: error.message, diagnostics: error.diagnostics } };
  }
  if (error instanceof PreviewError) {
    return { state: 'error', error: { code: error.code.toUpperCase().replaceAll('-', '_'), message: error.message } };
  }
  return { state: 'error', error: { code: 'AUTHORING_FAILED',
    message: error instanceof Error ? error.message : 'ImageFlow could not complete the request.' } };
}
