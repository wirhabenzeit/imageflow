import type { ProjectSummary } from './desktop';

// Source helpers live outside Sources.tsx so React fast refresh can treat that file as components only.
export const photoMime = 'application/x-imageflow-photo';
export const textMime = 'application/x-imageflow-text';
export type SourceKind = 'photo' | 'text';
export type SourceRef = { kind: SourceKind; id: string };

// Imported files are stored as "<id>-<name>"; show the original name.
export const fileName = (path: string) => (path.split('/').pop() ?? path).replace(/^(?:ph|tx|fl)-[a-f0-9-]{12}-/, '');
export const words = (source: string) => source.split(/\s+/).filter(Boolean).length;

export function excerpt(source: string) {
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s/.test(line))?.replace(/^#+\s*/, '');
  const body = lines.filter((line) => !/^#{1,6}\s/.test(line)).join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#]|^[-+]\s/g, '').slice(0, 220);
  return { heading, body };
}

export function sourceList(summary: ProjectSummary, kind: SourceKind) {
  return kind === 'photo'
    ? Object.entries(summary.photoIndex).map(([id, entry]) => ({ id, title: entry.title || fileName(entry.path), path: entry.path }))
    : Object.entries(summary.project.texts).map(([id, path]) => ({ id, title: fileName(path), path }));
}

