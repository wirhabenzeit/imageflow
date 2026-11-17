import { z } from 'zod';
import { makePreviewRequestSchema } from './preview';
import { projectOperationsSchema, spreadReference } from './project-commands';
import { makeInspectionSchema } from './inspection';
import { fixtureRequestSchema } from './fixtures';
import { docTopicIds } from './doc-topics';
import { mcpOutputSchemas } from './mcp-results';
export { mcpOutputSchemas };

const project = z.string().min(1).max(128).describe('Book handle from list_projects.');
const revision = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 input revision.')
  .describe('The revision returned by the latest inspect, check or context call. The call fails with REVISION_CONFLICT when the book changed since.');
const idempotencyKey = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/, 'Use a unique key with letters, digits, underscores or hyphens.')
  .describe('A new unique key for each intended change. Retrying with the same key and request returns the original result instead of applying it again.');

function relativePath(prefixes: string[]) {
  return z.string().min(1).max(512).refine((path) => {
    if (path.includes('\\') || path.includes('\0')) return false;
    const parts = path.split('/');
    return parts.length > 1 && prefixes.includes(parts[0]) && parts.every((part) => part !== '' && part !== '.' && part !== '..');
  }, 'Use a project-relative path inside ' + prefixes.join(' or ') + '.');
}

const importFields = {
  project, expectedRevision: revision, idempotencyKey,
  paths: z.array(relativePath(['inbox']).describe('A file you copied into the book, such as inbox/IMG_0042.jpg.')).min(1).max(20)
    .describe('Up to 20 files inside the book\'s inbox/ folder, at most 100 MB together. Each must match kind.'),
};
const extensions = z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/).describe('A lower-case extension with its dot, such as .gpx.')).min(1).max(20)
  .describe('Extensions the file parameter accepts, matching its accept option.');

export const mcpToolSchemas = {
  list_projects: z.strictObject({}),
  get_authoring_context: z.strictObject({
    project,
    docs: z.array(z.enum(docTopicIds)).max(12).optional()
      .describe('Template API reference topics to return in full, by ID from topics. Start with authoring-workflow.'),
    includeExamples: z.union([z.boolean(), z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).min(1).max(12)]).optional()
      .describe('Example template sources to return: names from examples, or true for all of them. Every example is always listed by name and description.'),
    includeSource: z.array(relativePath(['template', 'texts']).describe('A path from templateFiles, or a Markdown file under texts/.')).max(8).optional()
      .describe('Template or Markdown files to return, at most 32,000 characters each. Defaults to none; template already carries the parsed declarations.'),
  }),
  inspect_book: z.strictObject({
    project,
    view: z.enum(['summary', 'spreads', 'sources', 'parameters', 'elements'])
      .describe('summary: title, format, pages and template identity. spreads: saved spreads with their pages and contents. sources: photos, texts and files with capture metadata and where they are used. parameters: saved values next to their declarations. elements: measured bounds, typography and edit paths of the boxes and elements of one spread.'),
    offset: z.int().min(0).default(0).describe('Index of the first item to return, for paging.'),
    limit: z.int().min(1).max(100).default(30).describe('Number of items to return. Continue from nextOffset.'),
    spread: z.string().min(1).max(256).optional().describe('Spread ID. Required by the elements view; filters the spreads and parameters views.'),
    page: z.enum(['left', 'right']).optional().describe('Elements view only: facing page of a split sheet.'),
    box: z.string().min(1).max(256).optional().describe('Elements view only: measure just this box.'),
    element: z.string().min(1).max(256).optional().describe('Elements view only: measure just this element.'),
  }).superRefine((request, context) => {
    if (request.page && request.view !== 'elements') context.addIssue({ code: 'custom', message: 'Page filtering requires the elements view.' });
    if (request.view === 'elements' && !request.spread) context.addIssue({ code: 'custom', path: ['spread'], message: 'Element inspection requires a spread ID.' });
    if ((request.box || request.element) && request.view !== 'elements') context.addIssue({ code: 'custom', message: 'Box and element filters require the elements view.' });
    if (request.box && request.element) context.addIssue({ code: 'custom', message: 'Choose either a box or an element.' });
  }),
  check_book: z.strictObject({
    project,
    expectedRevision: revision.optional()
      .describe('Check exactly this revision. Required for page-number previews and drafts; a changed book returns a revision-conflict diagnostic.'),
    preview: makePreviewRequestSchema(spreadReference).optional()
      .describe('Return a rendered image of a page, a spread, a close-up of one box or element, or a contact sheet of several spreads.'),
    inspect: makeInspectionSchema(spreadReference).optional()
      .describe('Also measure the boxes and elements of one spread, as inspect_book does, in the same render as the preview or draft.'),
    typescript: z.boolean().optional()
      .describe('Type-check the template sources against the installed runtime in a bounded worker. Rendering still runs when types fail.'),
    draft: z.strictObject({ operations: projectOperationsSchema }).optional()
      .describe('Unsaved command batch, in the apply_project_changes format, rendered on top of the saved book. Preview and inspect targets may name spreads it inserts by $ref. Nothing is saved.'),
    fixtures: fixtureRequestSchema.optional()
      .describe('Render layouts, including unused ones, with synthetic typical, long, empty, portrait-photo and malformed-file content in separate fixture books per format, and report a coverage matrix. Nothing is saved.'),
  }).superRefine((request, context) => {
    if (request.fixtures && (request.preview || request.inspect || request.draft)) {
      context.addIssue({ code: 'custom', path: ['fixtures'], message: 'Fixture checks use fixtures.preview for images and cannot be combined with preview, inspect or draft.' });
    }
    if (request.preview && 'page' in request.preview.target && !('spread' in request.preview.target) && !request.expectedRevision) {
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
    label: z.string().trim().min(1).max(120).describe('Name of the change in the Undo menu, such as "Add chapter spreads".'),
    operations: projectOperationsSchema,
    dryRun: z.boolean().default(false).describe('Validate and report the changes without saving them.'),
  }),
  rebuild_dependencies: z.strictObject({ project }),
  list_templates: z.strictObject({}),
  save_template_to_library: z.strictObject({
    project,
    replaceHash: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a template hash from list_templates.').optional()
      .describe('Hash of the library entry with the same ID that this save may replace, from list_templates or a conflict result. Needed to replace a built-in template, the same version with other files, or a later version.'),
  }),
  import_sources: z.discriminatedUnion('kind', [
    z.strictObject({ ...importFields, kind: z.literal('photo').describe('Import photos (.jpg, .jpeg, .png or .webp).') }),
    z.strictObject({ ...importFields, kind: z.literal('markdown').describe('Import Markdown texts (.md).') }),
    z.strictObject({ ...importFields, kind: z.literal('file').describe('Import files for file parameters, such as GPX tracks.'), accept: extensions }),
  ]),
};

export type McpToolName = keyof typeof mcpToolSchemas;
export type McpToolArguments = { [Name in McpToolName]: z.output<typeof mcpToolSchemas[Name]> };

// Descriptions say what each tool is for and when to call it; the facts about each argument are on its schema field.
export const mcpTools: { name: McpToolName; title: string; description: string; readOnly: boolean }[] = [
  { name: 'list_projects', title: 'List open books', readOnly: true,
    description: 'List the books open in ImageFlow that agents may use, with their handles and current input revisions. Call it first.' },
  { name: 'get_authoring_context', title: 'Get authoring context', readOnly: true,
    description: 'Read a book\'s parsed template declarations, template identity, template files and the table of contents of the template API reference. Call it before editing a template; request reference topics, example templates and source files with docs, includeExamples and includeSource.' },
  { name: 'inspect_book', title: 'Inspect book', readOnly: true,
    description: 'Read a book\'s saved spreads, sources or parameter values, or measure the boxes and elements of one spread. Returns the revision to pass to checks and commands.' },
  { name: 'check_book', title: 'Check book', readOnly: true,
    description: 'Render the whole book and return diagnostics, optionally with a preview image, type checking, an unsaved draft or synthetic layout fixtures. Call it after every edit; it never saves.' },
  { name: 'apply_project_changes', title: 'Apply changes', readOnly: false,
    description: 'Save a batch of project commands (spreads, layouts, parameters, sources, crops, photo metadata) atomically as one named Undo step. Use it for project.json and photos.json instead of editing them.' },
  { name: 'rebuild_dependencies', title: 'Rebuild template dependencies', readOnly: false,
    description: 'Install the npm packages listed in template/package.json outside the book, in a cache ImageFlow manages, and bundle the ones the template imports into template/vendor/, which is all the book renders. Call it after changing template/package.json or adding a package import; never run npm install in template/. A long install answers state "installing": call again until it is "ready", then check_book.' },
  { name: 'list_templates', title: 'List library templates', readOnly: true,
    description: 'List the templates new books are made from: built-in and imported entries with ID, version, hash, formats, layouts, packages and network sites. Compare hashes with a book\'s templateIdentity.' },
  { name: 'save_template_to_library', title: 'Save template to library', readOnly: false,
    description: 'Validate a book\'s template/ folder and save it into the template library, so New Book offers it. Raise version for a changed template. A conflict result names the entry it would replace; pass its hash as replaceHash only when the user wants it replaced.' },
  { name: 'import_sources', title: 'Import sources', readOnly: false,
    description: 'Register files you copied into the book\'s inbox/ folder as photos, Markdown texts or files, and return their source IDs for assign_source or file parameters.' },
];

/** The JSON Schemas a tool advertises. Schemas used more than once, such as the command union that check_book drafts and
 * apply_project_changes share, are emitted once under $defs. MCP requires an object at the input root, including
 * tools with discriminated argument unions. */
export function advertisedSchemas(name: McpToolName) {
  return {
    input: { ...z.toJSONSchema(mcpToolSchemas[name], { io: 'input', reused: 'ref' }), type: 'object' as const },
    output: z.toJSONSchema(mcpOutputSchemas[name], { io: 'output', reused: 'ref' }),
  };
}

// The tools a running app serves, with their schemas. The bridge an agent started can outlive an app update; it asks
// the app for this on every new connection and serves these instead of the copy it was built with, so new tools and
// arguments work without restarting the agent. Older apps answer this name with an unknown-tool error.
export const mcpCatalogCall = '__imageflow_tool_catalog';
export type McpCatalogTool = { name: string; title: string; description: string; readOnly: boolean; input: Record<string, unknown>; output: Record<string, unknown> };
export function mcpCatalog(): McpCatalogTool[] {
  return mcpTools.map((tool) => ({ ...tool, ...advertisedSchemas(tool.name) }));
}

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
