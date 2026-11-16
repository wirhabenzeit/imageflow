import { z } from 'zod';
import { importModeSchema, sourceReferenceSchema } from './source-locations';
import type { SourceStatus } from './source-locations';
import type { Dimensions } from './spread';
import { captureFields } from './photo-metadata';
import type { CaptureMetadata } from './photo-metadata';

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, digits, underscores, or hyphens.')
  .refine((id) => !Object.hasOwn(Object.prototype, id), 'This identifier is reserved.');
const label = z.string().trim().min(1);
const scalar = z.union([z.string(), z.boolean(), z.number()]);
// A parameter's saved value: a scalar, or a list parameter's items as flat records. Items of that shape are kept as
// saved, even when the template no longer allows them (parameters.ts reports and resolves them); anything else, such
// as a nested object, is not a project ImageFlow wrote and fails to load like any other malformed value.
export const values = z.record(identifier, z.union([scalar, z.array(z.record(z.string(), scalar))])).default({});
const unit = z.number().min(0).max(1);
const crop = z.object({ centerX: unit, centerY: unit, zoom: z.number().min(1).max(20) });
// A box's content is shared by every layout that declares a box with its ID; layouts without that box keep it on the
// spread. Crops depend on the frame, so each layout has its own. A layout without one fills its frame around
// `focus`, the centre of the crop set last.
const box = z.object({
  photo: identifier.optional(),
  text: identifier.optional(),
  crops: z.record(identifier, crop).optional(),
  focus: z.object({ centerX: unit, centerY: unit }).optional(),
  params: values,
}).refine(({ photo, text, crops, focus }) => !(photo && text) && (!(crops || focus) || !!photo),
  'A box holds one assignment, and only photos have a crop.');


// The book formats this app reads and writes (`project.json` → `schemaVersion`). A book saved by a newer app with a
// higher number is refused with a request to update ImageFlow, and is left as it is. Format 2 adds page states (ADR
// 0009). A book is always written in the lowest format that holds it: only a book with page states is format 2, so
// every other book stays readable by apps that know format 1, which would drop the page states they do not know.
export const bookFormatVersion = 2;
export const newerBookMessage = (version: number) => 'This book was saved by a newer version of ImageFlow (book format ' +
  version + '; this version reads formats up to ' + bookFormatVersion + '). Update ImageFlow to open it. The book was not changed.';
// Release gates (ADR 0009). Format 2 is defined before this version can handle what it stores, so a book that uses
// it is refused with a request to update rather than opened with parts the app does not yet see:
// - Stored page states and replaced content (`pages`, `displaced`) hold references to photos, texts and files. Every
//   reference consumer reads them through `storedStates` and `storedBoxes` (phase 2), so this gate is lifted.
// - Split spreads render as two page layouts in one sheet (phase 3), so this gate is lifted too.
export const pageStatesSupported = true;
export const pageLayoutsShown = true;
export const pagesUnsupportedMessage = 'This book uses page layouts, which this version of ImageFlow does not support yet. ' +
  'Update ImageFlow to open it. The book was not changed.';
type GatedSpread = { pages?: unknown; displaced?: unknown; split?: unknown };
// Whether this version refuses a spread because of what it stores.
const gated = (spread: GatedSpread | null | undefined) => !!spread && ((!pageStatesSupported && (spread.pages !== undefined || spread.displaced !== undefined)) ||
  (!pageLayoutsShown && spread.split !== undefined));
/** Why this app cannot open a `project.json` at all, before validation, so the message is only the request to update. */
export function unsupportedBookMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { schemaVersion: version, spreads } = value as { schemaVersion?: unknown; spreads?: unknown };
  if (typeof version === 'number' && Number.isInteger(version) && version > bookFormatVersion) return newerBookMessage(version);
  if (Array.isArray(spreads) && spreads.some((spread) => gated(spread as GatedSpread | null))) return pagesUnsupportedMessage;
  return undefined;
}
const schemaVersion = z.literal([1, bookFormatVersion], {
  error: ({ input }) => typeof input === 'number' && Number.isInteger(input) && input > bookFormatVersion ? newerBookMessage(input) : undefined,
});

// The state a spread or one of its pages keeps for all its layouts: `definition` is the layout it shows, or showed
// last, and picks which of the boxes, elements and parameters are shown.
const layoutState = {
  definition: identifier,
  params: values,
  boxes: z.record(identifier, box).default({}),
  elements: z.record(identifier, z.object({ params: values })).default({}),
};
// A page without `definition` shows ImageFlow's blank page (ADR 0009 §3), which every template has without declaring
// it; the page still keeps what it stores for other layouts.
const pageState = z.object({ ...layoutState, definition: identifier.optional() });
export const pageSides = ['left', 'right'] as const;

// A spread as format 2 defines it. The release gates above apply to whole books (`projectSchema`), so this schema
// stays testable and ready for the phases that lift them.
export const spreadSchema = z.object({
  id: identifier,
  ...layoutState,
  // Each page's own state, once the spread was shown as page layouts (ADR 0009). A page keeps it, and its layout,
  // while the spread shows a spread layout, so showing pages again restores them.
  pages: z.object({ left: pageState.optional(), right: pageState.optional() }).optional(),
  // The spread shows its pages' layouts rather than `definition`.
  split: z.literal(true).optional(),
  // Content a layout change replaced (ADR 0009 §3), with the state it came from. Unlike content a layout has no box
  // for, it never shows again by itself: only *Place in…* returns it, and *Discard* removes it.
  displaced: z.array(z.object({
    from: z.enum(['spread', ...pageSides]),
    box: identifier,
    state: box.refine(({ photo, text }) => !!(photo || text), 'Only content is set aside: a photo or a text.'),
  })).optional(),
}).refine(({ pages, split }) => !split || !!(pages?.left || pages?.right), { message: 'A spread shown as pages needs the state of at least one page.', path: ['split'] });

// The lowest book format that holds a project.
export const bookFormatOf = (project: { spreads: readonly { pages?: unknown; split?: unknown; displaced?: unknown }[] }) =>
  project.spreads.some(({ pages, split, displaced }) => pages !== undefined || split !== undefined || displaced !== undefined) ? 2 : 1;

export const projectSchema = z.object({
  schemaVersion,
  title: label,
  importMode: importModeSchema.optional(),
  // `hash` is the template source's hash when the book was created from the template library; it tells a later
  // template update whether the book's copy was edited since.
  template: z.object({ id: identifier, version: label, hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  // The template format chosen in template controls; templates with one format ignore it.
  format: identifier.optional(),
  params: values,
  texts: z.record(identifier, sourceReferenceSchema).default({}),
  // File parameter sources (such as GPX tracks), by ID: owned relative paths or explicit external links.
  files: z.record(identifier, sourceReferenceSchema).default({}),
  // Each spread keeps one state for all its layouts: `definition` picks which boxes and elements are shown.
  spreads: z.array(spreadSchema.refine((spread) => !gated(spread), pagesUnsupportedMessage))
    .refine((spreads) => new Set(spreads.map((spread) => spread.id)).size === spreads.length, 'Spread IDs must be unique.'),
  // Every parsed book carries the format that holds it, so saving it writes that format.
}).transform((project) => ({ ...project, schemaVersion: bookFormatOf(project) as 1 | 2 }));

export const photoIndexSchema = z.record(identifier, z.object({
  path: z.string(),
  linked: z.boolean().optional(),
  caption: z.string().optional(),
  title: z.string().optional(),
  credit: z.string().optional(),
  altText: z.string().optional(),
  // Capture time, location and camera are read from the photo file and cannot be written here.
  ...Object.fromEntries(captureFields.map((field) => [field, z.custom<never>(() => false,
    { message: field + ' is read from the photo file and is read-only. Remove it from photos.json.' }).optional()])),
}));

export type Project = z.infer<typeof projectSchema>;
export type SpreadState = Project['spreads'][number];
export type PageSide = typeof pageSides[number];
export type PageState = NonNullable<NonNullable<SpreadState['pages']>[PageSide]>;
/** The state a box, element or parameter of a spread lives in: one of its pages', or the spread's own without a page. */
export const scopeState = (spread: SpreadState, page?: PageSide): SpreadState | PageState | undefined => page ? spread.pages?.[page] : spread;
export type BoxState = z.infer<typeof box>;
/** Where a spread stores a state: its own, or one of its pages'. */
export type StateLocation = 'spread' | PageSide;
export type LayoutState = SpreadState | PageState;
type StoredSpread = Pick<SpreadState, 'params' | 'boxes' | 'elements' | 'pages' | 'displaced'>;

// Every reference consumer (asset usage, source removal, commands, the authoring context) reads a spread through the
// two functions below, so content stored only on a page or set aside as replaced is never reported unused or left
// dangling (ADR 0009, phase 2).

/** Every layout state a spread stores, in order: its own, then the left and the right page's. */
export function storedStates<T extends StoredSpread>(spread: T): { location: StateLocation; state: Pick<T, 'params' | 'boxes' | 'elements'> }[] {
  return [{ location: 'spread' as const, state: spread },
    ...pageSides.flatMap((side) => spread.pages?.[side] ? [{ location: side, state: spread.pages[side] }] : [])];
}

/** Every box state a spread stores: the boxes of each layout state, then the content set aside as replaced. */
export function storedBoxes(spread: StoredSpread): { location: StateLocation; box: string; state: BoxState; displaced?: number }[] {
  return [...storedStates(spread).flatMap(({ location, state }) => Object.entries(state.boxes).map(([box, item]) => ({ location, box, state: item }))),
    ...(spread.displaced ?? []).map(({ from, box, state }, displaced) => ({ location: from, box, state, displaced }))];
}
export type Values = z.infer<typeof values>;
export type PhotoIndex = z.infer<typeof photoIndexSchema>;
export type Photo = Omit<PhotoIndex[string], 'path' | 'linked' | typeof captureFields[number]> & Dimensions & CaptureMetadata;
// A file the template reads through `file(id)`. Files are read as UTF-8 text.
export type ProjectFile = { name: string; extension: string; text?: string; problem?: string };
export type ProjectFiles = { project: Project; photoIndex: PhotoIndex };
export type RenderProject = {
  project: Project;
  photos: Record<string, Photo & { src: string }>;
  texts: Record<string, string>;
  // Registered files with their text, or why they could not be read.
  files: Record<string, ProjectFile>;
  problems: string[];
  sources?: Record<string, SourceStatus>;
  // `fonts`: the code points each bundled font file covers, as [first, last] ranges, by its file name under template/.
  template: { script: string; css?: string; assets: Record<string, string>; warnings?: string[]; fonts?: Record<string, [number, number][]> };
  mode: 'edit' | 'export';
  // Where this render is shown, set by the render frame from its URL before rendering (never saved or sent).
  view?: RenderView;
  // A synthetic authoring fixture book. Its artwork carries a banner and fixture labels so it is never mistaken for the book.
  fixture?: FixtureMarking;
  // The network origins this frame may reach (ADR 0006), when the app decides them for the book. Declared origins
  // missing here are reported as waiting for the user's permission rather than as unreachable sites.
  network?: string[];
};
// `'canvas'` is the interactive book in the editor; thumbnails and layout previews are edit-mode renders nobody clicks.
export type RenderView = 'canvas' | 'thumbnail' | 'layout-preview' | 'export';
// The book frame's `?view=` decides which edit-mode render is the canvas. Only the book view itself is; an unknown
// frame counts as a preview, so a new frame never shows editing scaffolding by accident.
export const frameView = (view: string | null): Exclude<RenderView, 'export'> =>
  view === 'book' ? 'canvas' : view === 'layouts' ? 'layout-preview' : 'thumbnail';
export const renderView = (book: Pick<RenderProject, 'mode' | 'view'>): RenderView =>
  book.mode === 'export' ? 'export' : book.view ?? 'canvas';
export type FixtureMarking = { banner: string; labels: Record<string, string> };

export function parseDocument<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.length ? ' → ' + issue.path.join(' → ') : '';
  throw new Error(label + path + ': ' + issue.message);
}

/** A view of one layout state with its sheet ID, for existing box/editor helpers. Nested state is shared;
 * writes to its parameter, box and element records write to the selected page. */
export function scopeSpread(spread: SpreadState | undefined, page?: PageSide): SpreadState | undefined {
  if (!spread) return undefined;
  if (!page) return spread;
  const state = spread.pages?.[page];
  return state && { ...state, id: spread.id, definition: state.definition ?? '' };
}
