import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../src/canonical-json';
import { commitHeaderSchema } from '../src/sync-snapshot';
import type { CommitHeader } from '../src/sync-snapshot';
import { requireBlobKey } from './sync-remote';
import type { SyncRemote } from './sync-remote';

/**
 * A sync remote in a plain folder (#251): iCloud Drive, Dropbox, Syncthing or a NAS, with no credentials. It holds
 * only immutable files, so a sync daemon never has two versions of one file to reconcile:
 *
 * - `books/<bookId>/snapshots/<commitId>.json`: the small commit headers; tips are derived from them (`remoteTips`);
 * - `blobs/content/<digest>`, `blobs/originals/<digest><ext>`, `blobs/proxies/<digest>-preview-v1<ext>`.
 *
 * Every file is written to a hidden temporary file beside it and renamed into place, so a reader never sees a partial
 * file that this Mac wrote; files another Mac is still delivering are caught by the engine's digest checks. Blobs are
 * copied with `COPYFILE_FICLONE`, so originals in a sync folder on the book's volume share their blocks with it.
 */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireId = (id: string, what: string) => { if (!uuidPattern.test(id)) throw new Error('Not a sync ' + what + ' ID: ' + id); return id; };
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const temporary = (destination: string) => join(dirname(destination), '.sync-' + randomUUID() + '.tmp');

export class FolderRemote implements SyncRemote {
  constructor(readonly root: string) {}

  private snapshots(bookId: string) { return join(this.root, 'books', requireId(bookId, 'book'), 'snapshots'); }
  private commitPath(bookId: string, commitId: string) { return join(this.snapshots(bookId), requireId(commitId, 'commit') + '.json'); }
  private blobPath(key: string) { requireBlobKey(key); return join(this.root, ...key.split('/')); }

  async putCommit(header: CommitHeader) {
    const parsed = commitHeaderSchema.parse(header);
    const destination = this.commitPath(parsed.bookId, parsed.commitId);
    await mkdir(dirname(destination), { recursive: true });
    const bytes = canonicalJson(parsed) + '\n';
    const staging = temporary(destination);
    try {
      await writeFile(staging, bytes, { flag: 'wx', mode: 0o644 });
      // A hard link never replaces a header that is already there; folders that cannot link fall back to a rename
      // after looking, which only a second Mac writing the same new UUID at the same moment could race.
      try { await link(staging, destination); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          const existing = await this.getCommit(parsed.bookId, parsed.commitId);
          if (canonicalJson(existing) !== canonicalJson(parsed)) throw new Error('A different commit with this ID exists.');
          return;
        }
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'EINVAL', 'ENOSYS'].includes(code ?? '')) throw error;
        if (await lstat(destination).catch(() => undefined)) throw new Error('A different commit with this ID exists.');
        await rename(staging, destination);
      }
    } finally { await rm(staging, { force: true }); }
  }

  async getCommit(bookId: string, commitId: string) {
    return this.readJson(this.commitPath(bookId, commitId));
  }

  /** Parsed JSON, or undefined for a file that is missing or not whole JSON yet (still arriving). */
  private async readJson(path: string): Promise<unknown> {
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    try { return JSON.parse(text); } catch { return undefined; }
  }

  async listBooks() {
    let names: string[];
    try { names = await readdir(join(this.root, 'books')); }
    catch (error) { if (missing(error)) return []; throw error; }
    return names.filter((name) => uuidPattern.test(name));
  }

  async listCommits(bookId: string) {
    let names: string[];
    try { names = await readdir(this.snapshots(bookId)); }
    catch (error) { if (missing(error)) return []; throw error; }
    const headers: unknown[] = [];
    // Hidden files are this or another Mac's temporary files, or iCloud placeholders (`.<name>.icloud`) not downloaded
    // yet. Conflict copies a sync daemon makes (`<id> (1).json`) hold an immutable header too and are read like it.
    for (const name of names.filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort()) {
      const value = await this.readJson(join(this.snapshots(bookId), name));
      if (value !== undefined) headers.push(value);
    }
    return headers;
  }

  async hasBlob(key: string) {
    return !!(await lstat(this.blobPath(key)).catch(() => undefined))?.isFile();
  }

  async putBlob(key: string, source: Uint8Array | { file: string }) {
    const destination = this.blobPath(key);
    if (await this.hasBlob(key)) return;
    await mkdir(dirname(destination), { recursive: true });
    const staging = temporary(destination);
    try {
      if (source instanceof Uint8Array) {
        const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
        try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
      } else await copyFile(source.file, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      // Content-addressed: one that arrived meanwhile from another Mac has the same bytes, and either may stay.
      await rename(staging, destination);
    } finally { await rm(staging, { force: true }); }
  }

  async getBlob(key: string) {
    try { return new Uint8Array(await readFile(this.blobPath(key))); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }

  async downloadBlob(key: string, destination: string) {
    const source = this.blobPath(key);
    const staging = temporary(destination);
    try {
      try { await copyFile(source, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL); }
      catch (error) { if (missing(error)) return false; throw error; }
      await rename(staging, destination);
      return true;
    } finally { await rm(staging, { force: true }); }
  }
}
