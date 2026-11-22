import { constants, watch as watchDirectory } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SourceEntry } from '../../src/source-locations';
import { sourceFolder } from '../../src/source-locations';
import type { LinkedLocator, PackageLocator } from '../../src/source-locator';
import { fileStamp } from '../file-stamp';
import { requireSourceAccess, SourceAccessError } from '../source-access';
import type { Materialized, MaterializeOptions, Observed, Revisions, SourceProvider, SourceRef, Unavailable } from '../source-provider';

/**
 * Sources that are files on this Mac (ADR 0011, Source providers). The two photo providers, `package` (a photo in the
 * book's own `photos/`) and `linked` (a file anywhere else), differ in where a file may be, whether reading it needs
 * an approval, how large it may be and who watches it. They share how a file is found, observed and copied, and so do
 * texts and files, which are not behind the provider contract and call the same functions directly.
 */
type FileSource = Pick<SourceEntry, 'kind' | 'path' | 'linked'> & { key?: string };
/** The states a file can be in; no file is ever offline or behind a sign-in. */
export type FileUnavailable = Exclude<Unavailable, 'offline' | 'needs-sign-in'>;
export type ObservedFile = { state: 'available'; revisions: Revisions; modified: string; file: string } | { state: FileUnavailable; problem: string };
export type ClonedFile = { file: string; before: Revisions; after: Revisions } | { state: FileUnavailable; problem: string };

export function within(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** The file a source names, checked for where it may be: a linked one approved and outside the book, an owned one inside its folder. */
export async function originalPath(folder: string, source: FileSource) {
  if (source.linked) {
    await requireSourceAccess(folder, source);
    if (!isAbsolute(source.path)) throw new Error('Linked sources must name an absolute file path.');
    const actual = await realpath(source.path);
    if (actual !== source.path) throw new SourceAccessError('The linked target changed. Locate this original again.');
    if (within(folder, actual)) throw new Error('A linked source must be outside the book. Use Copy into Book for internal files.');
    return actual;
  }
  const root = join(folder, sourceFolder(source.kind));
  const path = resolve(folder, source.path);
  if (isAbsolute(source.path) || !within(root, path)) throw new Error('Source must be inside ' + sourceFolder(source.kind) + '/.');
  const actual = await realpath(path);
  if (!within(root, actual)) throw new Error('Source points outside ' + sourceFolder(source.kind) + '/.');
  return actual;
}

/** The state an error stands for, while a file is found, read or copied. */
export function fileFailure(error: unknown, source: Pick<FileSource, 'path' | 'linked'>): { state: FileUnavailable; problem: string } {
  if (error instanceof SourceAccessError) return { state: 'unapproved', problem: error.message };
  const code = (error as NodeJS.ErrnoException).code;
  const state = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unreadable';
  return { state, problem: state === 'missing' ? (source.linked ? 'Original missing: ' : 'Missing project file: ') + source.path
    : state === 'denied' ? 'Access denied' : 'Original unavailable: ' + (error instanceof Error ? error.message : String(error)) };
}

// Megabytes. An owned photo has no limit: it was checked when it was imported.
const maximumSize = (source: FileSource) => source.kind === 'photo' ? source.linked ? 50 : undefined : source.kind === 'markdown' ? 5 : 20;

/** A file's state without reading it. Its revision is its stamp: a file has no cheaper sign that only its metadata changed. */
export async function observeFile(folder: string, source: FileSource): Promise<ObservedFile> {
  try {
    const file = await originalPath(folder, source);
    const info = await stat(file, { bigint: true });
    if (source.kind === 'markdown' && extname(source.path).toLowerCase() !== '.md') throw new Error('Expected a Markdown (.md) file.');
    const maximum = maximumSize(source);
    if (!info.isFile() || (maximum && info.size > BigInt(maximum * 1024 * 1024))) throw new Error(`Expected a regular file${maximum ? ` up to ${maximum} MB` : ''}.`);
    return { state: 'available', revisions: { revision: fileStamp(info) }, modified: new Date(Number(info.mtimeMs)).toISOString(), file };
  } catch (error) { return fileFailure(error, source); }
}

/**
 * A private copy of a file in `staging` (a clone where the volume makes them), with the file's revision before and
 * after: equal only if the path still names the same unchanged file once the copy exists.
 */
export async function cloneFile(folder: string, source: FileSource, staging: string): Promise<ClonedFile> {
  const before = await observeFile(folder, source);
  if (before.state !== 'available') return before;
  const file = join(staging, randomUUID() + '.tmp');
  // A copy that is not handed over is removed here: the folder may be one that is kept, such as the source cache.
  try { await copyFile(before.file, file, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL); }
  catch (error) { await rm(file, { force: true }); return fileFailure(error, source); }
  const after = await observeFile(folder, source);
  if (after.state !== 'available') { await rm(file, { force: true }); return after; }
  // Another file at the path has another inode, so its stamp differs like that of the same file after a change.
  return { file, before: before.revisions, after: after.revisions };
}

type FileLocator = PackageLocator | LinkedLocator;
const photoSource = ({ id, locator }: SourceRef<FileLocator>): FileSource =>
  ({ key: 'photo:' + id, kind: 'photo', path: locator.path, linked: locator.provider === 'linked' });
async function* clonePhotos(folder: string, refs: readonly SourceRef<FileLocator>[], { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
  for (const ref of refs) {
    if (signal.aborted) return;
    yield { id: ref.id, ...await cloneFile(folder, photoSource(ref), staging) };
  }
}
const observePhotos = (folder: string, refs: readonly SourceRef<FileLocator>[]): Promise<Observed[]> => Promise.all(refs.map((ref) => observeFile(folder, photoSource(ref))));
// A missing file is located again, by itself or in a folder; so is one that cannot be read or is not approved.
const fileRepairs = (state: Unavailable) => state === 'offline' || state === 'needs-sign-in' ? [] : ['locate', 'locate-folder'] as const;

/** A photo in the book package: the host's own storage. It needs no approval and is never watched here. */
export const packageProvider: SourceProvider<PackageLocator> = {
  provider: 'package',
  observe: observePhotos,
  materialize: clonePhotos,
  // The book folder is the host's, and its own watcher covers `photos/`.
  watch: () => () => {},
  repairs: fileRepairs,
};

// A linked file is looked at this often, whatever its folder's watch reports, and an unavailable one is tried again
// less often: looking covers what a watch misses, and a drive that comes back.
const pollInterval = 1500;
const retryInterval = 10_000;

/** A linked file to watch: `known` is the revision last observed, left out for a file that was unavailable then. */
export type WatchedFile = { id: string; source: FileSource; known?: string };
/**
 * Watches linked files where they are, photos, texts and files alike, and calls `changed` with the IDs of those whose
 * stamp differs from the last one seen, or that can be read again. A file that changed since `known` is reported at
 * once. Returns a function that stops watching.
 */
export function watchLinkedFiles(folder: string, files: readonly WatchedFile[], changed: (ids: string[]) => void): () => void {
  if (!files.length) return () => {};
  const stamps = new Map(files.flatMap(({ id, known }) => known ? [[id, known] as const] : []));
  const unavailable = new Set(files.filter(({ known }) => !known).map(({ id }) => id));
  const retryAt = new Map<string, number>();
  // Parent-directory watches survive a file being replaced atomically, which a watch on the file would not.
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;
  let scanning = false;
  let again = false;
  const scan = async () => {
    if (stopped) return;
    // A change reported while the files are being looked at is looked at afterwards.
    if (scanning) { again = true; return; }
    scanning = true;
    try {
      const moved: string[] = [];
      for (const { id, source } of files) {
        const stamp = await stat(source.path, { bigint: true }).then(fileStamp, () => '');
        const previous = stamps.get(id);
        stamps.set(id, stamp);
        if (previous !== undefined && previous !== stamp) { moved.push(id); continue; }
        if (!unavailable.has(id) || Date.now() <= (retryAt.get(id) ?? 0)) continue;
        retryAt.set(id, Date.now() + retryInterval);
        if ((await observeFile(folder, source)).state === 'available') { unavailable.delete(id); moved.push(id); }
      }
      if (stopped) return;
      for (const directory of new Set(files.map(({ source }) => dirname(source.path)))) {
        if (watchers.has(directory)) continue;
        try {
          const watcher = watchDirectory(directory, (_event, name) => {
            if (!name || files.some(({ source }) => source.path === join(directory, String(name)))) void scan();
          });
          watcher.on('error', () => { watcher.close(); watchers.delete(directory); });
          watchers.set(directory, watcher);
        } catch { /* Looking again retries a location that is not there, such as a drive that is not connected. */ }
      }
      if (moved.length) changed(moved);
    } finally {
      scanning = false;
      if (again) { again = false; void scan(); }
    }
  };
  const timer = setInterval(() => void scan(), pollInterval);
  timer.unref();
  void scan();
  return () => { stopped = true; clearInterval(timer); for (const watcher of watchers.values()) watcher.close(); watchers.clear(); };
}

/** A file elsewhere on this Mac: approved per path, limited in size and watched where it is. */
export const linkedProvider: SourceProvider<LinkedLocator> = {
  provider: 'linked',
  observe: observePhotos,
  materialize: clonePhotos,
  watch: (folder, refs, changed) => watchLinkedFiles(folder, refs.map((ref) => ({ id: ref.id, source: photoSource(ref), known: ref.known?.revision })), changed),
  repairs: fileRepairs,
};
