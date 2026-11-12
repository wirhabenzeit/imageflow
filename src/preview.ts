import { z } from 'zod';
import type { PrintSide } from './format';
import { identifier } from './project';
import type { RenderStatus, TemplateInfo } from './desktop';

export const maxPreviewEdge = 1600;
const owner = identifier.refine((id) => id.length <= 256);
const paddingMm = z.number().min(0).max(20).default(2);
// `spread` validates the spread target. Draft checks also accept `$alias` batch references, resolved before rendering.
export const makePreviewRequestSchema = (spread: z.ZodType<string, string>) => z.strictObject({
  target: z.union([
    z.strictObject({ spread, side: z.enum(['left', 'right']).optional() }),
    z.strictObject({ page: z.int().positive() }),
    z.strictObject({ spread, box: owner, paddingMm }),
    z.strictObject({ spread, element: owner, paddingMm }),
    z.strictObject({ spreads: z.array(spread).min(1).max(12), columns: z.int().min(1).max(4).default(3) }),
  ]),
  bounds: z.enum(['trim', 'bleed']).default('trim'),
  maxEdge: z.int().min(1).max(maxPreviewEdge).default(1000),
  format: z.enum(['png', 'jpeg']).default('png'),
  guides: z.boolean().default(false).describe('Draw trim (magenta) and safe-area (cyan, dashed) guides over the artwork.'),
  labels: z.boolean().default(false).describe('Outline every box and element and label it with its ID.'),
}).refine((request) => !('spreads' in request.target) || request.maxEdge >= 128,
  'Contact sheets require maxEdge of at least 128 pixels.');
export const previewRequestSchema = makePreviewRequestSchema(identifier.refine((id) => id.length <= 256));

export type PreviewRequest = z.input<typeof previewRequestSchema>;
export type PagePreviewMetadata = {
  width: number;
  height: number;
  widthMm: number;
  heightMm: number;
  bounds: 'trim' | 'bleed';
  spread: string;
  side: PrintSide;
  page: { left?: number; right?: number; number?: number };
  // Axis-aligned crop, in millimetres from the full sheet's outer bleed corner.
  detail?: { box?: string; element?: string; xMm: number; yMm: number };
  // Present when the image carries requested guide or label overlays rather than clean artwork.
  guides?: true; labels?: true;
};
export type ContactSheetMetadata = {
  kind: 'contact-sheet'; width: number; height: number; bounds: 'trim' | 'bleed'; columns: number;
  // Present on synthetic fixture sheets: the banner text drawn across the top `height` pixels.
  banner?: { text: string; height: number };
  guides?: true; labels?: true;
  // Pixel positions address each image inside the contact sheet. Physical sizes belong to its cells, not the collage.
  cells: (PagePreviewMetadata & { x: number; y: number; label: string })[];
};
export type PreviewMetadata = PagePreviewMetadata | ContactSheetMetadata;

type PreviewErrorCode = 'invalid-preview-request' | 'preview-target-not-found' |
  'render-failed' | 'render-timeout' | 'preview-capture-failed';

export class PreviewError extends Error {
  // Declarations of a template that loaded before the book failed to render, when available.
  readonly template?: TemplateInfo;
  // Where the render failed: spreads, declarations or a stack, as the renderer reported them.
  readonly failure?: Pick<Extract<RenderStatus, { state: 'error' }>, 'layoutFailures' | 'declarationIssues' | 'stack'>;
  constructor(readonly code: PreviewErrorCode, message: string, options?: ErrorOptions & { template?: TemplateInfo;
    failure?: PreviewError['failure'] }) {
    super(message, options);
    this.name = 'PreviewError';
    if (options?.template) this.template = options.template;
    const { layoutFailures, declarationIssues, stack } = options?.failure ?? {};
    if (layoutFailures?.length || declarationIssues?.length || stack) {
      this.failure = { ...(layoutFailures?.length ? { layoutFailures } : {}), ...(declarationIssues?.length ? { declarationIssues } : {}), ...(stack ? { stack } : {}) };
    }
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
