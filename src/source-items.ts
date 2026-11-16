import { orderedPhotos, photoGroups, defaultPhotoView } from './photo-view';
import type { PhotoView } from './photo-view';
import { sourceFileName, sourcePath } from './source-locations';
import type { SourceReference } from './source-locations';
import type { ProjectSummary } from './desktop';

// Source helpers live outside Sources.tsx so React fast refresh can treat that file as components only.
export const photosMime = 'application/x-imageflow-photos';
export const photoMime = 'application/x-imageflow-photo';
export const textMime = 'application/x-imageflow-text';
// Content a spread keeps outside its layout, dragged from the Inspector: `{ spread, box }` as JSON. The drag also
// carries the photo or text ID, so dropping it on another spread places another use of the source.
export const keptMime = 'application/x-imageflow-kept';
export type SourceKind = 'photo' | 'text';
export type SourceRef = { kind: SourceKind; id: string };
// The bottom panel shows photos and texts as thumbnails, or every asset as a plain list.
export type SourcesTab = SourceKind | 'assets';

// Imported files are stored as "<id>-<name>"; show the original name.
export const fileName = (path: SourceReference) => sourceFileName(path);
export const words = (source: string) => source.split(/\s+/).filter(Boolean).length;

export function excerpt(source: string) {
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s/.test(line))?.replace(/^#+\s*/, '');
  const body = lines.filter((line) => !/^#{1,6}\s/.test(line)).join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#]|^[-+]\s/g, '').slice(0, 4096);
  return { heading, body };
}

export function sourceList(summary: ProjectSummary, kind: SourceKind, view?: PhotoView) {
  return kind === 'photo'
    ? photoGroups(summary, orderedPhotos(summary, view), view ?? defaultPhotoView).flatMap((group) => group.ids).map((id) => ({ id, title: summary.photoIndex[id].title || fileName(summary.photoIndex[id].path), path: summary.photoIndex[id].path }))
    : Object.entries(summary.project.texts).map(([id, path]) => ({ id, title: fileName(path), path: sourcePath(path) }));
}


/**
 * The book's texts as choices for a Markdown box, named as the Texts list names them. Texts that share a name are told
 * apart by their folder when that differs, otherwise by a running number; storage IDs never appear.
 */
export function textChoices(summary: Pick<ProjectSummary, 'project'>): (readonly [id: string, name: string])[] {
  const entries = Object.entries(summary.project.texts).map(([id, path]) => ({ id, name: sourceFileName(path),
    folder: sourcePath(path).split('/').slice(0, -1).pop() ?? '' }));
  const seen = new Map<string, number>();
  return entries.map(({ id, name, folder }) => {
    const same = entries.filter((entry) => entry.name === name);
    if (same.length < 2) return [id, name] as const;
    if (new Set(same.map((entry) => entry.folder)).size === same.length && folder) return [id, name + ' — ' + folder] as const;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return [id, count === 1 ? name : name + ' (' + count + ')'] as const;
  });
}

// The name shown for a photo or Markdown source.
export function sourceTitle(summary: ProjectSummary, kind: SourceKind, id: string) {
  if (kind === 'photo') return summary.photoIndex[id]?.title || (summary.photoIndex[id] ? fileName(summary.photoIndex[id].path) : id);
  return summary.project.texts[id] ? fileName(summary.project.texts[id]) : id;
}
