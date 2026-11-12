import { sourcePath } from './source-locations';
import { z } from 'zod';
import type { TemplateInfo } from './desktop';
import { newSpread, resolveEditPath, writeEdit } from './editing';
import type { EditTarget } from './editing';
import { describeLayoutChange, discardContent, layoutChoices, planLayoutChange, swapContent, switchLayout } from './layouts';
import { hasFacingPages, spanFits } from './format';
import { isParameterValue } from './parameters';
import type { Parameter, Parameters } from './parameters';
import { identifier } from './project';
import type { ProjectFiles, SpreadState, Values } from './project';
import { maxZoom, setPlacement } from './spread';

const id = identifier.refine((value) => value.length <= 256, 'Identifiers must be at most 256 characters.');
export const spreadReference = z.union([id, z.string().startsWith('$').refine((value) => id.safeParse(value.slice(1)).success,
  'Use a spread ID or $ followed by a batch reference.')]);
const value = z.union([z.string(), z.boolean(), z.number()]);
const parameterValues = z.record(id, value);
const unit = z.number().min(0).max(1);
const placement = z.strictObject({ centerX: unit, centerY: unit, zoom: z.number().min(1).max(maxZoom) });
const initialBox = z.strictObject({
  photo: id.optional(), text: id.optional(), params: parameterValues.default({}),
  crops: z.record(id, placement).optional(), focus: z.strictObject({ centerX: unit, centerY: unit }).optional(),
}).refine(({ photo, text, crops, focus }) => !(photo && text) && (!(crops || focus) || !!photo),
  'A box has one source, and only photos have crops or focus.');
const boxTarget = z.strictObject({ spread: spreadReference, box: id });
const parameterTarget = {
  scope: z.enum(['document', 'spread', 'box', 'element']),
  spread: spreadReference.optional(), owner: id.optional(), key: id,
};
function validParameterTarget(target: z.infer<z.ZodObject<typeof parameterTarget>>) {
  return target.scope === 'document' ? target.spread === undefined && target.owner === undefined
    : target.scope === 'spread' ? target.spread !== undefined && target.owner === undefined
    : target.spread !== undefined && target.owner !== undefined;
}

export const projectOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set_title'), title: z.string().trim().min(1) }),
  z.strictObject({ op: z.literal('select_format'), format: id }),
  z.strictObject({ op: z.literal('set_parameter'), ...parameterTarget, value }).refine(validParameterTarget,
    'Document parameters omit spread/owner, spread parameters require spread, and box/element parameters require spread and owner.'),
  z.strictObject({ op: z.literal('reset_parameter'), ...parameterTarget }).refine(validParameterTarget,
    'Document parameters omit spread/owner, spread parameters require spread, and box/element parameters require spread and owner.'),
  z.strictObject({
    op: z.literal('insert_spread'), definition: id, ref: id.optional(), after: spreadReference.nullable().optional(),
    params: parameterValues.default({}), boxes: z.record(id, initialBox).default({}),
    elements: z.record(id, z.strictObject({ params: parameterValues.default({}) })).default({}),
  }),
  z.strictObject({ op: z.literal('duplicate_spread'), spread: spreadReference, ref: id.optional(), after: spreadReference.nullable().optional() }),
  z.strictObject({ op: z.literal('move_spread'), spread: spreadReference,
    after: spreadReference.nullable().describe('Required destination. Use null to move to the start, or an existing spread ID or $alias to move immediately after it.') }),
  z.strictObject({ op: z.literal('remove_spread'), spread: spreadReference }),
  z.strictObject({ op: z.literal('switch_layout'), spread: spreadReference, definition: id }),
  z.strictObject({ op: z.literal('assign_source'), ...boxTarget.shape, kind: z.enum(['photo', 'text']), source: id }),
  z.strictObject({ op: z.literal('clear_box'), ...boxTarget.shape }),
  z.strictObject({ op: z.literal('swap_content'), from: boxTarget, to: boxTarget }),
  z.strictObject({ op: z.literal('set_crop'), ...boxTarget.shape, ...placement.shape }),
  z.strictObject({ op: z.literal('set_photo_metadata'), photo: id, values: z.strictObject({
    title: z.string().nullable().optional(), caption: z.string().nullable().optional(),
    credit: z.string().nullable().optional(), altText: z.string().nullable().optional(),
  }) }),
]);
export const projectOperationsSchema = z.array(projectOperationSchema).min(1).max(100);
export type ProjectOperation = z.input<typeof projectOperationSchema>;
export type ProjectOperations = z.input<typeof projectOperationsSchema>;
export type ProjectCommandResult = {
  files: ProjectFiles; changes: string[]; affectedSpreads: string[]; references: Record<string, string>; reflow: boolean;
};
export type ProjectCommandErrorCode = 'INVALID_OPERATION' | 'SPREAD_NOT_FOUND' | 'LAYOUT_NOT_FOUND' | 'BOX_NOT_FOUND' |
  'ELEMENT_NOT_FOUND' | 'PARAMETER_NOT_FOUND' | 'INVALID_PARAMETER_VALUE' | 'SOURCE_NOT_FOUND' | 'BOX_TYPE_MISMATCH' | 'INCOMPATIBLE_LAYOUT' |
  'REFERENCE_NOT_FOUND' | 'DUPLICATE_REFERENCE' | 'INVALID_SPREAD_ID' | 'FORMAT_NOT_FOUND' | 'EMPTY_BOX';

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
  let reflow = false;
  let operationIndex = 0;
  const own = <T,>(record: Record<string, T>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;
  function fail(code: ProjectCommandErrorCode, message: string): never {
    throw new ProjectCommandError(code, message, operationIndex);
  }
  const allSpreads = () => project.spreads.map(({ id }) => id);
  function changed(message: string, spreads: string[], affectsFlow = false) {
    changes.push(message);
    for (const spread of spreads) affected.add(spread);
    reflow ||= affectsFlow;
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
  function findBox(spread: SpreadState, box: string) {
    return own(findLayout(spread.definition).boxes, box) ??
      fail('BOX_NOT_FOUND', 'Layout ' + spread.definition + ' has no box ' + box + '.');
  }
  function requireSource(kind: 'photo' | 'text', source: string) {
    const registry = kind === 'photo' ? photoIndex : project.texts;
    if (!Object.hasOwn(registry, source)) fail('SOURCE_NOT_FOUND', 'Unknown ' + kind + ' source ' + source + '.');
  }
  function validateValue(parameter: Parameter, value: Values[string], key: string) {
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
  function requireBoxKind(spread: SpreadState, box: string, kind: 'photo' | 'text') {
    const expected = kind === 'photo' ? 'photo' : 'markdown';
    if (findBox(spread, box).type !== expected) fail('BOX_TYPE_MISMATCH', 'Box ' + box + ' does not accept ' + kind + ' content.');
  }
  function validateInitialSpread(spread: SpreadState) {
    const layout = findLayout(spread.definition);
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
  function insertAfter(spread: SpreadState, after: string | null | undefined) {
    const position = after === undefined ? project.spreads.length : after === null ? 0 : project.spreads.indexOf(findSpread(after)) + 1;
    project.spreads.splice(position, 0, spread);
  }
  function parameterTarget(operation: Extract<z.output<typeof projectOperationSchema>, { op: 'set_parameter' | 'reset_parameter' }>) {
    const spread = operation.scope === 'document' ? undefined : findSpread(operation.spread!);
    let target: EditTarget | undefined;
    if (operation.scope === 'document') {
      const parameter = own(template.parameters, operation.key);
      if (parameter) target = { scope: 'document', path: 'document.' + operation.key, key: operation.key, param: parameter };
    } else {
      const path = operation.scope === 'spread' ? operation.key :
        (operation.scope === 'box' ? 'boxes.' : 'elements.') + operation.owner + '.' + operation.key;
      target = resolveEditPath(template, spread!.definition, path);
    }
    return { spread, target: target ?? fail('PARAMETER_NOT_FOUND', 'The current template has no parameter at this location.') };
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
        if (project.format !== operation.format) {
          project.format = operation.format;
          changed('Selected print format ' + operation.format, allSpreads(), true);
        }
        break;
      case 'set_parameter':
      case 'reset_parameter': {
        const { spread, target } = parameterTarget(operation);
        const group = target.scope === 'box' ? spread?.boxes ?? {} : spread?.elements ?? {};
        const values = target.scope === 'document' ? project.params : target.scope === 'spread' ? spread?.params : own(group, target.owner!)?.params;
        if (operation.op === 'set_parameter') {
          validateValue(target.param, operation.value, target.key);
          if (values && Object.hasOwn(values, target.key) && values[target.key] === operation.value) break;
          if ((target.scope === 'box' || target.scope === 'element') && !Object.hasOwn(group, target.owner!)) group[target.owner!] = { params: {} };
          writeEdit(project, spread?.id, target, operation.value);
        } else {
          if (!values || !Object.hasOwn(values, target.key)) break;
          delete values[target.key];
        }
        changed((operation.op === 'set_parameter' ? 'Updated ' : 'Reset ') + target.path,
          target.scope === 'document' ? allSpreads() : [spread!.id], true);
        break;
      }
      case 'insert_spread': {
        const spread = { ...newSpread(operation.definition), params: operation.params, boxes: operation.boxes, elements: operation.elements };
        validateInitialSpread(spread);
        if (!spanFits(template.spreads[operation.definition].span, template.format)) {
          fail('INCOMPATIBLE_LAYOUT', 'Layout ' + operation.definition + ' does not fit the book\'s format ' + template.format.label + (hasFacingPages(template.format)
            ? ', which has facing pages. Insert a spread layout.' : ', which has no facing pages. Insert a single-page layout.'));
        }
        registerSpread(spread, operation.ref);
        insertAfter(spread, operation.after);
        changed('Inserted spread ' + spread.id, allSpreads(), true);
        break;
      }
      case 'duplicate_spread': {
        const source = findSpread(operation.spread);
        const spread = { ...structuredClone(source), id: newSpread(source.definition).id };
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
        project.spreads.splice(before, 1);
        const position = after ? project.spreads.indexOf(after) + 1 : 0;
        project.spreads.splice(position, 0, spread);
        if (position !== before) changed('Moved spread ' + spread.id, allSpreads(), true);
        break;
      }
      case 'remove_spread': {
        const spread = findSpread(operation.spread);
        project.spreads.splice(project.spreads.indexOf(spread), 1);
        changed('Removed spread ' + spread.id, [spread.id, ...allSpreads()], true);
        break;
      }
      case 'switch_layout': {
        const spread = findSpread(operation.spread);
        findLayout(operation.definition);
        if (!layoutChoices(template.spreads, spread.definition, template.format).includes(operation.definition)) {
          fail('INCOMPATIBLE_LAYOUT', spanFits(template.spreads[operation.definition].span, template.format)
            ? 'A layout switch must keep the same page footprint.'
            : 'Layout ' + operation.definition + ' does not fit the book\'s format ' + template.format.label + (hasFacingPages(template.format)
              ? ', which has facing pages. Choose a spread layout.' : ', which has no facing pages. Choose a single-page layout.'));
        }
        if (spread.definition === operation.definition) break;
        const plan = planLayoutChange(spread, operation.definition, template.spreads);
        switchLayout(spread, operation.definition, template.spreads);
        changed('Changed layout of ' + spread.id + '. ' + describeLayoutChange(plan), [spread.id], plan.reflow);
        break;
      }
      case 'assign_source': {
        const spread = findSpread(operation.spread);
        requireBoxKind(spread, operation.box, operation.kind);
        requireSource(operation.kind, operation.source);
        const before = own(spread.boxes, operation.box);
        const source = operation.kind === 'photo' ? before?.photo : before?.text;
        if (source === operation.source && !before?.crops && !before?.focus) break;
        const replacement = { params: before?.params ?? {}, ...(operation.kind === 'photo' ? { photo: operation.source } : { text: operation.source }) };
        spread.boxes[operation.box] = replacement;
        changed('Assigned ' + operation.kind + ' ' + operation.source + ' to ' + operation.box, [spread.id], operation.kind === 'text');
        break;
      }
      case 'clear_box': {
        const spread = findSpread(operation.spread);
        const before = own(spread.boxes, operation.box);
        // Saved content outside the current layout, including content no layout declares any more, can be cleared too.
        if (!before) findBox(spread, operation.box);
        if (!before || (!before.photo && !before.text && !before.crops && !before.focus)) break;
        if (Object.values(template.spreads).some((layout) => own(layout.boxes, operation.box))) discardContent(spread, operation.box);
        // No layout can show or edit this box, so its parameters go with its content.
        else delete spread.boxes[operation.box];
        changed('Cleared box ' + operation.box, [spread.id], !!before.text);
        break;
      }
      case 'swap_content': {
        const from = findSpread(operation.from.spread);
        const to = findSpread(operation.to.spread);
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
        changed('Swapped content between ' + operation.from.box + ' and ' + operation.to.box, [from.id, to.id], fromType === 'markdown');
        break;
      }
      case 'set_crop': {
        const spread = findSpread(operation.spread);
        requireBoxKind(spread, operation.box, 'photo');
        const box = own(spread.boxes, operation.box);
        if (!box?.photo) fail('EMPTY_BOX', 'Assign a photo before setting its crop.');
        requireSource('photo', box.photo);
        const before = JSON.stringify(box);
        setPlacement(box, spread.definition, { centerX: operation.centerX, centerY: operation.centerY, zoom: operation.zoom });
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
          project.spreads.filter(({ boxes }) => Object.values(boxes).some(({ photo }) => photo === operation.photo)).map(({ id }) => id));
        break;
      }
    }
    operationIndex++;
  }
  return { files: next, changes, affectedSpreads: [...affected], references, reflow };
}
