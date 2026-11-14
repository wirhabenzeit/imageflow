import type { Project, SpreadState, Values } from './project';
import { resolveValue } from './parameters';
import type { Parameter, Parameters } from './parameters';
import { shownBoxes } from './layouts';
import { spanAllowedAt } from './format';
import type { PrintFormat } from './format';
import type { Layouts } from './layouts';

export function newSpread(definition: string): SpreadState {
  return { id: crypto.randomUUID(), definition, params: {}, boxes: {}, elements: {} };
}

/** The spreads a new book starts with: the template's opening spreads with new IDs, or none. */
export function openingSpreadStates(template: { openingSpreads?: readonly { layout: string; params?: Values }[] }): SpreadState[] {
  return (template.openingSpreads ?? []).map(({ layout, params }) => ({ ...newSpread(layout), params: { ...params } }));
}

/** The layouts that can be the first spread of an empty book: facing pages, or a single right page where the format allows one. */
export function firstSpreadLayouts(layouts: Layouts, format: PrintFormat) {
  // Counted as the first of several, so a closing left page is not offered as the start of a book.
  return Object.entries(layouts).filter(([, layout]) => spanAllowedAt(layout.span ?? 'spread', 0, 2, format)).map(([id]) => id);
}

// The boxes a spread shows. Without the template (still loading), every assigned box counts.
function shown(spread: SpreadState, layouts?: Layouts) {
  const ids = layouts ? new Set(shownBoxes(spread, Object.hasOwn(layouts, spread.definition) ? layouts[spread.definition] : undefined)) : undefined;
  return Object.entries(spread.boxes).filter(([id]) => !ids || ids.has(id)).map(([, box]) => box);
}

// How often each photo is shown in the book. Content kept outside a spread's current layout does not count.
export function assignmentCounts(project: Project, layouts?: Layouts) {
  const counts: Record<string, number> = {};
  for (const spread of project.spreads) {
    for (const { photo } of shown(spread, layouts)) {
      if (photo) counts[photo] = (counts[photo] ?? 0) + 1;
    }
  }
  return counts;
}

export type SourceUsage = Record<'photo' | 'text', Record<string, { spread: string; pages: string }[]>>;

// Lists the spreads that show each photo and Markdown source. `pages` holds a readable page range per spread.
export function sourceUsage(project: Project, pages: string[], layouts?: Layouts) {
  const usage: SourceUsage = { photo: {}, text: {} };
  project.spreads.forEach((spread, i) => {
    for (const box of shown(spread, layouts)) {
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
  editors?: Record<string, { parameters: readonly string[] }>;
  spreads: Record<string, {
    parameters: Parameters;
    boxes: Record<string, { parameters: Parameters }>;
    elements: Record<string, { parameters: Parameters; editor?: { parameters: readonly string[]; spread?: readonly string[] } }>;
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
  return resolveValue(target.param, value);
}

// Document parameters need no spread, so a book without spreads can still change them.
export function writeEdit(project: Project, spreadId: string | undefined, target: EditTarget, value: Values[string]) {
  if (target.scope === 'document') { project.params[target.key] = value; return; }
  const spread = project.spreads.find(({ id }) => id === spreadId);
  if (spread) editValues(project, spread, target, true)![target.key] = value;
}
