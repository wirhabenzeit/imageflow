import { z } from 'zod';
import type { ProjectFiles } from './project';
import { locatorOf, readableFileName } from './source-locator';

// Like the objects of project.json: unknown keys survive a load and save (ADR 0010), but the type strips them.
const looseObject = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape) as unknown as z.ZodObject<S, z.core.$strip>;
export const importModeSchema = z.enum(['copy', 'link']);
export type ImportMode = z.infer<typeof importModeSchema>;
// A relative string is document-owned. A linked reference names one explicitly selected external file.
export const sourceReferenceSchema = z.union([z.string(), looseObject({ path: z.string(), linked: z.literal(true) })]);
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type SourceKind = 'photo' | 'markdown' | 'file';
export type SourceKey = `${SourceKind}:${string}`;
export const sourcePath = (source: SourceReference | { path: string }) => typeof source === 'string' ? source : source.path;
export const sourceFileName = (source: SourceReference | { path: string }) => readableFileName(sourcePath(source));
export const sourceLinked = (source: SourceReference | { path: string; linked?: boolean }) => typeof source !== 'string' && 'linked' in source && source.linked === true;
export type SourceEntry = { key: SourceKey; kind: SourceKind; id: string; path: string; linked: boolean };
export type SourceStatus = SourceEntry & { state: 'available' | 'missing' | 'unreadable' | 'denied' | 'unapproved'; problem?: string; cached?: boolean; digest?: string };
/**
 * A file name as ImageFlow stores a copy under: letters, digits, combining marks, spaces, `.`, `_` and `-`; anything
 * else becomes `-`. Composed first (NFC), because macOS hands over names decomposed: `ö` as `o` and U+0308, whose
 * mark would otherwise be replaced, turning `Söng Kul.gpx` into `So-ng Kul.gpx` (beta finding F-026).
 */
export const storedFileName = (name: string) => name.normalize('NFC').replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '-');
export const sourceFolder = (kind: SourceKind) => kind === 'photo' ? 'photos' : kind === 'markdown' ? 'texts' : 'files';
export function sourceEntries(files: ProjectFiles): SourceEntry[] {
  return [
    // A photo's source is read through its locator (ADR 0011). Every locator of this version names a file.
    ...Object.entries(files.photoIndex).map(([id, entry]) => {
      const locator = locatorOf(entry);
      return { key: `photo:${id}` as const, kind: 'photo' as const, id, path: locator.path, linked: locator.provider === 'linked' };
    }),
    ...Object.entries(files.project.texts).map(([id, ref]) => ({ key: `markdown:${id}` as const, kind: 'markdown' as const, id, path: sourcePath(ref), linked: sourceLinked(ref) })),
    ...Object.entries(files.project.files).map(([id, ref]) => ({ key: `file:${id}` as const, kind: 'file' as const, id, path: sourcePath(ref), linked: sourceLinked(ref) })),
  ];
}
