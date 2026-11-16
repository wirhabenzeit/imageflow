import { scopeSpread, storedBoxes } from './project';
import type { PageSide, Project, SpreadState, Values } from './project';
import { resolveValue } from './parameters';
import type { Parameter, Parameters } from './parameters';
import { shownBoxes } from './layouts';
import { hasFacingPages, spanAllowedAt, spanRequiredAt } from './format';
import type { PrintFormat } from './format';
import type { Layouts } from './layouts';

export function newSpread(definition: string): SpreadState {
  return { id: crypto.randomUUID(), definition, params: {}, boxes: {}, elements: {} };
}

export type OpeningPageInput = { layout?: string; params?: Values };
export type OpeningSpreadInput = { layout: string; params?: Values } | { pages: Partial<Record<PageSide, OpeningPageInput>> };
/** Materialize the template's starting units, with independent records and fresh sheet IDs. */
export function openingSpreadStates(template: { openingSpreads?: readonly OpeningSpreadInput[] }): SpreadState[] {
  return (template.openingSpreads ?? []).map((entry) => {
    if ('layout' in entry) return { ...newSpread(entry.layout), params: structuredClone(entry.params ?? {}) };
    const definition = entry.pages.left?.layout ?? entry.pages.right?.layout ?? 'blank';
    const pages = Object.fromEntries(Object.entries(entry.pages).map(([side, page]) => [side, {
      ...(page.layout ? { definition: page.layout } : {}), params: structuredClone(page.params ?? {}), boxes: {}, elements: {},
    }]));
    return { ...newSpread(definition), split: true, pages };
  });
}

/** The layouts that can be the first spread of an empty book: facing pages, or a single right page where the format allows one. */
export function firstSpreadLayouts(layouts: Layouts, format: PrintFormat) {
  // Counted as the first of several, so a closing left page is not offered as the start of a book.
  return Object.entries(layouts).filter(([, layout]) => spanAllowedAt(layout.span ?? 'spread', 0, 2, format, layout.sides)).map(([id]) => id);
}

// Editor insertion can compose two page designs into a sheet, so a facing template needs no dummy spread
// layout just to create a book. Commands keep their narrower `firstSpreadLayouts`/insert_spread contract.
export function editorLayoutsAt(layouts: Layouts, format: PrintFormat, position: { index: number; count: number }) {
  const required = spanRequiredAt(position.index, position.count, format);
  return Object.keys(layouts).filter((id) => {
    const layout = layouts[id];
    if (hasFacingPages(format) && required === 'spread' && layout.span === 'page') {
      return !layout.sides || layout.sides.includes('left') || layout.sides.includes('right');
    }
    return spanAllowedAt(layout.span, position.index, position.count, format, layout.sides);
  });
}

export const firstEditorLayouts = (layouts: Layouts, format: PrintFormat) => editorLayoutsAt(layouts, format, { index: 0, count: 2 });

/** A fresh editor unit at this position. Page designs on full sheets start on their first allowed side, facing a
 * blank page; end pages and formats without facing pages keep the ordinary, unsplit single-page representation. */
export function newEditorSpread(definition: string, layouts: Layouts, format: PrintFormat,
  position: { index: number; count: number }): SpreadState | undefined {
  if (!Object.hasOwn(layouts, definition) || !editorLayoutsAt(layouts, format, position).includes(definition)) return;
  const sheet = newSpread(definition);
  if (hasFacingPages(format) && spanRequiredAt(position.index, position.count, format) === 'spread' && layouts[definition].span === 'page') {
    const side = !layouts[definition].sides || layouts[definition].sides.includes('left') ? 'left' : 'right';
    sheet.split = true;
    sheet.pages = { [side]: { definition, params: {}, boxes: {}, elements: {} } };
  }
  return sheet;
}

// The boxes a spread shows: its own layout's, or its pages' when it is shown as pages. Without the template (still
// loading), every box the spread stores counts, on its pages and among replaced content too.
function shown(spread: SpreadState, layouts?: Layouts) {
  if (!layouts) return storedBoxes(spread).map(({ state }) => state);
  const layout = (definition: string | undefined) => definition !== undefined && Object.hasOwn(layouts, definition) ? layouts[definition] : undefined;
  const states = spread.split ? Object.values(spread.pages ?? {}) : [spread];
  return states.flatMap((state) => shownBoxes(state, layout(state.definition)).map((id) => state.boxes[id]));
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
export type EditTarget = { page?: PageSide; path: string; scope: 'spread' | 'document' | 'element' | 'box'; owner?: string; key: string; param: Parameter };

const own = <T,>(record: Record<string, T> | undefined, key: string) => record && Object.hasOwn(record, key) ? record[key] : undefined;

export function resolveEditPath(template: EditableTemplate, definition: string, path: string, page?: PageSide): EditTarget | undefined {
  const spread = own(template.spreads, definition);
  if (!spread) return;
  const parts = path.split('.');
  if (parts.length === 1) {
    const param = own(spread.parameters, parts[0]);
    return param && { ...(page ? { page } : {}), path, scope: 'spread', key: parts[0], param };
  }
  if (parts.length === 2 && parts[0] === 'document') {
    const param = own(template.parameters, parts[1]);
    return param && { ...(page ? { page } : {}), path, scope: 'document', key: parts[1], param };
  }
  if (parts.length === 3 && (parts[0] === 'elements' || parts[0] === 'boxes')) {
    const owner = own<{ parameters: Parameters }>(parts[0] === 'elements' ? spread.elements : spread.boxes, parts[1]);
    const param = own(owner?.parameters, parts[2]);
    return param && { ...(page ? { page } : {}), path, scope: parts[0] === 'elements' ? 'element' : 'box', owner: parts[1], key: parts[2], param };
  }
}

function editValues(project: Project, spread: SpreadState, target: EditTarget, create = false) {
  if (target.scope === 'document') return project.params;
  const state = scopeSpread(spread, target.page);
  if (!state) return;
  if (target.scope === 'spread') return state.params;
  const group = target.scope === 'element' ? state.elements : state.boxes;
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
  if (spread) { const values = editValues(project, spread, target, true); if (values) values[target.key] = value; }
}
