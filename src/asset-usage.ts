import { coverInstance, storedBoxes, storedStates } from './project';
import type { Project, ProjectFiles } from './project';
import type { Parameters } from './parameters';
import type { SourcePlace, SourceUsage } from './editing';
import { sourceUsage } from './editing';
import type { ProjectSummary } from './desktop';

export const assetPageLabels = (summary: ProjectSummary) => summary.project.spreads.map(({ id }, i) => summary.pageLabels?.[id] ?? 'Spread ' + (i + 1));

// A usage's place as people read it: "Page 4", "Pages 4–5", or a name such as "Book settings".
export const usageLabel = (pages: string) => /^\d/.test(pages) ? (pages.includes('–') ? 'Pages ' : 'Page ') + pages : pages;

// Every set of saved parameter values in the book: document settings, then, for each spread, the parameters of each
// state it stores (its own and its pages'), of their elements, and of every box it stores, replaced content included.
// Values kept for a layout the spread no longer uses are still saved, so they count.
export function parameterValues(project: Project) {
  const layouts = project.cover ? [...project.spreads, { ...project.cover, id: coverInstance }] : project.spreads;
  return [{ values: project.params, spread: '' }, ...layouts.flatMap((spread) => [
    ...storedStates(spread).flatMap(({ state }) => [{ values: state.params, spread: spread.id },
      ...Object.values(state.elements).map(({ params }) => ({ values: params, spread: spread.id }))]),
    ...storedBoxes(spread).map(({ state }) => ({ values: state.params, spread: spread.id }))])];
}
// The values a parameter holds: itself, or, for a list, each field of each item. An item's own `id` is not a value.
const held = (value: unknown): unknown[] => Array.isArray(value)
  ? value.flatMap((item) => item && typeof item === 'object' ? Object.entries(item).filter(([key]) => key !== 'id').map(([, field]) => field) : [])
  : [value];

// By default, count saved references conservatively for unused and removal decisions, including retained values.
// Pass the active cover layout's box IDs to report visible cover photo placements.
export function assetUsage({ project, photoIndex }: ProjectFiles, pages: string[], coverBoxIds?: readonly string[]) {
  const usage = { ...sourceUsage(project, pages, undefined, coverBoxIds), file: {} } as SourceUsage & { file: Record<string, SourcePlace[]> };
  function record(value: unknown, spread: string, page: string) {
    if (typeof value !== 'string') return;
    const kinds = [Object.hasOwn(photoIndex, value) && 'photo', Object.hasOwn(project.texts, value) && 'text', Object.hasOwn(project.files, value) && 'file'] as const;
    for (const kind of kinds) if (kind) {
      if (kind !== 'file' && coverBoxIds && spread === coverInstance) continue;
      const list = usage[kind][value] ??= [];
      if (!list.some((entry) => entry.spread === spread)) list.push({ spread, pages: page, ...(spread === coverInstance ? { cover: true } : {}) });
    }
  }
  const labels = new Map(project.spreads.map(({ id }, i) => [id, pages[i]]));
  labels.set(coverInstance, 'Cover');
  for (const { values, spread } of parameterValues(project)) for (const value of Object.values(values)) for (const item of held(value)) record(item, spread, spread ? labels.get(spread)! : 'Book settings');
  return usage;
}

// Whether any saved value assigns the file, at any scope.
export const fileAssigned = (project: Project, id: string) =>
  parameterValues(project).some(({ values }) => Object.values(values).some((value) => held(value).includes(id)));

// Takes the files out of every saved assignment, in place: a parameter holding one goes back to its default, and a
// list item's field holding one takes its default again. The caller removes the registry entries.
export function clearFileAssignments(project: Project, ids: readonly string[]) {
  const gone = new Set(ids);
  for (const { values } of parameterValues(project)) for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && gone.has(value)) delete values[key];
    else if (Array.isArray(value)) for (const item of value) if (item && typeof item === 'object') {
      for (const [field, assigned] of Object.entries(item)) if (field !== 'id' && typeof assigned === 'string' && gone.has(assigned)) delete (item as Record<string, unknown>)[field];
    }
  }
}

// The extensions the template's file parameters accept, including list item fields. Files with other extensions
// are not guessed into a type: only these can be imported as files.
type FileLayout = { parameters: Parameters; boxes: Record<string, { parameters: Parameters }>; elements: Record<string, { parameters: Parameters }> };
type FileTemplate = { parameters: Parameters; spreads: Record<string, FileLayout>; coverLayouts?: Record<string, FileLayout> };
export function fileExtensions(template: FileTemplate | undefined) {
  const layouts = template ? [...Object.values(template.spreads), ...Object.values(template.coverLayouts ?? {})] : [];
  const groups = template ? [template.parameters, ...layouts.flatMap((spread) => [spread.parameters,
    ...Object.values(spread.boxes).map((box) => box.parameters), ...Object.values(spread.elements).map((element) => element.parameters)])] : [];
  return [...new Set(groups.flatMap((group) => Object.values(group).flatMap((param) =>
    param.type === 'list' ? Object.values(param.item) : [param]).flatMap((param) => param.type === 'file' ? param.accept : [])))];
}
