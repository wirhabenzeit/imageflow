import { z } from 'zod';
import type { PrintSide } from './format';
import { identifier } from './project';

export const maxPreviewEdge = 1600;
export const previewRequestSchema = z.strictObject({
  target: z.union([
    z.strictObject({ spread: identifier.refine((id) => id.length <= 256), side: z.enum(['left', 'right']).optional() }),
    z.strictObject({ page: z.int().positive() }),
  ]),
  bounds: z.enum(['trim', 'bleed']).default('trim'),
  maxEdge: z.int().min(1).max(maxPreviewEdge).default(1000),
  format: z.enum(['png', 'jpeg']).default('png'),
});

export type PreviewRequest = z.input<typeof previewRequestSchema>;
export type PreviewMetadata = {
  width: number;
  height: number;
  widthMm: number;
  heightMm: number;
  bounds: 'trim' | 'bleed';
  spread: string;
  side: PrintSide;
  page: { left?: number; right?: number };
};

type PreviewErrorCode = 'invalid-preview-request' | 'preview-target-not-found' |
  'render-failed' | 'render-timeout' | 'preview-capture-failed';

export class PreviewError extends Error {
  constructor(readonly code: PreviewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PreviewError';
  }
}

export function parsePreviewRequest(value: unknown) {
  const parsed = previewRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join('.');
    throw new PreviewError('invalid-preview-request', 'Invalid preview request' + (path ? ' (' + path + ')' : '') + '. ' + issue.message);
  }
  return parsed.data;
}

declare global {
  interface Window {
    imageflowPreview?: { state: 'ready'; metadata: PreviewMetadata } | { state: 'error'; code: PreviewErrorCode };
  }
}
