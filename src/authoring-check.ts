import { z } from 'zod';
import type { AuthoringReport } from './authoring';
import type { RenderStatus, TemplateInfo } from './desktop';
import { previewRequestSchema } from './preview';
import type { PreviewMetadata } from './preview';
import { inspectionSchema } from './inspection';

export const authoringCheckSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 input revision.').optional(),
  preview: previewRequestSchema.optional(),
  inspect: inspectionSchema.optional(),
  typescript: z.boolean().optional(),
});
export type AuthoringCheckRequest = z.input<typeof authoringCheckSchema>;
export type AuthoringCheckResult = AuthoringReport & {
  state: 'ready' | 'error';
  checks: {
    bundle: 'passed' | 'failed' | 'not-run';
    layout: 'completed' | 'failed' | 'not-run';
    typescript: 'passed' | 'failed' | 'not-run';
    print: 'not-run';
  };
  render?: Extract<RenderStatus, { state: 'ready' }>;
  // Declarations of a template that loaded, compiled and validated before its book failed to render.
  template?: TemplateInfo;
  typecheck?: { files: string[]; totalDiagnostics: number; truncated: boolean; elapsedMs: number };
  image?: PreviewMetadata & { mimeType: 'image/png' | 'image/jpeg'; data: string; draft?: true };
  // Present when the check rendered an unsaved command batch on top of the saved book.
  draft?: AuthoringDraftSummary;
};
export type AuthoringDraftSummary = {
  applied: boolean; committed: false;
  changes?: string[]; affectedSpreads?: string[]; references?: Record<string, string>; reflow?: boolean;
};
