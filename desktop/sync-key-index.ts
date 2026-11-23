import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The keys of a book on a remote whose store keeps a change feed (`SyncStore.changes`, the iCloud store; #292), as this
 * Mac last saw them, with the token to ask for what changed since. `StoreRemote` answers listings from it, so a sync
 * asks only for what changed instead of listing the book: 0.3 s instead of 9 s for 3000 records in the CloudKit spike.
 *
 * Kept per remote identity and book, so another remote (another Apple ID's database, a remote made again) never
 * shares one. A file that cannot be read counts as missing, and the book is then listed in full once.
 */
export type KeyIndexEntry = { size: number; lastModified: number };
export type KeyIndexState = { token: string; entries: Record<string, KeyIndexEntry> };
export interface KeyIndexCache {
  read(remoteId: string, bookId: string): Promise<KeyIndexState | undefined>;
  /** Stores a book's index; undefined removes it. */
  write(remoteId: string, bookId: string, state: KeyIndexState | undefined): Promise<void>;
  /** Removes every index of a remote: the account it belongs to changed. */
  forget(remoteId: string): Promise<void>;
}

const safe = /^[A-Za-z0-9-]{1,100}$/;

function readState(value: unknown): KeyIndexState | undefined {
  const state = value as { version?: unknown; token?: unknown; entries?: unknown } | null;
  if (!state || state.version !== 1 || typeof state.token !== 'string' || !state.entries || typeof state.entries !== 'object') return undefined;
  const entries: Record<string, KeyIndexEntry> = {};
  for (const [key, entry] of Object.entries(state.entries as Record<string, Partial<KeyIndexEntry>>)) {
    if (!entry || !Number.isFinite(entry.size) || !Number.isFinite(entry.lastModified)) return undefined;
    entries[key] = { size: entry.size!, lastModified: entry.lastModified! };
  }
  return { token: state.token, entries };
}

/** The indexes in a folder (`<userData>/Sync Cache` in the app): `<remoteId>/<bookId>.keys.json`, beside the header cache. */
export class FileKeyIndexCache implements KeyIndexCache {
  constructor(readonly folder: string) {}
  private file(remoteId: string, bookId: string) {
    return safe.test(remoteId) && safe.test(bookId) ? join(this.folder, remoteId, bookId + '.keys.json') : undefined;
  }
  async read(remoteId: string, bookId: string) {
    const file = this.file(remoteId, bookId);
    if (!file) return undefined;
    try { return readState(JSON.parse(await readFile(file, 'utf8'))); }
    catch { return undefined; }
  }
  async write(remoteId: string, bookId: string, state: KeyIndexState | undefined) {
    const file = this.file(remoteId, bookId);
    if (!file) return;
    if (!state) { await rm(file, { force: true }); return; }
    const folder = join(this.folder, remoteId);
    await mkdir(folder, { recursive: true });
    const staging = join(folder, '.' + randomUUID() + '.tmp');
    try {
      const handle = await open(staging, 'wx', 0o644);
      try { await handle.writeFile(JSON.stringify({ version: 1, ...state })); } finally { await handle.close(); }
      await rename(staging, file);
    } finally { await rm(staging, { force: true }); }
  }
  async forget(remoteId: string) {
    if (!safe.test(remoteId)) return;
    const folder = join(this.folder, remoteId);
    // Only the indexes: the commit headers kept beside them are immutable and stay valid for that remote.
    const names = await readdir(folder).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => name.endsWith('.keys.json')).map((name) => rm(join(folder, name), { force: true })));
  }
}

/** The indexes in memory, for tests. */
export class MemoryKeyIndexCache implements KeyIndexCache {
  readonly books = new Map<string, KeyIndexState>();
  async read(remoteId: string, bookId: string) { const state = this.books.get(remoteId + '/' + bookId); return state && structuredClone(state); }
  async write(remoteId: string, bookId: string, state: KeyIndexState | undefined) {
    if (state) this.books.set(remoteId + '/' + bookId, structuredClone(state)); else this.books.delete(remoteId + '/' + bookId);
  }
  async forget(remoteId: string) { for (const key of [...this.books.keys()]) if (key.startsWith(remoteId + '/')) this.books.delete(key); }
}
