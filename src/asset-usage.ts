import type { ProjectFiles } from './project';
import type { SourceUsage } from './editing';
import { sourceUsage } from './editing';

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
  for (const value of Object.values(project.params)) record(value, '', 'Book settings');
  project.spreads.forEach((spread, i) => {
    const values = [spread.params, ...Object.values(spread.boxes).map(({ params }) => params), ...Object.values(spread.elements).map(({ params }) => params)];
    for (const params of values) for (const value of Object.values(params)) record(value, spread.id, pages[i]);
  });
  return usage;
}
