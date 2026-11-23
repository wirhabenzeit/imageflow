import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/canonical-json';
import { blobKeyPattern, bookIdOfPrefix, bookPrefix, booksPrefix, bookTombstoneSchema, commitHeaderSchema, commitKey, deriveTips, NewerSyncFormatError, readBookTombstone,
  readCommitHeader, readRemoteIdentity, remoteIdentityKey, remoteIdentitySchema, snapshotsPrefix, tombstoneKey } from '../src/sync-snapshot';
import type { BookTombstone, CommitHeader } from '../src/sync-snapshot';
import { MemoryStore } from './sync-store';
import type { PutOptions, StoreEntry, StoreSource, SyncStore, TransferOptions } from './sync-store';

/** The parts of a book's prefix (ADR 0012, section 4). */
export type BookFolder = 'snapshots' | 'content' | 'originals' | 'proxies' | 'covers';
/** A book on a remote: there, or deleted from sync (its tombstone), or marked by a newer ImageFlow in a way this one cannot read. */
export type RemoteBook = { bookId: string; deleted?: BookTombstone; newer?: true };

/**
 * The storage books sync through (ADR 0010, Milestone 1; ADR 0012): immutable commit headers and immutable
 * content-addressed blobs, each book under its own prefix, plus the remote's identity and the tombstones of deleted
 * books. Heads are derived from the headers (`remoteTips`), so two Macs pushing at once produce two tips instead of a
 * torn head file. `StoreRemote` implements it over any object store; the sync engine never trusts what it returns and
 * verifies every digest itself.
 */
export interface SyncRemote {
  /** Stores a commit header. Headers are immutable: storing one whose ID exists is an error unless it is identical. */
  putCommit(header: CommitHeader): Promise<void>;
  /** A commit header as stored (parsed JSON), or undefined. The engine validates it (`readCommitHeader`). */
  getCommit(bookId: string, commitId: string): Promise<unknown>;
  /** Every commit header of a book as stored (parsed JSON). Objects that are not whole JSON are left out; anything
   * else is returned, so the engine can tell a header a newer version wrote from one that is damaged. */
  listCommits(bookId: string): Promise<unknown[]>;
  hasBlob(key: string): Promise<boolean>;
  /** Stores a blob under a key of `blobKeyPattern`, from bytes or a local file. An existing blob is kept. */
  putBlob(key: string, source: StoreSource, options?: PutOptions): Promise<void>;
  /** A whole blob, or undefined when the remote does not have it (yet). For small blobs. */
  getBlob(key: string): Promise<Uint8Array | undefined>;
  /** Writes a blob to a new local file at `destination`; false when the remote does not have it (yet). For large blobs. */
  downloadBlob(key: string, destination: string, options?: TransferOptions): Promise<boolean>;
  /** Copies a blob to its key in another book inside the remote (a duplicated book's originals), without uploading it
   * again; a blob already there is kept. Both keys name the same blob (part, digest and extension);
   * false when the remote does not have it or its store cannot copy, and the caller then uploads the blob. */
  copyBlob(from: string, to: string): Promise<boolean>;
  /** What a book stores, with sizes and times of last change: everything under its prefix, or one part of it. */
  listBook(bookId: string, folder?: BookFolder): Promise<StoreEntry[]>;
  /** The books on this remote, from one listing of prefixes. A deleted book is reported as such. */
  listBooks(): Promise<RemoteBook[]>;
  /** The remote's identity, a UUID written at first use. Two Macs that initialize an empty remote at once agree on it. */
  remoteId(): Promise<string>;
  /** The tombstone of a book deleted from sync, or undefined. Throws `NewerSyncFormatError` for one a newer version wrote. */
  bookTombstone(bookId: string): Promise<BookTombstone | undefined>;
  /** Deletes a book from the remote for every Mac: writes its tombstone, then removes everything else under its prefix. */
  deleteBook(bookId: string, now?: Date): Promise<BookTombstone>;
}

/** A book's commits on a remote. Throws `NewerSyncFormatError` for one a newer version wrote. */
export async function remoteCommits(remote: SyncRemote, bookId: string) {
  return (await remote.listCommits(bookId)).map(readCommitHeader).filter((header) => header !== undefined && header.bookId === bookId) as CommitHeader[];
}

export type RemoteBookListing = { bookId: string; tips: CommitHeader[]; title: string; updatedAt: string; newer?: true; deleted?: BookTombstone };

/**
 * The books on a remote with their tips, newest tip first, skipping books whose commits have not arrived yet. A book a
 * newer ImageFlow synced is listed with `newer` and no tips, and a book deleted from sync with `deleted` and no tips
 * (after the others), so neither hides the others.
 */
export async function remoteBooks(remote: SyncRemote) {
  const books: RemoteBookListing[] = [];
  for (const { bookId, deleted, newer } of await remote.listBooks()) {
    if (deleted) { books.push({ bookId, tips: [], title: '', updatedAt: deleted.deletedAt, deleted }); continue; }
    let tips: CommitHeader[] | undefined;
    try { tips = newer ? undefined : await remoteTips(remote, bookId); }
    catch (error) { if (!(error instanceof NewerSyncFormatError)) throw error; }
    if (!tips) { books.push({ bookId, tips: [], title: '', updatedAt: '', newer: true }); continue; }
    const latest = tips.at(-1);
    if (latest) books.push({ bookId, tips, title: latest.title, updatedAt: latest.createdAt });
  }
  const rank = (book: RemoteBookListing) => (book.deleted ? 2 : book.newer ? 1 : 0);
  return books.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
}

/** The tips of a book on a remote: commits that no other commit names as a parent. */
export async function remoteTips(remote: SyncRemote, bookId: string) {
  return deriveTips(await remoteCommits(remote, bookId));
}

export function requireBlobKey(key: string) {
  if (!blobKeyPattern.test(key)) throw new Error('Not a sync blob key: ' + key);
  return key;
}

/** A blob key without its book: `originals/<digest>.jpg`. */
const blobName = (key: string) => key.split('/').slice(2).join('/');
const encode = (value: unknown) => new TextEncoder().encode(canonicalJson(value) + '\n');

/**
 * `SyncRemote` over an object store (ADR 0012, section 2): the one implementation, with the layout of section 4. A
 * transport implements only `SyncStore`.
 */
export class StoreRemote<Store extends SyncStore = SyncStore> implements SyncRemote {
  constructor(readonly store: Store) {}

  /** A small JSON object as stored, or undefined for one that is missing or not whole JSON. */
  private async json(key: string): Promise<unknown> {
    const bytes = await this.store.get(key);
    if (!bytes) return undefined;
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
  }

  async putCommit(header: CommitHeader) {
    const parsed = commitHeaderSchema.parse(header);
    const { existed } = await this.store.putIfAbsent(commitKey(parsed.bookId, parsed.commitId), encode(parsed));
    if (!existed) return;
    const existing = await this.getCommit(parsed.bookId, parsed.commitId);
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(parsed)) throw new Error('A different commit with this ID exists.');
  }
  async getCommit(bookId: string, commitId: string) {
    return this.json(commitKey(bookId, commitId));
  }
  async listCommits(bookId: string) {
    const headers: unknown[] = [];
    // Anything a sync service put beside the headers (its conflict copy `<id> (1).json` holds an immutable header too)
    // is read like one; the engine decides what it is.
    for (const { key } of await this.store.list(snapshotsPrefix(bookId))) {
      const value = key.endsWith('.json') ? await this.json(key) : undefined;
      if (value !== undefined) headers.push(value);
    }
    return headers;
  }

  async hasBlob(key: string) { return !!await this.store.head(requireBlobKey(key)); }
  async putBlob(key: string, source: StoreSource, options?: PutOptions) { await this.store.putIfAbsent(requireBlobKey(key), source, options); }
  async getBlob(key: string) { return this.store.get(requireBlobKey(key)); }
  async downloadBlob(key: string, destination: string, options?: TransferOptions) { return this.store.download(requireBlobKey(key), destination, options); }
  async copyBlob(from: string, to: string) {
    // Only the book may differ: the same part, digest and extension, so a copy can never put other bytes under a key.
    if (blobName(requireBlobKey(from)) !== blobName(requireBlobKey(to))) throw new Error('A sync blob is only copied to its own key in another book: ' + from + ' to ' + to);
    // Blobs are immutable: one that is there already is left alone, and is what the copy would have been.
    if (await this.hasBlob(to)) return true;
    return await this.store.copy?.(from, to) ?? false;
  }

  async listBook(bookId: string, folder?: BookFolder) {
    return this.store.list(bookPrefix(bookId) + (folder ? folder + '/' : ''));
  }
  async listBooks() {
    const ids = (await this.store.listPrefixes(booksPrefix)).map(bookIdOfPrefix).filter((id) => id !== undefined);
    return Promise.all(ids.map(async (bookId): Promise<RemoteBook> => {
      try {
        const deleted = await this.bookTombstone(bookId);
        return deleted ? { bookId, deleted } : { bookId };
      } catch (error) {
        if (!(error instanceof NewerSyncFormatError)) throw error;
        return { bookId, newer: true };
      }
    }));
  }

  async remoteId() {
    const read = async () => readRemoteIdentity(await this.json(remoteIdentityKey))?.remoteId;
    const found = await read();
    if (found) return found;
    // Always read back and adopt what is there: whichever Mac wrote first wins, also where the store cannot say
    // reliably whether the object existed.
    await this.store.putIfAbsent(remoteIdentityKey, encode(remoteIdentitySchema.parse({ version: 1, remoteId: randomUUID() })));
    const adopted = await read();
    if (!adopted) throw new Error('The identity of the sync remote (' + remoteIdentityKey + ') cannot be read.');
    return adopted;
  }

  async bookTombstone(bookId: string) {
    const tombstone = readBookTombstone(await this.json(tombstoneKey(bookId)));
    return tombstone?.bookId === bookId ? tombstone : undefined;
  }
  async deleteBook(bookId: string, now = new Date()) {
    const key = tombstoneKey(bookId);
    // The tombstone goes first, so a deletion that is interrupted still reads as one; an earlier tombstone is kept.
    await this.store.putIfAbsent(key, encode(bookTombstoneSchema.parse({ version: 1, bookId, deletedAt: now.toISOString() })));
    const tombstone = await this.bookTombstone(bookId);
    if (!tombstone) throw new Error('The book could not be marked as deleted on the remote.');
    await this.store.delete((await this.store.list(bookPrefix(bookId))).map((entry) => entry.key).filter((other) => other !== key));
    return tombstone;
  }
}

/** A remote held in memory, for tests. */
export const memoryRemote = () => new StoreRemote(new MemoryStore());
