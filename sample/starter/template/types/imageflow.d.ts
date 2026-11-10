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
/** An ISO date such as `2027-03-01`. */
export type DateParameter = Common & { type: 'date'; default: string; min?: string; max?: string };
export type Parameter = BooleanParameter | StringParameter | IntegerParameter | NumberParameter | EnumParameter | ColorParameter | DateParameter;
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
};

// Declarations

export type BoxDeclaration = { type: 'photo' | 'markdown'; label: string; parameters?: Parameters; flowOrder?: number };
export type ElementDeclaration = { label: string; parameters?: Parameters };
export type SpreadDeclaration = {
  label: string;
  /** `left` or `right` for a single page at the start or end of the book. Default `spread`. */
  span?: Span;
  parameters?: Parameters;
  boxes?: Record<string, BoxDeclaration>;
  elements?: Record<string, ElementDeclaration>;
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

/** The context passed to `render`, typed from a spread declared with `spreadFor`. */
export type RenderContext<S extends SpreadDeclaration = SpreadDeclaration, D extends Parameters = Parameters> = {
  params: ValuesOf<S>;
  document: ParameterValues<D>;
  boxes: { [K in keyof S['boxes']]: BoxContext<S['boxes'][K]> };
  elements: { [K in keyof S['elements']]: { params: ValuesOf<S['elements'][K]> } };
  /** Book page numbers of this spread's pages. */
  page: { left?: number; right?: number };
  format: ResolvedFormat;
  mode: 'edit' | 'export';
};

/** The render context of a spread declared without `spreadFor`. */
export type UntypedRenderContext = {
  params: Values;
  document: Values;
  boxes: Record<string, { params: Values; photo?: Photo | null; text?: FlowPosition | null }>;
  elements: Record<string, { params: Values }>;
  page: { left?: number; right?: number };
  format: ResolvedFormat;
  mode: 'edit' | 'export';
};

export type SpreadDefinition = SpreadDeclaration & { render(context: UntypedRenderContext): ImageFlowNode };
export type TemplateDeclaration = {
  id: string;
  version: string;
  contract: 1;
  format: PrintFormat;
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
/** A box that shows the photo assigned to box `id`, cropped to fill it. */
export function PhotoBox(props: Styling & { id: string }): ImageFlowElement;
/** A box that shows its part of the Markdown text assigned to box `id`. */
export function MarkdownBox(props: Styling & { id: string }): ImageFlowElement;
/** Generated content with parameters, such as a calendar grid. */
export function Element(props: Styling & { id: string; children?: ImageFlowNode }): ImageFlowElement;
/** URL of a file in `template/assets/`. */
export function asset(path: string): string;
