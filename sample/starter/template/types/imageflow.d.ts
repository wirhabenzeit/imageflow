// Types for the `imageflow` module that ImageFlow provides to templates at runtime (template contract 1).
// ImageFlow keeps this file in sync with the app; edit your template, not this file.

// Lengths and print format

export type Length = { value: number; unit: 'mm' | 'pt' | 'in' };
export function mm(value: number): Length;
export function pt(value: number): Length;
export function inch(value: number): Length;

type Insets = { top: Length; bottom: Length; outside: Length; binding: Length };
export type Span = 'spread' | 'left' | 'right';
export type Resolution = { minimum: number; target: number; maximum: number };

export type PrintFormat = {
  label: string;
  trim: { width: Length; height: Length };
  bleed: Insets;
  safe: Insets;
  structure: {
    delivery: 'pages' | 'spreads';
    ends: 'single-pages' | 'inside-covers';
    pageCount: { min: number; max: number; step: 2 | 4 };
  };
  output: {
    container: 'pdf';
    colorSpace: 'sRGB';
    transparency: 'allow' | 'forbid';
    /** Effective photo resolution in ppi. Below `minimum` blocks print export; export downsamples to `maximum`. */
    resolution?: Resolution;
    minimumTextSize?: Length;
    /** Maximum PDF size in bytes. */
    maximumFileSize?: { pages: number; cover?: number };
    fonts?: { allowType3: false; allowSystemFonts: false };
  };
};

type MillimeterInsets = { top: number; bottom: number; outside: number; binding: number };
/** The print format in millimetres, as passed to `render`. */
export type ResolvedFormat = {
  trim: { width: number; height: number };
  bleed: MillimeterInsets;
  safe: MillimeterInsets;
  pageWidth: number;
  spreadWidth: number;
  outputWidth: number;
  height: number;
  resolution?: Resolution;
};

// Parameters

type Common = { label: string };
type Numeric = { min?: number; max?: number; step?: number; unit?: string };
export type BooleanParameter = Common & { type: 'boolean'; default: boolean };
export type StringParameter = Common & { type: 'string'; default: string; multiline?: boolean; maxLength?: number; placeholder?: string };
export type IntegerParameter = Common & Numeric & { type: 'integer'; default: number };
export type NumberParameter = Common & Numeric & { type: 'number'; default: number };
export type EnumParameter = Common & { type: 'enum'; default: string; options: readonly string[]; labels?: Record<string, string> };
/** A `#rrggbb` colour. */
export type ColorParameter = Common & { type: 'color'; default: string };
/** An ISO date such as `2027-03-01`. With `precision: 'month'` the editor picks a month and stores its first day. */
export type DateParameter = Common & { type: 'date'; default: string; min?: string; max?: string; precision?: 'day' | 'month' };
/**
 * A file the user adds to the project, such as a GPX track. The value is the file's ID, or `''` when none is assigned;
 * read the content with `file(id)`. `accept` lists lowercase extensions such as `'.gpx'`.
 */
export type FileParameter = Common & { type: 'file'; default: ''; accept: readonly string[] };
export type Parameter = BooleanParameter | StringParameter | IntegerParameter | NumberParameter | EnumParameter | ColorParameter | DateParameter |
  FileParameter;
export type Parameters = Record<string, Parameter>;

export type ParameterValue<P> =
  P extends { type: 'boolean' } ? boolean :
  P extends { type: 'integer' | 'number' } ? number :
  P extends { type: 'enum'; options: readonly (infer O)[] } ? O :
  string;
export type ParameterValues<P> = { [K in keyof P]: ParameterValue<P[K]> };

type Options<P extends Parameter> = Omit<P, 'type'>;
export const p: {
  boolean<const O extends Options<BooleanParameter>>(options: O): O & { type: 'boolean' };
  string<const O extends Options<StringParameter>>(options: O): O & { type: 'string' };
  integer<const O extends Options<IntegerParameter>>(options: O): O & { type: 'integer' };
  number<const O extends Options<NumberParameter>>(options: O): O & { type: 'number' };
  enum<const T extends string>(options: Common & { options: readonly T[]; default: NoInfer<T>; labels?: Partial<Record<T, string>> }):
    Common & { options: readonly T[]; default: T; labels?: Partial<Record<T, string>>; type: 'enum' };
  color<const O extends Options<ColorParameter>>(options: O): O & { type: 'color' };
  date<const O extends Options<DateParameter>>(options: O): O & { type: 'date' };
  file<const O extends Omit<FileParameter, 'type' | 'default'>>(options: O): O & { type: 'file'; default: '' };
};

// Declarations

export type BoxDeclaration = { type: 'photo' | 'markdown'; label: string; parameters?: Parameters; flowOrder?: number };
/**
 * Props of a template-supplied element editor. `values` holds all of the element's parameters with the draft
 * applied; `set` changes the editor's own parameters in the draft. ImageFlow validates and saves the draft when
 * the user clicks Done (or calls `commit`), as one undoable edit; `cancel` discards it.
 */
export type ElementEditorProps = {
  values: Values;
  set(changes: Values): void;
  document: Values;
  format: ResolvedFormat;
  readOnly: boolean;
  commit(): void;
  cancel(): void;
};
/**
 * An element's own editor for some of its parameters, shown in ImageFlow's editor dialog. It runs in a sandboxed
 * frame with the template's CSS; generated controls remain for the element's other parameters.
 */
export type ElementEditor = {
  label?: string;
  parameters: readonly string[];
  component(props: ElementEditorProps): ImageFlowNode;
  presentation?: 'dialog';
};
export type ElementDeclaration = { label: string; parameters?: Parameters; editor?: ElementEditor };
export type SpreadDeclaration = {
  label: string;
  /** `left` or `right` for a single page at the start or end of the book. Default `spread`. */
  span?: Span;
  parameters?: Parameters;
  boxes?: Record<string, BoxDeclaration>;
  elements?: Record<string, ElementDeclaration>;
};

// Anchors

/**
 * A place other spreads can refer to, such as a chapter opening listed in a table of contents. `side` names the page
 * of a two-page spread (default: its first page). Several spreads may declare the same ID; `book.anchors(id)` lists
 * them all.
 */
export type AnchorDeclaration = { id: string; title?: string; side?: 'left' | 'right' };
/** A declared anchor with the book page it is on. */
export type Anchor = { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' };
/** The whole book as seen from one spread. */
export type BookContext = {
  /** Number of pages in the book. */
  pages: number;
  /**
   * The anchor with this ID. Undefined when no spread declares it; the first when several do. The Book check warns
   * about both, on the spread that asked.
   */
  anchor(id: string): Anchor | undefined;
  /** All anchors with this ID, or all anchors, in page order. */
  anchors(id?: string): Anchor[];
};

// Render context

export type Photo = { width: number; height: number; caption?: string; title?: string; credit?: string; altText?: string };
/** Where a Markdown box sits in the chain of boxes that share its text. */
export type FlowPosition = { part: number; parts: number; title?: string };
export type Values = Record<string, string | number | boolean>;

type ValuesOf<T> = T extends { parameters: infer P } ? ParameterValues<P> : {};
type BoxContext<B> = B extends { type: 'photo' }
  ? { params: ValuesOf<B>; photo: Photo | null }
  : { params: ValuesOf<B>; text: FlowPosition | null };

type ParameterKeys<T> = T extends { parameters?: infer P } ? keyof NonNullable<P> & string : never;
type NestedPaths<Group extends string, R> = { [K in keyof R & string]: `${Group}.${K}.${ParameterKeys<R[K]>}` }[keyof R & string];
/** A parameter that `edit` can point at: `heading`, `document.paper`, `elements.grid.firstWeekday`, or `boxes.hero.showCaption`. */
export type EditPath<S extends SpreadDeclaration = SpreadDeclaration, D extends Parameters = Parameters> =
  | ParameterKeys<S> | `document.${keyof D & string}`
  | NestedPaths<'elements', NonNullable<S['elements']>> | NestedPaths<'boxes', NonNullable<S['boxes']>>;
/** Attributes returned by `edit`. Spread them onto the node that shows the parameters. */
export type EditMarker = { 'data-edit'?: string };

/** The context passed to `render`, typed from a spread declared with `spreadFor`. */
export type RenderContext<S extends SpreadDeclaration = SpreadDeclaration, D extends Parameters = Parameters> = {
  params: ValuesOf<S>;
  document: ParameterValues<D>;
  boxes: { [K in keyof S['boxes']]: BoxContext<S['boxes'][K]> };
  elements: { [K in keyof S['elements']]: { params: ValuesOf<S['elements'][K]> } };
  /** Book page numbers of this spread's pages. */
  page: { left?: number; right?: number };
  format: ResolvedFormat;
  /** The chosen key of `formats`, or `'default'` for a template with a single `format`. */
  formatId: string;
  mode: 'edit' | 'export';
  /**
   * Marks the node that shows these parameters, so clicking it in the editor opens them for editing:
   * `<h2 {...ctx.edit('heading')}>{ctx.params.heading}</h2>`. Returns no attributes in export.
   */
  edit(...paths: EditPath<S, D>[]): EditMarker;
  /** Page count and the anchors all spreads declare: `ctx.book.anchor('map')?.page`. */
  book: BookContext;
};

/** The render context of a spread declared without `spreadFor`. */
export type UntypedRenderContext = {
  params: Values;
  document: Values;
  boxes: Record<string, { params: Values; photo?: Photo | null; text?: FlowPosition | null }>;
  elements: Record<string, { params: Values }>;
  page: { left?: number; right?: number };
  format: ResolvedFormat;
  formatId: string;
  mode: 'edit' | 'export';
  edit(...paths: string[]): EditMarker;
  book: BookContext;
};

/**
 * Declares a spread's anchors from its saved values. ImageFlow calls it for every spread before rendering, so it must
 * be a pure function of `params` and `document`.
 */
export type AnchorContext<P = Values, D = Values> = { params: P; document: D };

export type SpreadDefinition = SpreadDeclaration & {
  render(context: UntypedRenderContext): ImageFlowNode;
  anchors?(context: AnchorContext): readonly AnchorDeclaration[];
};
export type TemplateDeclaration = {
  id: string;
  version: string;
  contract: 1;
  /**
   * Declare one `format`, or several named `formats` the user chooses between in Book settings (`defaultFormat`,
   * else the first, is used until they do). Layouts adapt through `ctx.format`, `ctx.formatId`, and the
   * `--trim-*`, `--bleed-*` and `--safe-*` CSS variables of `<Spread>`.
   */
  format?: PrintFormat;
  formats?: Record<string, PrintFormat>;
  defaultFormat?: string;
  parameters?: Parameters;
  spreads: Record<string, SpreadDefinition>;
};

export function defineTemplate<const T extends TemplateDeclaration>(template: T): T;

/**
 * Returns `spread`, which declares one spread with a typed render context:
 *
 *     const document = { paper: p.enum({ label: 'Paper', default: 'warm', options: ['warm', 'white'] }) };
 *     const spread = spreadFor(document);
 *     spread({ label: 'Story', parameters: { heading }, boxes: { hero: { type: 'photo', label: 'Photo' } },
 *       render: (ctx) => ... ctx.params.heading, ctx.boxes.hero.photo, ctx.document.paper ... });
 */
export function spreadFor<const D extends Parameters>(document: D): <
  const P extends Parameters = {},
  const B extends Record<string, BoxDeclaration> = {},
  const E extends Record<string, ElementDeclaration> = {},
>(definition: {
  label: string;
  span?: Span;
  parameters?: P;
  boxes?: B;
  elements?: E;
  render(context: RenderContext<{ label: string; parameters: P; boxes: B; elements: E }, D>): ImageFlowNode;
  /** Places other spreads can refer to through `ctx.book`, declared from this spread's values. */
  anchors?(context: AnchorContext<ParameterValues<P>, ParameterValues<D>>): readonly AnchorDeclaration[];
}) => SpreadDefinition;

// Components

export type CSSProperties =
  { [K in keyof CSSStyleDeclaration as CSSStyleDeclaration[K] extends string ? K : never]?: string | number } &
  { [property: `--${string}`]: string | number | undefined };
export type ImageFlowElement = { readonly type: unknown; readonly props: unknown; readonly key: string | null };
export type ImageFlowNode = ImageFlowElement | string | number | bigint | boolean | null | undefined | Iterable<ImageFlowNode>;
type Styling = { className?: string; style?: CSSProperties };

/** The root of every spread. Sets `--trim-width`, `--trim-height`, `--bleed-*`, and `--safe-*` CSS variables. */
export function Spread(props: Styling & { children?: ImageFlowNode }): ImageFlowElement;
/**
 * A box that shows the photo assigned to box `id`, cropped to fill it. In the editor, clicking it edits the box's
 * parameters and any others it is marked with.
 */
export function PhotoBox(props: Styling & EditMarker & { id: string }): ImageFlowElement;
/**
 * A box that shows its part of the Markdown text assigned to box `id`. `columns` (1–6, default 1) splits it into
 * columns; set the gap with the `columnGap` style. Text fills each column before continuing in the next box.
 * In the editor, clicking it edits the box's parameters and any others it is marked with: `{...ctx.edit('textSize')}`.
 */
export function MarkdownBox(props: Styling & EditMarker & { id: string; columns?: number }): ImageFlowElement;
/**
 * Generated content with parameters, such as a calendar grid. In the editor, clicking it edits the element's
 * parameters and any others it is marked with: `<Element id="grid" {...ctx.edit('month')}>`.
 */
export function Element(props: Styling & EditMarker & { id: string; children?: ImageFlowNode }): ImageFlowElement;
/** URL of a file in `template/assets/`. */
export function asset(path: string): string;
/**
 * The content of a file parameter's value, read as UTF-8 text before rendering, so preview and export see the same
 * input. Undefined when no file is assigned, or when the assigned file is missing or unreadable; ImageFlow reports the
 * latter in the Book check. Parse the text yourself and mark problems on a rendered node with `data-issue="…"`.
 */
export function file(id: string): { name: string; extension: string; text: string } | undefined;
