import type { SpreadDefinition, TemplateInfo } from './desktop';
import type { Project, SpreadState, Values } from './project';
import type { Parameters } from './parameters';

export function newSpread(definition: string): SpreadState {
  return { id: crypto.randomUUID(), definition, params: {}, boxes: {}, elements: {}, archive: {} };
}

function matching(values: Values, before: Parameters, after: Parameters) {
  return Object.fromEntries(Object.entries(values).filter(([id]) => before[id]?.type === after[id]?.type && after[id]));
}

export function switchDefinition(spread: SpreadState, definition: string, template: TemplateInfo) {
  if (definition === spread.definition) return;
  const old: SpreadDefinition | undefined = template.spreads[spread.definition];
  const next = template.spreads[definition];
  const { params, boxes, elements } = spread;
  spread.archive[spread.definition] = { params, boxes, elements };
  const saved = spread.archive[definition];
  spread.definition = definition;
  spread.params = { ...saved?.params, ...matching(params, old?.parameters ?? {}, next.parameters) };
  spread.boxes = { ...saved?.boxes };
  spread.elements = { ...saved?.elements };
  for (const [id, target] of Object.entries(next.boxes)) {
    const source = old?.boxes[id];
    const state = boxes[id];
    if (source?.type !== target.type || !state) continue;
    spread.boxes[id] = {
      ...state, params: { ...spread.boxes[id]?.params, ...matching(state.params, source.parameters, target.parameters) },
    };
  }
  for (const [id, target] of Object.entries(next.elements)) {
    const source = old?.elements[id];
    const state = elements[id];
    if (!source || !state) continue;
    spread.elements[id] = {
      params: { ...spread.elements[id]?.params, ...matching(state.params, source.parameters, target.parameters) },
    };
  }
  delete spread.archive[definition];
}

export function assignmentCounts(project: Project) {
  const counts: Record<string, number> = {};
  for (const spread of project.spreads) {
    for (const { photo } of Object.values(spread.boxes)) {
      if (photo) counts[photo] = (counts[photo] ?? 0) + 1;
    }
  }
  return counts;
}
