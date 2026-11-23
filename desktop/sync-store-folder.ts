import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { StoreRemote } from './sync-remote';
import { isStoreKey, requireStoreKey, requireStorePrefix } from './sync-store';
import type { PutOptions, StoreEntry, StoreSource, SyncStore, TransferOptions } from './sync-store';

/**
 * The object store over a plain folder (#251, ADR 0012): tests, development, and possibly a NAS or an external drive.
 * A key is a path below the root, so a synced folder has the layout of ADR 0012, section 4. It knows nothing about
 * sync: `StoreRemote` holds that, and this keeps only the file handling.
 *
 * - Every object is written to a hidden temporary file beside it and then linked into place, so a reader never sees a
 *   partial file and an object that is there is never replaced (`putIfAbsent`).
 * - Files are copied with `COPYFILE_FICLONE`, so originals in a folder on the book's volume share their blocks with it.
 * - Hidden files (temporary files, a sync service's placeholders) are not objects: they are never listed.
 */
// `EISDIR`: a key under which other keys lie is a folder here, and no object.
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const temporary = (destination: string) => join(dirname(destination), '.sync-' + randomUUID() + '.tmp');
const object = (info: Stats) => ({ size: info.size, lastModified: info.mtime });
/** A clone keeps its source's times; an object's time is when it was stored (the sweep's grace period counts from it). */
async function cloneInto(source: string, staging: string) {
  await copyFile(source, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  const now = new Date();
  await utimes(staging, now, now);
}

/**
 * Runs a write once more when its folder went away under it: a `delete` that emptied the folder removes it, and may do
 * so between this write making the folder and using it.
 */
async function again<T>(write: () => Promise<T>) {
  try { return await write(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return write();
  }
}

/** The file system calls a test replaces: a volume without hard links, a folder removed at the wrong moment. */
export type FolderIo = { link: typeof link; mkdir: typeof mkdir };

export class FolderStore implements SyncStore {
  private readonly io: FolderIo;
  constructor(readonly root: string, io: Partial<FolderIo> = {}) { this.io = { link, mkdir, ...io }; }

  private path(key: string) { return join(this.root, ...requireStoreKey(key).split('/')); }
  /** The folder a prefix lies in (as a key prefix ending in `/`, or empty) and its path. */
  private folderOf(prefix: string) {
    const folder = requireStorePrefix(prefix).slice(0, prefix.lastIndexOf('/') + 1);
    return { folder, path: join(this.root, ...folder.split('/').filter(Boolean)) };
  }

  async putIfAbsent(key: string, source: StoreSource, { signal, onProgress }: PutOptions = {}) {
    const destination = this.path(key);
    signal?.throwIfAborted();
    // Looked at first, so a large original that is there already is not copied to find that out.
    if (await this.head(key)) return { existed: true };
    return again(() => this.write(destination, source, signal, onProgress));
  }

  private async write(destination: string, source: StoreSource, signal: AbortSignal | undefined, onProgress: PutOptions['onProgress']) {
    await this.io.mkdir(dirname(destination), { recursive: true });
    const staging = temporary(destination);
    try {
      if (source instanceof Uint8Array) {
        const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
        try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
      } else await cloneInto(source.file, staging);
      // A file copy that is running cannot be stopped; one that was aborted meanwhile is discarded here, before it
      // becomes an object.
      signal?.throwIfAborted();
      // A hard link never replaces a file that is already there; folders that cannot link fall back to a rename after
      // looking, which only a second writer of the same key at the same moment could race.
      try { await this.io.link(staging, destination); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return { existed: true };
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'EINVAL', 'ENOSYS'].includes(code ?? '')) throw error;
        if (await lstat(destination).catch(() => undefined)) return { existed: true };
        await rename(staging, destination);
      }
      const size = (await lstat(destination)).size;
      onProgress?.(size, size);
      return { existed: false };
    } finally { await rm(staging, { force: true }); }
  }

  async get(key: string, { signal, onProgress }: TransferOptions = {}) {
    const path = this.path(key);
    signal?.throwIfAborted();
    try {
      const bytes = new Uint8Array(await readFile(path, { signal }));
      onProgress?.(bytes.length, bytes.length);
      return bytes;
    } catch (error) { signal?.throwIfAborted(); if (missing(error)) return undefined; throw error; }
  }

  async download(key: string, file: string, { signal, onProgress }: TransferOptions = {}) {
    const source = this.path(key);
    signal?.throwIfAborted();
    if (!await this.head(key)) return false;
    const staging = temporary(file);
    try {
      try { await copyFile(source, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL); }
      catch (error) { if (missing(error)) return false; throw error; }
      signal?.throwIfAborted();
      const size = (await lstat(staging)).size;
      await rename(staging, file);
      onProgress?.(size, size);
      return true;
    } finally { await rm(staging, { force: true }); }
  }

  async head(key: string) {
    const info = await lstat(this.path(key)).catch(() => undefined);
    return info?.isFile() ? object(info) : undefined;
  }

  async list(prefix: string) {
    const { folder, path } = this.folderOf(prefix);
    let names: string[];
    try { names = await readdir(path, { recursive: true }); }
    catch (error) { if (missing(error)) return []; throw error; }
    const entries: StoreEntry[] = [];
    for (const name of names) {
      const key = folder + name.split(sep).join('/');
      if (!key.startsWith(prefix) || !isStoreKey(key)) continue;
      // One that went away since the folder was read is not there.
      const info = await lstat(join(path, name)).catch(() => undefined);
      if (info?.isFile()) entries.push({ key, ...object(info) });
    }
    return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async listPrefixes(prefix: string) {
    const { folder, path } = this.folderOf(prefix);
    const prefixes: string[] = [];
    for (const entry of await readdir(path, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error; })) {
      const child = folder + entry.name + '/';
      // A folder left empty (by a put that failed, or a sync service) holds no object and is no prefix.
      if (entry.isDirectory() && child.startsWith(prefix) && isStoreKey(child.slice(0, -1)) && await holdsObject(join(path, entry.name))) prefixes.push(child);
    }
    return prefixes.sort();
  }

  async copy(from: string, to: string) {
    const source = this.path(from);
    const destination = this.path(to);
    return again(async () => {
      if (!await this.head(from)) return false;
      await this.io.mkdir(dirname(destination), { recursive: true });
      const staging = temporary(destination);
      try {
        await cloneInto(source, staging);
        await rename(staging, destination);
        return true;
      } finally { await rm(staging, { force: true }); }
    });
  }

  async delete(keys: readonly string[]) {
    for (const key of keys) {
      const path = this.path(key);
      await rm(path, { force: true });
      // Folders that end up empty go too, so a deleted book leaves no prefix behind.
      for (let folder = dirname(path); folder.startsWith(this.root + sep); folder = dirname(folder)) {
        try { await rmdir(folder); } catch { break; }
      }
    }
  }
}

async function holdsObject(folder: string): Promise<boolean> {
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() || (entry.isDirectory() && await holdsObject(join(folder, entry.name)))) return true;
  }
  return false;
}

/** A sync remote in a folder. */
export const folderRemote = (root: string) => new StoreRemote(new FolderStore(root));
