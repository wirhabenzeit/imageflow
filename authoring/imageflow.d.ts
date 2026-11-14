// Types for the `imageflow` module that ImageFlow provides to templates at runtime (template contract 1).
// ImageFlow keeps this file in sync with the app; edit your template, not this file.

// Lengths and print format

export type Length = { value: number; unit: 'mm' | 'pt' | 'in' };
export function mm(value: number): Length;
export function pt(value: number): Length;
export function inch(value: number): Length;

/** Insets of a format with facing pages: `outside` is the edge away from the fold, `binding` the edge at it. */
type Insets = { top: Length; bottom: Length; outside: Length; binding: Length };
/** Insets of a format without facing pages, named by the page's own edges. */
type PageInsets = { top: Length; bottom: Length; left: Length; right: Length };
/**
 * The pages a layout occupies. `'spread'` (two facing pages), `'left'` and `'right'` (a single page at a book end)
 * fit formats with facing pages; `'page'` fits formats without them (`facingPages: false`).
 */
export type Span = 'spread' | 'left' | 'right' | 'page';
export type Resolution = { minimum: number; target: number; maximum: number };

type FormatOutput = {
  container: 'pdf';
  colorSpace: 'sRGB';
  transparency: 'allow' | 'forbid';
  /** Effective photo resolution in ppi. Below `minimum` blocks print export; export downsamples to `maximum`. */
  resolution?: Resolution;
  minimumTextSize?: Length;
  /** Maximum PDF size in bytes. */
  maximumFileSize?: { pages: number; cover?: number };
  /** @deprecated Omit this field. Print always rejects Type 3 and fonts outside the template bundle. */
  fonts?: { allowType3: false; allowSystemFonts: false };
};
/** A format with facing pages: layouts are designed as spreads. */
export type FacingFormat = {
  label: string;
  trim: { width: Length; height: Length };
  bleed: Insets;
  safe: Insets;
  structure: {
    /** Default `true`. */
    facingPages?: true;
    delivery: 'pages' | 'spreads';
    ends: 'single-pages' | 'inside-covers';
    pageCount: { min: number; max: number; step: 2 | 4 };
  };
  output: FormatOutput;
};
/**
 * A format without facing pages, such as a wall calendar, cards or posters: every unit is one page, designed, checked
 * and exported on its own. Layouts use `span: 'page'`. Included in the contract-1 baseline.
 */
export type SinglePageFormat = {
  label: string;
  trim: { width: Length; height: Length };
  bleed: PageInsets;
  safe: PageInsets;
  structure: {
    facingPages: false;
    pageCount: { min: number; max: number; step: 1 | 2 | 4 };
  };
  output: FormatOutput;
};
export type PrintFormat = FacingFormat | SinglePageFormat;

/** One length for every side, or `{ all, ...sides }` where the named sides override `all`, or all four sides. */
export type InsetsShorthand = Length | (Partial<Insets> & { all: Length }) | Insets;
/** `InsetsShorthand` with the side names of a format without facing pages. */
export type PageInsetsShorthand = Length | (Partial<PageInsets> & { all: Length }) | PageInsets;
type FormatOptions = {
  label: string;
  trim: { width: Length; height: Length };
  /** Defaults to `{ container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' }`; given fields replace these. */
  output?: Partial<FormatOutput>;
};
type FacingFormatOptions = FormatOptions & {
  /** Default `true`. */
  facingPages?: true;
  bleed: InsetsShorthand;
  safe: InsetsShorthand;
  pageCount: { min: number; max: number; step: 2 | 4 };
  /** Default `'pages'`. */
  delivery?: 'pages' | 'spreads';
  /** Default `'single-pages'`. */
  ends?: 'single-pages' | 'inside-covers';
};
type SinglePageFormatOptions = FormatOptions & {
  facingPages: false;
  bleed: PageInsetsShorthand;
  safe: PageInsetsShorthand;
  pageCount: { min: number; max: number; step: 1 | 2 | 4 };
  /** Formats without facing pages have no delivery choice: every page is its own PDF page. */
  delivery?: never;
  /** Formats without facing pages have no book ends. */
  ends?: never;
};
/**
 * Builds a complete `PrintFormat` with less repetition: insets take one length for every side, and `ends`, `delivery`
 * and the PDF output basics have defaults. The result is an ordinary, fully specified `PrintFormat`. It describes
 * geometry, not a printer product: copy page counts, resolution and file limits from your printer's specification.
 *
 *     printFormat({ label: 'Square · 20 × 20 cm', trim: { width: mm(200), height: mm(200) },
 *       bleed: { all: mm(3), binding: mm(0) }, safe: mm(12), pageCount: { min: 24, max: 120, step: 2 } })
 *
 * With `facingPages: false` every unit is one page and the insets use `left` and `right`:
 *
 *     printFormat({ label: 'Wall calendar · A4', trim: { width: mm(210), height: mm(297) }, facingPages: false,
 *       bleed: mm(3), safe: mm(8), pageCount: { min: 13, max: 13, step: 1 } })
 */
export function printFormat(options: SinglePageFormatOptions): SinglePageFormat;
export function printFormat(options: FacingFormatOptions): FacingFormat;
export function printFormat(options: FacingFormatOptions | SinglePageFormatOptions): PrintFormat;

type Millimeters = {
  trim: { width: number; height: number };
  /** Width of one PDF page with its bleed. */
  pageWidth: number;
  /** Width of the sheet a layout draws on, with bleed: the spread, or the page without facing pages. */
  spreadWidth: number;
  outputWidth: number;
  height: number;
  resolution?: Resolution;
};
/** The print format in millimetres, as passed to `render`. Check `facingPages` before reading side-specific insets. */
export type ResolvedFormat =
  | Millimeters & { facingPages: true; bleed: { top: number; bottom: number; outside: number; binding: number };
    safe: { top: number; bottom: number; outside: number; binding: number } }
  | Millimeters & { facingPages: false; bleed: { top: number; bottom: number; left: number; right: number };
    safe: { top: number; bottom: number; left: number; right: number } };

// Parameters

type Common = {
  label: string;
  /**
   * Plain text for authoring tools and agents, up to 500 characters: what the value means, which way it goes and when
   * to change it, such as `'Higher values zoom in; 1 shows the whole route.'`. Shown in the authoring context and MCP
   * inspection, never in the editor's controls; it changes no default, constraint or saved value. Use `unit` for units.
   */
  description?: string;
};
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
type EnumKeys<C> = `${Extract<keyof C, string | number>}`;
export const p: {
  boolean<const O extends Options<BooleanParameter>>(options: Known<O, Options<BooleanParameter>>): O & { type: 'boolean' };
  string<const O extends Options<StringParameter>>(options: Known<O, Options<StringParameter>>): O & { type: 'string' };
  integer<const O extends Options<IntegerParameter>>(options: Known<O, Options<IntegerParameter>>): O & { type: 'integer' };
  number<const O extends Options<NumberParameter>>(options: Known<O, Options<NumberParameter>>): O & { type: 'number' };
  enum<const T extends string>(options: Common & { options: readonly T[]; default: NoInfer<T>; labels?: Partial<Record<T, string>> }):
    Common & { options: readonly T[]; default: T; labels?: Partial<Record<T, string>>; type: 'enum' };
  /** Keys become string values in JavaScript enumeration order (array index keys first). Use arrays for an explicit order. */
  enum<const C extends Record<string, string>>(options: Common & { options: C; default: NoInfer<EnumKeys<C>> }):
    Common & { options: EnumKeys<C>[]; default: EnumKeys<C>; labels: C; type: 'enum' };
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
 * the whole element; `set` applies the editor's own parameters. Each change is validated and undoable.
 * `commit` finishes typing and closes;
 * `cancel` closes without applying unfinished typing. Neither reverts earlier applied changes.
 *
 * Type the props from the element's declaration, so a misspelt parameter or a wrong value fails type checking:
 *
 *     const route = { track: p.file({ ... }), zoom: p.number({ ... }) };
 *     function RouteEditor({ values, set, Control }: ElementEditorProps<typeof route, 'track' | 'zoom'>) { ... }
 *
 * `P` is the element's parameters, `K` the ones this editor lists in `editor.parameters` (default: all of `P`), and
 * `D` the template's document parameters (default: untyped), `S` the layout's parameters, and `SK` the IDs the
 * editor lists in `spread`. Annotate inline editors in the same way. Without type arguments the props stay untyped.
 */
export type ElementEditorProps<P extends Parameters = Parameters, K extends keyof P & string = keyof P & string, D extends Parameters = Parameters,
  S extends Parameters = Parameters, SK extends keyof S & string = keyof S & string> = {
  values: ParameterValues<P>;
  /** Changes some of this editor's own parameters in the draft. Other keys and invalid values are ignored and reported. */
  set: EditorFunction<K, EditorChanges<P, K>, void>;
  /** All layout parameters, including drafts of those this editor owns. */
  spread: ParameterValues<S>;
  /** Changes only the layout parameters this editor lists in `spread`, in the same draft as `set`. */
  setSpread: EditorFunction<SK, EditorChanges<S, SK>, void>;
  /** The document settings, as `context.document`: current while the editor is open. */
  document: ParameterValues<D>;
  /** The format, as `context.format`: it follows a format change while the editor is open. */
  format: ResolvedFormat;
  /** The spread the editor was opened from, as `render` sees it, kept current while the editor is open. */
  context: EditorContext<SpreadDeclaration, D>;
  readOnly: boolean;
  commit(): void;
  cancel(): void;
  /** Where the editor is shown: `'inline'` on the page, in the element's frame, or `'dialog'` in the editor panel. */
  presentation: EditorPresentation;
  /**
   * Inline, the page keeps showing its artwork until the editor has drawn: call this while mounting with what it
   * still loads (a map's first tiles, an image), and the editor replaces the artwork once that settles, after a few
   * seconds at most. Does nothing in the panel or after the editor appeared.
   */
  waitUntil(until: Promise<unknown>): void;
  /**
   * ImageFlow's own control for one of this editor's parameters, bound to the draft: the same text field, slider,
   * choice or file chooser the generated controls use, including importing a file. Compose it with your own UI:
   * `<Control parameter="track" />`. `scope="spread"` names one of the layout parameters the editor declares in
   * `spread`: `<Control parameter="heading" scope="spread" />`.
   */
  Control: EditorFunction<K, { parameter: K; label?: string; scope?: 'element' }, ImageFlowElement>
    & EditorFunction<SK, { parameter: SK; label?: string; scope: 'spread' }, ImageFlowElement>;
  /**
   * Lets the user import a file into the project, offering these extensions, and resolves to its file ID (or
   * undefined when they cancel). Assign it with `set` to save the assignment immediately; the
   * imported file stays in the project. `file(id)` reads it at once.
   */
  importFile(accept: readonly string[]): Promise<string | undefined>;
};
/**
 * Typed props are checked strictly against the declaration, so an editor typed for `'zoon'` cannot be the editor of
 * an element that owns `'zoom'`. Untyped props (`K` is `string`) stay compatible with every declaration.
 */
type EditorChanges<P extends Parameters, K extends keyof P & string> = [K] extends [never] ? Record<string, never> : Partial<Pick<ParameterValues<P>, K>>;
type EditorFunction<K extends string, A, R> = string extends K ? { bivariant(argument: A): R }['bivariant'] : (argument: A) => R;
type ParametersOf<T> = T extends { parameters?: infer P } ? P extends Parameters ? P : {} : {};
type EditorSpreadKeys<T> = T extends { editor: { spread: readonly (infer K extends string)[] } } ? K : never;
type EditorKeys<T> = T extends { editor?: { parameters: readonly (infer K)[] } } ? K & string : never;
/**
 * An element's own editor for some of its parameters, shown in ImageFlow's non-modal editor panel. It runs in a sandboxed
 * frame with the template's CSS. The panel shows the element's other parameters below it as generated controls,
 * so the whole element is edited in one place, with changes applied as they happen.
 */
export type ElementEditor<K extends string = string, P extends Parameters = Parameters, Owned extends keyof P & string = K & keyof P & string,
  D extends Parameters = Parameters, S extends Parameters = Parameters, OwnedSpread extends keyof S & string = keyof S & string> = {
  label?: string;
  /** The element's own parameters this editor edits. */
  parameters: readonly K[];
  /** Layout parameters saved with the element in one edit; each belongs to one editor and has no sidebar control. */
  spread?: readonly (keyof S & string)[];
  component: EditorFunction<Owned, ElementEditorProps<P, Owned, D, S, OwnedSpread>, ImageFlowNode>;
  /**
   * `'inline'` edits on the page: the component runs in the element's own frame, at its printed size and position, in
   * place of its artwork, and the element's other parameters appear in a toolbar under the canvas. A rotated or
   * skewed element, or one too small to use, opens in the panel instead. Default `'dialog'`: the editor panel.
   */
  presentation?: EditorPresentation;
};
/** Where an editor is shown: `'dialog'`, the editor panel, or `'inline'`, on the page. */
export type EditorPresentation = 'dialog' | 'inline';
/**
 * The read-only view of the book an editor is opened from: the values `render` reads for that spread (its
 * parameters, the document's, boxes with their photos' metadata, elements, page numbers, the book's anchors and the
 * format), plus the spread's ID and layout. It follows the book while the editor stays open: reordering spreads,
 * another photo, a changed document setting or format refresh it. The editor's own draft is applied to it: an
 * element editor's element values and owned layout parameters, or a document editor's own document parameters. Markdown boxes'
 * `text` is null, since flow positions are known only to the book render. Pure helpers that take
 * `Pick<RenderContext, 'page' | 'book' | 'document'>` serve `render` and editors alike.
 */
export type EditorContext<S extends SpreadDeclaration = SpreadDeclaration, D extends Parameters = Parameters> =
  Pick<RenderContext<S, D>, 'params' | 'document' | 'boxes' | 'page' | 'format' | 'formatId' | 'book'> & {
    spread: string; layout: string;
    /** Actual rendered bounds in trim coordinates (mm). Null while the current page is pending or the element is hidden. */
    elements: SpreadDeclaration extends S ? Record<string, { params: Values; rect: Rect | null }>
      : { [K in keyof RenderContext<S, D>['elements']]: RenderContext<S, D>['elements'][K] & { rect: Rect | null } };
  };
/**
 * Props of a document editor. `values` holds only the editor's own document parameters (`K`), with the draft
 * applied, and `set` changes them. Every other setting is read from `context`, the spread the editor was opened
 * from, which follows the book while the editor is open. `format` is `context.format`. Included in the contract-1 baseline.
 *
 *     function MarkedDays({ values, set, context }: DocumentEditorProps<typeof documentParameters, 'markedDates'>) { ... }
 */
export type DocumentEditorProps<D extends Parameters = Parameters, K extends keyof D & string = keyof D & string> = {
  values: ParameterValues<Pick<D, K>>;
  /** Changes some of this editor's own document parameters in the draft. Other keys and invalid values are ignored and reported. */
  set: EditorFunction<K, EditorChanges<D, K>, void>;
  context: EditorContext<SpreadDeclaration, D>;
  format: ResolvedFormat;
  readOnly: boolean;
  commit(): void;
  cancel(): void;
  /** Where the editor is shown: `'inline'` over the marked node it was opened from, or `'dialog'` in the editor panel. */
  presentation: EditorPresentation;
  /**
   * Inline, the page keeps showing its artwork until the editor has drawn: call this while mounting with what it
   * still loads (a map's first tiles, an image), and the editor replaces the artwork once that settles, after a few
   * seconds at most. Does nothing in the panel or after the editor appeared.
   */
  waitUntil(until: Promise<unknown>): void;
  /** ImageFlow's own control for one of this editor's parameters, bound to the draft. */
  Control: EditorFunction<K, { parameter: K; label?: string }, ImageFlowElement>;
  importFile(accept: readonly string[]): Promise<string | undefined>;
};
/**
 * An editor for document parameters, declared in the template's `editors`. A node marked only with parameters it
 * owns, such as `ctx.edit('document.markedDates')`, opens it in ImageFlow's editor panel with that spread's
 * `context`; its parameters get no control in the template controls. Each document parameter belongs to one editor.
 */
export type DocumentEditor<D extends Parameters = Parameters, K extends keyof D & string = keyof D & string> = {
  label?: string;
  /** The document parameters this editor edits. */
  parameters: readonly K[];
  component: EditorFunction<K, DocumentEditorProps<D, K>, ImageFlowNode>;
  /**
   * `'inline'` edits on the page, in the frame of the marked node the editor was opened from, in place of that node.
   * Default `'dialog'`: the editor panel.
   */
  presentation?: EditorPresentation;
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
  /** The layout family this layout is a variant of: a key of the template's `layoutFamilies`. */
  family?: string;
  /** Tags that tell this variant apart from the others in its family, such as `{ size: '3x3' }`. Pickers read them. */
  variant?: VariantTags;
};

// Layout families

/** Template-defined tags of a layout variant. ImageFlow gives them no meaning; a family's picker reads them. */
export type VariantTags = Record<string, string | number | boolean>;
export type LayoutVariant = { id: string; label: string; variant: VariantTags };
/**
 * Props of a layout family's controls. `current` is the chosen layout; `saved` is the spread's saved layout.
 * `choose` immediately applies another variant as one undoable layout switch; `find` returns the variant whose
 * tags include all the given ones. The controls appear beside the selected spread's other settings.
 * `commit` applies the current choice; `cancel` leaves the controls without reverting applied choices.
 */
export type LayoutPickerProps = {
  variants: readonly LayoutVariant[];
  current: string;
  saved: string;
  choose(id: string): void;
  find(tags: VariantTags): string | undefined;
  document: Values;
  format: ResolvedFormat;
  readOnly: boolean;
  commit(): void;
  cancel(): void;
};
/**
 * Layouts that are variants of one design, such as a 2×2 and a 3×3 photo grid. Each variant is an ordinary layout
 * that names the family with `family`; variants must have the same `span`. With a `picker`, the sidebar shows the
 * family as one preview and its controls beside the selected spread's other settings; without one, it shows each variant.
 */
export type LayoutFamily = {
  label: string;
  picker?: { label?: string; component(props: LayoutPickerProps): ImageFlowNode };
};
/** Rejects properties a declaration does not have, such as a misspelt `flowOrdr`, in object literals and helpers alike. */
type Exact<T, Allowed> = { [X in Exclude<keyof T, keyof Allowed>]: never };
/** Rejects keys a parameter of its type does not have, such as `mutliline`, also in objects written without `p`. */
type ParametersChecked<P> = { [K in keyof P]: Exact<P[K], Extract<Parameter, { type: P[K] extends { type: infer T } ? T : never }>> };
type OwnParametersChecked<T> = T extends { parameters: infer P } ? { parameters: ParametersChecked<P> } : unknown;
/**
 * Types each element's `controls` and `editor.parameters` with that element's own parameter IDs, and its editor's
 * props with its parameters, the IDs the editor lists, and the document parameters `D`.
 */
type ElementsChecked<E, D extends Parameters = Parameters, S extends Parameters = Parameters> = { [K in keyof E]: { controls?: Controls<ParameterKeys<E[K]>>;
  editor?: ElementEditor<ParameterKeys<E[K]>, ParametersOf<E[K]>, EditorKeys<E[K]> & keyof ParametersOf<E[K]> & string, D, S, EditorSpreadKeys<E[K]> & keyof S & string> }
  & Exact<E[K], ElementDeclaration> & OwnParametersChecked<E[K]> };
type BoxesChecked<B> = { [K in keyof B]: { controls?: Controls<ParameterKeys<B[K]>> } & Exact<B[K], BoxDeclaration> & OwnParametersChecked<B[K]> };

// Anchors

/**
 * A place other spreads can refer to, such as a chapter opening listed in a table of contents. `side` names the page
 * of a two-page spread (default: its first page); without facing pages it is ignored and the anchor's `side` is
 * `'page'`. Several spreads may declare the same ID; `book.anchors(id)` lists them all.
 */
export type AnchorDeclaration = { id: string; title?: string; side?: 'left' | 'right' };
/** A declared anchor with the book page it is on. */
export type Anchor = { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' | 'page' };
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
 * Empty or whitespace-only values inherit `fallback`, without saving it. `fallbackLabel` identifies its source
 * in the editor; `hidden` suppresses the node explicitly. With neither value nor fallback, edit mode shows
 * `placeholder` (default: the parameter's placeholder or label), and export shows an empty node.
 * `presentation="inline"` opts a string parameter into on-page typing (included in the contract-1 baseline), the same word
 * as an editor's `presentation`. Without it, or with `'dialog'`, the node opens the parameter panel. Multiline inline strings default to preserving line breaks; template CSS and `style` take precedence.
 */
export type TextProps<Path extends string = string> = Styling & Placement & IssueMarker & { parameter: Path; as?: TextTag; presentation?: EditorPresentation; placeholder?: string; fallback?: string; fallbackLabel?: string; hidden?: boolean };

/** The geometry helpers with the spread's format already applied: `ctx.geometry.page('left', 'bleed')`. */
export type BoundGeometry = {
  /** One page of the spread. Works for single first and last pages too. */
  page(side: 'left' | 'right', area?: Area): Rect;
  /** The page, in a format without facing pages: `ctx.geometry.page('safe')`. */
  page(area?: Area): Rect;
  /** Both pages. Its `safe` area keeps only the outer, top and bottom insets. Throws without facing pages. */
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
  /** Book page numbers of this spread's pages: `left` and `right`, or `number` for a page without facing pages. */
  page: { left?: number; right?: number; number?: number };
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
  page: { left?: number; right?: number; number?: number };
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
/** Type-only marker: the layout family the builder saw, checked against the template's `layoutFamilies`. */
declare const typedFamily: unique symbol;
export type SpreadDefinition<D extends Parameters = Parameters, F extends string = string> = SpreadDeclaration & {
  render(context: UntypedRenderContext): ImageFlowNode;
  anchors?(context: AnchorContext): readonly AnchorDeclaration[];
  readonly [typedDocument]?: D;
  readonly [typedFamily]?: F;
};
/**
 * Known feature names, all part of the contract-1 baseline, which needs no `requires` entries. Extensions added after
 * the first public release will be listed after it and declared in `requires` (ADR 0008).
 */
export type Capability = 'anchors' | 'geometry' | 'box-helpers' | 'template-issues' | 'typed-components' |
  'spread-builder' | 'bound-geometry' | 'text-component' | 'format-helper' | 'box-records' | 'editor-controls' | 'editor-native-controls' |
  'layout-families' | 'editor-spread-parameters' | 'opening-spreads' | 'single-pages' | 'editor-context' | 'document-editors' |
  'editor-network' | 'rendered-images' | 'inline-editors' | 'inline-text';
/** All features this app provides, including the contract-1 baseline and any later extensions. */
export const capabilities: readonly Capability[];

/** The template as ImageFlow reads it, after `defineTemplate` has built its spreads. */
export type TemplateDeclaration = {
  id: string;
  version: string;
  label?: string;
  description?: string;
  contract: 1;
  /** Optional extensions beyond the contract-1 baseline. Older lists of baseline features remain accepted. */
  requires?: readonly Capability[];
  network?: readonly string[];
  format?: PrintFormat;
  formats?: Record<string, PrintFormat>;
  defaultFormat?: string;
  parameters?: Parameters;
  layoutFamilies?: Record<string, LayoutFamily>;
  spreads: Record<string, SpreadDefinition>;
  openingSpreads?: readonly OpeningSpread[];
  editors?: Record<string, DocumentEditor>;
};

/**
 * A spread a new book starts with: one of the template's layouts, optionally with some of that layout's own
 * parameters set. Included in the contract-1 baseline.
 */
export type OpeningSpread<L extends string = string> = { layout: L; params?: Values };

/** Declares one spread with a render context typed from its own declarations and the template's document parameters. */
export type SpreadBuilder<D extends Parameters> = <
  const P extends Parameters = {},
  const B extends Record<string, BoxDeclaration> = {},
  const E extends Record<string, ElementDeclaration> = {},
  const F extends string = never,
>(definition: {
  label: string;
  /** `left` or `right` for a single page at the start or end of the book. Default `spread`. */
  span?: Span;
  parameters?: P & ParametersChecked<P>;
  /** Arranges the controls of this layout's own parameters in the sidebar. */
  controls?: Controls<keyof P & string>;
  boxes?: B & BoxesChecked<B>;
  elements?: E & ElementsChecked<E, D, P>;
  render(context: RenderContext<{ label: string; parameters: P; boxes: B; elements: E }, D>): ImageFlowNode;
  /** Places other spreads can refer to through `ctx.book`, declared from this spread's values. */
  anchors?(context: AnchorContext<ParameterValues<P>, ParameterValues<D>>): readonly AnchorDeclaration[];
  /** The layout family this layout is a variant of: a key of the template's `layoutFamilies`. */
  family?: F;
  /** Tags that tell this variant apart from the others in its family, such as `{ size: '3x3' }`. Pickers read them. */
  variant?: VariantTags;
}) => SpreadDefinition<D, F>;
/** What `spreads` receives when it is a function. */
export type TemplateTools<D extends Parameters> = { spread: SpreadBuilder<D> };

type TemplateBase<D extends Parameters, L extends string = string> = {
  /** Stable template ID; `project.json` refers to it, and the template library keeps one entry per ID. */
  id: string;
  /** Compared as dot-separated numbers, such as `1.2.0`, when a template is imported into the library. */
  version: string;
  /** The template's name in the template library and the New Book picker, up to 80 characters. Defaults to the ID. */
  label?: string;
  /** One or two sentences for the template library, up to 300 characters. */
  description?: string;
  contract: 1;
  /**
   * Optional extensions beyond the contract-1 baseline. Omit for all currently shipped features.
   * Older baseline lists remain valid; an unsupported extension is rejected with an update hint.
   */
  requires?: readonly Capability[];
  /**
   * HTTPS origins rendering and editors may reach after user approval, such as `['https://tiles.openfreemap.org']`
   * or `'https://*.example.com'`, without paths. Rendering requests run inside `RenderedImage.draw`.
   * Included in the contract-1 baseline; declaring an origin does not grant permission to use it.
   */
  network?: readonly string[];
  /** Book-wide template parameters, shown in the template controls and read through `ctx.document`. */
  parameters?: D & ParametersChecked<D>;
  /** Families of layouts that are variants of one design, by ID. Layouts join one with `family`. */
  layoutFamilies?: { [K in L]: LayoutFamily };
  /** Editors of document parameters, by ID, opened from nodes marked with their parameters. Included in the contract-1 baseline. */
  editors?: Record<string, DocumentEditor<D, any>>;
};
/**
 * The spreads a new book starts with, in order. Without it, a new book starts with no spreads and the editor asks for
 * the first one. Single-page layouts must sit at a book end every format allows.
 */
type Opening<L extends string> = { openingSpreads?: readonly OpeningSpread<L>[] };
/** Every layout `openingSpreads` names must be declared in `spreads`; a missing one is reported there. */
type OpeningLayouts<S, L extends string> = { [K in Exclude<L, keyof S>]: SpreadDefinition<any> };
/**
 * Declare one `format`, or several named `formats` the user chooses between in template controls (`defaultFormat`,
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
/** The family a spread joins: from the builder's marker, or from a `family` written in a plain object. */
type FamilyOf<T> = typeof typedFamily extends keyof T ? NonNullable<T[typeof typedFamily & keyof T]>
  : T extends { family: infer F extends string } ? F : never;
type FamilyCheck<T, L extends string> = 0 extends 1 & T ? unknown : [FamilyOf<T>] extends [never] ? unknown : string extends FamilyOf<T> ? unknown
  : [Exclude<FamilyOf<T>, L>] extends [never] ? unknown
  : { family: `Declare layout family ${Exclude<FamilyOf<T>, L> & string} in the template's layoutFamilies` };
type DocumentCheck<S, D, L extends string = string> = {
  // Untyped spreads (`any`) are not checked.
  [K in keyof S]: FamilyCheck<S[K], L> & (0 extends 1 & TypedWith<S[K]> ? unknown : [Missing<D, TypedWith<S[K]>>] extends [never]
    ? [Mismatched<D, TypedWith<S[K]>>] extends [never] ? unknown
      : { [typedDocument]: `Document parameter ${Mismatched<D, TypedWith<S[K]>>} is declared differently in the template's parameters and in spreadFor()` }
    : { [typedDocument]: `Declare document parameter ${Missing<D, TypedWith<S[K]>>} in the template's parameters, or remove it from spreadFor()` })
    & SpreadChecked<S[K], D extends Parameters ? D : Parameters>;
};
/**
 * A spread written as a plain object gets the same unknown-property checks as one from the builder, and its editors
 * the template's document parameters `D`.
 */
type SpreadChecked<T, D extends Parameters = Parameters> = 0 extends 1 & T ? unknown : Exact<T, SpreadDefinition<any>> & OwnParametersChecked<T>
  & (T extends { boxes: infer B } ? { boxes: BoxesChecked<B> } : unknown)
  & (T extends { elements: infer E } ? { elements: ElementsChecked<E, D, ParametersOf<T>> } : unknown);

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
  const S extends Record<string, SpreadDefinition<any, any>> = {},
  const L extends string = never,
  const O extends string = never,
>(template: TemplateBase<D, L> & FormatChoice<F> & Opening<O> & { spreads: (tools: TemplateTools<D>) => S & DocumentCheck<S, D, L> & OpeningLayouts<S, O> }): TemplateDeclaration;
export function defineTemplate<
  const D extends Parameters = {},
  const F extends string = never,
  const S extends Record<string, SpreadDefinition<any, any>> = {},
  const L extends string = never,
  const O extends string = never,
>(template: TemplateBase<D, L> & FormatChoice<F> & Opening<O> & { spreads: S & DocumentCheck<S, D, L> & OpeningLayouts<S, O> }): TemplateDeclaration;

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
 * trim width), y from the top trim edge. Without facing pages, x is from the page's left trim edge. Place a platform component with `rect={rect}`, or any node with `style={geometry.css(rect)}`, inside `<Spread>`.
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
  /** The page of a format without facing pages. `left` and `right` throw there, and `page` throws with facing pages. */
  page(x: number, y: number, width: number, height: number): Rect;
  width(value: number): number;
  height(value: number): number;
  /** Horizontal and vertical ratios of the current trim to the design canvas. */
  scaleX: number; scaleY: number;
  /** CSS length, rounded to two decimals. Choose the scaling axis explicitly, including for type sizes. */
  length(value: number, unit: 'mm' | 'pt' | 'px', axis: 'x' | 'y' | 'min' | 'max'): string;
};
export const geometry: {
  /** One page of the spread. Works for single first and last pages too. */
  page(format: ResolvedFormat, side: 'left' | 'right', area?: Area): Rect;
  /** The page, in a format without facing pages. */
  page(format: ResolvedFormat, area?: Area): Rect;
  /** Both pages. Its `safe` area keeps only the outer, top and bottom insets. Throws without facing pages. */
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

/** Where and how big a `<RenderedImage>` draws. */
export type RenderTarget = {
  /** The element's size in CSS pixels (96 per inch), as laid out on the page. */
  width: number; height: number;
  /** Device pixels per CSS pixel: the screen's in previews, the format's target resolution ÷ 96 in export. */
  pixelRatio: number;
  mode: 'preview' | 'check' | 'export';
  /** Aborted when the element goes away, its inputs change, or ImageFlow stops waiting for it. */
  signal: AbortSignal;
};
export type RenderedImageProps = {
  /** Draws the picture for the target: a PNG or JPEG `Blob`, or a canvas. Reject to report a failure. */
  draw: (target: RenderTarget) => Promise<Blob | HTMLCanvasElement | OffscreenCanvas>;
  /** Everything `draw` depends on, as JSON-like data; the picture is drawn again when it changes. */
  inputs: unknown;
  /** Names the picture in messages, such as `'Map'`. */
  label?: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
};
/**
 * A picture that template code draws asynchronously, such as a map from a WebGL library and remote tiles
 * (part of the contract-1 baseline). ImageFlow gives `draw` the element's size, the output resolution and a cancellation
 * signal, runs a few at a time, and waits for all of them, with a timeout, before a Book check or export is final.
 * Inside `draw`, timers, WebGL, workers and requests to the template's `network` origins are allowed. The picture
 * is never saved in the book. Page and layout thumbnails may reuse a picture with identical inputs and output size within
 * the book window; checks and exports always draw afresh. A failure
 * or timeout is a `rendered-image-failed` error, so export never prints a page without it.
 */
export function RenderedImage(props: RenderedImageProps): ImageFlowElement;

// Only the declarations marked `export` above are part of the module.
export {};
