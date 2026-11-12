import { sourcePath } from './source-locations';
import type { SourceReference } from './source-locations';
import type { ProjectSummary } from './desktop';

// Source helpers live outside Sources.tsx so React fast refresh can treat that file as components only.
export const photoMime = 'application/x-imageflow-photo';
export const textMime = 'application/x-imageflow-text';
// Content a spread keeps outside its layout, dragged from the Inspector: `{ spread, box }` as JSON. The drag also
// carries the photo or text ID, so dropping it on another spread places another use of the source.
export const keptMime = 'application/x-imageflow-kept';
export type SourceKind = 'photo' | 'text';
export type SourceRef = { kind: SourceKind; id: string };

// Imported files are stored as "<id>-<name>"; show the original name.
export const fileName = (path: SourceReference) => (sourcePath(path).split('/').pop() ?? sourcePath(path)).replace(/^(?:ph|tx|fl)-[a-f0-9-]{12}-/, '');
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
    : Object.entries(summary.project.texts).map(([id, path]) => ({ id, title: fileName(path), path: sourcePath(path) }));
}


// The name shown for a photo or Markdown source.
export function sourceTitle(summary: ProjectSummary, kind: SourceKind, id: string) {
  if (kind === 'photo') return summary.photoIndex[id]?.title || (summary.photoIndex[id] ? fileName(summary.photoIndex[id].path) : id);
  return summary.project.texts[id] ? fileName(summary.project.texts[id]) : id;
}
