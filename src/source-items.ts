import { orderedPhotos, photoGroups, defaultPhotoView } from './photo-view';
import type { PhotoView } from './photo-view';
import { sourceFileName, sourcePath } from './source-locations';
import type { SourceReference } from './source-locations';
import type { ProjectSummary } from './desktop';
import { splitFrontmatter } from './frontmatter';
import type { TextMetaValue } from './frontmatter';

// Source helpers live outside Sources.tsx so React fast refresh can treat that file as components only.
export const photosMime = 'application/x-imageflow-photos';
export const photoMime = 'application/x-imageflow-photo';
export const textMime = 'application/x-imageflow-text';
// A parameter file dragged from the Assets tab onto a file setting: its ID, and its extension as a type of its own, so
// a setting can tell while dragging whether it accepts the file (drag data is readable only on drop).
export const fileMime = 'application/x-imageflow-file';
export const fileExtensionMime = (extension: string) => fileMime + '-ext' + extension.toLowerCase();
// Content a spread keeps outside its layout, dragged from the Inspector: `{ spread, box }` as JSON. The drag also
// carries the photo or text ID, so dropping it on another spread places another use of the source.
export const keptMime = 'application/x-imageflow-kept';
export type SourceKind = 'photo' | 'text';
export type SourceRef = { kind: SourceKind; id: string };
// The bottom panel shows photos and texts as thumbnails, or every asset as a plain list.
export type SourcesTab = SourceKind | 'assets';

// Imported files are stored as "<id>-<name>"; show the original name.
export const fileName = (path: SourceReference) => sourceFileName(path);
// A YAML header is not part of the text (src/frontmatter.ts): words, excerpts and previews leave it out.
export const words = (source: string) => splitFrontmatter(source).body.split(/\s+/).filter(Boolean).length;

/** A text's first heading, or its header's title, and the start of its text, for a tile; with the header's fields. */
export function excerpt(source: string) {
  const { body: text, meta } = splitFrontmatter(source);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const title = typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : undefined;
  // The text's own heading when it starts with one, else its header's title. A heading further down names a later
  // section, such as a second day in a diary, not the text.
  const leading = /^#{1,6}\s/.test(lines[0] ?? '') ? lines[0].replace(/^#+\s*/, '') : undefined;
  const heading = leading ?? title;
  const body = (leading === undefined ? lines : lines.slice(1)).map((line) => line.replace(/^#{1,6}\s+/, '')).join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#]|^[-+]\s/g, '').slice(0, 4096);
  return { heading, body, meta };
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

// "2026-08-22" as "22 Aug", for telling apart texts that are days of a journey.
function dayLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(day.getTime()) ? undefined : day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * The book's texts for a menu (F-043): by their heading or header title, and the header's date, as the Texts tiles
 * name them, since files such as "Bishkek.md" and "Bishkek.md (2)" are hard to tell apart. A text without either, or
 * one not readable now, keeps its file name; `file` names the file in either case.
 */
export function textMenuChoices(summary: Pick<ProjectSummary, 'project' | 'texts'>) {
  const files = new Map(textChoices(summary));
  const entries = Object.keys(summary.project.texts).map((id) => {
    const source = summary.texts[id];
    const { heading, meta } = source === undefined ? { heading: undefined, meta: null } : excerpt(source);
    const date = typeof meta?.date === 'string' ? dayLabel(meta.date) : undefined;
    const file = files.get(id) ?? id;
    return { id, file, title: heading ? heading + (date ? ' · ' + date : '') : file };
  });
  return entries.map((entry) => entry.title !== entry.file && entries.filter(({ title }) => title === entry.title).length > 1
    ? { ...entry, title: entry.title + ' — ' + entry.file } : entry);
}

// The name shown for a photo or Markdown source.
export function sourceTitle(summary: ProjectSummary, kind: SourceKind, id: string) {
  if (kind === 'photo') return summary.photoIndex[id]?.title || (summary.photoIndex[id] ? fileName(summary.photoIndex[id].path) : id);
  return summary.project.texts[id] ? fileName(summary.project.texts[id]) : id;
}

// A header value in one line: lists joined, fields of an object named.
export function metaText(value: TextMetaValue): string {
  if (value === null) return '—';
  if (Array.isArray(value)) return value.map(metaText).join(', ');
  if (typeof value === 'object') {
    // Named places and similar records: their name, else their fields.
    if (typeof value.name === 'string') return value.name;
    return Object.entries(value).map(([key, field]) => key + ': ' + metaText(field)).join(', ');
  }
  return String(value);
}
