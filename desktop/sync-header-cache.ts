import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoreEntry } from './sync-store';

/**
 * The commit headers this Mac has read, per remote and book (#281, ADR 0012 "Listing commits is cached"). Headers are
 * immutable, so `StoreRemote.listCommits` lists a book's keys and fetches only those it has not read; over a bucket
 * that turns one request per commit at every sync into one listing.
 *
 * Each entry keeps the tag of the object it was read from (S3's ETag, otherwise size and time), and is used only while
 * the listing shows the same tag: a header that was deleted and stored again is read again. Entries whose keys are no
 * longer listed are dropped at the next write, and a cache file that cannot be read counts as empty.
 */
export type CachedHeader = { tag: string; value: unknown };
export interface CommitHeaderCache {
  read(remoteId: string, bookId: string): Promise<Map<string, CachedHeader>>;
  write(remoteId: string, bookId: string, entries: Map<string, CachedHeader>): Promise<void>;
}

/** What identifies the object behind a listed key. */
export const entryTag = (entry: StoreEntry) => entry.etag ?? entry.size + ':' + entry.lastModified.getTime();

const safe = /^[A-Za-z0-9-]{1,100}$/;

/** The cache in a folder (`<userData>/Sync Cache` in the app): `<remoteId>/<bookId>.json`. */
export class FileHeaderCache implements CommitHeaderCache {
  constructor(readonly folder: string) {}
  private file(remoteId: string, bookId: string) {
    if (!safe.test(remoteId) || !safe.test(bookId)) return undefined;
    return join(this.folder, remoteId, bookId + '.json');
  }
  async read(remoteId: string, bookId: string) {
    const file = this.file(remoteId, bookId);
    const entries = new Map<string, CachedHeader>();
    if (!file) return entries;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value?.version !== 1 || !value.headers || typeof value.headers !== 'object') return entries;
      for (const [key, entry] of Object.entries(value.headers as Record<string, CachedHeader>)) {
        if (entry && typeof entry.tag === 'string' && entry.value !== undefined) entries.set(key, { tag: entry.tag, value: entry.value });
      }
    } catch { /* Missing or damaged: read from the remote again. */ }
    return entries;
  }
  async write(remoteId: string, bookId: string, entries: Map<string, CachedHeader>) {
    const file = this.file(remoteId, bookId);
    if (!file) return;
    const folder = join(this.folder, remoteId);
    await mkdir(folder, { recursive: true });
    const staging = join(folder, '.' + randomUUID() + '.tmp');
    try {
      const handle = await open(staging, 'wx', 0o644);
      try { await handle.writeFile(JSON.stringify({ version: 1, headers: Object.fromEntries(entries) })); } finally { await handle.close(); }
      await rename(staging, file);
    } finally { await rm(staging, { force: true }); }
  }
}

/** The cache in memory, for tests. */
export class MemoryHeaderCache implements CommitHeaderCache {
  readonly books = new Map<string, Map<string, CachedHeader>>();
  async read(remoteId: string, bookId: string) { return new Map(this.books.get(remoteId + '/' + bookId)); }
  async write(remoteId: string, bookId: string, entries: Map<string, CachedHeader>) { this.books.set(remoteId + '/' + bookId, new Map(entries)); }
}
