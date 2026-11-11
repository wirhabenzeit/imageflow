import { z } from 'zod';
import { previewRequestSchema } from './preview';
import { projectOperationsSchema } from './project-commands';

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
  }),
  inspect_book: z.strictObject({
    project,
    view: z.enum(['summary', 'spreads', 'sources', 'parameters']),
    offset: z.int().min(0).default(0),
    limit: z.int().min(1).max(100).default(30),
    spread: z.string().min(1).max(256).optional(),
  }),
  check_book: z.strictObject({ project, expectedRevision: revision.optional(), preview: previewRequestSchema.optional() })
    .superRefine((request, context) => {
      if (request.preview && 'page' in request.preview.target && !request.expectedRevision) {
        context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'Page-number previews require the inspected input revision.' });
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
  { name: 'get_authoring_context', readOnly: true, description: 'Read template declarations, authoring guidance and selected template or Markdown source files for one authorized project.' },
  { name: 'inspect_book', readOnly: true, description: 'Inspect a bounded set of saved spreads, sources or parameter values for one project. Use the returned revision for subsequent checks and commands.' },
  { name: 'check_book', readOnly: true, description: 'Refresh and bundle the project, check the whole-book layout, and optionally return a clean PNG or JPEG page or spread image with its revision and diagnostics. Coverage explicitly reports checks that were not run.' },
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
