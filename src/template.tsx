import { Component, createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { RenderedImage } from './rendered-image';
import { renderingSpread } from './purity';
import type { CSSProperties, ReactNode } from 'react';
import { z } from 'zod';
import { cssMM, formatSchema, hasFacingPages, hasSingleEnds, inch, mm, pageSequence, printFormat, pt, resolveFormat, spanFits } from './format';
import type { PrintFormat, ResolvedFormat, Span, UnitPages } from './format';
import { identifier, values } from './project';
import type { Photo, ProjectFile, RenderProject, SpreadState, Values } from './project';
import { getCrop, placementIn } from './spread';
import type { Crop, Placement as CropPlacement } from './spread';
import { declarationConflicts, familyProblems } from './layouts';
import type { VariantTags } from './layouts';
import { isParameterValue, p, parametersSchema, resolveParams } from './parameters';
import type { Parameters } from './parameters';
import type { BoxDefinition, SpreadDefinition, TemplateInfo } from './desktop';
import { boundGeometry, geometry, lenientFormat } from './geometry';
import type { BoundGeometry, Rect } from './geometry';
import { rememberDocument } from './declaration-check';
import { capabilities, runtimeExports } from './runtime-exports';
import { controlProblems, controlsSchema } from './controls';
import type { ControlItem } from './controls';
import { previewPath } from './template-preview';

export { inch, mm, p, printFormat, pt };
export type { PrintFormat, ResolvedFormat, Span } from './format';
export type { Parameter, Parameters } from './parameters';

export type RenderContext = {
  params: Values;
  document: Values;
  boxes: Record<string, { params: Values; photo?: Photo | null; text?: FlowPosition | null }>;
  elements: Record<string, { params: Values }>;
  // Page numbers: `left` and `right` on a spread, `number` on a page of a format without facing pages.
  page: UnitPages;
  format: ResolvedFormat;
  // The chosen named format, or 'default' for a template with a single format.
  formatId: string;
  mode: RenderProject['mode'];
  // Marks a rendered node as the place where these parameters are edited; spread the result onto the node.
  edit: (...paths: string[]) => EditMarker;
  // The whole book as seen from this spread: page count and the anchors every spread declares.
  book: BookContext;
  // The geometry helpers with this spread's format applied.
  geometry: BoundGeometry;
  // The platform components again, so the declarations can type-check box and element IDs per layout.
  PhotoBox: typeof PhotoBox;
  MarkdownBox: typeof MarkdownBox;
  Element: typeof Element;
  Text: typeof Text;
};
export type EditMarker = { 'data-edit'?: string };
// Attributes returned by `issue()`. Platform components forward them to their own node, so a finding can sit on a box,
// an element or the spread itself.
export type IssueMarker = { 'data-issue'?: string; 'data-issue-info'?: string };
const issueOn = (marker: IssueMarker) => ({ 'data-issue': marker['data-issue'], 'data-issue-info': marker['data-issue-info'] });

// Anchors are declared from a spread's saved values, never from rendered output, so every spread can read every
// anchor's page in the same single render: pages depend only on spread order and layout spans.
export type AnchorContext = { params: Values; document: Values };
export type AnchorDeclaration = { id: string; title?: string; side?: 'left' | 'right' };
// `side` is 'page' in a format without facing pages, where a unit has one page and a declared side is ignored.
export type Anchor = { id: string; title?: string; spread: string; page: number; side: 'left' | 'right' | 'page' };
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
/** A failure that belongs to one spread of the book, such as a layout whose anchors() throws. */
export class SpreadError extends Error {
  constructor(message: string, readonly spread: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SpreadError';
  }
}

// Lookups that found no anchor, or several, keyed so repeated renders report each once.
export type AnchorLookup = { spread: string; anchor: string; found: number };
export type BookIndex = { pages: number; anchors: Anchor[]; lookups?: Map<string, AnchorLookup> };

export function bookIndex(book: RenderProject, template: Template, sequence: { count: number; spreads: { page: UnitPages }[] }): BookIndex {
  const document = resolveParams(template.parameters, book.project.params);
  const anchors = book.project.spreads.flatMap((spread, i) => {
    const definition = template.spreads[spread.definition];
    if (!definition?.anchors) return [];
    let returned: unknown;
    try { returned = definition.anchors({ params: resolveParams(definition.parameters, spread.params), document }); }
    catch (error) { throw new SpreadError(definition.label + ' could not declare its anchors: ' + (error instanceof Error ? error.message : String(error)), spread.id, { cause: error }); }
    const declared = anchorDeclarations.safeParse(returned);
    if (!declared.success) {
      throw new SpreadError(definition.label + ' declares invalid anchors: ' +
        declared.error.issues.map((issue) => (issue.path.join('.') || 'anchors') + ' ' + issue.message).join('; ') + '.', spread.id);
    }
    const { left, right, number } = sequence.spreads[i].page;
    return declared.data.map(({ id, title, side }): Anchor => {
      const named = title !== undefined ? { title } : {};
      if (number !== undefined) return { id, ...named, spread: spread.id, page: number, side: 'page' };
      // A single-page spread has only one page, whichever side the declaration names.
      const resolved = !left ? 'right' : !right ? 'left' : side ?? 'left';
      return { id, ...named, spread: spread.id, page: (resolved === 'left' ? left : right)!, side: resolved };
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
// and reports changes; ImageFlow owns the non-modal panel, validation, live saving and Undo.
// An editor asks for 'inline': it then edits on the page, in the frame of the element or
// marked node it was opened from. It falls back to the panel ('dialog') where it cannot, such as a rotated element.
export type EditorPresentation = 'dialog' | 'inline';
const presentation = z.enum(['dialog', 'inline']).default('dialog');
export type ElementEditorProps = {
  values: Values; set: (changes: Values) => void;
  // The layout's (spread) parameters: all of them to read, and `setSpread` for the ones the editor declares.
  spread: Values; setSpread: (changes: Values) => void;
  document: Values; format: ResolvedFormat;
  // What `render` reads about the spread the editor was opened from, read-only and kept current (see EditorContext).
  context: EditorContext;
  readOnly: boolean; commit: () => void; cancel: () => void;
  // Where the editor is shown: on the page in the element's frame ('inline'), or in the panel ('dialog').
  presentation: EditorPresentation;
  // Inline: the page keeps its artwork until these settle (a few seconds at most), so the editor appears drawn.
  waitUntil: (until: Promise<unknown>) => void;
  // The app's own control for one of the editor's parameters, bound to the draft, and the file import it uses.
  // `scope: 'spread'` names one of the layout parameters the editor declares instead of an element parameter.
  Control: (props: { parameter: string; label?: string; scope?: 'element' | 'spread' }) => ReactNode;
  importFile: (accept: readonly string[]) => Promise<string | undefined>;
};
// The read-only view of the book an editor is opened from: the values `render` reads for that spread, without the
// components. It follows the book while the editor is open (a reorder, another photo, a document setting), so a
// helper such as the calendar's month can serve `render` and the editor alike. Markdown flow positions are not known
// outside the book render, so `boxes[id].text` is null.
export type EditorContext = Pick<RenderContext, 'params' | 'document' | 'boxes' | 'page' | 'format' | 'formatId' | 'book'> & {
  // Measured bounds in trim coordinates (mm), null before the current page is ready or when not rendered.
  elements: Record<string, { params: Values; rect: Rect | null }>;
  // The spread's ID and its layout.
  spread: string; layout: string;
};
// A document editor edits some of the template's document parameters, opened from any node marked with them, such
// as a calendar's days. `values` holds every document parameter with the draft applied; `set` changes the editor's own.
export type DocumentEditorProps = {
  values: Values; set: (changes: Values) => void;
  context: EditorContext; format: ResolvedFormat;
  readOnly: boolean; commit: () => void; cancel: () => void;
  presentation: EditorPresentation;
  waitUntil: (until: Promise<unknown>) => void;
  Control: (props: { parameter: string; label?: string }) => ReactNode;
  importFile: (accept: readonly string[]) => Promise<string | undefined>;
};
// A layout family's picker chooses one of the family's variants. It runs in a sandboxed frame like an element
// editor; its choice is a layout ID, applied immediately as an ordinary undoable layout switch.
export type LayoutVariant = { id: string; label: string; variant: VariantTags };
export type LayoutPickerProps = {
  variants: LayoutVariant[]; current: string; saved: string; choose: (id: string) => void;
  find: (tags: VariantTags) => string | undefined;
  document: Values; format: ResolvedFormat; readOnly: boolean; commit: () => void; cancel: () => void;
};
const layoutFamily = z.object({
  label: z.string().min(1),
  picker: z.object({
    label: z.string().min(1).optional(),
    component: z.custom<(props: LayoutPickerProps) => ReactNode>((value) => typeof value === 'function', 'Expected a picker component.'),
  }).optional(),
});
// A document editor owns some document parameters. Nodes marked only with those parameters open it, with the context
// of the spread they are on. Its parameters get no control in the template controls.
const documentEditor = z.object({
  label: z.string().min(1).optional(),
  parameters: z.array(identifier).min(1, 'A document editor needs at least one document parameter to edit.'),
  component: z.custom<(props: DocumentEditorProps) => ReactNode>((value) => typeof value === 'function', 'Expected an editor component.'),
  presentation,
});
const elementEditor = z.object({
  label: z.string().min(1).optional(),
  // The element's own parameters the editor edits, and the layout's (spread) parameters it edits with them. The
  // editor is still the element's: its scope stays this spread, and document settings are read-only to it.
  parameters: z.array(identifier),
  spread: z.array(identifier).optional(),
  component: z.custom<(props: ElementEditorProps) => ReactNode>((value) => typeof value === 'function', 'Expected an editor component.'),
  presentation,
}).refine(({ parameters, spread }) => parameters.length + (spread?.length ?? 0) > 0,
  'An element editor needs at least one parameter to edit, of the element or of the layout (spread).');
// `controls` arranges a scope's generated controls; see src/controls.ts. Problems are reported at the scope.
const checkControls = (context: z.RefinementCtx, parameters: Parameters, controls: ControlItem[] | undefined, owned?: readonly string[]) => {
  for (const message of controlProblems(parameters, controls, owned)) context.addIssue({ code: 'custom', message, path: ['controls'] });
};
const elements = z.record(identifier, z.object({
  label: z.string().min(1), parameters: parametersSchema, controls: controlsSchema, editor: elementEditor.optional(),
}).refine(({ parameters, editor }) => !editor || editor.parameters.every((key) => Object.hasOwn(parameters, key)),
  'An element editor can only edit parameters its element declares.')
  .superRefine(({ parameters, controls, editor }, context) => checkControls(context, parameters, controls, editor?.parameters))).default({});
const boxSchema = z.object({
  type: z.enum(['photo', 'markdown']), label: z.string().min(1), parameters: parametersSchema, flowOrder: z.int().positive().optional(),
  controls: controlsSchema,
}).superRefine(({ parameters, controls }, context) => checkControls(context, parameters, controls));

const definition = z.object({
  label: z.string().min(1),
  // Defaults to 'page' when no format of the template has facing pages, else to 'spread' (see withSpans).
  span: z.enum(['spread', 'left', 'right', 'page']).default('spread'),
  parameters: parametersSchema,
  boxes: z.record(identifier, boxSchema).default({}),
  elements,
  controls: controlsSchema,
  render: z.custom<(context: RenderContext) => ReactNode>((value) => typeof value === 'function', 'Expected a render function.'),
  anchors: z.custom<(context: AnchorContext) => unknown>((value) => typeof value === 'function', 'Expected an anchors function.').optional(),
  // The layout family this layout is a variant of, and free-form tags a family's picker reads to tell variants apart.
  family: identifier.optional(),
  variant: z.record(identifier, z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
}).superRefine(({ parameters, controls, elements }, context) => {
  // Layout parameters an element editor edits: declared here, edited by one editor only, and without a generated
  // control of their own, like the element parameters an editor owns.
  const owners = new Map<string, string>();
  for (const [id, { editor }] of Object.entries(elements)) {
    for (const key of editor?.spread ?? []) {
      const path = ['elements', id, 'editor', 'spread'];
      if (!Object.hasOwn(parameters, key)) {
        context.addIssue({ code: 'custom', path, message: 'Element ' + id + "'s editor edits layout parameter " + key + ', which this layout does not declare.' });
      } else if (owners.has(key)) {
        context.addIssue({ code: 'custom', path, message: 'Layout parameter ' + key + ' is edited by the editors of both ' + owners.get(key) + ' and ' + id + '. Give it to one editor.' });
      } else owners.set(key, id);
    }
  }
  checkControls(context, parameters, controls, [...owners.keys()]);
}).refine(({ boxes }) => {
  const order = Object.values(boxes).filter(({ type }) => type === 'markdown').map(({ flowOrder }) => flowOrder);
  return order.length < 2 || (!order.includes(undefined) && new Set(order).size === order.length);
}, 'Markdown boxes need unique flowOrder values.');

// The spreads a new book starts with, in order. Each names a layout and may set some of its own parameters.
const openingSpread = z.strictObject({ layout: identifier, params: values });

// A layout's span defaults to 'page' when every declared format lacks facing pages, so a calendar template does not
// repeat it on every layout, and to 'spread' otherwise. Applied before validation, so every rule sees the span.
const plainRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function withSpans(template: unknown) {
  if (!plainRecord(template) || !plainRecord(template.spreads)) return template;
  const formats = plainRecord(template.formats) ? Object.values(template.formats) : [template.format];
  const single = formats.length > 0 && formats.every((format) => plainRecord(format) && plainRecord(format.structure) && format.structure.facingPages === false);
  const span = single ? 'page' : 'spread';
  return { ...template, spreads: Object.fromEntries(Object.entries(template.spreads).map(([id, definition]) =>
    [id, plainRecord(definition) && definition.span === undefined ? { ...definition, span } : definition])) };
}

// A template declares one print format, or several named formats the user chooses between in template controls.
export const templateSchema = z.preprocess(withSpans, z.object({
  id: identifier,
  version: z.string().min(1),
  // Shown in the template library and the New Book picker; the ID is shown without a label.
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(300).optional(),
  // An image inside the template folder that the New Book picker shows instead of a render of the opening spread.
  preview: z.string().refine((path) => previewPath(path) !== undefined,
    'Use a PNG, JPEG or WebP file inside the template folder, such as ./preview.jpg, without .. or a leading dot.').optional(),
  contract: z.literal(1),
  // Optional extensions beyond the contract-1 baseline. Baseline names in older templates remain valid.
  requires: z.array(z.string()).optional().superRefine((required, context) => {
    const missing = (required ?? []).filter((name) => !(capabilities as readonly string[]).includes(name));
    if (missing.length) {
      context.addIssue({ code: 'custom', message: 'This template requires ImageFlow features this app does not provide: ' +
        missing.join(', ') + '. Update ImageFlow. This app provides: ' + capabilities.join(', ') + '.' });
    }
  }),
  // HTTPS origins editors and RenderedImage.draw may reach after user approval (ADR 0006).
  network: z.array(z.string().regex(/^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/,
    'Use an HTTPS origin such as https://tiles.example.com, or https://*.example.com for its subdomains, without a path.'))
    .max(20).optional(),
  format: formatSchema.optional(),
  formats: z.record(identifier, formatSchema).optional(),
  defaultFormat: identifier.optional(),
  parameters: parametersSchema,
  // Arranges the document parameters' generated controls in Book settings, as `controls` does at the other scopes.
  controls: controlsSchema,
  // Layouts that are variants of one design, by family ID. Each variant names its family with `family`.
  layoutFamilies: z.record(identifier, layoutFamily).optional(),
  spreads: z.record(identifier, definition).refine((spreads) => Object.keys(spreads).length > 0, 'Declare a spread.')
    // An ID means the same box or parameter in every layout, so switching layouts can carry its content.
    .superRefine((spreads, context) => {
      for (const message of declarationConflicts(spreads)) context.addIssue({ code: 'custom', message });
    }),
  openingSpreads: z.array(openingSpread).optional(),
  // Editors of document parameters, by ID.
  editors: z.record(identifier, documentEditor).optional(),
}).superRefine(({ parameters, editors, controls }, context) => {
  const owners = new Map<string, string>();
  for (const [id, editor] of Object.entries(editors ?? {})) {
    for (const key of editor.parameters) {
      const path = ['editors', id, 'parameters'];
      if (!Object.hasOwn(parameters, key)) {
        context.addIssue({ code: 'custom', path, message: 'Document editor ' + id + ' edits ' + key + ', which the template\'s parameters do not declare.' });
      } else if (owners.has(key)) {
        context.addIssue({ code: 'custom', path, message: 'Document parameter ' + key + ' is edited by both ' + owners.get(key) + ' and ' + id + '. Give it to one editor.' });
      } else owners.set(key, id);
    }
  }
  // A document parameter a document editor owns has no generated control, as for element editors.
  checkControls(context, parameters, controls, [...owners.keys()]);
}).superRefine(({ spreads, layoutFamilies }, context) => {
  for (const { path, message } of familyProblems(spreads, layoutFamilies)) context.addIssue({ code: 'custom', message, path });
}).superRefine((template, context) => {
  for (const issue of openingSpreadProblems(template)) context.addIssue({ code: 'custom', ...issue });
}).refine(({ format, formats }) => !format !== !formats, 'Declare either format or formats.')
  .refine(({ formats }) => !formats || Object.keys(formats).length > 0, 'Declare at least one format.')
  .refine(({ formats, defaultFormat }) => !defaultFormat || (!!formats && Object.hasOwn(formats, defaultFormat)),
    'defaultFormat must name one of the formats.'));
export type DeclaredTemplate = z.infer<typeof templateSchema>;
type OpeningSpread = z.infer<typeof openingSpread>;

// Opening spreads must name declared layouts, set only those layouts' own parameters to allowed values, and form a
// sequence every declared format of the default format's kind accepts: single pages only at the book ends the format
// allows, and only page layouts without facing pages. A template offering both kinds starts books in the default one.
function openingSpreadProblems({ spreads, openingSpreads, format, formats, defaultFormat }: {
  spreads: Record<string, { span: Span; parameters: Parameters }>; openingSpreads?: OpeningSpread[];
  format?: PrintFormat; formats?: Record<string, PrintFormat>; defaultFormat?: string;
}) {
  const problems: { path: (string | number)[]; message: string }[] = [];
  if (!openingSpreads) return problems;
  openingSpreads.forEach(({ layout, params }, index) => {
    const path = ['openingSpreads', index];
    const definition = Object.hasOwn(spreads, layout) ? spreads[layout] : undefined;
    if (!definition) {
      problems.push({ path: [...path, 'layout'], message: 'Layout ' + layout + ' is not declared in spreads. Declared layouts: ' +
        Object.keys(spreads).join(', ') + '.' });
      return;
    }
    for (const [key, value] of Object.entries(params)) {
      const parameter = Object.hasOwn(definition.parameters, key) ? definition.parameters[key] : undefined;
      if (!parameter) problems.push({ path: [...path, 'params', key], message: 'Layout ' + layout + ' has no parameter ' + key + '.' });
      else if (!isParameterValue(parameter, value)) problems.push({ path: [...path, 'params', key],
        message: JSON.stringify(value) + ' is not an allowed value for ' + parameter.label + ' in layout ' + layout + '.' });
    }
  });
  const declared = openingSpreads.map(({ layout }) => Object.hasOwn(spreads, layout) ? spreads[layout] : undefined);
  if (declared.some((definition) => !definition)) return problems;
  const all = formats ? Object.entries(formats) : format ? [['default', format] as const] : [];
  const first = formats && defaultFormat && Object.hasOwn(formats, defaultFormat) ? formats[defaultFormat] : all[0]?.[1];
  const choices = all.filter(([, choice]) => !first || hasFacingPages(choice) === hasFacingPages(first));
  for (const [id, choice] of choices) {
    declared.forEach((definition, index) => {
      // Opening spreads may be only part of a book, so full spreads may sit anywhere; the Book check reports a
      // missing opening or closing page. Single pages must still be at their own end.
      const { span } = definition!;
      if (spanFits(span, choice) && (span === 'right' ? index === 0 : span === 'left' ? index === declared.length - 1 : true)) return;
      const where = formats ? 'format ' + id : 'the format';
      if ((span === 'page') === hasFacingPages(choice)) {
        problems.push({ path: ['openingSpreads', index, 'layout'], message: 'Layout ' + openingSpreads[index].layout + (hasFacingPages(choice)
          ? " is a single page (span: 'page'), but " + where + ' has facing pages.'
          : ' is for facing pages, but ' + where + " has none. Use a layout with span: 'page'.") });
        return;
      }
      const ends = hasSingleEnds(choice);
      problems.push({ path: ['openingSpreads', index, 'layout'], message: 'Layout ' + openingSpreads[index].layout + ' is a single ' +
        definition!.span + ' page. ' + (ends ? 'In ' + where + ' it can only be the ' + (definition!.span === 'right' ? 'first' : 'last') +
          ' opening spread.' : where[0].toUpperCase() + where.slice(1) + ' has no single pages at the book ends.') });
    });
  }
  return problems;
}
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
type DeclaredSpread = Omit<SpreadDefinition, 'span' | 'parameters' | 'boxes' | 'elements'> & {
  span?: Span; parameters?: Parameters;
  boxes?: Record<string, Omit<BoxDefinition, 'parameters'> & { parameters?: Parameters }>;
  elements?: Record<string, { label: string; parameters?: Parameters }>;
  render(context: RenderContext): ReactNode;
  anchors?(context: AnchorContext): AnchorDeclaration[];
};
// The builder `spreads: ({ spread }) => ...` receives. It only exists for TypeScript, so at runtime it returns the
// definition unchanged.
const spreadBuilder = <T,>(definition: T) => definition;
export type TemplateDeclaration = {
  id: string; version: string; label?: string; description?: string; preview?: string; contract: 1; requires?: string[]; network?: string[]; format?: PrintFormat; formats?: Record<string, PrintFormat>; defaultFormat?: string;
  parameters?: Parameters;
  controls?: ControlItem[];
  layoutFamilies?: Record<string, { label: string; picker?: { label?: string; component: (props: LayoutPickerProps) => ReactNode } }>;
  spreads: Record<string, DeclaredSpread> | ((tools: { spread: typeof spreadBuilder }) => Record<string, DeclaredSpread>);
  openingSpreads?: { layout: string; params?: Values }[];
  editors?: Record<string, { label?: string; parameters: string[]; component: (props: DocumentEditorProps) => ReactNode; presentation?: EditorPresentation }>;
};
// `spreads` may be a function of the builder; the declaration ImageFlow validates always has the built record.
// Applied by defineTemplate and again when the template loads, for templates exported without defineTemplate.
export function normalizeTemplate(template: unknown) {
  if (!template || typeof template !== 'object' || typeof (template as { spreads?: unknown }).spreads !== 'function') return template;
  const declared = template as { spreads: (tools: { spread: typeof spreadBuilder }) => unknown };
  return { ...declared, spreads: declared.spreads({ spread: spreadBuilder }) };
}
export const defineTemplate = (template: TemplateDeclaration) => normalizeTemplate(template);

export function templateInfo(template: Template): TemplateInfo {
  return {
    format: template.format, formatId: template.formatId, formats: template.formatChoices,
    structures: Object.fromEntries(Object.entries(template.formats ?? { default: template.format }).map(([id, format]) => [id, format.structure])),
    id: template.id, version: template.version, ...(template.label ? { label: template.label } : {}),
    ...(template.description ? { description: template.description } : {}),
    ...(template.preview ? { preview: previewPath(template.preview)! } : {}),
    parameters: template.parameters, ...(template.controls ? { controls: template.controls } : {}), openingSpreads: template.openingSpreads ?? [],
    ...(template.editors ? { editors: Object.fromEntries(Object.entries(template.editors).map(([id, { label, parameters, presentation }]) =>
      [id, { ...(label ? { label } : {}), parameters, presentation }])) } : {}),
    ...(template.network?.length ? { network: [...new Set(template.network)] } : {}),
    layoutFamilies: Object.fromEntries(Object.entries(template.layoutFamilies ?? {}).map(([id, { label, picker }]) => [id, {
      label, ...(picker ? { picker: { ...(picker.label ? { label: picker.label } : {}) } } : {}),
    }])),
    // Functions (render, editor components) stay in the render frame; the editor gets plain declarations.
    spreads: Object.fromEntries(Object.entries(template.spreads).map(([id, { render: _render, anchors: _anchors, elements, ...info }]) => [id, {
      ...info, declaresAnchors: !!_anchors,
      elements: Object.fromEntries(Object.entries(elements).map(([key, { editor, ...element }]) => [key, {
        ...element, ...(editor ? { editor: { label: editor.label, parameters: editor.parameters,
          ...(editor.spread?.length ? { spread: editor.spread } : {}), presentation: editor.presentation } } : {}),
      }])),
    }])),
  };
}

type SpreadValues = Pick<RenderContext, 'params' | 'document' | 'boxes' | 'elements'>;
const SpreadData = createContext<{
  book: RenderProject; spread: SpreadState; format: ResolvedFormat; renderPhotos: boolean;
  definition: Template['spreads'][string]; documentParameters: Parameters; values: SpreadValues; lazyPhotos: boolean;
} | null>(null);

function useSpread() {
  const value = useContext(SpreadData);
  if (!value) throw new Error('Spread components must be rendered by ImageFlow.');
  return value;
}

type Styling = { className?: string; style?: CSSProperties };
// `rect` positions a platform component absolutely, in millimetres; properties in `style` win over it.
type Placement = { rect?: Rect };
const place = (rect: Rect | undefined, style: CSSProperties | undefined) => rect ? { ...geometry.css(rect), ...style } : style;

export function Spread({ className, style, children, ...marker }: Styling & IssueMarker & { children?: ReactNode }) {
  const { format } = useSpread();
  const { trim } = format;
  // Inset variables follow the format's own side names: outside and binding with facing pages, left and right without.
  const sides = format.facingPages
    ? { '--bleed-outside': cssMM(format.bleed.outside), '--safe-outside': cssMM(format.safe.outside), '--safe-binding': cssMM(format.safe.binding) }
    : { '--bleed-left': cssMM(format.bleed.left), '--bleed-right': cssMM(format.bleed.right),
      '--safe-left': cssMM(format.safe.left), '--safe-right': cssMM(format.safe.right) };
  const geometry = {
    '--trim-width': cssMM(trim.width), '--trim-height': cssMM(trim.height),
    '--bleed-top': cssMM(format.bleed.top), '--bleed-bottom': cssMM(format.bleed.bottom),
    '--safe-top': cssMM(format.safe.top), '--safe-bottom': cssMM(format.safe.bottom), ...sides,
  } as unknown as CSSProperties;
  return (
    <div className="if-sheet" data-pages={format.facingPages ? undefined : 'single'} style={{ width: cssMM(format.spreadWidth), height: cssMM(format.height) }}>
      <div className={['if-spread', className].filter(Boolean).join(' ')} style={{ ...style, ...geometry }} {...issueOn(marker)}>
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

/**
 * What a PhotoBox render callback receives about its photo. Lengths are CSS pixels (96 per inch) of the printed
 * page, with the origin at the box's top-left corner, so they match the box's own layout size whatever the editor's
 * zoom. `image` is where the whole photo goes so that the box shows the host's crop; it usually extends past the box,
 * which clips it. `style` places an absolutely positioned HTML image there, in percentages of the box.
 */
export type PhotoRender = {
  src: string;
  alt: string;
  box: { width: number; height: number };
  image: { x: number; y: number; width: number; height: number };
  style: CSSProperties;
  crop: Crop;
  placement: CropPlacement;
  ppi: number;
};
// `uid` is unique in the book (spread and box), for SVG ids such as a clipPath's. Ids may contain hyphens, so the
// spread id's length keeps pairs such as one-x/hero and one/x-hero apart. Identifiers never contain '.', so a
// callback derives further ids as uid + '.mask', and export suffixes its copies with '.p1' (see svg-ids.ts).
export const photoBoxUid = (spread: string, box: string) => 'if-' + spread.length + '-' + spread + '-' + box;
export type PhotoBoxState = { id: string; uid: string; params: Values; photo: Photo | null };
export type PhotoBoxRender = (photo: PhotoRender, box: PhotoBoxState) => ReactNode;

// The placement a crop gesture shows before it is saved, by spread and box. The app sends it to the book frame while
// a photo of a box with a render callback is selected, so the template's artwork follows the gesture.
const livePlacements = new Map<string, CropPlacement>();
const liveListeners = new Set<() => void>();
export function setLivePlacement(spread: string, box: string, placement: CropPlacement | undefined) {
  // One gesture at a time: a new placement replaces any other, and none clears them all.
  const key = spread + '\u0000' + box;
  const current = livePlacements.get(key);
  if (!placement) {
    if (!livePlacements.size) return;
    livePlacements.clear();
  } else {
    if (livePlacements.size === 1 && current && current.centerX === placement.centerX && current.centerY === placement.centerY && current.zoom === placement.zoom) return;
    livePlacements.clear();
    livePlacements.set(key, { centerX: placement.centerX, centerY: placement.centerY, zoom: placement.zoom });
  }
  for (const listener of liveListeners) listener();
}
const subscribeLive = (listener: () => void) => { liveListeners.add(listener); return () => { liveListeners.delete(listener); }; };
// Lazy book views tell callback boxes when their spread comes near the screen (see photoLoader in render.tsx).
export const photoNearEvent = 'imageflow-photo-near';

const pixelsPerMm = 96 / 25.4;
// The photo and its crop as a callback sees them, from the box's size in CSS pixels.
export function photoRender(photo: Photo & { src: string }, placement: CropPlacement, size: { width: number; height: number }, src: string): PhotoRender {
  const crop = getCrop(photo, placement, size.width / size.height);
  const width = size.width / crop.width;
  const height = size.height / crop.height;
  return {
    src, alt: photo.altText ?? photo.title ?? '',
    box: { width: size.width, height: size.height },
    image: { x: -crop.x * width, y: -crop.y * height, width, height },
    style: { position: 'absolute', maxWidth: 'none', width: 100 / crop.width + '%', height: 100 / crop.height + '%',
      left: -100 * crop.x / crop.width + '%', top: -100 * crop.y / crop.height + '%' },
    crop, placement: { ...placement },
    ppi: Math.min(photo.width * crop.width / size.width, photo.height * crop.height / size.height) * 96,
  };
}

// The editor's book view draws callback boxes after its first render (when their spread comes near) and again during
// crop gestures, outside the render pass that reports errors. A callback that throws there is caught per box: the box
// shows that it failed and the failure reaches the live Book check, instead of the whole book view unmounting.
export type PhotoRenderFailure = { spread: string; box: string; message: string };
const photoRenderFailures = new Map<string, PhotoRenderFailure>();
const failureListeners = new Set<() => void>();
export const currentPhotoRenderFailures = () => [...photoRenderFailures.values()];
export function watchPhotoRenderFailures(listener: () => void) { failureListeners.add(listener); return () => { failureListeners.delete(listener); }; }
function setPhotoRenderFailure(key: string, failure: PhotoRenderFailure | undefined) {
  if (failure) photoRenderFailures.set(key, failure);
  else if (!photoRenderFailures.delete(key)) return;
  for (const listener of failureListeners) listener();
}
type BoundaryProps = { spread: string; box: string; reset: string; children: ReactNode };
export class PhotoRenderBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  private get key() { return this.props.spread + '\u0000' + this.props.box; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    setPhotoRenderFailure(this.key, { spread: this.props.spread, box: this.props.box, message: error instanceof Error ? error.message : String(error) });
  }
  // A new crop, size or parameter value draws again.
  componentDidUpdate(previous: BoundaryProps) {
    if (previous.reset === this.props.reset) return;
    if (previous.spread !== this.props.spread || previous.box !== this.props.box) setPhotoRenderFailure(previous.spread + '\u0000' + previous.box, undefined);
    if (this.state.failed) { setPhotoRenderFailure(this.key, undefined); this.setState({ failed: false }); }
  }
  componentWillUnmount() { setPhotoRenderFailure(this.key, undefined); }
  render() { return this.state.failed ? <span className="if-placeholder" data-photo-render-failed="">Photo could not be drawn</span> : this.props.children; }
}

// Calls a box's render callback as its own component, so a boundary around it catches what it throws.
function PhotoRenderCall({ render, photo, state, spread }: { render: PhotoBoxRender; photo: PhotoRender; state: PhotoBoxState; spread: string }) {
  renderingSpread(spread);
  try {
    return <>{render(photo, state)}</>;
  } finally {
    renderingSpread(undefined);
  }
}

export function PhotoBox({ id, className, style, rect, children, 'data-edit': marked, ...marker }: Styling & Placement & EditMarker & IssueMarker &
  { id: string; children?: PhotoBoxRender }) {
  const { spread, book, format, renderPhotos, definition, lazyPhotos, values } = useSpread();
  if (children !== undefined && typeof children !== 'function') {
    throw new Error('PhotoBox ' + id + ': children must be a render function, such as {(photo, box) => <img src={photo.src} style={photo.style} />}.');
  }
  const render = children;
  const box = spread.boxes[id];
  const photo = box?.photo ? book.photos[box.photo] : undefined;
  const saved = placementIn(box, spread.definition);
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  // A callback needs the box's size. A `rect` gives it at once; otherwise the box is measured before it is painted.
  const [size, setSize] = useState<{ width: number; height: number } | null>(() =>
    rect && rect.width > 0 && rect.height > 0 ? { width: rect.width * pixelsPerMm, height: rect.height * pixelsPerMm } : null);
  const [near, setNear] = useState(!lazyPhotos);
  const liveOf = () => render && book.mode === 'edit' ? livePlacements.get(spread.id + '\u0000' + id) : undefined;
  const live = useSyncExternalStore(subscribeLive, liveOf, liveOf);
  const placement = live ?? saved;

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
      const crop = getCrop(photo, saved, w / h);
      element.dataset.ppi = String(Math.min(photo.width * crop.width / w, photo.height * crop.height / h) * 96);
      if (render) {
        setSize((current) => current && Math.abs(current.width - w) < 0.01 && Math.abs(current.height - h) < 0.01 ? current : { width: w, height: h });
        return;
      }
      if (!img) return;
      if (book.mode !== 'edit' && !lazyPhotos && !img.getAttribute('src')) img.src = exportSource(photo, w / crop.width, format);
      img.style.width = 100 / crop.width + '%';
      img.style.height = 100 / crop.height + '%';
      img.style.left = -100 * crop.x / crop.width + '%';
      img.style.top = -100 * crop.y / crop.height + '%';
    }
    const observer = new ResizeObserver(cropPhoto);
    cropPhoto();
    observer.observe(element);
    return () => observer.disconnect();
  }, [photo, saved.centerX, saved.centerY, saved.zoom, renderPhotos, !!render]);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || !render || !lazyPhotos) return;
    const listener = (event: Event) => flushSync(() => setNear(!!(event as CustomEvent<boolean>).detail));
    element.addEventListener(photoNearEvent, listener);
    return () => element.removeEventListener(photoNearEvent, listener);
  }, [!!render, lazyPhotos]);

  let content: ReactNode = null;
  if (photo && renderPhotos && render && size && near) {
    const shown = photoRender(photo, placement, size, '');
    // Export loads a rendition sized for the saved crop at print resolution; the editor its preview or thumbnail.
    shown.src = book.mode === 'edit' ? photo.src : exportSource(photo, size.width / getCrop(photo, saved, size.width / size.height).width, format);
    const resolved = values.boxes[id];
    const state = { id, uid: photoBoxUid(spread.id, id), params: resolved?.params ?? {}, photo: resolved?.photo ?? null };
    content = <PhotoRenderCall render={render} photo={shown} state={state} spread={spread.id} />;
    // Outside the editor's book view a throw fails the render as for any other template code.
    if (lazyPhotos) {
      content = <PhotoRenderBoundary spread={spread.id} box={id}
        reset={JSON.stringify([shown.src, shown.placement, shown.box, state.params, state.photo])}>{content}</PhotoRenderBoundary>;
    }
  }

  return (
    <div ref={frame} data-box={id} data-box-type="photo" data-empty={photo ? undefined : ''}
      data-photo-render={render ? 'custom' : undefined} data-pending={render && photo && renderPhotos && !(size && near) ? '' : undefined}
      data-edit={editTarget(book, 'boxes.' + id + '.', definition.boxes[id]?.parameters, marked)}
      className={['if-photo', className].filter(Boolean).join(' ')} style={place(rect, style)} {...issueOn(marker)}>
      {photo && renderPhotos && !render &&
        <img ref={image} src={book.mode === 'edit' && !lazyPhotos ? photo.src : undefined}
          data-src={lazyPhotos ? photo.src : undefined} alt={photo.altText ?? photo.title ?? ''} />}
      {content}
      {!photo && book.mode === 'edit' && <span className="if-placeholder">{box?.photo ? 'Missing photo' : 'Drop a photo'}</span>}
    </div>
  );
}

// `columns` splits the box into that many columns; text flows down each column before moving to the next box.
export function MarkdownBox({ id, className, style, rect, columns = 1, 'data-edit': marked, ...marker }: Styling & Placement & EditMarker &
  IssueMarker & { id: string; columns?: number | `${number}` }) {
  const { spread, book, definition } = useSpread();
  const text = spread.boxes[id]?.text;
  const count = Math.max(1, Math.min(6, Math.round(Number(columns)) || 1));
  return (
    <div data-box={id} data-box-type="markdown" data-columns={count > 1 ? count : undefined}
      data-edit={editTarget(book, 'boxes.' + id + '.', definition.boxes[id]?.parameters, marked)}
      data-empty={text !== undefined && book.texts[text] !== undefined ? undefined : ''}
      className={['if-markdown', className].filter(Boolean).join(' ')} style={place(rect, style)} {...issueOn(marker)}>
      {book.mode === 'edit' && (!text || book.texts[text] === undefined) &&
        <span className="if-placeholder">{text ? 'Missing Markdown' : 'Drop a Markdown file'}</span>}
    </div>
  );
}

// In the editor an element is also an edit target for its own parameters and any it is marked with.
export function Element({ id, className, style, rect, children, 'data-edit': marked, ...marker }: Styling & Placement & EditMarker & IssueMarker &
  { id: string; children?: ReactNode }) {
  const { book, definition } = useSpread();
  return <div data-element={id} data-edit={editTarget(book, 'elements.' + id + '.', definition.elements[id]?.parameters, marked)}
    className={className} style={place(rect, style)} {...issueOn(marker)}>{children}</div>;
}

export type TextTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div' | 'blockquote' | 'figcaption';
const textTags = new Set<string>(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'div', 'blockquote', 'figcaption']);
// The declaration and resolved value a parameter path names: `heading`, `document.title`, `boxes.hero.credit`.
function parameterAt({ definition, documentParameters, values }: Pick<NonNullable<ReturnType<typeof useSpread>>, 'definition' | 'documentParameters' | 'values'>,
  path: string) {
  const own = <T,>(record: Record<string, T> | undefined, key: string) => record && Object.hasOwn(record, key) ? record[key] : undefined;
  const parts = path.split('.');
  if (parts.length === 1) return { param: own(definition.parameters, path), value: own(values.params, path) };
  if (parts.length === 2 && parts[0] === 'document') return { param: own(documentParameters, parts[1]), value: own(values.document, parts[1]) };
  if (parts.length === 3 && (parts[0] === 'boxes' || parts[0] === 'elements')) {
    const declared = parts[0] === 'boxes' ? own(definition.boxes, parts[1]) : own(definition.elements, parts[1]);
    const resolved = parts[0] === 'boxes' ? own(values.boxes, parts[1]) : own(values.elements, parts[1]);
    return { param: own(declared?.parameters, parts[2]), value: own(resolved?.params, parts[2]) };
  }
  return { param: undefined, value: undefined };
}

// Shows a string parameter and marks the node for editing. Empty, it shows an editor-only placeholder.
export function Text({ parameter, as = 'p', presentation, placeholder, fallback, fallbackLabel = 'inherited text', hidden = false, className, style, rect, ...marker }: Styling & Placement & IssueMarker &
  { parameter: string; as?: TextTag; presentation?: EditorPresentation; placeholder?: string; fallback?: string; fallbackLabel?: string; hidden?: boolean }) {
  const data = useSpread();
  const { param, value } = parameterAt(data, parameter);
  if (!param) throw new Error('Text shows parameter ' + parameter + ', which this layout does not declare.');
  if (!textTags.has(as)) throw new Error('Text cannot render as ' + as + '. Use one of ' + [...textTags].join(', ') + '.');
  if (presentation !== undefined && presentation !== 'inline' && presentation !== 'dialog') throw new Error("Text presentation must be 'inline' or 'dialog'.");
  const inline = presentation === 'inline';
  if (inline && param.type !== 'string') throw new Error('Inline Text needs a string parameter: ' + parameter + '.');
  if (hidden) return null;
  const saved = value === undefined ? '' : String(value);
  const inherited = !saved.trim() && !!fallback?.trim();
  const text = saved.trim() ? saved : inherited ? fallback! : '';
  const empty = !text && data.book.mode === 'edit';
  const hint = placeholder ?? (param.type === 'string' && param.placeholder ? param.placeholder : param.label);
  const Tag = as;
  // The edit marker stays in export, like ctx.edit(), so checks can name the parameter this text shows.
  return <Tag data-edit={parameter} data-empty={empty ? '' : undefined} data-inline-text={inline ? '' : undefined}
    data-multiline={inline && param.type === 'string' && param.multiline ? '' : undefined}
    data-text-fallback={fallback?.trim() ? fallback : undefined} data-text-fallback-label={fallback?.trim() ? fallbackLabel : undefined}
    className={className} style={place(rect, style)} {...issueOn(marker)}>
    {empty ? <span className="if-text-placeholder">{hint}</span> : inherited && data.book.mode === 'edit'
      ? <span className="if-text-inherited" title={'Using ' + fallbackLabel}>{text}</span> : text}
  </Tag>;
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
// The definitions remember the document they were typed with, so loading can report a mismatch with the template's
// own parameters (the authoring types reject it too).
export const spreadFor = (document: Parameters) => <T,>(definition: T) => {
  rememberDocument(definition, document);
  return definition;
};

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
  photo: (label: string, parameters: Parameters = {}, options: { controls?: ControlItem[] } = {}) => ({
    type: 'photo' as const, label, parameters, ...(options.controls ? { controls: options.controls } : {}),
  }),
  markdown: (label: string, options: { flowOrder?: number; parameters?: Parameters; controls?: ControlItem[] } = {}) => ({
    type: 'markdown' as const, label, parameters: options.parameters ?? {}, ...(options.flowOrder !== undefined ? { flowOrder: options.flowOrder } : {}),
    ...(options.controls ? { controls: options.controls } : {}),
  }),
  // Several photo boxes with explicit IDs: `box.photos(['one', 'two'], (id, i) => 'Photo ' + (i + 1))`.
  photos: <K extends string>(ids: readonly K[], label: (id: K, index: number) => string, parameters: Parameters = {}) =>
    Object.fromEntries(ids.map((id, i) => [id, box.photo(label(id, i), parameters)])) as Record<K, { type: 'photo'; label: string; parameters: Parameters }>,
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
export function issue(found: TemplateIssue): Required<IssueMarker> {
  return { 'data-issue': found.message, 'data-issue-info': JSON.stringify(found) };
}

export const runtime = {
  defineTemplate, spreadFor, p, mm, pt, inch, printFormat, Spread, PhotoBox, MarkdownBox, Element, asset, file, geometry, box, issue, capabilities,
  RenderedImage,
} satisfies Record<typeof runtimeExports[number], unknown>;

// The values `render` reads for one spread: its parameters, the document's, and its boxes and elements.
function spreadValues(book: RenderProject, template: Template, spread: SpreadState, positions: Record<string, FlowPosition>): SpreadValues {
  const definition = template.spreads[spread.definition];
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
  return { params: resolveParams(definition.parameters, spread.params), document: resolveParams(template.parameters, book.project.params), boxes, elements };
}

/**
 * The read-only context of an editor opened from this spread: what `render` reads, computed from the saved book the
 * same way. Undefined when the spread no longer exists or its layout is unknown. `key` is a serializable summary,
 * so a caller can tell whether a newer book changed anything the editor sees.
 */
export function editorContext(book: RenderProject, template: Template, spreadId: string): { context: EditorContext; key: string } | undefined {
  const { spreads } = book.project;
  const index = spreads.findIndex(({ id }) => id === spreadId);
  const spread = spreads[index];
  const definition = spread && template.spreads[spread.definition];
  if (!definition) return undefined;
  const sequence = pageSequence(spreads.map((state) => template.spreads[state.definition]?.span ?? 'spread'), template.format);
  const index_ = bookIndex(book, template, sequence);
  const format = resolveFormat(template.format);
  const values = spreadValues(book, template, spread, {});
  const page = sequence.spreads[index].page;
  const context: EditorContext = {
    ...values, page, format: spanFits(definition.span, template.format) ? format : lenientFormat(format), formatId: template.formatId,
    elements: Object.fromEntries(Object.entries(values.elements).map(([id, element]) => [id, { ...element, rect: null }])),
    book: bookContext(index_, spread.id), spread: spread.id, layout: spread.definition,
  };
  return { context, key: JSON.stringify([spread.id, spread.definition, page, index_.pages, index_.anchors, values, template.formatId]) };
}

/** The editor context from a newer book, with the format that book chose, as the book render chooses it. */
export const refreshedEditorContext = (book: RenderProject, template: Template, spreadId: string) =>
  editorContext(book, chooseFormat(template, book.project.format), spreadId);

/** Page measurements are separate from saved values, so a pending or hidden element has no guessed geometry. */
export function withEditorGeometry(context: EditorContext, measurements: unknown): EditorContext {
  const rects = plainRecord(measurements) ? measurements : {};
  return { ...context, elements: Object.fromEntries(Object.entries(context.elements).map(([id, element]) => {
    const rect = rects[id];
    const valid = plainRecord(rect) && ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key])) &&
      (rect.width as number) > 0 && (rect.height as number) > 0;
    return [id, { ...element, rect: valid ? { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number } : null }];
  })) };
}

/**
 * The context an editor sees: the saved book with its draft applied, so helpers reading `context` agree with what
 * the editor shows. A document editor's draft is its own document parameters; an element editor's is the element's
 * values (including the generated controls' draft) and the layout parameters it owns.
 */
export function withEditorDraft(context: EditorContext, draft: { document: Values } | { element: string; values: Values; spread: Values }): EditorContext {
  if ('document' in draft) return { ...context, document: { ...context.document, ...draft.document } };
  return { ...context, params: { ...context.params, ...draft.spread },
    elements: { ...context.elements, [draft.element]: { ...context.elements[draft.element], params: { ...context.elements[draft.element]?.params, ...draft.values } } } };
}

// `lazyPhotos` leaves photo sources in data-src; the editor's book view loads them as spreads come near the screen.
export function SpreadView({ book, template, format, spread, page, index, positions, renderPhotos, lazyPhotos = false }: {
  book: RenderProject; template: Template; format: ResolvedFormat; spread: SpreadState;
  page: RenderContext['page']; index: BookIndex; positions: Record<string, FlowPosition>; renderPhotos: boolean; lazyPhotos?: boolean;
}) {
  const definition = template.spreads[spread.definition];
  if (!definition) throw new Error('Spread ' + spread.id + ' uses an unknown definition: ' + spread.definition + '.');
  const values = spreadValues(book, template, spread, positions);
  // A layout drawn in a format it does not fit gets lenient geometry, through ctx.geometry and ctx.format alike.
  const fits = spanFits(definition.span, template.format);
  // Purity guards (Book check and export only) attribute impure calls to the layout rendering now.
  renderingSpread(spread.id);
  let content: ReturnType<typeof definition.render>;
  try {
    content = definition.render({
      ...values, page, format: fits ? format : lenientFormat(format), formatId: template.formatId, mode: book.mode,
      // Exported artwork keeps the invisible marker too, so checks can name the parameter a text block shows.
      edit: (...paths) => paths.length ? { 'data-edit': paths.join(' ') } : {},
      book: bookContext(index, spread.id), geometry: boundGeometry(format, { lenient: !fits }),
      PhotoBox, MarkdownBox, Element, Text,
    });
  } finally {
    renderingSpread(undefined);
  }
  return <SpreadData.Provider value={{ book, spread, format, renderPhotos, definition, documentParameters: template.parameters, values, lazyPhotos }}>
    {content}</SpreadData.Provider>;
}
