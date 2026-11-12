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

/** One length for every side, or `{ all, ...sides }` where the named sides override `all`, or all four sides. */
export type InsetsShorthand = Length | (Partial<Insets> & { all: Length }) | Insets;
/**
 * Builds a complete `PrintFormat` with less repetition: insets take one length for every side, and `ends`, `delivery`
 * and the PDF output basics have defaults. The result is an ordinary, fully specified `PrintFormat`. It describes
 * geometry, not a printer product: copy page counts, resolution and file limits from your printer's specification.
 *
 *     printFormat({ label: 'Square · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
 *       bleed: { all: mm(3), binding: mm(0) }, safe: mm(12), pageCount: { min: 24, max: 120, step: 2 } })
 */
export function printFormat(options: {
  label: string;
  trim: { width: Length; height: Length };
  bleed: InsetsShorthand;
  safe: InsetsShorthand;
  pageCount: { min: number; max: number; step: 2 | 4 };
  /** Default `'pages'`. */
  delivery?: 'pages' | 'spreads';
  /** Default `'single-pages'`. */
  ends?: 'single-pages' | 'inside-covers';
  /** Defaults to `{ container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' }`; given fields replace these. */
  output?: Partial<PrintFormat['output']>;
}): PrintFormat;

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
/** Rejects option names the parameter type does not have, such as `mutliline`, which ImageFlow would ignore. */
type Known<O, Allowed> = O & { [K in Exclude<keyof O, keyof Allowed>]: never };
export const p: {
  boolean<const O extends Options<BooleanParameter>>(options: Known<O, Options<BooleanParameter>>): O & { type: 'boolean' };
  string<const O extends Options<StringParameter>>(options: Known<O, Options<StringParameter>>): O & { type: 'string' };
  integer<const O extends Options<IntegerParameter>>(options: Known<O, Options<IntegerParameter>>): O & { type: 'integer' };
  number<const O extends Options<NumberParameter>>(options: Known<O, Options<NumberParameter>>): O & { type: 'number' };
  enum<const T extends string>(options: Common & { options: readonly T[]; default: NoInfer<T>; labels?: Partial<Record<T, string>> }):
    Common & { options: readonly T[]; default: T; labels?: Partial<Record<T, string>>; type: 'enum' };
  color<const O extends Options<ColorParameter>>(options: Known<O, Options<ColorParameter>>): O & { type: 'color' };
  date<const O extends Options<DateParameter>>(options: Known<O, Options<DateParameter>>): O & { type: 'date' };
  file<const O extends Omit<FileParameter, 'type' | 'default'>>(options: Known<O, Omit<FileParameter, 'type' | 'default'>>): O & { type: 'file'; default: '' };
};

// Editing UI

/** A value `when` compares a parameter with. An array matches any of its values. */
export type ConditionValue = string | number | boolean | readonly (string | number | boolean)[];
/**
 * Shows a control or group only while the named parameters of the same scope have these values (all must match).
 * A hidden control keeps its saved value; validation and project commands are unaffected.
 */
export type Condition<K extends string = string> = { [P in K]?: ConditionValue };
/**
 * One entry of `controls`: a parameter ID, a parameter with presentation options, or a titled group.
 *
 *     controls: ['show', { group: 'Stamp', when: { show: true }, controls: ['text', { parameter: 'tilt', label: 'Rotation' }] }]
 */
export type ControlItem<K extends string = string> =
  | K
  | { parameter: K; label?: string; description?: string; when?: Condition<K> }
  | { group: string; description?: string; controls: readonly ControlItem<K>[]; when?: Condition<K> };
/**
 * Arranges the generated controls of a scope's parameters: their order, groups, labels, descriptions and
 * conditions. Without `controls`, every parameter gets a control in declaration order. A parameter left out gets no
 * control but keeps its value, validation and project commands; use that for values only a custom editor or an
 * agent sets.
 */
export type Controls<K extends string = string> = readonly ControlItem<K>[];

// Declarations

export type BoxDeclaration = { type: 'photo' | 'markdown'; label: string; parameters?: Parameters; flowOrder?: number; controls?: Controls };
/**
 * Props of a template-supplied element editor. `values` holds all of the element's parameters with the draft
 * applied, including changes in the dialog's generated controls as the user makes them, so the editor can preview
 * the whole element; `set` changes the editor's own parameters in the draft. ImageFlow validates and saves the draft when
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
  /**
   * ImageFlow's own control for one of this editor's parameters, bound to the draft: the same text field, slider,
   * choice or file chooser the generated controls use, including importing a file. Compose it with your own UI:
   * `<Control parameter="track" />`.
   */
  Control(props: { parameter: string; label?: string }): ImageFlowElement;
  /**
   * Lets the user import a file into the project, offering these extensions, and resolves to its file ID (or
   * undefined when they cancel). Assign it with `set`, so Done saves it and Cancel discards the assignment; the
   * imported file stays in the project. `file(id)` reads it at once.
   */
  importFile(accept: readonly string[]): Promise<string | undefined>;
};
/**
 * An element's own editor for some of its parameters, shown in ImageFlow's editor dialog. It runs in a sandboxed
 * frame with the template's CSS. The dialog shows the element's other parameters below it as generated controls,
 * so the whole element is edited in one place and saved together with Done.
 */
export type ElementEditor<K extends string = string> = {
  label?: string;
  parameters: readonly K[];
  component(props: ElementEditorProps): ImageFlowNode;
  presentation?: 'dialog';
};
export type ElementDeclaration = { label: string; parameters?: Parameters; controls?: Controls; editor?: ElementEditor };
export type SpreadDeclaration = {
  label: string;
  /** `left` or `right` for a single page at the start or end of the book. Default `spread`. */
  span?: Span;
  parameters?: Parameters;
  controls?: Controls;
  boxes?: Record<string, BoxDeclaration>;
  elements?: Record<string, ElementDeclaration>;
};
/** Rejects properties a declaration does not have, such as a misspelt `flowOrdr`, in object literals and helpers alike. */
type Exact<T, Allowed> = { [X in Exclude<keyof T, keyof Allowed>]: never };
/** Rejects keys a parameter of its type does not have, such as `mutliline`, also in objects written without `p`. */
type ParametersChecked<P> = { [K in keyof P]: Exact<P[K], Extract<Parameter, { type: P[K] extends { type: infer T } ? T : never }>> };
type OwnParametersChecked<T> = T extends { parameters: infer P } ? { parameters: ParametersChecked<P> } : unknown;
/** Types each element's `controls` and `editor.parameters` with that element's own parameter IDs. */
type ElementsChecked<E> = { [K in keyof E]: { controls?: Controls<ParameterKeys<E[K]>>; editor?: ElementEditor<ParameterKeys<E[K]>> } & Exact<E[K], ElementDeclaration> & OwnParametersChecked<E[K]> };
type BoxesChecked<B> = { [K in keyof B]: { controls?: Controls<ParameterKeys<B[K]>> } & Exact<B[K], BoxDeclaration> & OwnParametersChecked<B[K]> };

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

type BoxIds<S extends SpreadDeclaration, T extends 'photo' | 'markdown'> =
  { [K in keyof S['boxes'] & string]: NonNullable<S['boxes']>[K] extends { type: T } ? K : never }[keyof S['boxes'] & string];
/** Column count of a Markdown box, also as a numeric string such as an enum option `'2'`. */
export type Columns = number | `${number}`;

type ParameterKeys<T> = T extends { parameters?: infer P } ? keyof NonNullable<P> & string : never;
type NestedPaths<Group extends string, R> = { [K in keyof R & string]: `${Group}.${K}.${ParameterKeys<R[K]>}` }[keyof R & string];
/** A parameter that `edit` can point at: `heading`, `document.paper`, `elements.grid.firstWeekday`, or `boxes.hero.showCaption`. */
export type EditPath<S extends SpreadDeclaration = SpreadDeclaration, D extends Parameters = Parameters> =
  | ParameterKeys<S> | `document.${keyof D & string}`
  | NestedPaths<'elements', NonNullable<S['elements']>> | NestedPaths<'boxes', NonNullable<S['boxes']>>;
type StringKeys<P> = { [K in keyof P & string]: P[K] extends { type: 'string' } ? K : never }[keyof P & string];
type StringParameterKeys<T> = T extends { parameters?: infer P } ? StringKeys<NonNullable<P>> : never;
type NestedStringPaths<Group extends string, R> = { [K in keyof R & string]: `${Group}.${K}.${StringParameterKeys<R[K]>}` }[keyof R & string];
/** A string parameter that `Text` can show: `heading`, `document.title`, `elements.map.label`, or `boxes.hero.credit`. */
export type TextPath<S extends SpreadDeclaration = SpreadDeclaration, D extends Parameters = Parameters> =
  | StringParameterKeys<S> | `document.${StringKeys<D>}`
  | NestedStringPaths<'elements', NonNullable<S['elements']>> | NestedStringPaths<'boxes', NonNullable<S['boxes']>>;
/** Attributes returned by `edit`. Spread them onto the node that shows the parameters. */
export type EditMarker = { 'data-edit'?: string };
/** Attributes returned by `issue`. Spread them onto a native node or any platform component, including `Spread`. */
export type IssueMarker = { 'data-issue'?: string; 'data-issue-info'?: string };
/**
 * Places a platform component at a rectangle (millimetres, spread coordinates) with absolute positioning. Properties
 * in `style` win over the ones `rect` sets, so `style={{ height: 'auto' }}` lets a heading grow.
 */
type Placement = { rect?: Rect };
/** HTML tags `Text` can render. */
export type TextTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div' | 'blockquote' | 'figcaption';
/**
 * Props of `ctx.Text`. It shows the string parameter's value in an `as` tag (default `p`) and marks it for editing.
 * When the value is empty, the editor shows `placeholder` (default: the parameter's `placeholder`, else its label);
 * the exported book shows nothing there.
 */
export type TextProps<Path extends string = string> = Styling & Placement & IssueMarker & { parameter: Path; as?: TextTag; placeholder?: string };

/** The geometry helpers with the spread's format already applied: `ctx.geometry.page('left', 'bleed')`. */
export type BoundGeometry = {
  /** One page of the spread. Works for single first and last pages too. */
  page(side: 'left' | 'right', area?: Area): Rect;
  /** Both pages. Its `safe` area keeps only the outer, top and bottom insets. */
  spread(area?: Area): Rect;
  /** Design coordinates on a fixed canvas scaled to this format's trim; see `geometry.design`. */
  design(canvas: { width: number; height: number }): DesignCanvas;
  inset: typeof geometry.inset;
  grid: typeof geometry.grid;
  css: typeof geometry.css;
};

/** The context passed to `render`, typed from a spread declared with the `spread` builder or `spreadFor`. */
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
   * `<h2 {...ctx.edit('heading')}>{ctx.params.heading}</h2>`. For a single string parameter, `ctx.Text` is shorter.
   * The marker is invisible and stays in the exported artwork, so the Book check can name the parameter a text shows.
   */
  edit(...paths: EditPath<S, D>[]): EditMarker;
  /** Page count and the anchors all spreads declare: `ctx.book.anchor('map')?.page`. */
  book: BookContext;
  /** The geometry helpers for this spread's format: `<ctx.PhotoBox id="hero" rect={ctx.geometry.page('left', 'bleed')} />`. */
  geometry: BoundGeometry;
  /** `PhotoBox` limited to this layout's photo box IDs: `<ctx.PhotoBox id="hero" />` fails type checking for unknown IDs. */
  PhotoBox(props: Styling & Placement & EditMarker & IssueMarker & { id: BoxIds<S, 'photo'> }): ImageFlowElement;
  /** `MarkdownBox` limited to this layout's Markdown box IDs. */
  MarkdownBox(props: Styling & Placement & EditMarker & IssueMarker & { id: BoxIds<S, 'markdown'>; columns?: Columns }): ImageFlowElement;
  /** `Element` limited to this layout's element IDs. */
  Element(props: Styling & Placement & EditMarker & IssueMarker & { id: keyof S['elements'] & string; children?: ImageFlowNode }): ImageFlowElement;
  /**
   * Shows a string parameter and makes it editable by clicking it: `<ctx.Text parameter="heading" as="h2" rect={...} />`.
   * Use `ctx.edit` for nodes that combine several parameters or show more than the value.
   */
  Text(props: TextProps<TextPath<S, D>>): ImageFlowElement;
};

/** The render context of a spread declared as a plain object, without the `spread` builder. */
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
  geometry: BoundGeometry;
  PhotoBox: typeof PhotoBox;
  MarkdownBox: typeof MarkdownBox;
  Element: typeof Element;
  Text(props: TextProps): ImageFlowElement;
};

/**
 * Declares a spread's anchors from its saved values. ImageFlow calls it for every spread before rendering, so it must
 * be a pure function of `params` and `document`.
 */
export type AnchorContext<P = Values, D = Values> = { params: P; document: D };

/** Type-only marker: the document parameters a spread's render context was typed with. Never set it yourself. */
declare const typedDocument: unique symbol;
export type SpreadDefinition<D extends Parameters = Parameters> = SpreadDeclaration & {
  render(context: UntypedRenderContext): ImageFlowNode;
  anchors?(context: AnchorContext): readonly AnchorDeclaration[];
  readonly [typedDocument]?: D;
};
/** Template API features beyond the first contract-1 release. List the ones a template uses in `requires`. */
export type Capability = 'anchors' | 'geometry' | 'box-helpers' | 'template-issues' | 'typed-components' |
  'spread-builder' | 'bound-geometry' | 'text-component' | 'format-helper' | 'box-records' | 'editor-controls' | 'editor-native-controls' |
  'opening-spreads';
/** The features this app provides. */
export const capabilities: readonly Capability[];

/** The template as ImageFlow reads it, after `defineTemplate` has built its spreads. */
export type TemplateDeclaration = {
  id: string;
  version: string;
  contract: 1;
  requires?: readonly Capability[];
  format?: PrintFormat;
  formats?: Record<string, PrintFormat>;
  defaultFormat?: string;
  parameters?: Parameters;
  spreads: Record<string, SpreadDefinition>;
  openingSpreads?: readonly OpeningSpread[];
};

/**
 * A spread a new book starts with: one of the template's layouts, optionally with some of that layout's own
 * parameters set. Requires the `opening-spreads` capability.
 */
export type OpeningSpread<L extends string = string> = { layout: L; params?: Values };

/** Declares one spread with a render context typed from its own declarations and the template's document parameters. */
export type SpreadBuilder<D extends Parameters> = <
  const P extends Parameters = {},
  const B extends Record<string, BoxDeclaration> = {},
  const E extends Record<string, ElementDeclaration> = {},
>(definition: {
  label: string;
  /** `left` or `right` for a single page at the start or end of the book. Default `spread`. */
  span?: Span;
  parameters?: P & ParametersChecked<P>;
  /** Arranges the controls of this layout's own parameters in the sidebar. */
  controls?: Controls<keyof P & string>;
  boxes?: B & BoxesChecked<B>;
  elements?: E & ElementsChecked<E>;
  render(context: RenderContext<{ label: string; parameters: P; boxes: B; elements: E }, D>): ImageFlowNode;
  /** Places other spreads can refer to through `ctx.book`, declared from this spread's values. */
  anchors?(context: AnchorContext<ParameterValues<P>, ParameterValues<D>>): readonly AnchorDeclaration[];
}) => SpreadDefinition<D>;
/** What `spreads` receives when it is a function. */
export type TemplateTools<D extends Parameters> = { spread: SpreadBuilder<D> };

type TemplateBase<D extends Parameters> = {
  /** Stable template ID; `project.json` refers to it. */
  id: string;
  version: string;
  contract: 1;
  /**
   * Features this template needs, such as `['anchors', 'geometry']`. An app without one of them reports which,
   * instead of failing in a layout. Apps older than this field ignore it.
   */
  requires?: readonly Capability[];
  /** Book settings, shown in Book settings and read through `ctx.document`. */
  parameters?: D & ParametersChecked<D>;
};
/**
 * The spreads a new book starts with, in order. Without it, a new book starts with no spreads and the editor asks for
 * the first one. Single-page layouts must sit at a book end every format allows.
 */
type Opening<L extends string> = { openingSpreads?: readonly OpeningSpread<L>[] };
/** Every layout `openingSpreads` names must be declared in `spreads`; a missing one is reported there. */
type OpeningLayouts<S, L extends string> = { [K in Exclude<L, keyof S>]: SpreadDefinition<any> };
/**
 * Declare one `format`, or several named `formats` the user chooses between in Book settings (`defaultFormat`,
 * else the first, is used until they do). Layouts adapt through `ctx.format`, `ctx.formatId`, `ctx.geometry`, and the
 * `--trim-*`, `--bleed-*` and `--safe-*` CSS variables of `<Spread>`.
 */
type FormatChoice<F extends string> =
  | { format: PrintFormat; formats?: never; defaultFormat?: never }
  | { formats: { [K in F]: PrintFormat }; defaultFormat?: NoInfer<F>; format?: never };
type Missing<D, Typed> = Exclude<keyof Typed, keyof D> & string;
/** Parameters both declare whose template values a spread typed with `Typed` could not accept, such as a wider enum. */
type Mismatched<D, Typed> = { [K in keyof Typed & keyof D]: [ParameterValue<D[K]>] extends [ParameterValue<Typed[K]>] ? never : K }[keyof Typed & keyof D] & string;
/**
 * A spread typed with `spreadFor(document)` must not read document parameters the template does not declare: at
 * runtime they would be undefined.
 */
type TypedWith<T> = typeof typedDocument extends keyof T ? NonNullable<T[typeof typedDocument & keyof T]> : {};
type DocumentCheck<S, D> = {
  // Untyped spreads (`any`) are not checked.
  [K in keyof S]: (0 extends 1 & TypedWith<S[K]> ? unknown : [Missing<D, TypedWith<S[K]>>] extends [never]
    ? [Mismatched<D, TypedWith<S[K]>>] extends [never] ? unknown
      : { [typedDocument]: `Document parameter ${Mismatched<D, TypedWith<S[K]>>} is declared differently in the template's parameters and in spreadFor()` }
    : { [typedDocument]: `Declare document parameter ${Missing<D, TypedWith<S[K]>>} in the template's parameters, or remove it from spreadFor()` })
    & SpreadChecked<S[K]>;
};
/** A spread written as a plain object gets the same unknown-property checks as one from the builder. */
type SpreadChecked<T> = 0 extends 1 & T ? unknown : Exact<T, SpreadDefinition<any>> & OwnParametersChecked<T>
  & (T extends { boxes: infer B } ? { boxes: BoxesChecked<B> } : unknown)
  & (T extends { elements: infer E } ? { elements: ElementsChecked<E> } : unknown);

/**
 * Declares the template. Prefer `spreads` as a function: its `spread` builder types every layout's `ctx.document`
 * from `parameters`, so the document settings are declared once.
 *
 *     export default defineTemplate({
 *       id: 'travel', version: '1.0.0', contract: 1, format,
 *       parameters: { accent: p.color({ label: 'Accent', default: '#243b30' }) },
 *       spreads: ({ spread }) => ({
 *         story: spread({ label: 'Story', boxes: { hero: box.photo('Photo') }, render: (ctx) => ... ctx.document.accent ... }),
 *       }),
 *     });
 */
// Two signatures rather than a union: TypeScript cannot infer the spreads through a union of a record and a
// function, and would then check neither against the document parameters.
export function defineTemplate<
  const D extends Parameters = {},
  const F extends string = never,
  const S extends Record<string, SpreadDefinition<any>> = {},
  const L extends string = never,
>(template: TemplateBase<D> & FormatChoice<F> & Opening<L> & { spreads: (tools: TemplateTools<D>) => S & DocumentCheck<S, D> & OpeningLayouts<S, L> }): TemplateDeclaration;
export function defineTemplate<
  const D extends Parameters = {},
  const F extends string = never,
  const S extends Record<string, SpreadDefinition<any>> = {},
  const L extends string = never,
>(template: TemplateBase<D> & FormatChoice<F> & Opening<L> & { spreads: S & DocumentCheck<S, D> & OpeningLayouts<S, L> }): TemplateDeclaration;

/**
 * Returns a `spread` builder typed with these document parameters, for spreads declared outside `defineTemplate`,
 * such as in their own files. Pass the same object as the template's `parameters`:
 *
 *     export const document = { paper: p.enum({ label: 'Paper', default: 'warm', options: ['warm', 'white'] }) };
 *     export const spread = spreadFor(document);
 */
export function spreadFor<const D extends Parameters>(document: D & ParametersChecked<D>): SpreadBuilder<D>;

// Components

export type CSSProperties =
  { [K in keyof CSSStyleDeclaration as CSSStyleDeclaration[K] extends string ? K : never]?: string | number } &
  { [property: `--${string}`]: string | number | undefined };
export type ImageFlowElement = { readonly type: unknown; readonly props: unknown; readonly key: string | null };
export type ImageFlowNode = ImageFlowElement | string | number | bigint | boolean | null | undefined | Iterable<ImageFlowNode>;
type Styling = { className?: string; style?: CSSProperties };

/** The root of every spread. Sets `--trim-width`, `--trim-height`, `--bleed-*`, and `--safe-*` CSS variables. */
export function Spread(props: Styling & IssueMarker & { children?: ImageFlowNode }): ImageFlowElement;
/**
 * A box that shows the photo assigned to box `id`, cropped to fill it. In the editor, clicking it edits the box's
 * parameters and any others it is marked with.
 */
export function PhotoBox(props: Styling & Placement & EditMarker & IssueMarker & { id: string }): ImageFlowElement;
/**
 * A box that shows its part of the Markdown text assigned to box `id`. `columns` (1–6, default 1) splits it into
 * columns; set the gap with the `columnGap` style. Text fills each column before continuing in the next box.
 * In the editor, clicking it edits the box's parameters and any others it is marked with: `{...ctx.edit('textSize')}`.
 */
export function MarkdownBox(props: Styling & Placement & EditMarker & IssueMarker & { id: string; columns?: Columns }): ImageFlowElement;
/**
 * Generated content with parameters, such as a calendar grid. In the editor, clicking it edits the element's
 * parameters and any others it is marked with: `<Element id="grid" {...ctx.edit('month')}>`.
 */
export function Element(props: Styling & Placement & EditMarker & IssueMarker & { id: string; children?: ImageFlowNode }): ImageFlowElement;
// Reusable declarations

/**
 * Box declarations to reuse across layouts. The ID stays where the box is declared, so it keeps its saved identity:
 * `boxes: { hero: box.photo('Main photo', { caption }), body: box.markdown('Story', { flowOrder: 1 }) }`.
 */
export const box: {
  photo<const P extends Parameters = {}>(label: string, parameters?: P & ParametersChecked<P>, options?: { controls?: Controls<keyof P & string> }):
    { type: 'photo'; label: string; parameters: P; controls?: Controls<keyof P & string> };
  markdown<const P extends Parameters = {}>(label: string, options?: { flowOrder?: number; parameters?: P & ParametersChecked<P>; controls?: Controls<keyof P & string> }):
    { type: 'markdown'; label: string; parameters: P; flowOrder?: number; controls?: Controls<keyof P & string> };
  /**
   * Several photo boxes with explicit IDs, typed without casts: `boxes: box.photos(['one', 'two'], (id, i) => 'Photo ' + (i + 1))`.
   * The IDs are saved identities, so list them literally and never derive them from content.
   */
  photos<const K extends string, const P extends Parameters = {}>(ids: readonly K[], label: (id: K, index: number) => string, parameters?: P & ParametersChecked<P>):
    { [Id in K]: { type: 'photo'; label: string; parameters: P } };
};

// Geometry

/**
 * A rectangle in millimetres in spread coordinates: x from the left page's trim edge (the right page starts at the
 * trim width), y from the top trim edge. Place a platform component with `rect={rect}`, or any node with `style={geometry.css(rect)}`, inside `<Spread>`.
 */
export type Rect = { x: number; y: number; width: number; height: number };
/**
 * `trim`: the page as cut. `safe`: the trim minus the format's safe insets (outside or binding by side). `bleed`: the
 * outer edges extended into the bleed; the edge at the fold stays at the fold, because a page's binding bleed shows
 * the facing page.
 */
export type Area = 'trim' | 'safe' | 'bleed';
/** Rectangles on a design canvas, scaled to the trim; `width`/`height` convert a design length to millimetres. */
export type DesignCanvas = {
  left(x: number, y: number, width: number, height: number): Rect;
  right(x: number, y: number, width: number, height: number): Rect;
  width(value: number): number;
  height(value: number): number;
};
export const geometry: {
  /** One page of the spread. Works for single first and last pages too. */
  page(format: ResolvedFormat, side: 'left' | 'right', area?: Area): Rect;
  /** Both pages. Its `safe` area keeps only the outer, top and bottom insets. */
  spread(format: ResolvedFormat, area?: Area): Rect;
  /** Shrinks a rectangle by millimetres on every side, or on the named sides. */
  inset(rect: Rect, by: number | { top?: number; right?: number; bottom?: number; left?: number }): Rect;
  /** Equal cells in reading order. Gaps in millimetres are between cells only. */
  grid(rect: Rect, options: { columns: number; rows?: number; gap?: number; columnGap?: number; rowGap?: number }): Rect[];
  /**
   * Design coordinates: positions on a fixed design canvas, such as 290 × 290 units, scaled to the chosen trim,
   * horizontally with its width and vertically with its height. Type sizes do not scale. `width`/`height` convert
   * a design length to millimetres.
   */
  design(format: ResolvedFormat, canvas: { width: number; height: number }): DesignCanvas;
  /** Absolute positioning for a rectangle, in millimetres. */
  css(rect: Rect): CSSProperties;
};

// Template findings

/**
 * A finding about the template's input, such as an assigned file it cannot parse. `file` is the file ID of a file
 * parameter. Reported in the Book check and by `check_book` as `template:<code>` on the given box or element, or
 * else on the one that contains the node. `error` blocks print export; the default is `warning`.
 */
export type TemplateIssue = {
  code: string; message: string; severity?: 'error' | 'warning';
  box?: string; element?: string; parameter?: string; file?: string;
  details?: Record<string, string | number>; suggestion?: string;
};
/**
 * Attributes that report a finding. Spread them onto a rendered node or a platform component such as `Element`;
 * a hidden node works in export:
 * `<span hidden {...issue({ code: 'gpx-invalid', message, element: 'route', parameter: 'track', file: track })} />`.
 * The plain `data-issue="…"` attribute still works and reports a `template-issue` warning.
 */
export function issue(found: TemplateIssue): Required<IssueMarker>;

/** URL of a file in `template/assets/`. */
export function asset(path: string): string;
/**
 * The content of a file parameter's value, read as UTF-8 text before rendering, so preview and export see the same
 * input. Undefined when no file is assigned, or when the assigned file is missing or unreadable; ImageFlow reports the
 * latter in the Book check. Parse the text yourself and mark problems on a rendered node with `data-issue="…"`.
 */
export function file(id: string): { name: string; extension: string; text: string } | undefined;

// Only the declarations marked `export` above are part of the module.
export {};
