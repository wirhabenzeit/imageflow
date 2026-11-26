import { z } from 'zod';
import type { PhotoIndex, ProjectFiles } from './project';
import type { ProvidedMetadata } from './asset-facts';
import { isFileLocator, locatorName, locatorOf, locatorReach, readableFileName, readLocator } from './source-locator';
import type { Locator, Reach } from './source-locator';

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
/** Where a file source is: relative to the book, or `linked`, an absolute path elsewhere on this Mac. */
export type SourceFile = { path: string; linked: boolean };
type SourceBase<K extends SourceKind> = { key: `${K}:${string}`; kind: K; id: string;
  /** A readable name: a file's name without its storage prefix, or what a photo's locator offers (ADR 0011). */
  name: string };
/** A text or a file: always a file (ADR 0011 leaves them out of the provider contract). */
export type FileSourceEntry = (SourceBase<'markdown'> | SourceBase<'file'>) & SourceFile;
/** A photo, read through its locator's provider; only a file locator has a path (see `sourceFile`). */
export type PhotoSourceEntry = SourceBase<'photo'> & { locator: Locator };
export type SourceEntry = FileSourceEntry | PhotoSourceEntry;
/**
 * Why a source cannot be read. `offline` (the provider's app or server is not reachable) and `needs-sign-in` come from
 * providers without files; a file is never in either.
 */
export type SourceState = 'available' | 'missing' | 'unreadable' | 'denied' | 'unapproved' | 'offline' | 'needs-sign-in';
/**
 * Where an original is that is not on this Mac and need not be (#308, `awayOriginal`): on the Mac the photo was linked
 * on, in a Lightroom catalog that cannot be reached now, in the sync remote, or still uploading from another Mac.
 */
export type SourceAway = 'other-mac' | 'catalog' | 'not-downloaded' | 'uploading';
/** What can be offered for a source that cannot be read, as its provider answers (`SourceProvider.repairs`). */
export type SourceRepair = 'locate' | 'locate-folder' | 'launch' | 'sign-in' | 'allow';
export type SourceStatus = SourceEntry & { state: SourceState; problem?: string; cached?: boolean; digest?: string;
  /** The repairs to offer while the source is unavailable; Retry is always offered. */
  repairs?: SourceRepair[];
  /** The original is elsewhere and the photo drawn from its preview: normal while editing, needed for print. `state` stays what reading it ran into. */
  away?: SourceAway;
  /**
   * An export prints only the provider's preview of this photo (ADR 0011): its provider could not produce the
   * full-resolution original when the export asked for it, so the page is a proof. Set only in an export's load.
   */
  previewOnly?: boolean;
  /**
   * The photo changed in its source, which has no preview of it as it is now (ADR 0011, §2): it is drawn as it was
   * before, until there is one. Print is not affected: an export prints the photo as it is now.
   */
  outOfDate?: boolean;
  /** The photo has no preview yet, and one is being fetched: it is not a failure. */
  pending?: boolean;
  /** The photo's aspect ratio changed in its source after it was placed: a crop may frame another part of it. */
  reshaped?: boolean };
/** What a Book check error for an unavailable original adds after its cause; the export summary strips it again. */
export const cachedPreviewNote = '. Showing a cached preview; the original is required for print.';
/** A Book check error's text for an unavailable original, on a spread or the cover: its cause, which may end with a full stop of its own, and the note. */
export const cachedPreviewText = (problem: string) => problem.replace(/\.+$/, '') + cachedPreviewNote;
/** What an out-of-date photo is marked with (`SourceStatus.outOfDate`). */
export const outOfDateNote = 'Edited in Lightroom Classic since this preview. It updates when you are back in Lightroom’s Library; export prints the photo as it is now.';
/**
 * Why print cannot use a source's original here, or undefined when it can: it is drawn from a cached preview, or only
 * its provider's preview is on this Mac (ADR 0011). Print marks such a page ORIGINAL UNAVAILABLE and is a proof only.
 */
export function printProblem(status: SourceStatus | undefined): string | undefined {
  if (!status) return undefined;
  if (status.state !== 'available' && status.cached) return status.problem ?? 'Original unavailable';
  if (status.previewOnly) return 'Only a preview of this photo is on this Mac';
  return undefined;
}
/** The file a source is, for a text, a file, or a photo whose locator is a file; undefined for any other photo. */
export const sourceFile = (source: SourceEntry): SourceFile | undefined => source.kind !== 'photo' ? { path: source.path, linked: source.linked }
  : isFileLocator(source.locator) ? { path: source.locator.path, linked: source.locator.provider === 'linked' } : undefined;
/** A source as a file: what finding, reading, approving and watching a file needs. */
export type FileSource = SourceFile & { key: SourceKey; kind: SourceKind; id: string };
/** A source as a file, or undefined for a photo that is not one. */
export const fileSourceOf = (source: SourceEntry): FileSource | undefined => {
  const file = sourceFile(source);
  return file && { key: source.key, kind: source.kind, id: source.id, ...file };
};
/** Whose storage a source is in: `package` for the book's own, `linked` for a file elsewhere, or a provider. */
export const sourceProvider = (source: SourceEntry) => source.kind === 'photo' ? source.locator.provider : source.linked ? 'linked' : 'package';
/**
 * How far a source reaches (ADR 0012): `book` for what the package holds, anything else for what Copy into Book can
 * take into it. A photo's is its locator kind's; a text or a file is in the book or a linked file on this Mac.
 */
export const sourceReach = (source: SourceEntry): Reach => source.kind === 'photo' ? locatorReach(source.locator) : source.linked ? 'mac' : 'book';
/** The folder a file source is in, for display; undefined for a photo that is not a file. */
export const sourceFolderName = (source: SourceEntry) => sourceFile(source)?.path.split(/[\\/]/).slice(-2, -1)[0];
/**
 * A file name as ImageFlow stores a copy under: letters, digits, combining marks, spaces, `.`, `_` and `-`; anything
 * else becomes `-`. Composed first (NFC), because macOS hands over names decomposed: `ö` as `o` and U+0308, whose
 * mark would otherwise be replaced, turning `Söng Kul.gpx` into `So-ng Kul.gpx` (beta finding F-026).
 */
export const storedFileName = (name: string) => name.normalize('NFC').replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '-');
export const sourceFolder = (kind: SourceKind) => kind === 'photo' ? 'photos' : kind === 'markdown' ? 'texts' : 'files';
/**
 * A photo's title as the book resolves it (ADR 0011): the book's own where photos.json has the key, else its
 * provider's. A present empty title is an override that blanks the provider's.
 */
export function photoTitle(files: { photoIndex: PhotoIndex; photoProvided?: Record<string, ProvidedMetadata> }, id: string) {
  const entry = files.photoIndex[id];
  return entry && (Object.hasOwn(entry, 'title') ? entry.title : files.photoProvided?.[id]?.title);
}
/** What a photo's locator offers as its name (a file's name without its storage prefix), else its ID. */
export function photoSourceName(files: { photoIndex: PhotoIndex }, id: string) {
  const entry = files.photoIndex[id];
  const locator = entry && readLocator(entry);
  return locator ? locatorName(id, locator) : id;
}
/** The name shown for a photo: its title, else what its locator offers. */
export const photoName = (files: { photoIndex: PhotoIndex; photoProvided?: Record<string, ProvidedMetadata> }, id: string) =>
  photoTitle(files, id) || photoSourceName(files, id);
export function sourceEntries(files: ProjectFiles): SourceEntry[] {
  return [
    // A photo's source is read through its locator (ADR 0011), and named by it.
    ...Object.entries(files.photoIndex).map(([id, entry]): PhotoSourceEntry => {
      const locator = locatorOf(entry);
      return { key: `photo:${id}`, kind: 'photo', id, locator, name: locatorName(id, locator) };
    }),
    ...Object.entries(files.project.texts).map(([id, ref]): FileSourceEntry => ({ key: `markdown:${id}`, kind: 'markdown', id, path: sourcePath(ref), linked: sourceLinked(ref), name: sourceFileName(ref) })),
    ...Object.entries(files.project.files).map(([id, ref]): FileSourceEntry => ({ key: `file:${id}`, kind: 'file', id, path: sourcePath(ref), linked: sourceLinked(ref), name: sourceFileName(ref) })),
  ];
}
