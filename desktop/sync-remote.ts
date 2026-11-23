import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/canonical-json';
import { blobKeyPattern, bookIdOfDeletedMarker, bookIdOfPrefix, bookPrefix, booksPrefix, bookTombstoneSchema, commitHeaderSchema, commitKey, deletedMarkerKey, deletedPrefix, deriveTips,
  NewerSyncFormatError, readBookTombstone, readCommitHeader, readRemoteIdentity, remoteIdentityKey, remoteIdentitySchema, snapshotsPrefix, tombstoneKey } from '../src/sync-snapshot';
import type { BookTombstone, CommitHeader } from '../src/sync-snapshot';
import { entryTag } from './sync-header-cache';
import type { CachedHeader, CommitHeaderCache } from './sync-header-cache';
import type { KeyIndexCache } from './sync-key-index';
import { ChangeTokenExpiredError, MemoryStore } from './sync-store';
import type { PutOptions, StoreEntry, StoreSource, SyncStore, TransferOptions } from './sync-store';

/** The parts of a book's prefix (ADR 0012, section 4). */
export type BookFolder = 'snapshots' | 'content' | 'originals' | 'proxies' | 'covers';
/** A book on a remote: there, or deleted from sync (its tombstone), or marked by a newer ImageFlow in a way this one cannot read. */
export type RemoteBook = { bookId: string; deleted?: BookTombstone; newer?: true };

/**
 * A book that was deleted from sync (its tombstone, ADR 0012, section 4): nothing is pushed for it, and a Mac that still
 * has it asks whether to keep it here only or sync it again as a new book.
 */
export class BookDeletedError extends Error {
  readonly code = 'SYNC_DELETED';
  constructor(readonly tombstone?: BookTombstone) {
    super('This book was deleted from sync on another Mac, so it was not synced. Keep it on this Mac only, or sync it again as a new book.');
    this.name = 'BookDeletedError';
  }
}

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
  /**
   * What a book stores, with sizes and times of last change: everything under its prefix, or one part of it. Over a
   * store with a change feed this comes from the key index; `full` lists the store itself, for what deletes on the
   * strength of a listing (Clean Up).
   */
  listBook(bookId: string, folder?: BookFolder, options?: { full?: boolean }): Promise<StoreEntry[]>;
  /**
   * What the books on this remote store, in bytes, per book and in all (Settings → Sync; #292). Deleted books count
   * only what is left of them. Over a store with a change feed it comes from the key indexes.
   */
  usage(): Promise<{ bytes: number; books: { bookId: string; bytes: number }[] }>;
  /**
   * The books on this remote, from one listing of prefixes and one of the deletion markers (`deletedPrefix`); only the
   * tombstones of books deleted from sync are read. A deleted book is reported as such.
   */
  listBooks(): Promise<RemoteBook[]>;
  /**
   * Starts a sync of a book; the function it returns ends it. Over a store without a change feed, the first listing the
   * sync needs (its commits) lists the whole book once, and that one listing answers the sync's other questions
   * (`hasBlob`, the book's originals) until the sync ends, so nothing is listed twice and no blob is asked about with a
   * request of its own. Over a store with a feed the key index answers already, and this does nothing. Optional.
   */
  prepareSync?(bookId: string): Promise<() => void>;
  /** The remote's identity, a UUID written at first use. Two Macs that initialize an empty remote at once agree on it. */
  remoteId(): Promise<string>;
  /**
   * The tombstone of a book deleted from sync, or undefined. Throws `NewerSyncFormatError` for one a newer version wrote.
   * Asked right after the book's commits were listed (a sync, a status), it is answered from that listing where it
   * says: the one listing of a sync over a bucket, which holds `deleted.json` when there is one, or the key index the
   * change feed just brought up to date, which has commits only while the book is not deleted (deleting it removes its
   * commits first). Otherwise, and with `fresh`, the store is asked.
   */
  bookTombstone(bookId: string, options?: { fresh?: boolean }): Promise<BookTombstone | undefined>;
  /**
   * Deletes a book from the remote for every Mac: writes its marker and then its tombstone, then removes everything else
   * under its prefix. From the start, this remote refuses to store anything more for the book (`BookDeletedError`), so
   * an upload that was under way does not bring it back.
   */
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
  /**
   * `headerCache` keeps the commit headers read, per remote and book, so `listCommits` fetches only new ones.
   * `keyIndex` keeps the key index of each book over a store with a change feed, so it outlives the app.
   */
  constructor(readonly store: Store, private readonly options: { headerCache?: CommitHeaderCache; keyIndex?: KeyIndexCache;
    /** Runs before each commit is stored and refuses it by throwing: the iCloud remote checks that the account is still its own. */
    beforeCommit?: () => Promise<void> } = {}) {}
  private identity?: string;
  /** Books this remote deleted: it stores nothing more for them, so nothing under way puts their prefix (an iCloud zone) back. */
  private readonly deleted = new Set<string>();
  private refuseDeleted(key: string) {
    const bookId = key.split('/')[1];
    if (key.startsWith(booksPrefix) && this.deleted.has(bookId)) throw new BookDeletedError();
  }
  /** The key indexes read or kept up to date while this remote is used, by remote identity and book. */
  private readonly indexes = new Map<string, { token?: string; entries: Map<string, StoreEntry> }>();
  private readonly indexing = new Map<string, Promise<StoreEntry[]>>();
  /** When the key index of each book was last brought up to date from the change feed. */
  private readonly refreshed = new Map<string, number>();
  /** Books this remote asked about and found without a tombstone, while nothing changed in them since (see `bookTombstone`). */
  private readonly confirmed = new Set<string>();

  /**
   * Every key of a book but its tombstone. Over a store with a change feed (#292): the key index, brought up to date
   * with what changed since its token, and made again from a full listing when there is none or the store no longer
   * accepts it. A book the store holds nothing for (its zone deleted on the server) has no keys and its index goes.
   */
  private async bookKeys(bookId: string): Promise<StoreEntry[]> {
    const changes = this.store.changes?.bind(this.store);
    if (!changes) return (await this.store.list(bookPrefix(bookId))).filter(({ key }) => key !== tombstoneKey(bookId));
    const remoteId = await this.knownRemoteId();
    const slot = (remoteId ?? '') + '/' + bookId;
    // One refresh at a time per book; callers that come while it runs wait for the next one.
    const previous = this.indexing.get(slot) ?? Promise.resolve([]);
    const refresh = previous.catch(() => []).then(async () => {
      let index = this.indexes.get(slot);
      if (!index && remoteId) {
        const kept = await this.options.keyIndex?.read(remoteId, bookId).catch(() => undefined);
        if (kept) index = { token: kept.token, entries: new Map(Object.entries(kept.entries).map(([key, { size, lastModified }]) => [key, { key, size, lastModified: new Date(lastModified) }])) };
      }
      const result = await changes(bookId, index?.token).catch(async (error) => {
        if (!(error instanceof ChangeTokenExpiredError)) throw error;
        index = undefined;
        return changes(bookId);
      });
      if (!result) {
        this.indexes.delete(slot);
        if (remoteId) await this.options.keyIndex?.write(remoteId, bookId, undefined).catch(() => {});
        return [];
      }
      // Changes this Mac did not make itself (another Mac's push or deletion; its own writes are in the index already)
      // make the tombstone be asked again (`bookTombstone`).
      const known = index?.entries;
      if (!index?.token || result.deleted.some((key) => known?.has(key)) || result.changed.some((entry) => !known?.has(entry.key))) this.confirmed.delete(slot);
      // Without a token the answer is everything: it replaces the index.
      const entries = index?.token ? new Map(index.entries) : new Map<string, StoreEntry>();
      for (const key of result.deleted) entries.delete(key);
      for (const entry of result.changed) entries.set(entry.key, entry);
      this.indexes.set(slot, { token: result.token, entries });
      this.refreshed.set(slot, Date.now());
      if (remoteId) {
        await this.options.keyIndex?.write(remoteId, bookId, { token: result.token, entries: Object.fromEntries([...entries.values()].map(({ key, size, lastModified }) => [key, { size, lastModified: lastModified.getTime() }])) })
          .catch((error) => console.warn('ImageFlow could not keep the keys it read', error));
      }
      return [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    });
    this.indexing.set(slot, refresh);
    try { return await refresh; }
    finally { if (this.indexing.get(slot) === refresh) this.indexing.delete(slot); }
  }
  /** The key index of a book as last read, without asking the store; undefined where there is none. */
  private indexOf(key: string) {
    const bookId = key.split('/')[1];
    return this.indexes.get((this.identity ?? '') + '/' + bookId);
  }
  /**
   * The syncs running over a store without a change feed, by book: the listing of the whole book each takes at its
   * first need, which lives only as long as the sync (`prepareSync`), so nothing later acts on what it found.
   */
  private readonly sessions = new Map<string, { count: number; listing?: Promise<Map<string, StoreEntry>> }>();
  /** The listing of a book for the sync running, taken now if it was not yet; undefined outside a sync. */
  private sessionListing(bookId: string) {
    const session = this.sessions.get(bookId);
    if (!session) return undefined;
    const listing = session.listing ??= this.store.list(bookPrefix(bookId)).then((entries) => new Map(entries.map((entry) => [entry.key, entry])));
    // A listing that failed is not kept: the next question lists again.
    listing.catch(() => { if (session.listing === listing) session.listing = undefined; });
    return listing;
  }
  /** Notes an object this remote stored, so a check later in the same sync needs no request. */
  private noteStored(key: string, size: number) {
    const entry = { key, size, lastModified: new Date() };
    const index = this.indexOf(key);
    if (index && !index.entries.has(key)) index.entries.set(key, entry);
    void this.sessions.get(key.split('/')[1])?.listing?.then((listed) => { if (!listed.has(key)) listed.set(key, entry); }, () => {});
  }

  /** A small JSON object as stored, or undefined for one that is missing or not whole JSON. */
  private async json(key: string): Promise<unknown> {
    const bytes = await this.store.get(key);
    if (!bytes) return undefined;
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
  }

  async putCommit(header: CommitHeader) {
    const parsed = commitHeaderSchema.parse(header);
    this.refuseDeleted(commitKey(parsed.bookId, parsed.commitId));
    await this.options.beforeCommit?.();
    const bytes = encode(parsed);
    const { existed } = await this.store.putIfAbsent(commitKey(parsed.bookId, parsed.commitId), bytes);
    if (!existed) { this.noteStored(commitKey(parsed.bookId, parsed.commitId), bytes.length); return; }
    const existing = await this.getCommit(parsed.bookId, parsed.commitId);
    if (existing === undefined || canonicalJson(existing) !== canonicalJson(parsed)) throw new Error('A different commit with this ID exists.');
  }
  async getCommit(bookId: string, commitId: string) {
    return this.json(commitKey(bookId, commitId));
  }
  async listCommits(bookId: string) {
    // Anything a sync service put beside the headers (its conflict copy `<id> (1).json` holds an immutable header too)
    // is read like one; the engine decides what it is.
    const prefix = snapshotsPrefix(bookId);
    const session = this.store.changes ? undefined : this.sessionListing(bookId);
    const listed = (this.store.changes ? (await this.bookKeys(bookId)).filter(({ key }) => key.startsWith(prefix))
      : session ? [...(await session).values()].filter(({ key }) => key.startsWith(prefix)) : await this.store.list(prefix))
      .filter(({ key }) => key.endsWith('.json'));
    const cache = this.options.headerCache;
    // Cached by the remote's identity; a remote without one yet is read whole, and none is written by reading.
    const remoteId = cache && listed.length ? await this.knownRemoteId() : undefined;
    const cached = remoteId ? await cache!.read(remoteId, bookId).catch(() => new Map<string, CachedHeader>()) : new Map<string, CachedHeader>();
    const values: unknown[] = new Array(listed.length);
    const missing = listed.flatMap((entry, index) => {
      const hit = cached.get(entry.key);
      if (hit && hit.tag === entryTag(entry)) { values[index] = hit.value; return []; }
      return [index];
    });
    // A few at a time: over a bucket each is a request.
    for (let start = 0; start < missing.length; start += 8) {
      await Promise.all(missing.slice(start, start + 8).map(async (index) => { values[index] = await this.json(listed[index].key); }));
    }
    if (remoteId && (missing.length || cached.size !== listed.length)) {
      const entries = new Map(listed.flatMap((entry, index) => (values[index] === undefined ? [] : [[entry.key, { tag: entryTag(entry), value: values[index] }] as const])));
      await cache!.write(remoteId, bookId, entries).catch((error) => console.warn('ImageFlow could not keep the commits it read', error));
    }
    return values.filter((value) => value !== undefined);
  }
  /** The identity this remote last read, without asking the store; undefined before the first read. */
  async knownIdentity() { return this.identity; }
  /** The remote's identity if it has one, without writing it. */
  private async knownRemoteId() {
    this.identity ??= readRemoteIdentity(await this.json(remoteIdentityKey))?.remoteId;
    return this.identity;
  }

  async hasBlob(key: string) {
    // Blobs are immutable and only Clean Up or deleting the book removes them: one the key index has is there (over a
    // store without a change feed, one the last listing of the book had). One it lacks may have arrived since, so the
    // store is asked.
    if (this.indexOf(requireBlobKey(key))?.entries.has(key)) return true;
    if (await this.sessionListing(key.split('/')[1])?.then((listed) => listed.has(key), () => false)) return true;
    return !!await this.store.head(key);
  }
  async putBlob(key: string, source: StoreSource, options?: PutOptions) {
    this.refuseDeleted(requireBlobKey(key));
    let size = 0;
    await this.store.putIfAbsent(requireBlobKey(key), source, { ...options, onProgress: (done, total) => { size = total ?? done; options?.onProgress?.(done, total); } });
    this.noteStored(key, size);
  }
  async getBlob(key: string) { return this.store.get(requireBlobKey(key)); }
  async downloadBlob(key: string, destination: string, options?: TransferOptions) { return this.store.download(requireBlobKey(key), destination, options); }
  async copyBlob(from: string, to: string) {
    // Only the book may differ: the same part, digest and extension, so a copy can never put other bytes under a key.
    if (blobName(requireBlobKey(from)) !== blobName(requireBlobKey(to))) throw new Error('A sync blob is only copied to its own key in another book: ' + from + ' to ' + to);
    // Blobs are immutable: one that is there already is left alone, and is what the copy would have been.
    if (await this.hasBlob(to)) return true;
    this.refuseDeleted(to);
    return await this.store.copy?.(from, to) ?? false;
  }

  async listBook(bookId: string, folder?: BookFolder, { full = false }: { full?: boolean } = {}) {
    const prefix = bookPrefix(bookId) + (folder ? folder + '/' : '');
    if (full || !this.store.changes) {
      // Within a sync, from its one listing of the book.
      const session = full ? undefined : this.sessionListing(bookId);
      if (session) return [...(await session).values()].filter(({ key }) => key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return this.store.list(prefix);
    }
    const entries = (await this.bookKeys(bookId)).filter(({ key }) => key.startsWith(prefix));
    // The feed leaves the tombstone out (it outlives the book's objects); a listing of the whole book has it.
    const tombstone = folder ? undefined : await this.store.head(tombstoneKey(bookId));
    return tombstone ? [...entries, { key: tombstoneKey(bookId), ...tombstone }].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) : entries;
  }
  async prepareSync(bookId: string) {
    // Over a change feed the key index is brought up to date when the commits are listed, and answers `hasBlob`.
    if (this.store.changes) return () => {};
    const session = this.sessions.get(bookId) ?? { count: 0 };
    session.count++;
    this.sessions.set(bookId, session);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--session.count === 0 && this.sessions.get(bookId) === session) this.sessions.delete(bookId);
    };
  }
  async usage() {
    const books: { bookId: string; bytes: number }[] = [];
    const ids = (await this.listBooks()).map(({ bookId }) => bookId);
    // A few books at a time: over a store without a feed, or without an index yet, each is a full listing.
    for (let start = 0; start < ids.length; start += 4) {
      books.push(...await Promise.all(ids.slice(start, start + 4).map(async (bookId) =>
        ({ bookId, bytes: (await this.listBook(bookId)).reduce((sum, { size }) => sum + size, 0) }))));
    }
    return { bytes: books.reduce((sum, book) => sum + book.bytes, 0), books };
  }
  async listBooks() {
    const [prefixes, markers] = await Promise.all([this.store.listPrefixes(booksPrefix), this.store.list(deletedPrefix)]);
    const ids = prefixes.map(bookIdOfPrefix).filter((id) => id !== undefined);
    // Only books with a marker can be deleted: their tombstones are read, and no other book costs a request.
    const marked = new Set(markers.map(({ key }) => bookIdOfDeletedMarker(key)).filter((id) => id !== undefined));
    return Promise.all(ids.map(async (bookId): Promise<RemoteBook> => {
      if (!marked.has(bookId)) return { bookId };
      try {
        const deleted = await this.bookTombstone(bookId, { fresh: true });
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
    if (found) return this.identity = found;
    // Always read back and adopt what is there: whichever Mac wrote first wins, also where the store cannot say
    // reliably whether the object existed.
    await this.store.putIfAbsent(remoteIdentityKey, encode(remoteIdentitySchema.parse({ version: 1, remoteId: randomUUID() })));
    const adopted = await read();
    if (!adopted) throw new Error('The identity of the sync remote (' + remoteIdentityKey + ') cannot be read.');
    return this.identity = adopted;
  }

  async bookTombstone(bookId: string, { fresh = false }: { fresh?: boolean } = {}) {
    if (!fresh && !await this.mayHaveTombstone(bookId)) return undefined;
    const tombstone = readBookTombstone(await this.json(tombstoneKey(bookId)));
    const found = tombstone?.bookId === bookId ? tombstone : undefined;
    if (!found && this.store.changes) this.confirmed.add((this.identity ?? '') + '/' + bookId);
    return found;
  }
  /**
   * False when a listing just taken says the book has no tombstone, so no request is needed (see `bookTombstone`):
   * - over a store without a feed, the listing of the sync running, which holds `deleted.json` when there is one;
   * - over a store with a feed (iCloud, whose tombstones live apart from the book), a key index brought up to date in
   *   the last few seconds that holds commits, of a book this remote found without a tombstone before while nothing
   *   in it changed since. Deleting a book removes its commits before it writes the tombstone, so a deletion always
   *   shows in the feed.
   * True when the store has to be asked.
   */
  private async mayHaveTombstone(bookId: string) {
    const session = this.sessions.get(bookId)?.listing;
    if (session) {
      const listed = await session.catch(() => undefined);
      return !listed || listed.has(tombstoneKey(bookId));
    }
    if (!this.store.changes) return true;
    const slot = (this.identity ?? '') + '/' + bookId;
    const index = this.indexes.get(slot);
    const recent = Date.now() - (this.refreshed.get(slot) ?? 0) < 5000;
    return !index || !recent || !this.confirmed.has(slot) || ![...index.entries.keys()].some((key) => key.startsWith(snapshotsPrefix(bookId)));
  }
  async deleteBook(bookId: string, now = new Date()) {
    const key = tombstoneKey(bookId);
    this.deleted.add(bookId);
    const record = encode(bookTombstoneSchema.parse({ version: 1, bookId, deletedAt: now.toISOString() }));
    // The marker goes first: a marker without a tombstone reads as a book that is not deleted, and a tombstone then
    // always has its marker, so a deletion that stops between the two is never half visible. Deleting again finishes it.
    await this.store.putIfAbsent(deletedMarkerKey(bookId), record);
    // Then its commits, so the book stops reading as one with a history (and the change feed shows the deletion),
    // then the tombstone, so a deletion interrupted after it still reads as one; an earlier tombstone is kept.
    const commits = (await this.store.list(snapshotsPrefix(bookId))).map((entry) => entry.key);
    if (!await this.store.head(key)) await this.store.delete(commits);
    await this.store.putIfAbsent(key, record);
    const tombstone = await this.bookTombstone(bookId, { fresh: true });
    if (!tombstone) throw new Error('The book could not be marked as deleted on the remote.');
    await this.store.delete((await this.store.list(bookPrefix(bookId))).map((entry) => entry.key).filter((other) => other !== key));
    this.indexes.delete((this.identity ?? '') + '/' + bookId);
    if (this.identity) await this.options.keyIndex?.write(this.identity, bookId, undefined).catch(() => {});
    return tombstone;
  }
}

/** A remote held in memory, for tests. */
export const memoryRemote = () => new StoreRemote(new MemoryStore());
