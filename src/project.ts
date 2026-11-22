import { z } from 'zod';
import { importModeSchema, sourceReferenceSchema } from './source-locations';
import type { SourceStatus } from './source-locations';
import type { Dimensions } from './spread';
import { captureFields } from './photo-metadata';
import type { CaptureMetadata } from './photo-metadata';
import { namesFile, readLocator } from './source-locator';

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, digits, underscores, or hyphens.')
  .refine((id) => !Object.hasOwn(Object.prototype, id), 'This identifier is reserved.');
const label = z.string().trim().min(1);
const scalar = z.union([z.string(), z.boolean(), z.number()]);
// A parameter's saved value: a scalar, or a list parameter's items as flat records. Items of that shape are kept as
// saved, even when the template no longer allows them (parameters.ts reports and resolves them); anything else, such
// as a nested object, is not a project ImageFlow wrote and fails to load like any other malformed value.
export const values = z.record(identifier, z.union([scalar, z.array(z.record(z.string(), scalar))])).default({});
const unit = z.number().min(0).max(1);
// Objects of project.json and photos.json keep keys this version does not know on load and save (ADR 0010, guardrail 2),
// so a build that predates an additive field never drops it when it saves a book that has it. The schema is loose at
// run time but typed as stripping, so `Project` and `PhotoIndex` (and the templates built from them) never see such keys.
const object = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape) as unknown as z.ZodObject<S, z.core.$strip>;
// Keys that could reach the prototype chain are refused anywhere in a document, before a schema copies any of them
// (`JSON.parse` makes `__proto__` an own key, and copying it onto a result would replace the result's prototype).
const reservedKeys = ['__proto__', 'constructor', 'prototype'];
function reservedKeyPath(value: unknown, path: PropertyKey[] = []): PropertyKey[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of Object.keys(value)) {
    if (reservedKeys.includes(key)) return [...path, key];
    const found = reservedKeyPath((value as Record<string, unknown>)[key], [...path, key]);
    if (found) return found;
  }
  return undefined;
}
const guarded = <T extends z.ZodType>(schema: T) => z.preprocess((input, ctx) => {
  const path = reservedKeyPath(input);
  if (path) ctx.issues.push({ code: 'custom', input, path, message: 'The key ' + String(path.at(-1)) + ' is reserved. Remove it.' });
  return input;
}, schema) as unknown as z.ZodPipe<z.ZodUnknown, T>;
const crop = object({ centerX: unit, centerY: unit, zoom: z.number().min(1).max(20) });
// A box's content is shared by every layout that declares a box with its ID; layouts without that box keep it on the
// spread. Crops depend on the frame, so each layout has its own. A layout without one fills its frame around
// `focus`, the centre of the crop set last.
const box = object({
  photo: identifier.optional(),
  text: identifier.optional(),
  crops: z.record(identifier, crop).optional(),
  focus: object({ centerX: unit, centerY: unit }).optional(),
  params: values,
}).refine(({ photo, text, crops, focus }) => !(photo && text) && (!(crops || focus) || !!photo),
  'A box holds one assignment, and only photos have a crop.');


// The book formats this app reads and writes (`project.json` → `schemaVersion`). A book saved by a newer app with a
// higher number is refused with a request to update ImageFlow, and is left as it is. Format 2 adds page states (ADR
// 0009), format 3 adds saved exterior covers, and format 4 adds photos that are not files (ADR 0011): a `photos.json`
// entry without a `path`, read through a source provider. A book is written in the lowest format that holds all its
// data, so the format follows `photos.json` as well as `project.json`.
export const bookFormatVersion = 4;
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
const schemaVersion = z.literal([1, 2, 3, bookFormatVersion], {
  error: ({ input }) => typeof input === 'number' && Number.isInteger(input) && input > bookFormatVersion ? newerBookMessage(input) : undefined,
});

// The state a spread or one of its pages keeps for all its layouts: `definition` is the layout it shows, or showed
// last, and picks which of the boxes, elements and parameters are shown.
const layoutState = {
  definition: identifier,
  params: values,
  boxes: z.record(identifier, box).default({}),
  elements: z.record(identifier, object({ params: values })).default({}),
};
// A page without `definition` shows ImageFlow's blank page (ADR 0009 §3), which every template has without declaring
// it; the page still keeps what it stores for other layouts.
const pageState = object({ ...layoutState, definition: identifier.optional() });
export const pageSides = ['left', 'right'] as const;

// A spread as format 2 defines it. The release gates above apply to whole books (`projectSchema`), so this schema
// stays testable and ready for the phases that lift them.
export const spreadSchema = object({
  id: identifier,
  ...layoutState,
  // Each page's own state, once the spread was shown as page layouts (ADR 0009). A page keeps it, and its layout,
  // while the spread shows a spread layout, so showing pages again restores them.
  pages: object({ left: pageState.optional(), right: pageState.optional() }).optional(),
  // The spread shows its pages' layouts rather than `definition`.
  split: z.literal(true).optional(),
  // Content a layout change replaced (ADR 0009 §3), with the state it came from. Unlike content a layout has no box
  // for, it never shows again by itself: only *Place in…* returns it, and *Discard* removes it.
  displaced: z.array(object({
    from: z.enum(['spread', ...pageSides]),
    box: identifier,
    state: box.refine(({ photo, text }) => !!(photo || text), 'Only content is set aside: a photo or a text.'),
  })).optional(),
}).refine(({ pages, split }) => !split || !!(pages?.left || pages?.right), { message: 'A spread shown as pages needs the state of at least one page.', path: ['split'] });

export type BookFormat = 1 | 2 | 3 | 4;
/**
 * The lowest book format that holds a project and, when given, its photo index. `projectSchema` sees `project.json`
 * alone and gives its lower bound; whatever writes a book passes the photo index too (`withBookFormat`), so a book
 * holding a photo that is not a file is format 4 and refused by every build that cannot read such an entry.
 */
export function bookFormatOf(project: { cover?: unknown; spreads: readonly { pages?: unknown; split?: unknown; displaced?: unknown }[] },
  photoIndex?: Readonly<Record<string, Readonly<Record<string, unknown>>>>): BookFormat {
  if (photoIndex && Object.values(photoIndex).some((entry) => !namesFile(entry))) return 4;
  if (project.cover !== undefined) return 3;
  return project.spreads.some(({ pages, split, displaced }) => pages !== undefined || split !== undefined || displaced !== undefined) ? 2 : 1;
}
/** A project with the format that holds it together with its photo index: what a save writes. */
export const withBookFormat = <P extends Project>(project: P, photoIndex: PhotoIndex): P => {
  const schemaVersion = bookFormatOf(project, photoIndex);
  return project.schemaVersion === schemaVersion ? project : { ...project, schemaVersion };
};
const coverState = object(layoutState);

export const projectSchema = guarded(object({
  schemaVersion,
  title: label,
  // The book's logical lineage across copies of one book (ADR 0010). Never an instance or security key (that is
  // `sourceBookKey`): a Finder copy shares it. New Book, Duplicate and Save a Copy start a new one.
  bookId: z.uuid().optional(),
  importMode: importModeSchema.optional(),
  // `hash` is the template source's hash when the book was created from the template library; it tells a later
  // template update whether the book's copy was edited since.
  template: object({ id: identifier, version: label, hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  // The template format chosen in template controls; templates with one format ignore it.
  format: identifier.optional(),
  params: values,
  texts: z.record(identifier, sourceReferenceSchema).default({}),
  // File parameter sources (such as GPX tracks), by ID: owned relative paths or explicit external links.
  files: z.record(identifier, sourceReferenceSchema).default({}),
  cover: coverState.optional(),
  // Each spread keeps one state for all its layouts: `definition` picks which boxes and elements are shown.
  spreads: z.array(spreadSchema.refine((spread) => !gated(spread), pagesUnsupportedMessage))
    .refine((spreads) => new Set(spreads.map((spread) => spread.id)).size === spreads.length, 'Spread IDs must be unique.'),
  // Every parsed book carries the format that holds it, so saving it writes that format.
}).transform((project) => ({ ...project, schemaVersion: bookFormatOf(project) })));

export const photoIndexSchema = guarded(z.record(identifier, object({
  // A file, relative to the book or, `linked`, absolute. An entry without one names a photo that is not a file (book
  // format 4, ADR 0011) in the fields of its provider's locator, which this schema keeps as unknown keys.
  path: z.string().optional(),
  linked: z.boolean().optional(),
  caption: z.string().optional(),
  title: z.string().optional(),
  credit: z.string().optional(),
  altText: z.string().optional(),
  // Capture time, location and camera are read from the photo file and cannot be written here.
  ...Object.fromEntries(captureFields.map((field) => [field, z.custom<never>(() => false,
    { message: field + ' is read from the photo file and is read-only. Remove it from photos.json.' }).optional()])),
}).refine((entry) => !!readLocator(entry), { message: 'This photo has no path and names no source this version of ImageFlow can read. If a newer version of ImageFlow saved it, update ImageFlow to open it.', path: ['path'] })));

export type Project = z.infer<typeof projectSchema>;
export type SpreadState = Project['spreads'][number];
export type CoverState = NonNullable<Project['cover']>;
// Existing artwork and source controls identify layout instances with a string. The exterior cover's
// internal ID is outside the book's spread-ID grammar and is never written as a spread.
export const coverInstance = '.cover';
export type PageSide = typeof pageSides[number];
export type PageState = NonNullable<NonNullable<SpreadState['pages']>[PageSide]>;
/** The state a box, element or parameter of a spread lives in: one of its pages', or the spread's own without a page. */
export const scopeState = (spread: SpreadState, page?: PageSide): SpreadState | PageState | undefined => page ? spread.pages?.[page] : spread;
export type BoxState = z.infer<typeof box>;
/** A box with its content (assignment, crops and focus) removed: its parameters, and any keys this version does not
 * know, stay. Code that replaces a box's content builds the new state from this rather than from `params` alone, so
 * an unknown key of the box survives (ADR 0010). */
export const boxBase = (box?: BoxState): BoxState => {
  const { photo: _photo, text: _text, crops: _crops, focus: _focus, params, ...rest } = box ?? {} as Partial<BoxState>;
  return { ...rest, params: params ?? {} };
};
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
  // `hash` identifies the template files as loaded. `pictureScopes`: the picture cache scope of each template file that
  // places drawn pictures, by its path in template/ (desktop/picture-scopes.ts).
  template: { script: string; css?: string; assets: Record<string, string>; warnings?: string[]; fonts?: Record<string, [number, number][]>; hash?: string;
    pictureScopes?: Record<string, string> };
  mode: 'edit' | 'export';
  // The design proof's scale (proof-sheet): photos load at the size they show on its sheet, not at print resolution.
  proofScale?: number;
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
export type FixtureMarking = { banner: string; labels: Record<string, string>; coverPages?: number };

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
