import type { BigIntStats } from 'node:fs';
import fs, { lstat, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

type RetainedFolder = { folder: string; files: Map<string, BigIntStats> };
const renditionName = /^([a-f0-9]{64})-(?:thumb|preview|export(?:-[1-9]\d{0,5})?)\.(?:jpg|png)$/;

async function privateFolder(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
  return realpath(path);
}

function sameRendition(before: BigIntStats, after: BigIntStats) {
  // Adding/removing hard links changes ctime. Rendition writers publish replacements with rename(), never in place.
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs;
}

const discard = (folder?: string) => folder ? rm(folder, { recursive: true, force: true }).catch(() => {}) : Promise.resolve();

/** Owns only successfully validated private check folders. Fresh attempts receive independent hard links. */
export class CheckRenditionCache {
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private retained?: RetainedFolder;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;

  constructor({ maxFiles = 2048, maxBytes = 512 * 1024 * 1024 }: { maxFiles?: number; maxBytes?: number } = {}) {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('Rendition cache limits must be nonnegative safe integers.');
    }
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
  }

  private enqueue<T>(task: () => Promise<T>, fallback: T): Promise<T> {
    const result = this.pending.then(task).catch(() => fallback);
    this.pending = result.then(() => {});
    return result;
  }

  seed(targetFolder: string, keys: Set<string>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const wanted = new Set(keys);
    return this.enqueue(async () => {
      if (this.closed || !this.retained) return;
      const target = await privateFolder(targetFolder);
      if (!target || target === this.retained.folder) return;
      for (const [name, original] of this.retained.files) {
        if (this.closed) return;
        const match = renditionName.exec(name);
        if (!match || !wanted.has(match[1])) continue;
        const source = join(this.retained.folder, name);
        const destination = join(target, name);
        let linked = false;
        try {
          if (!sameRendition(original, await lstat(source, { bigint: true }))) continue;
          await fs.link(source, destination);
          linked = true;
          if (!sameRendition(original, await lstat(destination, { bigint: true }))) await unlink(destination);
        } catch {
          // A missing/evicted source is a cache miss. Existing target files belong to the fresh attempt.
          if (linked) await unlink(destination).catch(() => {});
        }
      }
    }, undefined);
  }

  retain(validatedFolder: string, keys: Set<string>): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const wanted = new Set(keys);
    return this.enqueue(async () => {
      if (this.closed) return false;
      const folder = await privateFolder(validatedFolder);
      if (!folder) return false;
      const files = new Map<string, BigIntStats>();
      let bytes = 0;
      for (const name of (await readdir(folder)).sort()) {
        if (this.closed) return false;
        const path = join(folder, name);
        const match = renditionName.exec(name);
        const info = await lstat(path, { bigint: true });
        if (match && wanted.has(match[1]) && info.isFile() && !info.isSymbolicLink() &&
            files.size < this.maxFiles && info.size <= BigInt(this.maxBytes - bytes)) {
          files.set(name, info);
          bytes += Number(info.size);
        } else {
          // Only this completed private attempt is pruned. The caller still cleans it up if ownership is declined.
          await fs.rm(path, { recursive: true, force: true });
        }
      }
      if (this.closed) return false;
      const previous = this.retained;
      this.retained = { folder, files };
      if (previous?.folder !== folder) await discard(previous?.folder);
      return !this.closed && this.retained?.folder === folder;
    }, false);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const owned = this.retained;
    this.retained = undefined;
    this.closing = this.pending.then(() => discard(owned?.folder)).catch(() => {});
    return this.closing;
  }
}
