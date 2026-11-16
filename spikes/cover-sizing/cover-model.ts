/** Draft API only. No application code imports this file. */
import type { FacingFormat, PrintFormat } from '../../src/format';

// Same shape and helpers as the existing template API: mm(), pt(), inch().
export type Length = PrintFormat['trim']['width'];
export type Edges = { top: Length; right: Length; bottom: Length; left: Length };
export type PageCount = FacingFormat['structure']['pageCount'];
export type PDFOutput = Omit<PrintFormat['output'], 'maximumFileSize'> & {
  /** Bytes for this one PDF artifact. */
  maximumFileSize?: number;
};
/** The template supplies the selected specification, not a catalog of products. */
export type PrintSpecification = {
  interior: PrintFormat;
  cover?: CoverFormat;
};

// Illustrative integration contract. Actual parameter typing would use the
// template's existing document-parameter inference in the shipped SDK.
export type PrintContext<Document> = { document: Readonly<Document>; formatId: string };
export type PrintDeclaration<Document> = PrintSpecification
  | ((context: PrintContext<Document>) => PrintSpecification);

export type CoverWidths = {
  spine: Length;
  /** Physical flaps on this same printable exterior surface. */
  flaps?: { back: Length; front: Length };
};
export type CoverWidthSchedule =
  | { kind: 'fixed'; value: CoverWidths }
  | {
    kind: 'page-bands';
    // Inclusive bounds. Match only after validating the interior's pageCount rule.
    // Exactly one band must cover each allowed page count; no interpolation.
    bands: { from: number; to: number; value: CoverWidths }[];
  };

type CoverBase = {
  height: Length;
  outer: {
    // Same geometric operation; different meaning of the boundary on the sheet.
    kind: 'bleed' | 'wrap';
    insets: Edges;
  };
  // Explicit cover requirements, independent of the interior output settings.
  output: PDFOutput;
  source?: { url: string; checkedOn: string; note?: string };
};
export type WrapCover = CoverBase & {
  kind: 'wrap';
  // Cover panel sizes, not interior trim widths. No universal board allowance.
  panels: { back: Length; front: Length };
  widths: CoverWidthSchedule;
  safe: { back: Edges; spine: Edges; front: Edges };
  // Declared iff every widths entry contains both flap widths.
  flaps?: { safe: { back: Edges; front: Edges } };
  // Optional bands INSIDE the panels next to the spine. They do not add width.
  // Used for warnings and guides; safe insets still define the safe rectangles.
  foldAvoidance?: { back: Length; front: Length };
};
export type FrontPanelCover = CoverBase & {
  kind: 'front-panel';
  width: Length;
  safe: Edges;
};
export type CoverFormat = WrapCover | FrontPanelCover;

/** Platform result, computed once for preview, checking and export. All mm. */
export type Rect = { x: number; y: number; width: number; height: number };
export type CoverRegion = 'backFlap' | 'back' | 'spine' | 'front' | 'frontFlap';
export type ResolvedCover = {
  kind: CoverFormat['kind'];
  outerKind: CoverBase['outer']['kind'];
  interiorPages: number;
  // Origin (0,0) is the top-left of trim; sheet includes negative outer insets.
  sheet: Rect;
  trim: Rect;
  regions: Partial<Record<CoverRegion, Rect>>;
  // null means the existing region is too narrow for its required safe insets.
  // A missing key means that physical region does not exist.
  safe: Partial<Record<CoverRegion, Rect | null>>;
  folds: { x: number }[];
  avoid: Rect[];
  output: PDFOutput;
};

// Authoring-helper contract only; implementation deliberately deferred.
// Enumerate valid counts when the specification is built, call sizeAt for each, and merge
// adjacent valid counts with identical widths. Return ONLY plain data, not code.
export type CoverWidthsHelper = (options: {
  pageCount: PageCount;
  sizeAt: (interiorPages: number) => CoverWidths;
}) => CoverWidthSchedule;
