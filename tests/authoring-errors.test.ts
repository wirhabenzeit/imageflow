import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthoringDiagnostic, RevisionDiagnosticCode } from '../src/authoring';
import { authoringErrorResult } from '../desktop/authoring-errors';
import { AuthoringError } from '../desktop/authoring-service';
import { AuthoringQueueError } from '../desktop/authoring-queue';
import { TemplateCompileError } from '../desktop/project';
import { ProjectRevisionError } from '../desktop/revisions';
import { PreviewError } from '../src/preview';

test('actual cancellation and its Node abort wrapper are classified by their request signal', () => {
  const controller = new AbortController();
  const reason = new Error('Request cancelled');
  const wrapper = new Error('The operation was aborted', { cause: reason });
  wrapper.name = 'AbortError';
  assert.equal(authoringErrorResult(reason, controller.signal).error.code, 'AUTHORING_FAILED');
  controller.abort(reason);
  const expected = { state: 'error', error: { code: 'CANCELLED', message: 'The request was cancelled.' } };
  assert.deepEqual(authoringErrorResult(reason, controller.signal), expected);
  assert.deepEqual(authoringErrorResult(wrapper, controller.signal), expected);
  const unrelated = new Error('Another request aborted');
  unrelated.name = 'AbortError';
  assert.deepEqual(authoringErrorResult(unrelated, controller.signal), {
    state: 'error', error: { code: 'AUTHORING_FAILED', message: 'Another request aborted' },
  });
});

test('structured authoring failures retain their code and details after unrelated cancellation', () => {
  const controller = new AbortController();
  controller.abort(new Error('Late cancellation'));
  const error = new AuthoringError('REVISION_CONFLICT', 'Inspect the current revision.', {
    currentRevision: 'a'.repeat(64), operationIndex: 2, committed: false,
  });
  assert.deepEqual(authoringErrorResult(error, controller.signal), {
    state: 'error', error: { code: 'REVISION_CONFLICT', message: 'Inspect the current revision.',
      currentRevision: 'a'.repeat(64), operationIndex: 2, committed: false },
  });
  const reserved = new AuthoringError('SOURCE_CHANGED', 'Inputs changed.', { code: 'old-code', message: 'Old message' });
  assert.deepEqual(authoringErrorResult(reserved, controller.signal), {
    state: 'error', error: { code: 'SOURCE_CHANGED', message: 'Inputs changed.' },
  });
});

test('queue errors retain the bounded queue and revoked connection codes', () => {
  const signal = new AbortController().signal;
  for (const code of ['AUTHORING_QUEUE_FULL', 'AUTHORING_QUEUE_CLOSED'] as const) {
    const error = new AuthoringQueueError(code, 'Wait or reconnect.');
    assert.deepEqual(authoringErrorResult(error, signal), { state: 'error', error: { code, message: error.message } });
  }
});

test('revision capture failures expose stable transport codes and the affected input path', () => {
  const signal = AbortSignal.abort(new Error('An unrelated request cancellation'));
  const codes: RevisionDiagnosticCode[] = ['source-changed', 'source-missing', 'source-outside-project', 'source-unreadable'];
  for (const code of codes) {
    const error = new ProjectRevisionError(code, 'template/index.tsx');
    assert.deepEqual(authoringErrorResult(error, signal), {
      state: 'error', error: { code: code.toUpperCase().replaceAll('-', '_'), message: error.message, path: 'template/index.tsx' },
    });
  }
  assert.equal(Object.hasOwn(authoringErrorResult(new ProjectRevisionError('source-changed'), signal).error, 'path'), false);
});

test('compilation failures retain source diagnostics when cancellation arrives concurrently', () => {
  const diagnostics: AuthoringDiagnostic[] = [{ code: 'template-compile-error', severity: 'error', stage: 'template',
    message: 'Expected an expression.', location: { path: 'template/index.tsx', line: 4, column: 8 } }];
  const error = new TemplateCompileError('The template could not be bundled.', diagnostics);
  const signal = AbortSignal.abort(new Error('Late cancellation'));
  assert.deepEqual(authoringErrorResult(error, signal), {
    state: 'error', error: { code: 'TEMPLATE_COMPILE_ERROR', message: error.message, diagnostics },
  });
});

test('fallback failures preserve Error messages and use the app message for unknown values', () => {
  const signal = new AbortController().signal;
  assert.deepEqual(authoringErrorResult(new Error('Disk unavailable'), signal), {
    state: 'error', error: { code: 'AUTHORING_FAILED', message: 'Disk unavailable' },
  });
  for (const error of [undefined, null, 7, 'Unexpected rejection']) {
    assert.deepEqual(authoringErrorResult(error, signal), {
      state: 'error', error: { code: 'AUTHORING_FAILED', message: 'ImageFlow could not complete the request.' },
    });
  }
});

test('preview failures retain their specific code when cancellation arrives concurrently', () => {
  const signal = AbortSignal.abort(new Error('Late cancellation'));
  const error = new PreviewError('preview-target-not-found', 'The requested spread has no left page.');
  assert.deepEqual(authoringErrorResult(error, signal), {
    state: 'error', error: { code: 'PREVIEW_TARGET_NOT_FOUND', message: error.message },
  });
});
