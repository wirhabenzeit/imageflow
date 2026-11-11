import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { z } from 'zod';
import { cssMM, formatSchema, inch, mm, pt } from './format';
import type { PrintFormat, ResolvedFormat, Span } from './format';
import { identifier } from './project';
import type { Photo, ProjectFile, RenderProject, SpreadState, Values } from './project';
import { getCrop, placementIn } from './spread';
import { declarationConflicts } from './layouts';
import { p, parametersSchema, resolveParams } from './parameters';
import type { Parameters } from './parameters';
import type { BoxDefinition, SpreadDefinition, TemplateInfo } from './desktop';
import { geometry } from './geometry';
import { capabilities, runtimeExports } from './runtime-exports';

export { inch, mm, p, pt };
export type { PrintFormat, ResolvedFormat, Span } from './format';
export type { Parameter, Parameters } from './parameters';

export type RenderContext = {
  params: Values;
  document: Values;
  boxes: Record<string, { params: Values; photo?: Photo | null; text?: FlowPosition | null }>;
  elements: Record<string, { params: Values }>;
  page: { left?: number; right?: number };
  format: ResolvedFormat;
  // The chosen named format, or 'default' for a template with a single format.
  formatId: string;
  mode: RenderProject['mode'];
  // Marks a rendered node as the place where these parameters are edited; spread the result onto the node.
  edit: (...paths: string[]) => EditMarker;
  // The whole book as seen from this spread: page count and the anchors every spread declares.
  book: BookContext;
  // The platform components again, so the declarations can type-check box and element IDs per layout.
  PhotoBox: typeof PhotoBox;
  MarkdownBox: typeof MarkdownBox;
  Element: typeof Element;
};
export type EditMarker = { 'data-edit'?: string };

// Anchors are declared from a spread's saved values, never from rendered output, so every spread can read every
// anchor's page in the same single render: pages depend only on spread order and layout spans.
export type AnchorContext = { params: Values; document: Values };
export type AnchorDeclaration = { id: string; title?: string; side?: 'left' | 'right' };
export type Anchor = { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' };
export type BookContext = {
  pages: number;
  // The anchor declared with this ID, if exactly one spread declares it. With several, the first; the check warns.
  anchor(id: string): Anchor | undefined;
  // All anchors with this ID, or all anchors, in page order.
  anchors(id?: string): Anchor[];
};
const anchorDeclarations = z.array(z.strictObject({
  id: z.string().min(1).max(256), title: z.string().max(1000).optional(), side: z.enum(['left', 'right']).optional(),
})).max(100);
// Lookups that found no anchor, or several, keyed so repeated renders report each once.
export type AnchorLookup = { spread: string; anchor: string; found: number };
export type BookIndex = { pages: number; anchors: Anchor[]; lookups?: Map<string, AnchorLookup> };

export function bookIndex(book: RenderProject, template: Template, sequence: { count: number; spreads: { page: RenderContext['page'] }[] }): BookIndex {
  const document = resolveParams(template.parameters, book.project.params);
  const anchors = book.project.spreads.flatMap((spread, i) => {
    const definition = template.spreads[spread.definition];
    if (!definition?.anchors) return [];
    let returned: unknown;
    try { returned = definition.anchors({ params: resolveParams(definition.parameters, spread.params), document }); }
    catch (error) { throw new Error(definition.label + ' could not declare its anchors: ' + (error instanceof Error ? error.message : String(error))); }
    const declared = anchorDeclarations.safeParse(returned);
    if (!declared.success) {
      throw new Error(definition.label + ' declares invalid anchors: ' +
        declared.error.issues.map((issue) => (issue.path.join('.') || 'anchors') + ' ' + issue.message).join('; ') + '.');
    }
    const { left, right } = sequence.spreads[i].page;
    return declared.data.map(({ id, title, side }): Anchor => {
      // A single-page spread has only one page, whichever side the declaration names.
      const resolved = !left ? 'right' : !right ? 'left' : side ?? 'left';
      return { id, ...(title !== undefined ? { title } : {}), spread: spread.id, page: (resolved === 'left' ? left : right)!, side: resolved };
    });
  });
  // A spread may declare its right-page anchor before its left-page one. The sort is stable within a page.
  return { pages: sequence.count, anchors: anchors.sort((a, b) => a.page - b.page) };
}

export function bookContext(index: BookIndex, spread: string): BookContext {
  const copy = (anchor: Anchor) => ({ ...anchor });
  const matching = (id: string) => index.anchors.filter((anchor) => anchor.id === id);
  return {
    pages: index.pages,
    anchor(id) {
      const found = matching(id);
      if (found.length !== 1) index.lookups?.set(spread + '\u0000' + id, { spread, anchor: id, found: found.length });
      return found[0] && copy(found[0]);
    },
    anchors: (id) => (id === undefined ? index.anchors : matching(id)).map(copy),
  };
}

// In the editor, boxes and elements are edit targets for their own parameters, followed by any they are marked with.
function editTarget(book: RenderProject, prefix: string, parameters: Parameters | undefined, marked?: string) {
  if (book.mode !== 'edit') return undefined;
  const edits = [...Object.keys(parameters ?? {}).map((key) => prefix + key), ...(marked?.split(' ').filter(Boolean) ?? [])];
  return edits.length ? [...new Set(edits)].join(' ') : undefined;
}

export type FlowPosition = { part: number; parts: number; title?: string };
// An element may supply its own editor for some of its parameters. The component runs in a sandboxed frame
// and edits a draft; ImageFlow owns the dialog, validation, saving and Undo.
export type ElementEditorProps = {
  values: Values; set: (changes: Values) => void; document: Values; format: ResolvedFormat;
  readOnly: boolean; commit: () => void; cancel: () => void;
};
const elementEditor = z.object({
  label: z.string().min(1).optional(),
  parameters: z.array(identifier).min(1),
  component: z.custom<(props: ElementEditorProps) => ReactNode>((value) => typeof value === 'function', 'Expected an editor component.'),
  presentation: z.literal('dialog').default('dialog'),
});
const elements = z.record(identifier, z.object({ label: z.string().min(1), parameters: parametersSchema, editor: elementEditor.optional() })
  .refine(({ parameters, editor }) => !editor || editor.parameters.every((key) => Object.hasOwn(parameters, key)),
    'An element editor can only edit parameters its element declares.')).default({});
const boxSchema = z.object({
  type: z.enum(['photo', 'markdown']), label: z.string().min(1), parameters: parametersSchema, flowOrder: z.int().positive().optional(),
});

const definition = z.object({
  label: z.string().min(1),
  span: z.enum(['spread', 'left', 'right']).default('spread'),
  parameters: parametersSchema,
  boxes: z.record(identifier, boxSchema).default({}),
  elements,
  render: z.custom<(context: RenderContext) => ReactNode>((value) => typeof value === 'function', 'Expected a render function.'),
  anchors: z.custom<(context: AnchorContext) => unknown>((value) => typeof value === 'function', 'Expected an anchors function.').optional(),
}).refine(({ boxes }) => {
  const order = Object.values(boxes).filter(({ type }) => type === 'markdown').map(({ flowOrder }) => flowOrder);
  return order.length < 2 || (!order.includes(undefined) && new Set(order).size === order.length);
}, 'Markdown boxes need unique flowOrder values.');

// A template declares one print format, or several named formats the user chooses between in Book settings.
export const templateSchema = z.object({
  id: identifier,
  version: z.string().min(1),
  contract: z.literal(1),
  // Features beyond the first contract-1 release. Apps that predate `requires` ignore it; their bundler still
  // rejects imports of helpers they do not export.
  requires: z.array(z.string()).optional().superRefine((required, context) => {
    const missing = (required ?? []).filter((name) => !(capabilities as readonly string[]).includes(name));
    if (missing.length) {
      context.addIssue({ code: 'custom', message: 'This template requires ImageFlow features this app does not provide: ' +
        missing.join(', ') + '. Update ImageFlow, or remove them from requires. This app provides: ' + capabilities.join(', ') + '.' });
    }
  }),
  format: formatSchema.optional(),
  formats: z.record(identifier, formatSchema).optional(),
  defaultFormat: identifier.optional(),
  parameters: parametersSchema,
  spreads: z.record(identifier, definition).refine((spreads) => Object.keys(spreads).length > 0, 'Declare a spread.')
    // An ID means the same box or parameter in every layout, so switching layouts can carry its content.
    .superRefine((spreads, context) => {
      for (const message of declarationConflicts(spreads)) context.addIssue({ code: 'custom', message });
    }),
}).refine(({ format, formats }) => !format !== !formats, 'Declare either format or formats.')
  .refine(({ formats }) => !formats || Object.keys(formats).length > 0, 'Declare at least one format.')
  .refine(({ formats, defaultFormat }) => !defaultFormat || (!!formats && Object.hasOwn(formats, defaultFormat)),
    'defaultFormat must name one of the formats.');
export type DeclaredTemplate = z.infer<typeof templateSchema>;
// A template with its format resolved for one project: the project's choice, else the default, else the first.
export type Template = Omit<DeclaredTemplate, 'format'> & { format: PrintFormat; formatId: string; formatChoices: Record<string, string> };
export function chooseFormat(template: DeclaredTemplate, chosen?: string): Template & { unknownChoice: boolean } {
  // A template with a single format ignores the project's choice and offers none.
  if (!template.formats) return { ...template, format: template.format!, formatId: 'default', unknownChoice: false, formatChoices: {} };
  const known = !!chosen && Object.hasOwn(template.formats, chosen);
  const formatId = known ? chosen : template.defaultFormat ?? Object.keys(template.formats)[0];
  return {
    ...template, format: template.formats[formatId], formatId, unknownChoice: !!chosen && !known,
    formatChoices: Object.fromEntries(Object.entries(template.formats).map(([id, format]) => [id, format.label])),
  };
}
export type TemplateDeclaration = {
  id: string; version: string; contract: 1; requires?: string[]; format?: PrintFormat; formats?: Record<string, PrintFormat>; defaultFormat?: string;
  parameters?: Parameters;
  spreads: Record<string, Omit<SpreadDefinition, 'span' | 'parameters' | 'boxes' | 'elements'> & {
    span?: Span; parameters?: Parameters;
    boxes?: Record<string, Omit<BoxDefinition, 'parameters'> & { parameters?: Parameters }>;
    elements?: Record<string, { label: string; parameters?: Parameters }>;
    render(context: RenderContext): ReactNode;
    anchors?(context: AnchorContext): AnchorDeclaration[];
  }>;
};
export const defineTemplate = <T extends TemplateDeclaration>(template: T) => template;

export function templateInfo(template: Template): TemplateInfo {
  return {
    format: template.format, formatId: template.formatId, formats: template.formatChoices,
    version: template.version, parameters: template.parameters,
    // Functions (render, editor components) stay in the render frame; the editor gets plain declarations.
    spreads: Object.fromEntries(Object.entries(template.spreads).map(([id, { render: _render, anchors: _anchors, elements, ...info }]) => [id, {
      ...info,
      elements: Object.fromEntries(Object.entries(elements).map(([key, { editor, ...element }]) => [key, {
        ...element, ...(editor ? { editor: { label: editor.label, parameters: editor.parameters, presentation: editor.presentation } } : {}),
      }])),
    }])),
  };
}

const SpreadData = createContext<{
  book: RenderProject; spread: SpreadState; format: ResolvedFormat; renderPhotos: boolean;
  definition: Template['spreads'][string]; lazyPhotos: boolean;
} | null>(null);

function useSpread() {
  const value = useContext(SpreadData);
  if (!value) throw new Error('Spread components must be rendered by ImageFlow.');
  return value;
}

type Styling = { className?: string; style?: CSSProperties };

export function Spread({ className, style, children }: Styling & { children?: ReactNode }) {
  const { format } = useSpread();
  const { trim, bleed, safe } = format;
  const geometry = {
    '--trim-width': cssMM(trim.width), '--trim-height': cssMM(trim.height),
    '--bleed-top': cssMM(bleed.top), '--bleed-bottom': cssMM(bleed.bottom), '--bleed-outside': cssMM(bleed.outside),
    '--safe-top': cssMM(safe.top), '--safe-bottom': cssMM(safe.bottom),
    '--safe-outside': cssMM(safe.outside), '--safe-binding': cssMM(safe.binding),
  } as CSSProperties;
  return (
    <div className="if-sheet" style={{ width: cssMM(format.spreadWidth), height: cssMM(format.height) }}>
      <div className={['if-spread', className].filter(Boolean).join(' ')} style={{ ...style, ...geometry }}>
        {children}
      </div>
    </div>
  );
}

// Pixel width the export needs for a photo drawn `cssWidth` CSS pixels wide (uncropped), capped at the format's
// maximum resolution. Rounded up to 16 px so nearby placements share a cached rendition.
const exportCap = 300;
function exportSource(photo: Photo & { src: string }, cssWidth: number, format: ResolvedFormat) {
  const ppi = format.resolution?.maximum ?? exportCap;
  const width = Math.ceil(cssWidth / 96 * ppi / 16) * 16;
  return width < photo.width ? photo.src + '/' + width : photo.src;
}

export function PhotoBox({ id, className, style, 'data-edit': marked }: Styling & EditMarker & { id: string }) {
  const { spread, book, format, renderPhotos, definition, lazyPhotos } = useSpread();
  const box = spread.boxes[id];
  const photo = box?.photo ? book.photos[box.photo] : undefined;
  const placement = placementIn(box, spread.definition);
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);

  useLayoutEffect(() => {
    const element = frame.current;
    const img = image.current;
    if (!element || !photo) return;
    function cropPhoto() {
      if (!element || !photo) return;
      const { width, height } = getComputedStyle(element);
      const w = parseFloat(width);
      const h = parseFloat(height);
      if (!(w > 0 && h > 0)) return;
      const crop = getCrop(photo, placement, w / h);
      element.dataset.ppi = String(Math.min(photo.width * crop.width / w, photo.height * crop.height / h) * 96);
      if (!img) return;
      if (book.mode !== 'edit' && !img.getAttribute('src')) img.src = exportSource(photo, w / crop.width, format);
      img.style.width = 100 / crop.width + '%';
      img.style.height = 100 / crop.height + '%';
      img.style.left = -100 * crop.x / crop.width + '%';
      img.style.top = -100 * crop.y / crop.height + '%';
    }
    const observer = new ResizeObserver(cropPhoto);
    cropPhoto();
    observer.observe(element);
    return () => observer.disconnect();
  }, [photo, placement.centerX, placement.centerY, placement.zoom, renderPhotos]);

  return (
    <div ref={frame} data-box={id} data-box-type="photo" data-empty={photo ? undefined : ''}
      data-edit={editTarget(book, 'boxes.' + id + '.', definition.boxes[id]?.parameters, marked)}
      className={['if-photo', className].filter(Boolean).join(' ')} style={style}>
      {photo && renderPhotos &&
        <img ref={image} src={book.mode === 'edit' && !lazyPhotos ? photo.src : undefined}
          data-src={lazyPhotos ? photo.src : undefined} alt={photo.altText ?? photo.title ?? ''} />}
      {!photo && book.mode === 'edit' && <span className="if-placeholder">{box?.photo ? 'Missing photo' : 'Drop a photo'}</span>}
    </div>
  );
}

// `columns` splits the box into that many columns; text flows down each column before moving to the next box.
export function MarkdownBox({ id, className, style, columns = 1, 'data-edit': marked }: Styling & EditMarker & { id: string; columns?: number }) {
  const { spread, book, definition } = useSpread();
  const text = spread.boxes[id]?.text;
  const count = Math.max(1, Math.min(6, Math.round(Number(columns)) || 1));
  return (
    <div data-box={id} data-box-type="markdown" data-columns={count > 1 ? count : undefined}
      data-edit={editTarget(book, 'boxes.' + id + '.', definition.boxes[id]?.parameters, marked)}
      data-empty={text !== undefined && book.texts[text] !== undefined ? undefined : ''}
      className={['if-markdown', className].filter(Boolean).join(' ')} style={style}>
      {book.mode === 'edit' && (!text || book.texts[text] === undefined) &&
        <span className="if-placeholder">{text ? 'Missing Markdown' : 'Drop a Markdown file'}</span>}
    </div>
  );
}

// In the editor an element is also an edit target for its own parameters and any it is marked with.
export function Element({ id, className, style, children, 'data-edit': marked }: Styling & EditMarker & { id: string; children?: ReactNode }) {
  const { book, definition } = useSpread();
  return <div data-element={id} data-edit={editTarget(book, 'elements.' + id + '.', definition.elements[id]?.parameters, marked)}
    className={className} style={style}>{children}</div>;
}

let assets: Record<string, string> = {};
export function setTemplateAssets(next: Record<string, string>) {
  assets = next;
}
export function asset(path: string) {
  const url = assets['assets/' + path];
  if (!url) throw new Error('Missing template asset: ' + path);
  return url;
}

// Returns an identity helper for spread declarations. It exists for TypeScript: `spread({...})` infers each
// spread's parameters, boxes, and elements, and types its render context with the given document parameters.
export const spreadFor = (_document: Parameters) => <T,>(definition: T) => definition;

// The project's files for file parameters, read by `file(id)` during render.
let files: Record<string, ProjectFile> = {};
export function setTemplateFiles(next: Record<string, ProjectFile>) {
  files = next;
}
// The content of a file parameter's value, or undefined when none is assigned or the file cannot be read (the Book
// check reports the latter). Templates parse it themselves and mark problems with `data-issue` on a rendered node.
export function file(id: string): { name: string; extension: string; text: string } | undefined {
  const found = id && Object.hasOwn(files, id) ? files[id] : undefined;
  return found?.text === undefined ? undefined : { name: found.name, extension: found.extension, text: found.text };
}

// Reusable box declarations. The ID stays explicit where the declaration is used: `boxes: { hero: box.photo('Hero') }`.
export const box = {
  photo: (label: string, parameters: Parameters = {}) => ({ type: 'photo' as const, label, parameters }),
  markdown: (label: string, options: { flowOrder?: number; parameters?: Parameters } = {}) => ({
    type: 'markdown' as const, label, parameters: options.parameters ?? {}, ...(options.flowOrder !== undefined ? { flowOrder: options.flowOrder } : {}),
  }),
};

// A structured finding a template reports about its input, such as a file it cannot parse. Spread the result onto
// a rendered node (a hidden one works in export). The Book check reports it once per spread with code
// `template:<code>`, on the given box or element, or else on the box or element that contains the node.
export type TemplateIssue = {
  code: string; message: string; severity?: 'error' | 'warning';
  box?: string; element?: string; parameter?: string; file?: string;
  details?: Record<string, string | number>; suggestion?: string;
};
export const templateIssueSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Use a lowercase code such as gpx-invalid.'),
  message: z.string().min(1).max(1000), severity: z.enum(['error', 'warning']).default('warning'),
  box: identifier.optional(), element: identifier.optional(), parameter: identifier.optional(), file: z.string().max(256).optional(),
  details: z.record(z.string(), z.union([z.string().max(1000), z.number()])).optional(), suggestion: z.string().max(1000).optional(),
});
export function issue(found: TemplateIssue): { 'data-issue': string; 'data-issue-info': string } {
  return { 'data-issue': found.message, 'data-issue-info': JSON.stringify(found) };
}

export const runtime = {
  defineTemplate, spreadFor, p, mm, pt, inch, Spread, PhotoBox, MarkdownBox, Element, asset, file, geometry, box, issue, capabilities,
} satisfies Record<typeof runtimeExports[number], unknown>;

// `lazyPhotos` leaves photo sources in data-src; the editor's book view loads them as spreads come near the screen.
export function SpreadView({ book, template, format, spread, page, index, positions, renderPhotos, lazyPhotos = false }: {
  book: RenderProject; template: Template; format: ResolvedFormat; spread: SpreadState;
  page: RenderContext['page']; index: BookIndex; positions: Record<string, FlowPosition>; renderPhotos: boolean; lazyPhotos?: boolean;
}) {
  const definition = template.spreads[spread.definition];
  if (!definition) throw new Error('Spread ' + spread.id + ' uses an unknown definition: ' + spread.definition + '.');
  const boxes = Object.fromEntries(Object.entries(definition.boxes).map(([id, box]) => {
    const assigned = spread.boxes[id];
    const params = resolveParams(box.parameters, assigned?.params ?? {});
    if (box.type === 'photo') {
      const photo = assigned?.photo ? book.photos[assigned.photo] : null;
      if (!photo) return [id, { params, photo: null }];
      const { src: _src, ...metadata } = photo;
      return [id, { params, photo: metadata }];
    }
    return [id, { params, text: positions[spread.id + ':' + id] ?? null }];
  }));
  const elements = Object.fromEntries(Object.entries(definition.elements).map(([id, element]) => [
    id, { params: resolveParams(element.parameters, spread.elements[id]?.params ?? {}) },
  ]));
  const content = definition.render({
    params: resolveParams(definition.parameters, spread.params),
    document: resolveParams(template.parameters, book.project.params),
    boxes, elements, page, format, formatId: template.formatId, mode: book.mode,
    edit: (...paths) => book.mode === 'edit' && paths.length ? { 'data-edit': paths.join(' ') } : {},
    book: bookContext(index, spread.id), PhotoBox, MarkdownBox, Element,
  });
  return <SpreadData.Provider value={{ book, spread, format, renderPhotos, definition, lazyPhotos }}>{content}</SpreadData.Provider>;
}
