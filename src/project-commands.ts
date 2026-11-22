import { sourcePath } from './source-locations';
import { z } from 'zod';
import type { TemplateInfo } from './desktop';
import type { PrintFormat } from './format';
import { newSpread, resolveEditPath, writeEdit } from './editing';
import type { EditTarget } from './editing';
import { describeLayoutChange, discardContent, editorLayoutChoices, editorLayoutTarget, layoutChoices, layoutFootprint, swapContent, swapPages, switchLayout } from './layouts';
import { hasFacingPages, spanAllowedAt, spanFits, spanRequiredAt } from './format';
import { isParameterValue, listProblems, newItemId, resolveValue, sameValue } from './parameters';
import type { ListItem, Parameter, Parameters } from './parameters';
import { boxBase, coverInstance, identifier, scopeState, storedBoxes } from './project';
import { coverLayoutsFor } from './cover';
import type { LayoutState, PageSide, ProjectFiles, SpreadState, Values } from './project';
import { maxZoom, setPlacement } from './spread';
import { insertionProblem, spreadOrder } from './spread-order';

const id = identifier.refine((value) => value.length <= 256, 'Identifiers must be at most 256 characters.');
const spreadReferenceMessage = 'Use a spread ID or a string such as "$chapter" for a batch reference.';
export const spreadReference = z.union([id, z.string().startsWith('$').refine((value) => id.safeParse(value.slice(1)).success,
  spreadReferenceMessage)], { error: spreadReferenceMessage });
const scalar = z.union([z.string(), z.boolean(), z.number()]);
// A list parameter's value is its whole array of items, each with its `id`.
const value = z.union([scalar, z.array(z.record(z.string(), scalar))])
  .describe('The new value, of the type the parameter declares. A list parameter takes its whole array of items, each with its id.');
const parameterValues = z.record(id, value).describe('Parameter values by parameter ID; omitted parameters take their defaults.');
const itemValues = z.record(id, scalar);
const unit = z.number().min(0).max(1);
const placement = {
  centerX: unit.describe('Horizontal centre of the visible region, 0 (left edge of the photo) to 1 (right edge).'),
  centerY: unit.describe('Vertical centre of the visible region, 0 (top) to 1 (bottom).'),
  zoom: z.number().min(1).max(maxZoom).describe('1 fills the box with the whole photo cropped to its shape; larger values zoom in.'),
};
const placementSchema = z.strictObject(placement);
const focus = z.strictObject({ centerX: placement.centerX, centerY: placement.centerY })
  .describe('The point to keep visible when the photo is cropped to other layouts.');
const initialBox = z.strictObject({
  photo: id.optional().describe('Photo source ID.'), text: id.optional().describe('Markdown text source ID.'),
  params: parameterValues.default({}),
  crops: z.record(id, placementSchema).optional().describe('Saved crop per layout ID.'), focus: focus.optional(),
}).refine(({ photo, text, crops, focus }) => !(photo && text) && (!(crops || focus) || !!photo),
  'A box has one source, and only photos have crops or focus.');
const spreadTarget = spreadReference.describe('Spread ID, or a $ref defined earlier in this batch.');
const boxId = id.describe('Box ID, as the spread\'s layout declares it.');
const page = z.enum(['left', 'right']).optional().describe('Split-sheet page; omit for unsplit units.');
const address = {
  spread: spreadTarget.optional(), page,
  cover: z.literal(true).optional().describe('Target the exterior cover. Omit spread and page.'),
};
type LayoutAddress = { spread?: string; page?: PageSide; cover?: true };
const validAddress = ({ spread, page, cover }: LayoutAddress) =>
  cover ? spread === undefined && page === undefined : spread !== undefined;
const addressMessage = 'Choose a spread (with an optional page) or cover: true.';
const boxTarget = z.strictObject({ ...address, box: boxId }).refine(validAddress, addressMessage);
const parameterTarget = {
  ...address,
  scope: z.enum(['document', 'spread', 'cover', 'box', 'element'])
    .describe('Where the parameter is saved: document, spread, cover layout, box or element.'),
  owner: id.optional().describe('Box or element ID of a box or element parameter.'),
  key: id.describe('Parameter ID.'),
};
const after = spreadReference.nullable().optional()
  .describe('Insert after this spread ID or $ref; null inserts at the start; omitted appends at the end.');
const ref = id.optional().describe('Name for the new spread, usable as $name in later operations of this batch and in draft preview targets.');
const definition = id.describe('Layout ID from the target’s layout declarations.');
type ParameterAddress = z.infer<z.ZodObject<typeof parameterTarget>>;
function validParameterTarget(target: ParameterAddress) {
  if (target.scope === 'document' || target.scope === 'cover') {
    return target.spread === undefined && target.owner === undefined && target.page === undefined &&
      (target.scope === 'cover' || target.cover === undefined);
  }
  return target.scope === 'spread' ? target.spread !== undefined && target.cover === undefined && target.owner === undefined
    : validAddress(target) && target.owner !== undefined;
}

const targetMessage = 'Use document or cover for layout-wide settings, spread with a spread ID, or box/element with an owner and a spread or cover target.';
const itemId = id.describe('ID of an existing list item.');
const initialBoxes = z.record(id, initialBox).default({}).describe('Initial box content by ID.');
const initialElements = z.record(id, z.strictObject({ params: parameterValues.default({}) })).default({}).describe('Initial element parameters by ID.');
const initialPage = z.strictObject({ definition: definition.optional(), params: parameterValues.default({}),
  boxes: initialBoxes,
  elements: initialElements,
});
export const projectOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set_title'), title: z.string().trim().min(1).describe('The book title.') })
    .describe('Rename the book.'),
  z.strictObject({ op: z.literal('select_format'), format: id.describe('Format ID from template.formats.') })
    .describe('Choose one of the template\'s print formats.'),
  z.strictObject({ op: z.literal('set_parameter'), ...parameterTarget, value }).refine(validParameterTarget, targetMessage)
    .describe('Set a document, spread, box or element parameter.'),
  z.strictObject({ op: z.literal('reset_parameter'), ...parameterTarget }).refine(validParameterTarget, targetMessage)
    .describe('Remove a saved parameter value, including one the template no longer declares.'),
  // Item operations on a list parameter, addressed by the item's stable id, so an agent does not resend the list.
  z.strictObject({ op: z.literal('insert_list_item'), ...parameterTarget, item: itemValues.describe('Field values; missing fields take their defaults. An id is generated unless given.'),
    after: id.nullable().optional().describe('Item id to insert after, null for the start; omitted appends.') }).refine(validParameterTarget, targetMessage)
    .describe('Add an item to a list parameter.'),
  z.strictObject({ op: z.literal('update_list_item'), ...parameterTarget, id: itemId,
    values: itemValues.describe('Field values to change; other fields keep their values.') }).refine(validParameterTarget, targetMessage)
    .describe('Change fields of one list item.'),
  z.strictObject({ op: z.literal('remove_list_item'), ...parameterTarget, id: itemId }).refine(validParameterTarget, targetMessage)
    .describe('Remove one list item.'),
  z.strictObject({ op: z.literal('move_list_item'), ...parameterTarget, id: itemId,
    after: id.nullable().describe('Item id to move after, or null to move to the start.') }).refine(validParameterTarget, targetMessage)
    .describe('Move one list item.'),
  z.strictObject({
    op: z.literal('insert_spread'), definition, ref, after,
    params: parameterValues.default({}),
    boxes: initialBoxes,
    elements: initialElements,
  }).describe('Add a spread with the given layout.'),
  z.strictObject({ op: z.literal('insert_page_pair'), ref, after,
    pages: z.strictObject({ left: initialPage.optional().describe('Left page; omitted is blank.'), right: initialPage.optional().describe('Right page; omitted is blank.') })
      .refine(pages => !!(pages.left?.definition || pages.right?.definition), 'Choose a layout for at least one page.').describe('Facing page layouts and initial contents.'),
  }).describe('Insert a full facing sheet with independent page layouts. An omitted side is blank.'),
  z.strictObject({ op: z.literal('clear_page'), spread: spreadTarget, page: z.enum(['left', 'right']).describe('Page to clear.') })
    .describe('Show a blank page on one side of a full facing sheet, keeping its content for recovery.'),
  z.strictObject({ op: z.literal('swap_pages'), spread: spreadTarget })
    .describe('Exchange the complete left and right page states of a split sheet.'),
  z.strictObject({ op: z.literal('duplicate_spread'), spread: spreadTarget, ref, after })
    .describe('Copy a spread with its contents. after defaults to directly after the original.'),
  z.strictObject({ op: z.literal('move_spread'), spread: spreadTarget,
    after: spreadReference.nullable().describe('Required destination. Use null to move to the start, or an existing spread ID or $alias to move immediately after it.') })
    .describe('Move a spread.'),
  z.strictObject({ op: z.literal('remove_spread'), spread: spreadTarget }).describe('Remove a spread.'),
  z.strictObject({ op: z.literal('switch_layout'), ...address, definition }).refine(validAddress, addressMessage)
    .describe('Change a spread to another layout with the same page footprint, carrying over content with matching IDs. Also switches layout family variants.'),
  z.strictObject({ op: z.literal('assign_source'), ...boxTarget.shape,
    kind: z.enum(['photo', 'text']).describe('photo for photo boxes, text for Markdown boxes.'),
    source: id.describe('Source ID from inspect_book sources or import_sources.') })
    .refine(validAddress, addressMessage).describe('Put a photo or Markdown text into a box.'),
  z.strictObject({ op: z.literal('clear_box'), ...boxTarget.shape }).refine(validAddress, addressMessage).describe('Remove the content of a box.'),
  z.strictObject({ op: z.literal('swap_content'), from: boxTarget.describe('First box.'), to: boxTarget.describe('Second box.') })
    .describe('Exchange the contents of two boxes, on the same or different spreads.'),
  z.strictObject({ op: z.literal('set_crop'), ...boxTarget.shape, ...placement })
    .refine(validAddress, addressMessage)
    .describe('Set the crop of the photo in a box for the spread\'s current layout.'),
  z.strictObject({ op: z.literal('set_photo_metadata'), photo: id.describe('Photo source ID.'), values: z.strictObject({
    title: z.string().nullable().optional().describe('Short title of the photo.'),
    caption: z.string().nullable().optional().describe('Caption text that templates may print with the photo.'),
    credit: z.string().nullable().optional().describe('Photographer or source credit.'),
    altText: z.string().nullable().optional().describe('Description of the photo for accessibility.'),
  }).describe('Fields to change; null clears a field or reverts it to its source, omitted fields stay.') })
    .describe('Change the title, caption, credit or alt text saved with a photo.'),
]);
export const projectOperationsSchema = z.array(projectOperationSchema).min(1).max(100)
  .describe('Up to 100 operations, applied in order as one atomic step: either all succeed or none is saved.');
export const projectOperationNames = projectOperationSchema.options.map((schema) => schema.shape.op.value);
export type ProjectOperation = z.input<typeof projectOperationSchema>;
export type ProjectOperations = z.input<typeof projectOperationsSchema>;
export type ProjectCommandResult = {
  files: ProjectFiles; changes: string[]; affectedSpreads: string[]; affectedCover?: true; references: Record<string, string>; reflow: boolean;
};
export type ProjectCommandErrorCode = 'INVALID_OPERATION' | 'SPREAD_SHOWN_AS_PAGES' | 'SPREAD_NOT_FOUND' | 'LAYOUT_NOT_FOUND' | 'BOX_NOT_FOUND' |
  'ELEMENT_NOT_FOUND' | 'PARAMETER_NOT_FOUND' | 'INVALID_PARAMETER_VALUE' | 'SOURCE_NOT_FOUND' | 'BOX_TYPE_MISMATCH' | 'INCOMPATIBLE_LAYOUT' |
  'REFERENCE_NOT_FOUND' | 'DUPLICATE_REFERENCE' | 'INVALID_SPREAD_ID' | 'FORMAT_NOT_FOUND' | 'EMPTY_BOX' | 'INVALID_POSITION' |
  'NOT_A_LIST' | 'ITEM_NOT_FOUND' | 'COVER_UNAVAILABLE' | 'COVER_LAYOUT_REQUIRED';

export class ProjectCommandError extends Error {
  constructor(readonly code: ProjectCommandErrorCode, message: string, readonly operationIndex?: number) {
    super(message);
    this.name = 'ProjectCommandError';
  }
}

export function applyProjectCommands(
  files: ProjectFiles, template: TemplateInfo, operations: unknown, options: { generateId?: () => string } = {},
): ProjectCommandResult {
  const parsed = projectOperationsSchema.safeParse(operations);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProjectCommandError('INVALID_OPERATION', issue.message,
      typeof issue.path[0] === 'number' ? issue.path[0] : undefined);
  }
  const next: ProjectFiles = { project: structuredClone(files.project), photoIndex: structuredClone(files.photoIndex) };
  const { project, photoIndex } = next;
  const references: Record<string, string> = {};
  const changes: string[] = [];
  const affected = new Set<string>();
  let affectedCover = false;
  let reflow = false;
  let operationIndex = 0;
  const own = <T,>(record: Record<string, T>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
  function fail(code: ProjectCommandErrorCode, message: string): never {
    throw new ProjectCommandError(code, message, operationIndex);
  }
  const allSpreads = () => project.spreads.map(({ id }) => id);
  // The book's format as the batch has changed it so far: a select_format earlier in the batch applies to the
  // commands after it.
  let format: Pick<PrintFormat, 'label' | 'structure'> = template.format;
  let formatId = template.formatId;
  function changed(message: string, spreads: string[], affectsFlow = false) {
    changes.push(message);
    for (const spread of spreads) {
      if (spread === coverInstance) affectedCover = true;
      else affected.add(spread);
    }
    reflow ||= affectsFlow && (spreads.length === 0 || spreads.some((id) => id !== coverInstance));
  }
  function resolveReference(reference: string) {
    if (!reference.startsWith('$')) return reference;
    return own(references, reference.slice(1)) ?? fail('REFERENCE_NOT_FOUND', 'Unknown batch reference ' + reference + '.');
  }
  function findSpread(reference: string) {
    const id = resolveReference(reference);
    return project.spreads.find((spread) => spread.id === id) ?? fail('SPREAD_NOT_FOUND', 'Spread ' + id + ' does not exist.');
  }
  function findLayout(definition: string) {
    return own(template.spreads, definition) ?? fail('LAYOUT_NOT_FOUND', 'The template has no layout ' + definition + '.');
  }
  function coverLayouts() {
    const layouts = coverLayoutsFor(template.coverLayouts, formatId);
    if (!template.coverFormats || !Object.hasOwn(template.coverFormats, formatId) || !Object.keys(layouts).length) {
      fail('COVER_UNAVAILABLE', 'The active format has no exterior cover.');
    }
    return layouts;
  }
  function coverLayout(definition: string) {
    return own(coverLayouts(), definition) ?? fail('LAYOUT_NOT_FOUND', 'The active format has no cover layout ' + definition + '.');
  }
  function findBox(spread: LayoutState, box: string) {
    const layout = spread === project.cover ? coverLayout(spread.definition ?? '') : findLayout(spread.definition ?? '');
    return own(layout.boxes, box) ??
      fail('BOX_NOT_FOUND', 'Layout ' + spread.definition + ' has no box ' + box + '.');
  }
  function requireSource(kind: 'photo' | 'text', source: string) {
    const registry = kind === 'photo' ? photoIndex : project.texts;
    if (!Object.hasOwn(registry, source)) fail('SOURCE_NOT_FOUND', 'Unknown ' + kind + ' source ' + source + '.');
  }
  function validateValue(parameter: Parameter, value: Values[string], key: string) {
    if (parameter.type === 'list') {
      const problems = listProblems(parameter, value);
      if (problems.length) fail('INVALID_PARAMETER_VALUE', 'Parameter ' + key + ' rejects this value: it ' + problems.slice(0, 3).join('; ') + '.');
      for (const item of value as ListItem[]) for (const [field, declared] of Object.entries(parameter.item)) {
        if (Object.hasOwn(item, field)) validateValue(declared, item[field], key + ' item ' + item.id + ' field ' + field);
      }
      return;
    }
    if (!isParameterValue(parameter, value)) fail('INVALID_PARAMETER_VALUE', 'Parameter ' + key + ' rejects this value.');
    if (parameter.type === 'file' && value !== '') {
      const path = own(project.files, String(value));
      if (path === undefined) fail('SOURCE_NOT_FOUND', 'Unknown file source ' + value + '.');
      if (!parameter.accept.some((extension) => sourcePath(path).toLowerCase().endsWith(extension))) {
        fail('INVALID_PARAMETER_VALUE', 'File ' + value + ' has an unsupported extension for ' + key + '.');
      }
    }
  }
  function validateValues(parameters: Parameters, values: Values) {
    for (const [key, value] of Object.entries(values)) {
      const parameter = own(parameters, key) ?? fail('PARAMETER_NOT_FOUND', 'Unknown parameter ' + key + '.');
      validateValue(parameter, value, key);
    }
  }
  function requireBoxKind(spread: LayoutState, box: string, kind: 'photo' | 'text') {
    const expected = kind === 'photo' ? 'photo' : 'markdown';
    if (findBox(spread, box).type !== expected) fail('BOX_TYPE_MISMATCH', 'Box ' + box + ' does not accept ' + kind + ' content.');
  }
  function validateInitialSpread(spread: SpreadState) {
    const layout = findLayout(spread.definition ?? '');
    validateValues(layout.parameters, spread.params);
    for (const [box, state] of Object.entries(spread.boxes)) {
      validateValues(findBox(spread, box).parameters, state.params);
      const source = state.photo ?? state.text;
      if (source) {
        const kind = state.photo ? 'photo' : 'text';
        requireBoxKind(spread, box, kind);
        requireSource(kind, source);
      }
      for (const definition of Object.keys(state.crops ?? {})) {
        const cropLayout = findLayout(definition);
        if (!layoutChoices(template.spreads, spread.definition).includes(definition)) {
          fail('INCOMPATIBLE_LAYOUT', 'Crop layout ' + definition + ' has a different page footprint.');
        }
        if (own(cropLayout.boxes, box)?.type !== 'photo') {
          fail('BOX_TYPE_MISMATCH', 'Crop layout ' + definition + ' has no photo box ' + box + '.');
        }
      }
    }
    for (const [element, state] of Object.entries(spread.elements)) {
      const declaration = own(layout.elements, element) ?? fail('ELEMENT_NOT_FOUND', 'Layout ' + spread.definition + ' has no element ' + element + '.');
      validateValues(declaration.parameters, state.params);
    }
  }
  function registerSpread(spread: SpreadState, ref?: string) {
    if (ref && Object.hasOwn(references, ref)) fail('DUPLICATE_REFERENCE', 'Batch reference $' + ref + ' already exists.');
    if (options.generateId) spread.id = options.generateId();
    if (!id.safeParse(spread.id).success || project.spreads.some(({ id }) => id === spread.id)) {
      fail('INVALID_SPREAD_ID', 'The generated spread ID must be valid and unique.');
    }
    if (ref) references[ref] = spread.id;
  }
  function checkInsertion(spread: SpreadState, after: string | null | undefined) {
    const position = after === undefined ? project.spreads.length : after === null ? 0 : project.spreads.indexOf(findSpread(after)) + 1;
    const problem = insertionProblem(project.spreads, position, layoutFootprint(spread, template.spreads).span, { spreads: template.spreads, format }, layoutFootprint(spread, template.spreads).sides);
    if (problem) fail('INVALID_POSITION', problem);
  }
  function insertAfter(spread: SpreadState, after: string | null | undefined) {
    const position = after === undefined ? project.spreads.length : after === null ? 0 : project.spreads.indexOf(findSpread(after)) + 1;
    project.spreads.splice(position, 0, spread);
  }
  function commandState({ spread, page, cover }: LayoutAddress) {
    if (cover) {
      const layouts = coverLayouts();
      const state = project.cover;
      if (!state || !Object.hasOwn(layouts, state.definition)) return fail('COVER_LAYOUT_REQUIRED', 'Choose a cover layout first.');
      return { sheet: { id: coverInstance }, state };
    }
    const sheet = findSpread(spread!);
    if (page && !sheet.split) fail('INVALID_OPERATION', 'Page addressing requires a split sheet. Omit page for an unsplit unit.');
    if (!page && sheet.split) fail('SPREAD_SHOWN_AS_PAGES', 'Spread ' + sheet.id + ' is shown as pages. Specify page: left or right.');
    const state = scopeState(sheet, page);
    if (!state) fail('INVALID_OPERATION', 'The requested page is blank. Choose its layout first.');
    return { sheet, state };
  }
  function parameterLocation(operation: ParameterAddress) {
    const scoped = operation.scope === 'document' ? undefined : commandState(operation.scope === 'cover' ? { cover: true } : operation);
    const spread = scoped?.sheet, state = scoped?.state;
    const layoutScope = operation.scope === 'spread' || operation.scope === 'cover';
    const path = operation.scope === 'document' ? 'document.' + operation.key : layoutScope ? operation.key :
      (operation.scope === 'box' ? 'boxes.' : 'elements.') + operation.owner + '.' + operation.key;
    const group = operation.scope === 'box' ? state?.boxes : state?.elements;
    const values = operation.scope === 'document' ? project.params
      : layoutScope ? state?.params : group && own(group, operation.owner!)?.params;
    return { spread, state, path, values };
  }
  function parameterTarget(operation: ParameterAddress, location = parameterLocation(operation)) {
    const { state, path } = location;
    let target: EditTarget | undefined;
    if (operation.scope === 'document') {
      const parameter = own(template.parameters, operation.key);
      if (parameter) target = { scope: 'document', path, key: operation.key, param: parameter };
    } else {
      const scoped = state === project.cover ? { ...template, spreads: coverLayouts() } : template;
      target = resolveEditPath(scoped, state!.definition ?? '', path, operation.page);
    }
    return { ...location, target: target ?? fail('PARAMETER_NOT_FOUND', 'The current template has no parameter at this location.') };
  }

  for (const operation of parsed.data) {
    switch (operation.op) {
      case 'set_title':
        if (project.title !== operation.title) {
          project.title = operation.title;
          changed('Updated book title', allSpreads());
        }
        break;
      case 'select_format':
        if (!Object.hasOwn(template.formats, operation.format)) fail('FORMAT_NOT_FOUND', 'Unknown print format ' + operation.format + '.');
        format = { label: template.formats[operation.format], structure: template.structures?.[operation.format] ?? template.format.structure };
        formatId = operation.format;
        if (project.format !== operation.format) {
          project.format = operation.format;
          changed('Selected print format ' + operation.format, allSpreads(), true);
        }
        break;
      case 'set_parameter': {
        const { spread, target, values } = parameterTarget(operation);
        validateValue(target.param, operation.value, target.key);
        if (values && Object.hasOwn(values, target.key) && sameValue(values[target.key], operation.value)) break;
        writeEdit(project, spread?.id, target, operation.value);
        changed('Updated ' + target.path, target.scope === 'document' ? allSpreads() : [spread!.id], true);
        break;
      }
      case 'reset_parameter': {
        const location = parameterLocation(operation);
        const { spread, state, path, values } = location;
        if (!values || !Object.hasOwn(values, operation.key)) {
          // Nothing is saved here. Resetting is then only valid for a parameter the template declares, so a mistyped
          // key or owner fails with PARAMETER_NOT_FOUND instead of succeeding silently.
          parameterTarget(operation, location);
          break;
        }
        delete values[operation.key];
        // An element entry holds nothing but its params: drop it once empty, so no orphan owner remains for an element
        // the template no longer declares.
        if (operation.scope === 'element' && state && !Object.keys(values).length) delete state.elements[operation.owner!];
        changed('Reset ' + path, spread ? [spread.id] : allSpreads(), true);
        break;
      }
      case 'insert_list_item':
      case 'update_list_item':
      case 'remove_list_item':
      case 'move_list_item': {
        const { spread, target, values } = parameterTarget(operation);
        const param = target.param;
        if (param.type !== 'list') fail('NOT_A_LIST', 'Parameter ' + target.path + ' is not a list. Use set_parameter.');
        const saved = values && Object.hasOwn(values, target.key) ? values[target.key] : undefined;
        // Item operations start from the saved list, or the default when none is saved. A saved list the template no
        // longer allows is not rewritten item by item: replace it with set_parameter or reset_parameter.
        if (saved !== undefined && listProblems(param, saved).length) {
          fail('INVALID_PARAMETER_VALUE', 'The saved ' + target.path + ' is not a valid list (' + listProblems(param, saved)[0] +
            '). Replace it with set_parameter or reset_parameter first.');
        }
        const items = structuredClone(saved !== undefined ? saved as ListItem[] : resolveValue(param, undefined) as ListItem[]);
        const index = (item: string) => {
          const found = items.findIndex(({ id }) => id === item);
          return found >= 0 ? found : fail('ITEM_NOT_FOUND', target.path + ' has no item ' + item + '.');
        };
        const position = (after: string | null | undefined) => after === undefined ? items.length : after === null ? 0 : index(after) + 1;
        let message: string;
        if (operation.op === 'insert_list_item') {
          const { id: given, ...fields } = operation.item;
          if (given !== undefined && (typeof given !== 'string' || items.some(({ id }) => id === given))) {
            fail('INVALID_PARAMETER_VALUE', 'Item id ' + String(given) + ' must be a unique identifier in ' + target.path + '.');
          }
          const item: ListItem = { id: typeof given === 'string' ? given : newItemId(items), ...fields };
          items.splice(position(operation.after), 0, item);
          message = 'Added item ' + item.id + ' to ';
        } else if (operation.op === 'update_list_item') {
          if (Object.hasOwn(operation.values, 'id')) fail('INVALID_PARAMETER_VALUE', 'An item keeps its id; update its other fields.');
          const at = index(operation.id);
          items[at] = { ...items[at], ...operation.values };
          message = 'Updated item ' + operation.id + ' of ';
        } else if (operation.op === 'remove_list_item') {
          items.splice(index(operation.id), 1);
          message = 'Removed item ' + operation.id + ' from ';
        } else {
          const [item] = items.splice(index(operation.id), 1);
          if (operation.after === operation.id) fail('INVALID_POSITION', 'An item cannot move after itself.');
          items.splice(position(operation.after), 0, item);
          message = 'Moved item ' + operation.id + ' in ';
        }
        validateValue(param, items, target.key);
        if (saved !== undefined && sameValue(saved, items)) break;
        writeEdit(project, spread?.id, target, items);
        changed(message + target.path, target.scope === 'document' ? allSpreads() : [spread!.id], true);
        break;
      }
      case 'insert_spread': {
        const spread = { ...newSpread(operation.definition), params: operation.params, boxes: operation.boxes, elements: operation.elements };
        validateInitialSpread(spread);
        if (!spanFits(template.spreads[operation.definition].span, format)) {
          fail('INCOMPATIBLE_LAYOUT', 'Layout ' + operation.definition + ' does not fit the book\'s format ' + format.label + (hasFacingPages(format)
            ? ', which has facing pages. Insert a spread layout.' : ', which has no facing pages. Insert a single-page layout.'));
        }
        checkInsertion(spread, operation.after);
        registerSpread(spread, operation.ref);
        insertAfter(spread, operation.after);
        changed('Inserted spread ' + spread.id, allSpreads(), true);
        break;
      }
      case 'insert_page_pair': {
        if (!hasFacingPages(format)) fail('INCOMPATIBLE_LAYOUT', 'Page pairs need a facing-pages format.');
        const definition = operation.pages.left?.definition ?? operation.pages.right!.definition!;
        const spread: SpreadState = { ...newSpread(definition), split: true, pages: operation.pages };
        for (const side of ['left', 'right'] as const) {
          const state = spread.pages?.[side];
          if (!state) continue;
          if (!state.definition) {
            if (Object.keys(state.params).length || Object.keys(state.boxes).length || Object.keys(state.elements).length) {
              fail('INVALID_OPERATION', 'Initial content needs a page layout.');
            }
            continue;
          }
          const layout = findLayout(state.definition);
          if (layout.span !== 'page' || (layout.sides && !layout.sides.includes(side))) {
            fail('INCOMPATIBLE_LAYOUT', 'Layout ' + state.definition + ' is not allowed on the ' + side + ' page.');
          }
          validateInitialSpread({ ...state, definition: state.definition, id: spread.id });
        }
        checkInsertion(spread, operation.after);
        registerSpread(spread, operation.ref);
        insertAfter(spread, operation.after);
        changed('Inserted page pair ' + spread.id, allSpreads(), true);
        break;
      }
      case 'clear_page': {
        const spread = findSpread(operation.spread);
        const position = { index: project.spreads.indexOf(spread), count: project.spreads.length };
        if (!hasFacingPages(format) || spanRequiredAt(position.index, position.count, format) !== 'spread') {
          fail('INCOMPATIBLE_LAYOUT', 'Blank pages require a full facing sheet.');
        }
        const plan = switchLayout(spread, { page: operation.page }, template.spreads);
        changed('Cleared ' + operation.page + ' page of ' + spread.id, [spread.id], plan.reflow);
        break;
      }
      case 'swap_pages': {
        const spread = findSpread(operation.spread);
        if (!spread.split) fail('INVALID_OPERATION', 'Only split sheets have pages to swap.');
        for (const side of ['left', 'right'] as const) {
          const definition = spread.pages?.[side]?.definition;
          const layout = definition ? findLayout(definition) : undefined;
          if (layout?.sides && !layout.sides.includes(side === 'left' ? 'right' : 'left')) {
            fail('INCOMPATIBLE_LAYOUT', 'A page layout is restricted to its current side.');
          }
        }
        swapPages(spread);
        changed('Swapped pages of ' + spread.id, [spread.id], true);
        break;
      }
      case 'duplicate_spread': {
        const source = findSpread(operation.spread);
        const spread = { ...structuredClone(source), id: newSpread(source.definition).id };
        checkInsertion(spread, operation.after === undefined ? source.id : operation.after);
        registerSpread(spread, operation.ref);
        insertAfter(spread, operation.after === undefined ? source.id : operation.after);
        changed('Duplicated spread ' + source.id + ' as ' + spread.id, allSpreads(), true);
        break;
      }
      case 'move_spread': {
        const spread = findSpread(operation.spread);
        const after = operation.after === null ? undefined : findSpread(operation.after);
        if (spread === after) break;
        const before = project.spreads.indexOf(spread);
        const position = after ? project.spreads.filter((other) => other !== spread).indexOf(after) + 1 : 0;
        if (position === before) break;
        const ordered = spreadOrder(project.spreads, spread.id, position, { spreads: template.spreads, format });
        if (!ordered) {
          fail('INVALID_POSITION', 'This move would put a spread where ' + format.label + ' does not allow it: the book must open on a single ' +
            'right page and close on a single left page, with full spreads between them. Spreads cannot move into or out of those ends.');
        }
        project.spreads = ordered;
        changed('Moved spread ' + spread.id, allSpreads(), true);
        break;
      }
      case 'remove_spread': {
        const spread = findSpread(operation.spread);
        project.spreads.splice(project.spreads.indexOf(spread), 1);
        changed('Removed spread ' + spread.id, [spread.id, ...allSpreads()], true);
        break;
      }
      case 'switch_layout': {
        if (operation.cover) {
          const layout = coverLayout(operation.definition);
          if (project.cover?.definition === operation.definition) break;
          if (project.cover) project.cover.definition = operation.definition;
          else project.cover = { definition: operation.definition, params: {}, boxes: {}, elements: {} };
          changed('Selected cover layout ' + layout.label, [coverInstance]);
          break;
        }
        const spread = findSpread(operation.spread!);
        findLayout(operation.definition);
        const position = { index: project.spreads.indexOf(spread), count: project.spreads.length };
        if (operation.page) {
          if (!hasFacingPages(format) || spanRequiredAt(position.index, position.count, format) !== 'spread') {
            fail('INCOMPATIBLE_LAYOUT', 'Page layout changes require a full facing sheet. Omit page at book ends or in non-facing formats.');
          }
          if (!editorLayoutChoices(template.spreads, spread, format, position, operation.page).includes(operation.definition)) {
            fail('INCOMPATIBLE_LAYOUT', 'The layout is not allowed on the requested page.');
          }
          const plan = switchLayout(spread, editorLayoutTarget(template.spreads, operation.definition, format, position, operation.page), template.spreads);
          changed('Changed layout of ' + spread.id + ' ' + operation.page + '. ' + describeLayoutChange(plan), [spread.id], plan.reflow);
          break;
        }
        if (spread.split) {
          const layout = template.spreads[operation.definition];
          if (!spanAllowedAt(layout.span ?? 'spread', position.index, position.count, format, layout.sides)) {
            fail('INCOMPATIBLE_LAYOUT', 'Specify page to change an individual page, or choose a spread layout to merge the sheet.');
          }
        } else if (!layoutChoices(template.spreads, spread.definition, format, position).includes(operation.definition)) {
          const required = spanRequiredAt(position.index, position.count, format);
          if (template.spreads[operation.definition].span !== required && required !== own(template.spreads, spread.definition)?.span) {
            fail('INCOMPATIBLE_LAYOUT', 'This position requires a layout with span: \'' + required + '\' in ' + format.label + '.');
          }
          fail('INCOMPATIBLE_LAYOUT', spanFits(template.spreads[operation.definition].span, format)
            ? 'A layout switch must keep the same page footprint.'
            : 'Layout ' + operation.definition + ' does not fit the book\'s format ' + format.label + (hasFacingPages(format)
              ? ', which has facing pages. Choose a spread layout.' : ', which has no facing pages. Choose a single-page layout.'));
        }
        if (!spread.split && spread.definition === operation.definition) break;
        const plan = switchLayout(spread, operation.definition, template.spreads);
        changed('Changed layout of ' + spread.id + '. ' + describeLayoutChange(plan), [spread.id], plan.reflow);
        break;
      }
      case 'assign_source': {
        const { sheet: spread, state } = commandState(operation);
        requireBoxKind(state, operation.box, operation.kind);
        requireSource(operation.kind, operation.source);
        const before = own(state.boxes, operation.box);
        const source = operation.kind === 'photo' ? before?.photo : before?.text;
        if (source === operation.source && !before?.crops && !before?.focus) break;
        const replacement = { ...boxBase(before), ...(operation.kind === 'photo' ? { photo: operation.source } : { text: operation.source }) };
        state.boxes[operation.box] = replacement;
        changed('Assigned ' + operation.kind + ' ' + operation.source + ' to ' + operation.box, [spread.id], operation.kind === 'text');
        break;
      }
      case 'clear_box': {
        const { sheet: spread, state } = commandState(operation);
        const before = own(state.boxes, operation.box);
        // Saved content outside the current layout, including content no layout declares any more, can be cleared too.
        if (!before) findBox(state, operation.box);
        if (!before || (!before.photo && !before.text && !before.crops && !before.focus)) break;
        const layouts = operation.cover ? template.coverLayouts ?? {} : template.spreads;
        if (Object.values(layouts).some((layout) => own(layout.boxes, operation.box))) discardContent(state, operation.box);
        // No layout can show or edit this box, so its parameters go with its content.
        else delete state.boxes[operation.box];
        changed('Cleared box ' + operation.box, [spread.id], !!before.text);
        break;
      }
      case 'swap_content': {
        const { sheet: fromSheet, state: from } = commandState(operation.from);
        const { sheet: toSheet, state: to } = commandState(operation.to);
        const fromType = findBox(from, operation.from.box).type;
        if (findBox(to, operation.to.box).type !== fromType) fail('BOX_TYPE_MISMATCH', 'Swapped boxes must accept the same content type.');
        if (from === to && operation.from.box === operation.to.box) break;
        const moving = own(from.boxes, operation.from.box);
        const displaced = own(to.boxes, operation.to.box);
        if (!moving?.photo && !moving?.text) fail('EMPTY_BOX', 'The source box has no content to swap.');
        for (const state of [moving, displaced]) {
          const source = state?.photo ?? state?.text;
          if (!source) continue;
          const kind = state?.photo ? 'photo' : 'text';
          if ((kind === 'photo' ? 'photo' : 'markdown') !== fromType) fail('BOX_TYPE_MISMATCH', 'Stored box content has the wrong type.');
          requireSource(kind, source);
        }
        if (moving.photo === displaced?.photo && moving.text === displaced?.text && !moving.crops && !displaced?.crops &&
            moving.focus?.centerX === displaced?.focus?.centerX && moving.focus?.centerY === displaced?.focus?.centerY) break;
        if (!displaced) to.boxes[operation.to.box] = { params: {} };
        swapContent(from, operation.from.box, to, operation.to.box);
        changed('Swapped content between ' + operation.from.box + ' and ' + operation.to.box, [fromSheet.id, toSheet.id], fromType === 'markdown');
        break;
      }
      case 'set_crop': {
        const { sheet: spread, state } = commandState(operation);
        requireBoxKind(state, operation.box, 'photo');
        const box = own(state.boxes, operation.box);
        if (!box?.photo) fail('EMPTY_BOX', 'Assign a photo before setting its crop.');
        requireSource('photo', box.photo);
        const before = JSON.stringify(box);
        setPlacement(box, state.definition!, { centerX: operation.centerX, centerY: operation.centerY, zoom: operation.zoom });
        if (before !== JSON.stringify(box)) changed('Updated crop of ' + operation.box, [spread.id]);
        break;
      }
      case 'set_photo_metadata': {
        const photo = own(photoIndex, operation.photo) ?? fail('SOURCE_NOT_FOUND', 'Unknown photo source ' + operation.photo + '.');
        let updated = false;
        for (const [key, value] of Object.entries(operation.values)) {
          const field = key as keyof typeof operation.values;
          if (value === null && Object.hasOwn(photo, field)) { delete photo[field]; updated = true; }
          else if (value !== null && value !== undefined && photo[field] !== value) { photo[field] = value; updated = true; }
        }
        if (updated) changed('Updated photo metadata for ' + operation.photo,
          project.spreads.filter((spread) => storedBoxes(spread).some(({ state }) => state.photo === operation.photo)).map(({ id }) => id));
        break;
      }
    }
    operationIndex++;
  }
  return { files: next, changes, affectedSpreads: [...affected], ...(affectedCover ? { affectedCover: true as const } : {}), references, reflow };
}
