import { z } from 'zod';
import type { AuthoringDiagnostic, AuthoringReport } from './authoring';
import type { FixtureCase, FixtureSkip } from './fixtures';
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
    // The template's default export satisfies the template contract, and its ID matches project.json.
    declarations: 'passed' | 'failed' | 'not-run';
    layout: 'completed' | 'failed' | 'not-run';
    typescript: 'passed' | 'failed' | 'not-run';
    // Synthetic fixture renders of layouts, separate from the saved book's layout check.
    fixtures: 'completed' | 'failed' | 'not-run';
    print: 'not-run';
  };
  render?: Extract<RenderStatus, { state: 'ready' }>;
  // Declarations of a template that loaded, compiled and validated before its book failed to render.
  template?: TemplateInfo;
  typecheck?: { files: string[]; totalDiagnostics: number; truncated: boolean; elapsedMs: number };
  image?: PreviewMetadata & { mimeType: 'image/png' | 'image/jpeg'; data: string; draft?: true; fixture?: true };
  // Present when the check rendered an unsaved command batch on top of the saved book.
  draft?: AuthoringDraftSummary;
  // Present when the check rendered synthetic layout fixtures.
  fixtures?: FixtureReport;
};
export type FixtureCellReport = {
  layout: string; case: FixtureCase; format: string; label: string;
  // `failed`: the layout threw or the fixture book could not render; `not-isolated`: a render with other fixtures failed
  // and the isolation budget ran out before this fixture rendered on its own.
  state: 'passed' | 'warnings' | 'errors' | 'failed' | 'not-isolated';
  errors: number; warnings: number; codes: string[]; message?: string;
};
export type FixtureReport = {
  synthetic: true; committed: false;
  // Revision of the saved inputs (template, document parameters) the fixtures were rendered from.
  revision: string | null;
  matrix: { layouts: string[]; formats: string[]; cases: FixtureCase[] };
  coverage: { planned: number; rendered: number; failed: number; notIsolated: number; skipped: FixtureSkip[] };
  cells: FixtureCellReport[];
  // Findings in fixture books, located by layout, case and format instead of a saved spread.
  diagnostics: (AuthoringDiagnostic & { fixture: { layout: string; case: FixtureCase; format: string } })[];
  diagnosticsTruncated: boolean;
  // Checks that synthetic books cannot answer; the saved-book check and print preflight cover them.
  notEvaluated: string[];
};
export type AuthoringDraftSummary = {
  applied: boolean; committed: false;
  changes?: string[]; affectedSpreads?: string[]; references?: Record<string, string>; reflow?: boolean;
};
