import type { Project, ProjectFiles } from './project';
import type { Parameters } from './parameters';
import type { SourceUsage } from './editing';
import { sourceUsage } from './editing';
import type { ProjectSummary } from './desktop';

export const assetPageLabels = (summary: ProjectSummary) => summary.project.spreads.map(({ id }, i) => summary.pageLabels?.[id] ?? 'Spread ' + (i + 1));

// A usage's place as people read it: "Page 4", "Pages 4–5", or a name such as "Book settings".
export const usageLabel = (pages: string) => /^\d/.test(pages) ? (pages.includes('–') ? 'Pages ' : 'Page ') + pages : pages;

// Every set of saved parameter values in the book: document settings, then each spread's own, its boxes' and its
// elements'. Values kept for a layout the spread no longer uses are still saved, so they count.
export function parameterValues(project: Project) {
  return [{ values: project.params, spread: '' }, ...project.spreads.flatMap((spread) => [{ values: spread.params, spread: spread.id },
    ...Object.values(spread.boxes).map(({ params }) => ({ values: params, spread: spread.id })),
    ...Object.values(spread.elements).map(({ params }) => ({ values: params, spread: spread.id }))])];
}
// The values a parameter holds: itself, or, for a list, each field of each item. An item's own `id` is not a value.
const held = (value: unknown): unknown[] => Array.isArray(value)
  ? value.flatMap((item) => item && typeof item === 'object' ? Object.entries(item).filter(([key]) => key !== 'id').map(([, field]) => field) : [])
  : [value];

// Count saved references conservatively, including parameters and content kept by another layout. An asset is
// safe to describe as unused only when no saved value references it; a filename or path is never a reference.
export function assetUsage({ project, photoIndex }: ProjectFiles, pages: string[]) {
  const usage = { ...sourceUsage(project, pages), file: {} } as SourceUsage & { file: Record<string, { spread: string; pages: string }[]> };
  function record(value: unknown, spread: string, page: string) {
    if (typeof value !== 'string') return;
    const kinds = [Object.hasOwn(photoIndex, value) && 'photo', Object.hasOwn(project.texts, value) && 'text', Object.hasOwn(project.files, value) && 'file'] as const;
    for (const kind of kinds) if (kind) {
      const list = usage[kind][value] ??= [];
      if (!list.some((entry) => entry.spread === spread)) list.push({ spread, pages: page });
    }
  }
  const labels = new Map(project.spreads.map(({ id }, i) => [id, pages[i]]));
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
type FileTemplate = { parameters: Parameters; spreads: Record<string, { parameters: Parameters; boxes: Record<string, { parameters: Parameters }>; elements: Record<string, { parameters: Parameters }> }> };
export function fileExtensions(template: FileTemplate | undefined) {
  const groups = template ? [template.parameters, ...Object.values(template.spreads).flatMap((spread) => [spread.parameters,
    ...Object.values(spread.boxes).map((box) => box.parameters), ...Object.values(spread.elements).map((element) => element.parameters)])] : [];
  return [...new Set(groups.flatMap((group) => Object.values(group).flatMap((param) =>
    param.type === 'list' ? Object.values(param.item) : [param]).flatMap((param) => param.type === 'file' ? param.accept : [])))];
}
