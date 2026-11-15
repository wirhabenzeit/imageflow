import type { Parameters } from './parameters';
import type { SpreadState, Values } from './project';
import type { TemplateInfo } from './desktop';
import { newSpread } from './editing';

// Settings that describe a layout rather than a book's content: switches, numbers, choices, colours and dates.
// Text, files and lists are content, so example spreads fall back to the template's defaults for them.
const layoutTypes = new Set(['boolean', 'integer', 'number', 'enum', 'color', 'date']);

function layoutValues(values: Values | undefined, parameters: Parameters | undefined): Values {
  const kept: Values = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const type = parameters && Object.hasOwn(parameters, key) ? parameters[key].type : undefined;
    if (type && layoutTypes.has(type)) kept[key] = value;
  }
  return kept;
}

/**
 * The example spreads a new book can start with: the layouts of a built-in template's sample book, in order, with their
 * layout settings but none of its content (no photos, texts, crops, text values or files). Spreads whose layout the
 * template no longer declares are left out.
 */
export function exampleSpreadStates(spreads: readonly SpreadState[], info: Pick<TemplateInfo, 'spreads'>): SpreadState[] {
  return spreads.flatMap((spread) => {
    const definition = Object.hasOwn(info.spreads, spread.definition) ? info.spreads[spread.definition] : undefined;
    if (!definition) return [];
    const boxes: SpreadState['boxes'] = {};
    for (const [id, box] of Object.entries(spread.boxes ?? {})) {
      const params = layoutValues(box.params, Object.hasOwn(definition.boxes, id) ? definition.boxes[id].parameters : undefined);
      if (Object.keys(params).length) boxes[id] = { params };
    }
    const elements: SpreadState['elements'] = {};
    for (const [id, element] of Object.entries(spread.elements ?? {})) {
      const params = layoutValues(element.params, Object.hasOwn(definition.elements, id) ? definition.elements[id].parameters : undefined);
      if (Object.keys(params).length) elements[id] = { params };
    }
    return [{ ...newSpread(spread.definition), params: layoutValues(spread.params, definition.parameters), boxes, elements }];
  });
}

/** Whether example spreads differ from the template's opening spreads, so offering the choice is worthwhile. */
export function examplesDiffer(spreads: readonly Pick<SpreadState, 'definition'>[], info: Pick<TemplateInfo, 'openingSpreads'>) {
  const opening = (info.openingSpreads ?? []).map(({ layout }) => layout);
  return spreads.length !== opening.length || spreads.some(({ definition }, index) => definition !== opening[index]);
}
