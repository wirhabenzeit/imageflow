import { z } from 'zod';
import type { ProjectFiles } from './project';

export const importModeSchema = z.enum(['copy', 'link']);
export type ImportMode = z.infer<typeof importModeSchema>;
// A relative string is document-owned. A linked reference names one explicitly selected external file.
export const sourceReferenceSchema = z.union([z.string(), z.object({ path: z.string(), linked: z.literal(true) })]);
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SourceKind = 'photo' | 'markdown' | 'file';
export type SourceKey = `${SourceKind}:${string}`;
export const sourcePath = (source: SourceReference | { path: string }) => typeof source === 'string' ? source : source.path;
export const sourceLinked = (source: SourceReference | { path: string; linked?: boolean }) => typeof source !== 'string' && 'linked' in source && source.linked === true;
export type SourceEntry = { key: SourceKey; kind: SourceKind; id: string; path: string; linked: boolean };
export type SourceStatus = SourceEntry & { state: 'available' | 'missing' | 'unreadable' | 'denied'; problem?: string; cached?: boolean; digest?: string };
export const sourceFolder = (kind: SourceKind) => kind === 'photo' ? 'photos' : kind === 'markdown' ? 'texts' : 'files';
export function sourceEntries(files: ProjectFiles): SourceEntry[] {
  return [
    ...Object.entries(files.photoIndex).map(([id, entry]) => ({ key: `photo:${id}` as const, kind: 'photo' as const, id, path: entry.path, linked: !!entry.linked })),
    ...Object.entries(files.project.texts).map(([id, ref]) => ({ key: `markdown:${id}` as const, kind: 'markdown' as const, id, path: sourcePath(ref), linked: sourceLinked(ref) })),
    ...Object.entries(files.project.files).map(([id, ref]) => ({ key: `file:${id}` as const, kind: 'file' as const, id, path: sourcePath(ref), linked: sourceLinked(ref) })),
  ];
}
