import { z } from 'zod';
import type { AuthoringDiagnostic } from './authoring';
import type { AuthoringCheckResult } from './authoring-check';
import type { HistoryState } from './desktop';
import type { LibraryEntry } from './library';
import type { PreviewMetadata } from './preview';
import { pageSides } from './project';
import type { ActiveBookEditor } from './desktop';

// Output schemas for the result shapes that MCP capability discovery freezes (#77): the input revision, the diagnostic
// envelope, check coverage, template identity, image metadata and command results. Objects are loose: a later version
// may add fields, but never removes or retypes the ones declared here. Errors (isError results) are not validated.

const revision = z.string().regex(/^[a-f0-9]{64}$/).nullable()
  .describe('SHA-256 of the book inputs this result describes, or null when they could not be captured. Pass it as expectedRevision.');
const history = z.looseObject({
  undo: z.string().optional().describe('Name of the step Undo would revert.'),
  redo: z.string().optional().describe('Name of the step Redo would apply.'),
}).describe('The app\'s shared Undo history after this call.');

export const diagnosticSchema = z.looseObject({
  code: z.string().describe('Stable diagnostic code.'),
  stage: z.enum(['project', 'template', 'render', 'preview']),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  location: z.looseObject({
    path: z.string().optional().describe('Project-relative file.'),
    line: z.number().optional(), column: z.number().optional(),
    spread: z.string().optional(), cover: z.literal(true).optional(), page: z.enum(['left', 'right']).optional(), box: z.string().optional(), element: z.string().optional(),
    source: z.string().optional().describe('Source ID.'),
    parameter: z.string().optional(),
    where: z.string().optional().describe('Readable location.'),
    declaration: z.string().optional().describe('Path inside the template declaration.'),
  }).optional(),
  details: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('Measured and allowed values.'),
  suggestion: z.string().optional(),
});

export const checksSchema = z.looseObject({
  bundle: z.enum(['passed', 'failed', 'not-run']),
  declarations: z.enum(['passed', 'failed', 'not-run']),
  layout: z.enum(['completed', 'failed', 'not-run']),
  typescript: z.enum(['passed', 'failed', 'not-run']),
  fixtures: z.enum(['completed', 'failed', 'not-run']),
  print: z.enum(['not-run']),
}).describe('Which checks ran and how they ended. not-run means the check gives no answer, not that it passed.');

export const templateIdentitySchema = z.looseObject({
  saved: z.looseObject({ id: z.string(), version: z.string(), hash: z.string().optional() }).nullable()
    .describe('Template identity saved in project.json when the book was made or its template last updated.'),
  current: z.looseObject({ id: z.string().nullable(), version: z.string().nullable(), hash: z.string().nullable(),
    basedOn: z.looseObject({ id: z.string(), version: z.string() }).optional() })
    .describe('Identity declared by the template files now, and the library hash of those files.'),
  matchesSavedHash: z.boolean().nullable().describe('Whether the template files are unchanged since the book was made; null when either hash is unknown.'),
  note: z.string().optional().describe('What a mismatch means.'),
});

const pageImage = {
  width: z.number().describe('Pixels.'), height: z.number().describe('Pixels.'),
  widthMm: z.number(), heightMm: z.number(), bounds: z.enum(['trim', 'bleed']), spread: z.string(),
  side: z.enum(['left', 'right', 'spread', 'page']),
  page: z.looseObject({ left: z.number().optional(), right: z.number().optional(), number: z.number().optional() }),
  detail: z.looseObject({ box: z.string().optional(), element: z.string().optional(), xMm: z.number(), yMm: z.number() }).optional()
    .describe('Close-up crop, in millimetres from the sheet\'s outer bleed corner.'),
  guides: z.literal(true).optional(), labels: z.literal(true).optional(),
};
const imageFlags = {
  mimeType: z.enum(['image/png', 'image/jpeg']).describe('The image itself is the image content block of this result.'),
  draft: z.literal(true).optional().describe('The image shows unsaved draft operations.'),
  fixture: z.literal(true).optional().describe('The image shows synthetic fixtures, never the saved book.'),
};
export const imageSchema = z.union([
  z.looseObject({ ...pageImage, ...imageFlags }),
  z.looseObject({
    cover: z.literal(true), interiorPages: z.number(), previewPages: z.number().optional(),
    width: pageImage.width, height: pageImage.height, widthMm: pageImage.widthMm, heightMm: pageImage.heightMm,
    bounds: pageImage.bounds, detail: pageImage.detail, guides: pageImage.guides, labels: pageImage.labels, ...imageFlags,
  }),
  z.looseObject({
    kind: z.literal('contact-sheet'), width: z.number(), height: z.number(), bounds: z.enum(['trim', 'bleed']), columns: z.number(),
    banner: z.looseObject({ text: z.string(), height: z.number() }).optional(),
    guides: z.literal(true).optional(), labels: z.literal(true).optional(),
    cells: z.array(z.looseObject({ ...pageImage, x: z.number(), y: z.number(), label: z.string() })),
    ...imageFlags,
  }),
]).describe('Metadata of the returned image.');

const state = z.enum(['ready', 'error']);
const reportFields = { revision, diagnostics: z.array(diagnosticSchema), checks: checksSchema };
const commandFields = {
  changes: z.array(z.string()).optional().describe('One line per change, as shown in Undo.'),
  affectedSpreads: z.array(z.string()).optional(),
  affectedCover: z.literal(true).optional(),
  references: z.record(z.string(), z.string()).optional().describe('Spread IDs created for $alias batch references.'),
  reflow: z.boolean().optional().describe('Whether text flow may have moved on other spreads.'),
};

const revisionMoved = z.looseObject({ expectedRevision: z.string(), revision: z.string() }).optional()
  .describe('The book changed after expectedRevision; planned at revision instead.');

const checkpointFields = {
  checkpointId: z.string().nullable().optional().describe('The book history checkpoint of this commit, or null when nothing changed.'),
  requestFingerprint: z.string().optional(),
};

const libraryEntry = z.looseObject({
  id: z.string(), version: z.string(), label: z.string(), description: z.string().optional(),
  source: z.enum(['built-in', 'imported']), replacesBuiltIn: z.boolean().optional(),
  hash: z.string().describe('As in templateIdentity.'), importedAt: z.string().optional(),
  formats: z.array(z.string()), layouts: z.array(z.string()), openingSpreads: z.number(),
  shape: z.enum(['Square', 'Landscape', 'Portrait']).optional(),
  packages: z.array(z.looseObject({ name: z.string(), version: z.string(), license: z.string() })).optional(),
  network: z.array(z.string()).optional(), networkTrust: z.enum(['built-in', 'allowed']).optional(),
  unavailable: z.string().optional().describe('Why no book can be made from it.'),
});
const libraryVersion = z.looseObject({ id: z.string(), version: z.string(), hash: z.string(), source: z.enum(['built-in', 'imported']) });

// The editor the book window reports as open. The window sends it over IPC, so the main process parses it before
// trusting it in a lease refusal or an inspect_book summary.
export const activeBookEditorSchema = z.object({ label: z.string().min(1).max(200), spread: z.string().max(256).optional(),
  page: z.enum(pageSides).optional(), field: z.string().max(500).optional() }) satisfies z.ZodType<ActiveBookEditor>;
export function parseActiveEditor(value: unknown): ActiveBookEditor | undefined {
  const parsed = activeBookEditorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const mcpOutputSchemas = {
  list_projects: z.looseObject({
    projects: z.array(z.looseObject({
      project: z.string().describe('Handle for the other tools. It expires when the book closes or reopens.'),
      title: z.string(), folder: z.string(), writable: z.boolean(), revision, history,
    })),
    scope: z.string().optional(),
  }),
  get_authoring_context: z.looseObject({
    project: z.string(), root: z.string().describe('The book folder.'), guide: z.string(),
    ...reportFields,
    template: z.looseObject({}).optional().describe('Parsed template declarations: the active format, every format in full (printFormats), parameters, layouts with their boxes and elements, layout families and opening spreads.'),
    templateIdentity: templateIdentitySchema,
    sources: z.record(z.string(), z.looseObject({ text: z.string(), sha256: z.string(), truncated: z.boolean() })).describe('Requested includeSource files.'),
    templateFiles: z.array(z.string()).optional().describe('Files under template/. Generated folders are listed once, ending in /. Like template, topics and capabilities, left out when only docs, examples or sources were requested.'),
    topics: z.array(z.looseObject({ id: z.string(), title: z.string(), summary: z.string(), bytes: z.number() })).optional()
      .describe('Table of contents of the template API reference. Request topics with docs.'),
    docs: z.record(z.string(), z.string()).optional().describe('Requested reference topics as Markdown, by topic ID.'),
    examples: z.array(z.looseObject({ name: z.string(), description: z.string(), source: z.string().optional() }))
      .describe('Shipped example templates. Requested ones include their source.'),
    capabilities: z.looseObject({}).optional(),
  }),
  inspect_book: z.looseObject({
    project: z.string(), ...reportFields,
    activeEditor: activeBookEditorSchema.optional().describe('Editor open in ImageFlow at the time of summary inspection, with its saved field address when available.'),
    templateIdentity: templateIdentitySchema.optional(),
    cover: z.looseObject({}).optional().describe('Cover availability, saved artwork and resolved geometry for the active format.'),
    items: z.array(z.looseObject({})).optional(), total: z.number().optional(), nextOffset: z.number().nullable().optional(),
  }),
  check_book: z.looseObject({
    state, ...reportFields,
    image: imageSchema.optional(),
    typecheck: z.looseObject({ files: z.array(z.string()), totalDiagnostics: z.number(), truncated: z.boolean(), elapsedMs: z.number() }).optional(),
    draft: z.looseObject({ applied: z.boolean(), committed: z.literal(false), ...commandFields }).optional()
      .describe('Present when the check rendered unsaved draft operations.'),
    fixtures: z.looseObject({}).optional().describe('Fixture coverage matrix and findings, present when fixtures were requested.'),
    revisionMoved, notice: z.string().optional(),
  }),
  apply_project_changes: z.looseObject({
    state, revision,
    committed: z.union([z.boolean(), z.literal('pending')]).describe('Whether the batch was saved. A failed check before planning returns false with diagnostics.'),
    dryRun: z.boolean().optional(), ...commandFields, revisionMoved,
    replayed: z.literal(true).optional().describe('This idempotencyKey was already applied; this is the original result.'),
    ...checkpointFields,
    diagnostics: z.array(diagnosticSchema).optional(), checks: checksSchema.optional(),
    history: history.optional(), notice: z.string().optional(),
  }),
  list_book_checkpoints: z.looseObject({
    project: z.string(),
    checkpoints: z.array(z.looseObject({
      checkpointId: z.string(), time: z.string(), origin: z.enum(['app', 'mcp']), label: z.string(), changed: z.array(z.string()),
      changedOutsideBefore: z.array(z.string()).optional().describe('Manifests changed outside ImageFlow since the previous checkpoint.'),
      mcp: z.looseObject({ tool: z.string(), idempotencyKey: z.string(), requestFingerprint: z.string(), session: z.string() }).optional(),
    })).describe('Newest first.'),
    nextCursor: z.string().nullable(),
    changedOutsideSinceLatest: z.array(z.string()).describe('Manifests on disk that differ from the newest checkpoint.'),
  }),
  rebuild_dependencies: z.looseObject({
    state: z.enum(['ready', 'installing']).describe('"installing" while npm is still installing; call again to wait for it.'),
    project: z.string(),
    packages: z.record(z.string(), z.string()).optional().describe('Packages and versions in the new saved bundle.'),
    imports: z.array(z.string()).optional().describe('The package imports the new bundle provides.'),
    untyped: z.array(z.string()).optional().describe('Imports without type declarations; add their @types packages and rebuild.'),
    reused: z.boolean().optional().describe('npm did not run: an earlier install of the same package.json and lockfile was reused. The bundle is rebuilt either way, from the current sources of linked `file:` packages too.'),
    lockfileUpdated: z.boolean().optional().describe('npm updated template/package-lock.json.'),
    leftoverNodeModules: z.boolean().optional().describe('template/node_modules exists. The book does not use it; ask the user before deleting it.'),
    notice: z.string().optional(),
  }),
  list_templates: z.looseObject({
    templates: z.array(libraryEntry),
  }),
  read_library_template: z.looseObject({
    template: libraryVersion,
    files: z.array(z.looseObject({ path: z.string(), files: z.number().optional().describe('Files in a generated folder, listed once.'),
      status: z.enum(['same', 'changed', 'library-only', 'book-only']).optional() })).optional(),
    changelog: z.string().optional().describe('The file that lists changes per version.'),
    path: z.string().optional(), text: z.string().optional(), truncated: z.boolean().optional(), sha256: z.string().optional(),
  }),
  save_template_to_library: z.looseObject({
    status: z.enum(['saved', 'replaced', 'unchanged', 'conflict']).describe('conflict: nothing was saved; see reason and current.'),
    template: z.looseObject({ id: z.string(), version: z.string(), label: z.string(), hash: z.string().optional() }),
    reason: z.enum(['changed', 'older', 'built-in', 'replaced-meanwhile']).optional(),
    current: libraryVersion.optional().describe('The entry a conflict would replace.'),
    replaced: libraryVersion.optional(),
    message: z.string().optional(), notice: z.string().optional(),
  }),
  import_sources: z.looseObject({
    state, revision, committed: z.union([z.boolean(), z.literal('pending')]),
    sources: z.array(z.looseObject({ id: z.string(), path: z.string(), kind: z.enum(['photo', 'markdown', 'file']) })).optional()
      .describe('Registered source IDs, in the order of paths.'),
    replayed: z.literal(true).optional(), ...checkpointFields,
    diagnostics: z.array(diagnosticSchema).optional(), checks: checksSchema.optional(),
    history: history.optional(), notice: z.string().optional(),
  }),
  rename_source: z.looseObject({
    state, revision, committed: z.union([z.boolean(), z.literal('pending')]),
    source: z.looseObject({ id: z.string(), kind: z.enum(['markdown', 'file']), path: z.string() }).optional(),
    replayed: z.literal(true).optional(), ...checkpointFields, notice: z.string().optional(),
  }),
};

// The declared shapes accept every value of the app's own types, so output validation cannot reject a typed result.
type Accepts<Schema extends z.ZodType, Value> = Value extends z.input<Schema> ? true : never;
const accepts: [
  Accepts<typeof diagnosticSchema, AuthoringDiagnostic>,
  Accepts<typeof checksSchema, AuthoringCheckResult['checks']>,
  Accepts<typeof imageSchema, PreviewMetadata & Pick<NonNullable<AuthoringCheckResult['image']>, 'mimeType' | 'draft' | 'fixture'>>,
  Accepts<typeof history, HistoryState>,
  Accepts<typeof libraryEntry, LibraryEntry>,
] = [true, true, true, true, true];
void accepts;
