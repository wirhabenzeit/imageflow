import { z } from 'zod';
import { makePreviewRequestSchema } from './preview';
import { projectOperationsSchema, spreadReference } from './project-commands';
import { makeInspectionSchema } from './inspection';
import { fixtureRequestSchema } from './fixtures';

const project = z.string().min(1).max(128).describe('Stable project handle returned by list_projects.');
const revision = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 input revision.');
const idempotencyKey = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/, 'Use a unique key with letters, digits, underscores or hyphens.');

function relativePath(prefixes: string[]) {
  return z.string().min(1).max(512).refine((path) => {
    if (path.includes('\\') || path.includes('\0')) return false;
    const parts = path.split('/');
    return parts.length > 1 && prefixes.includes(parts[0]) && parts.every((part) => part !== '' && part !== '.' && part !== '..');
  }, 'Use a project-relative path inside ' + prefixes.join(' or ') + '.');
}

const importFields = {
  project, expectedRevision: revision, idempotencyKey,
  paths: z.array(relativePath(['inbox'])).min(1).max(20),
};
const extensions = z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/)).min(1).max(20);

export const mcpToolSchemas = {
  list_projects: z.strictObject({}),
  get_authoring_context: z.strictObject({
    project,
    includeSource: z.array(relativePath(['template', 'texts'])).max(8).optional(),
    includeExamples: z.boolean().optional().describe('Also return the complete example templates shipped with the app.'),
  }),
  inspect_book: z.strictObject({
    project,
    view: z.enum(['summary', 'spreads', 'sources', 'parameters', 'elements']),
    offset: z.int().min(0).default(0),
    limit: z.int().min(1).max(100).default(30),
    spread: z.string().min(1).max(256).optional(),
    box: z.string().min(1).max(256).optional(), element: z.string().min(1).max(256).optional(),
  }).superRefine((request, context) => {
    if (request.view === 'elements' && !request.spread) context.addIssue({ code: 'custom', path: ['spread'], message: 'Element inspection requires a spread ID.' });
    if ((request.box || request.element) && request.view !== 'elements') context.addIssue({ code: 'custom', message: 'Box and element filters require the elements view.' });
    if (request.box && request.element) context.addIssue({ code: 'custom', message: 'Choose either a box or an element.' });
  }),
  check_book: z.strictObject({
    project, expectedRevision: revision.optional(),
    preview: makePreviewRequestSchema(spreadReference).optional(),
    inspect: makeInspectionSchema(spreadReference).optional(),
    typescript: z.boolean().optional().describe('Type-check template sources against the installed runtime in a bounded worker. Rendering still runs when types fail.'),
    draft: z.strictObject({ operations: projectOperationsSchema }).optional()
      .describe('Unsaved command batch, using the apply_project_changes operations, to render on top of the saved book. Nothing is saved.'),
    fixtures: fixtureRequestSchema.optional()
      .describe('Render layouts, including unused ones, with synthetic content in separate fixture books per format and report a coverage matrix. Nothing is saved.'),
  }).superRefine((request, context) => {
    if (request.fixtures && (request.preview || request.inspect || request.draft)) {
      context.addIssue({ code: 'custom', path: ['fixtures'], message: 'Fixture checks use fixtures.preview for images and cannot be combined with preview, inspect or draft.' });
    }
    if (request.preview && 'page' in request.preview.target && !request.expectedRevision) {
      context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'Page-number previews require the inspected input revision.' });
    }
    if (request.draft && !request.expectedRevision) {
      context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'Draft checks require the inspected input revision.' });
    }
    const target = request.preview?.target;
    const references = [...(target && 'spread' in target ? [target.spread] : target && 'spreads' in target ? target.spreads : []),
      ...(request.inspect ? [request.inspect.spread] : [])];
    if (references.some((id) => id.startsWith('$')) && !request.draft) {
      context.addIssue({ code: 'custom', path: ['preview', 'target', 'spread'], message: 'Batch references such as $chapter can only target spreads inserted by a draft.' });
    }
  }),
  apply_project_changes: z.strictObject({
    project, expectedRevision: revision, idempotencyKey,
    label: z.string().trim().min(1).max(120), operations: projectOperationsSchema,
    dryRun: z.boolean().default(false),
  }),
  import_sources: z.discriminatedUnion('kind', [
    z.strictObject({ ...importFields, kind: z.literal('photo') }),
    z.strictObject({ ...importFields, kind: z.literal('markdown') }),
    z.strictObject({ ...importFields, kind: z.literal('file'), accept: extensions }),
  ]),
};

export type McpToolName = keyof typeof mcpToolSchemas;
export type McpToolArguments = { [Name in McpToolName]: z.output<typeof mcpToolSchemas[Name]> };

export const mcpTools: { name: McpToolName; description: string; readOnly: boolean }[] = [
  { name: 'list_projects', readOnly: true, description: 'List projects authorized by the connected ImageFlow app and obtain their stable handles and input revisions.' },
  { name: 'get_authoring_context', readOnly: true, description: 'Read template declarations, authoring guidance, the installed template API capabilities and selected template or Markdown source files for one authorized project. includeExamples adds complete example templates to start from or copy layouts out of.' },
  { name: 'inspect_book', readOnly: true, description: 'Inspect saved spreads, sources or parameters. The elements view requires spread and measures box/element bounds in millimetres, computed typography, editable paths and assigned sources after whole-book text flow. Use the returned revision for checks and commands.' },
  { name: 'check_book', readOnly: true, description: 'Check whole-book layout and return revision-tagged diagnostics and optional native artwork. Set typescript:true for installed-runtime type checking; type errors do not suppress usable images. Preview target supports page, spread, spread+box/element close-ups, or spreads:[IDs] contact sheets (at most 12); guides/labels add opt-in trim, safe-area and box/element overlays. Layout errors carry the spread and template source line; text that runs out of its box or overlaps other text is reported per block. inspect requests bounded measured element geometry and typography. draft.operations renders unsaved changes; $aliases from inserted spreads work in preview and inspect targets. fixtures renders layouts (also unused ones) with synthetic typical, long, empty, portrait-photo and malformed-file content per format, reports tested/skipped coverage and returns a bannered fixture contact sheet that is never the saved book. Coverage reports checks not run.' },
  { name: 'apply_project_changes', readOnly: false, description: 'Apply an atomic, revision-checked project command batch through ImageFlow. A unique idempotencyKey makes retries safe. dryRun validates without saving. One applied batch creates one named Undo entry.' },
  { name: 'import_sources', readOnly: false, description: 'Import up to 20 files copied into this project’s inbox/ folder. Requires the current input revision and a unique idempotencyKey. Returns registered source IDs and import outcomes.' },
];

export function parseMcpArguments(name: string, args: unknown): { name: McpToolName; args: Record<string, unknown> } {
  if (!Object.hasOwn(mcpToolSchemas, name)) throw new Error('Unknown ImageFlow tool ' + name + '.');
  const tool = name as McpToolName;
  const parsed = mcpToolSchemas[tool].safeParse(args);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => (issue.path.length ? issue.path.join('.') + ': ' : '') + issue.message).join('\n'));
  }
  return { name: tool, args: parsed.data };
}

export const mcpLimits = {
  requestBytes: 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  clients: 8,
  callsPerClient: 4,
  handshakeMs: 5000,
  callMs: 120_000,
} as const;

// The stdio adapter and desktop service exchange one JSON object per line over their private socket.
export const mcpDescriptorSchema = z.strictObject({ socket: z.string().min(1).max(103), token: z.string().regex(/^[a-f0-9]{64}$/) });
export type McpDescriptor = z.infer<typeof mcpDescriptorSchema>;
const requestId = z.string().min(1).max(64);
export const mcpHelloSchema = z.strictObject({ type: z.literal('hello'), token: z.string(), name: z.string().trim().min(1).max(120) });
export const mcpCallSchema = z.strictObject({ type: z.literal('call'), id: requestId, name: z.string(), args: z.unknown() });
export const mcpCancelSchema = z.strictObject({ type: z.literal('cancel'), id: requestId });
export const mcpReplySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('result'), id: requestId, result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal('error'), id: requestId.optional(), error: z.strictObject({ code: z.string(), message: z.string() }) }),
]);
