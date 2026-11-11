import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { AuthoringDiagnostic } from '../src/authoring';

export type TypecheckResult = {
  diagnostics: AuthoringDiagnostic[]; files: string[]; totalDiagnostics: number; truncated: boolean; elapsedMs: number;
};
export type Typecheck = (folder: string, signal: AbortSignal) => Promise<TypecheckResult>;

/** The compiler runs off the app thread. Its worker reads only template sources and installed declarations/libs,
 * never executes template code, and is terminated on cancellation, timeout or completion. */
export function checkTemplateTypes(folder: string, signal: AbortSignal, runtimeRoot: string, timeoutMs = 15_000): Promise<TypecheckResult> {
  signal.throwIfAborted();
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(runtimeRoot, 'typecheck-worker.cjs'), {
      workerData: { folder, typesRoot: join(runtimeRoot, 'authoring-types') },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (result?: TypecheckResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve({ ...result!, elapsedMs: Math.round(performance.now() - started) });
    };
    const fail = (code: string, message: string) => finish({ files: [], totalDiagnostics: 1, truncated: false, elapsedMs: 0,
      diagnostics: [{ code, stage: 'template', severity: 'error', message }] });
    const abort = () => finish(undefined, signal.reason);
    const timer = setTimeout(() => fail('typescript-timeout', 'Type checking exceeded 15 seconds. Reduce template complexity and try again.'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.once('message', (result: TypecheckResult) => finish(result));
    worker.once('error', () => fail('typescript-unavailable', 'The installed template type checker could not complete.'));
    worker.once('exit', () => { if (!settled) fail('typescript-unavailable', 'The template type checker stopped without a result.'); });
  });
}
