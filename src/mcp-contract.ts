import { z } from 'zod';
import { makePreviewRequestSchema, previewTargets } from './preview';
import { projectOperationNames, projectOperationsSchema, spreadReference } from './project-commands';
import { makeInspectionSchema } from './inspection';
import { fixtureRequestSchema } from './fixtures';
import { capturedSchema, maxSheetPhotos, photoSheetSchema } from './photo-sheet';
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
  .describe('Required with kind file: the extensions the file parameter accepts, matching its accept option.');

export const mcpToolSchemas = {
  list_projects: z.strictObject({}),
  get_authoring_context: z.strictObject({
    project,
    docs: z.array(z.enum(docTopicIds)).max(12).optional()
      .describe('Template API reference topics to return in full, by ID from topics. Start with authoring-workflow.'),
    includeExamples: z.union([z.boolean(), z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).min(1).max(12)]).optional()
      .describe('Example sources to include. Pass names from examples, or true for all.'),
    includeSource: z.array(relativePath(['template', 'texts']).describe('A path from templateFiles, or a Markdown file under texts/.')).max(8).optional()
      .describe('Template or Markdown files to return, up to 32,000 characters each.'),
    includeTemplate: z.boolean().optional()
      .describe('With docs, includeExamples or includeSource, also return declarations, files, topics and capabilities.'),
  }),
  inspect_book: z.strictObject({
    project,
    view: z.enum(['summary', 'spreads', 'cover', 'sources', 'parameters', 'elements'])
      .describe('summary: book details and the spread count, without the spreads. spreads and cover: saved layout state; split sheets give restoreDefinition, not definition. sources: registry, usage and counts per kind. parameters: saved values and declarations. elements: bounds, typography and edit paths.'),
    offset: z.int().min(0).default(0).describe('Index of the first item to return, for paging.'),
    limit: z.int().min(1).max(100).optional().describe('Number of items to return, by default 30, or every named photo. Continue from nextOffset.'),
    spread: z.string().min(1).max(256).optional().describe('Spread ID for element measurements or to filter spreads and parameters.'),
    cover: z.literal(true).optional().describe('Elements view only: measure the exterior cover.'),
    page: z.enum(['left', 'right']).optional().describe('Elements view only: facing page of a split sheet.'),
    box: z.string().min(1).max(256).optional().describe('Elements view only: measure just this box.'),
    element: z.string().min(1).max(256).optional().describe('Elements view only: measure just this element.'),
    kind: z.enum(['photo', 'text', 'file']).optional().describe('Sources view only: list just photos, texts or files. The counts per kind are always returned.'),
    photos: z.array(z.string().min(1).max(256)).min(1).max(maxSheetPhotos).optional().describe('Sources view: just these photos, in order.'),
    unplaced: z.literal(true).optional().describe('Sources view: just photos no page or cover shows, by capture time.'),
    captured: capturedSchema.optional().describe('Sources view: just photos taken in this camera-local time range, by capture time.'),
    sheet: photoSheetSchema.optional().describe('Sources view: also an image of the listed photos, uncropped, with ID and capture time. At most ' + maxSheetPhotos + '.'),
  }).superRefine((request, context) => {
    if (request.kind && request.view !== 'sources') context.addIssue({ code: 'custom', path: ['kind'], message: 'Kind filtering requires the sources view.' });
    for (const option of ['photos', 'unplaced', 'captured', 'sheet'] as const) {
      if (request[option] === undefined) continue;
      if (request.view !== 'sources') context.addIssue({ code: 'custom', path: [option], message: option + ' requires the sources view.' });
      else if (request.kind && request.kind !== 'photo') context.addIssue({ code: 'custom', path: [option], message: option + ' is about photos; use kind photo or omit it.' });
    }
    if (request.sheet && request.limit !== undefined && request.limit > maxSheetPhotos) context.addIssue({ code: 'custom', path: ['limit'], message: 'A sheet shows at most ' + maxSheetPhotos + ' photos.' });
    if (request.page && request.view !== 'elements') context.addIssue({ code: 'custom', message: 'Page filtering requires the elements view.' });
    if (request.view === 'elements' && (request.cover ? !!request.spread || !!request.page : !request.spread)) {
      context.addIssue({ code: 'custom', message: 'Element inspection requires one spread or cover: true.' });
    }
    if (request.cover && request.view !== 'elements') context.addIssue({ code: 'custom', message: 'For saved cover state, use view: cover.' });
    if ((request.box || request.element) && request.view !== 'elements') context.addIssue({ code: 'custom', message: 'Box and element filters require the elements view.' });
    if (request.box && request.element) context.addIssue({ code: 'custom', message: 'Choose either a box or an element.' });
  }),
  check_book: z.strictObject({
    project,
    cover: z.literal(true).optional().describe('Check the exterior cover.'),
    includeTemplate: z.boolean().optional().describe('Include full template declarations and render summary.'),
    include: z.array(z.enum(['units', 'flow', 'anchors', 'occurrences'])).max(4).optional()
      .describe('Render lists to return for the whole book, not just the addressed spreads; occurrences: every place of a finding.'),
    expectedRevision: revision.optional()
      .describe('Required for drafts and page-number previews. Changed inputs return revision-conflict.'),
    preview: makePreviewRequestSchema(spreadReference).optional()
      .describe('Render artwork of a page, spread, cover, box, element or contact sheet.'),
    inspect: makeInspectionSchema(spreadReference).optional()
      .describe('Measure boxes and elements of one cover or spread.'),
    typescript: z.boolean().optional()
      .describe('Check template types against the installed runtime.'),
    draft: z.strictObject({ operations: projectOperationsSchema }).optional()
      .describe('Render unsaved commands. Preview and inspect can address inserted spreads by $ref.'),
    fixtures: fixtureRequestSchema.optional()
      .describe('Render layouts with synthetic content per format and report coverage.'),
  }).superRefine((request, context) => {
    if (request.fixtures && (request.cover || request.preview || request.inspect || request.draft)) {
      context.addIssue({ code: 'custom', path: ['fixtures'], message: 'Fixture checks cannot be combined with cover, preview, inspect or draft.' });
    }
    if (request.preview && 'page' in request.preview.target && !('spread' in request.preview.target) && !request.expectedRevision) {
      context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'Page-number previews require the inspected input revision.' });
    }
    if (request.draft && !request.expectedRevision) {
      context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'Draft checks require the inspected input revision.' });
    }
    const target = request.preview?.target;
    const references = [...(target && 'spread' in target ? [target.spread] : target && 'spreads' in target ? target.spreads : []),
      ...(request.inspect?.spread ? [request.inspect.spread] : [])];
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
  list_book_checkpoints: z.strictObject({
    project,
    idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional()
      .describe('Only checkpoints committed with this key, such as a request whose reply was lost.'),
    cursor: z.string().uuid().optional().describe('nextCursor from the previous page.'),
    limit: z.int().min(1).max(100).default(20).describe('Number of checkpoints to return, newest first.'),
    include: z.array(z.enum(['changes'])).max(1).optional()
      .describe('changes: each agent checkpoint\'s full lists of changes, affected spreads, references and sources, instead of their counts.'),
  }),
  rebuild_dependencies: z.strictObject({ project }),
  list_templates: z.strictObject({}),
  read_library_template: z.strictObject({
    template: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/).describe('Template ID from list_templates.'),
    path: z.string().min(1).max(512).optional().describe('A text file from the file list, such as index.tsx. Without it, lists the files.'),
    project: project.optional().describe('Compare the file list with this book\'s template/.'),
  }),
  save_template_to_library: z.strictObject({
    project,
    replaceHash: z.string().regex(/^[a-f0-9]{64}$/, 'Expected a template hash from list_templates.').optional()
      .describe('Hash of the library entry with the same ID that this save may replace, from list_templates or a conflict result. Needed to replace a built-in template, the same version with other files, or a later version.'),
  }),
  // One object, not a union by kind: clients that show only top-level properties would show none (API-016).
  import_sources: z.strictObject({ ...importFields,
    kind: z.enum(['photo', 'markdown', 'file']).describe('photo: .jpg, .jpeg, .png or .webp. markdown: .md texts. file: for file parameters, such as GPX tracks.'),
    accept: extensions.optional(),
  }).superRefine(({ kind, accept }, context) => {
    if (kind === 'file' && !accept) context.addIssue({ code: 'custom', path: ['accept'], message: 'Name the extensions the file parameter accepts.' });
    if (kind !== 'file' && accept) context.addIssue({ code: 'custom', path: ['accept'], message: 'accept is only for kind file.' });
  }),
  rename_source: z.strictObject({
    project, expectedRevision: revision, idempotencyKey,
    source: z.string().min(1).max(256).describe('ID of a text or file stored in the book, not linked.'),
    name: z.string().trim().min(1).max(200).describe('New file name. The extension is kept.'),
  }),
};

export type McpToolName = keyof typeof mcpToolSchemas;
export type McpToolArguments = { [Name in McpToolName]: z.output<typeof mcpToolSchemas[Name]> };

// Descriptions say what each tool is for and when to call it; the facts about each argument are on its schema field.
export const mcpTools: { name: McpToolName; title: string; description: string; readOnly: boolean }[] = [
  { name: 'list_projects', title: 'List open books', readOnly: true,
    description: 'List authorized open books with their handles and revisions. Call first.' },
  { name: 'get_authoring_context', title: 'Get authoring context', readOnly: true,
    description: 'Read parsed declarations, template identity and files. Before editing a template, request reference topics, examples and source files: those calls return just what they request.' },
  { name: 'inspect_book', title: 'Inspect book', readOnly: true,
    description: 'Read saved spreads, cover, sources or parameters, see photos that are not placed, or measure layout elements. Returns the revision for checks and commands.' },
  { name: 'check_book', title: 'Check book', readOnly: true,
    description: 'Check content or the exterior cover without saving. Supports previews, type checks, drafts and synthetic fixtures.' },
  { name: 'apply_project_changes', title: 'Apply changes', readOnly: false,
    description: 'Save commands atomically as one Undo step. See get_authoring_context with docs: ["project-commands"] for examples.' },
  { name: 'list_book_checkpoints', title: 'List book checkpoints', readOnly: true,
    description: 'List saved project and photo manifests, newest first. Look up a lost reply by idempotencyKey after reopening.' },
  { name: 'rebuild_dependencies', title: 'Rebuild template dependencies', readOnly: false,
    description: 'Install the npm packages listed in template/package.json outside the book, in a cache ImageFlow manages, and bundle the ones the template imports into template/vendor/, which is all the book renders. Call it after changing template/package.json or adding a package import; never run npm install in template/. A long install answers state "installing": call again until it is "ready", then check_book.' },
  { name: 'list_templates', title: 'List library templates', readOnly: true,
    description: 'List built-in and imported templates. Compare their hashes with a book\'s templateIdentity.' },
  { name: 'read_library_template', title: 'Read library template', readOnly: true,
    description: 'List a library template\'s files, or read one, such as a newer starter\'s, to port its changes into a book\'s fork. With project, says which files differ from the book\'s template/.' },
  { name: 'save_template_to_library', title: 'Save template to library', readOnly: false,
    description: 'Validate a book\'s template/ folder and save it into the template library, so New Book offers it. Raise version for a changed template. A conflict result names the entry it would replace; pass its hash as replaceHash only when the user wants it replaced.' },
  { name: 'import_sources', title: 'Import sources', readOnly: false,
    description: 'Register files you copied into the book\'s inbox/ folder as photos, Markdown texts or files, and return their source IDs for assign_source or file parameters.' },
  { name: 'rename_source', title: 'Rename source', readOnly: false,
    description: 'Rename a stored text or file, as Rename… in Assets does. Its ID and assignments stay. Photos are named by title (set_photo_metadata). Not undoable.' },
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

// A preview target that fits no shape is answered with the list of shapes. When one shape fits its keys, that shape's
// own issues (an invalid spread ID, an unknown page side) are what the agent has to fix, so those are reported instead.
function previewTargetIssues(issue: z.core.$ZodIssue, args: unknown): z.core.$ZodIssue[] {
  if (issue.code !== 'invalid_union' || issue.path.at(-2) !== 'preview' || issue.path.at(-1) !== 'target') return [issue];
  const target = issue.path.reduce<unknown>((value, key) =>
    typeof value === 'object' && value !== null ? (value as Record<PropertyKey, unknown>)[key] : undefined, args);
  const present = (key: PropertyKey) => typeof target === 'object' && target !== null && Object.hasOwn(target, key);
  const fitting = issue.errors.find((branch) => branch.every((inner) =>
    inner.code !== 'unrecognized_keys' && (!inner.path.length || present(inner.path[0]))));
  return fitting ? fitting.map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] })) : [{ ...issue, message: previewTargets }];
}

export function parseMcpArguments(name: string, args: unknown): { name: McpToolName; args: Record<string, unknown> } {
  if (!Object.hasOwn(mcpToolSchemas, name)) throw new Error('Unknown ImageFlow tool ' + name + '.');
  const tool = name as McpToolName;
  const parsed = mcpToolSchemas[tool].safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap((issue) => previewTargetIssues(issue, args));
    const messages = issues.slice(0, 4).map((issue) => {
      const path = issue.path.map((part, index) =>
        typeof part === 'number' ? '[' + part + ']' : (index ? '.' : '') + String(part).slice(0, 80)).join('');
      const error = (message: string) => path ? path + ': ' + message : message;
      const draft = issue.path[0] === 'draft';
      const [field, index, key] = draft ? issue.path.slice(1) : issue.path;
      if (field !== 'operations' || typeof index !== 'number') return error(issue.message.slice(0, 300));
      const input = args as { operations?: { op?: unknown }[]; draft?: { operations?: { op?: unknown }[] } };
      const op = (draft ? input.draft?.operations : input.operations)?.[index]?.op;
      const name = projectOperationNames.find((candidate) => candidate === op);
      if (!name && key === 'op') {
        return error('Choose an op from ' + projectOperationNames.join(', ') + '.');
      }
      return error((name ? name + ' — ' : '') + issue.message.slice(0, 300));
    });
    if (issues.length > messages.length) messages.push((issues.length - messages.length) + ' more validation issues.');
    throw new Error(messages.join('\n'));
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
