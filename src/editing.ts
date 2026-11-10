import type { SpreadDefinition, TemplateInfo } from './desktop';
import type { Project, SpreadState, Values } from './project';
import { isParameterValue } from './parameters';
import type { Parameter, Parameters } from './parameters';

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

export type SourceUsage = Record<'photo' | 'text', Record<string, { spread: string; pages: string }[]>>;

// Lists the spreads that show each photo and Markdown source. `pages` holds a readable page range per spread.
export function sourceUsage(project: Project, pages: string[]) {
  const usage: SourceUsage = { photo: {}, text: {} };
  project.spreads.forEach((spread, i) => {
    for (const box of Object.values(spread.boxes)) {
      for (const [kind, id] of [['photo', box.photo], ['text', box.text]] as const) {
        if (!id) continue;
        const list = usage[kind][id] ??= [];
        if (!list.some((entry) => entry.spread === spread.id)) list.push({ spread: spread.id, pages: pages[i] });
      }
    }
  });
  return usage;
}

// Templates mark rendered nodes with `ctx.edit(path, ...)` so the editor can edit those parameters in place.
// Paths: `heading` (spread), `document.paper`, `elements.grid.firstWeekday`, `boxes.hero.showCaption`.
type EditableTemplate = {
  parameters: Parameters;
  spreads: Record<string, {
    parameters: Parameters;
    boxes: Record<string, { parameters: Parameters }>;
    elements: Record<string, { parameters: Parameters }>;
  }>;
};
export type EditTarget = { path: string; scope: 'spread' | 'document' | 'element' | 'box'; owner?: string; key: string; param: Parameter };

const own = <T,>(record: Record<string, T> | undefined, key: string) => record && Object.hasOwn(record, key) ? record[key] : undefined;

export function resolveEditPath(template: EditableTemplate, definition: string, path: string): EditTarget | undefined {
  const spread = own(template.spreads, definition);
  if (!spread) return;
  const parts = path.split('.');
  if (parts.length === 1) {
    const param = own(spread.parameters, parts[0]);
    return param && { path, scope: 'spread', key: parts[0], param };
  }
  if (parts.length === 2 && parts[0] === 'document') {
    const param = own(template.parameters, parts[1]);
    return param && { path, scope: 'document', key: parts[1], param };
  }
  if (parts.length === 3 && (parts[0] === 'elements' || parts[0] === 'boxes')) {
    const owner = own<{ parameters: Parameters }>(parts[0] === 'elements' ? spread.elements : spread.boxes, parts[1]);
    const param = own(owner?.parameters, parts[2]);
    return param && { path, scope: parts[0] === 'elements' ? 'element' : 'box', owner: parts[1], key: parts[2], param };
  }
}

function editValues(project: Project, spread: SpreadState, target: EditTarget, create = false) {
  if (target.scope === 'document') return project.params;
  if (target.scope === 'spread') return spread.params;
  const group = target.scope === 'element' ? spread.elements : spread.boxes;
  if (create) group[target.owner!] ??= { params: {} };
  return group[target.owner!]?.params;
}

export function readEdit(project: Project, spread: SpreadState, target: EditTarget) {
  const value = editValues(project, spread, target)?.[target.key];
  return isParameterValue(target.param, value) ? value! : target.param.default;
}

export function writeEdit(project: Project, spreadId: string, target: EditTarget, value: Values[string]) {
  const spread = project.spreads.find(({ id }) => id === spreadId);
  if (spread) editValues(project, spread, target, true)![target.key] = value;
}
