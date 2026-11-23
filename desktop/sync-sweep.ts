import { createHash } from 'node:crypto';
import { contentBlobKey, coverBlobKey, deriveTips, NewerSyncFormatError, originalBlobKey, proxyBlobKey, stateBlobSchema, tombstoneKey } from '../src/sync-snapshot';
import { remoteCommits, sweepableKey } from './sync-remote';
import type { RemoteUsage, SyncRemote } from './sync-remote';
import type { StoreEntry } from './sync-store';

/**
 * Storage figures and Clean Up (ADR 0012, sections 4 and 5; #285).
 *
 * Commit headers and everything under `content/` stay for good: they are small, and a three-way merge needs the common
 * ancestor's state and content. What Clean Up deletes are originals, previews and covers that no tip of the book names
 * (neither its state blob nor its header's `coverDigest`), once they are older than a grace period by the store's time
 * of last change, so a Mac in the middle of a push, which uploads blobs before its commit, loses nothing. Of a book
 * deleted from sync it deletes everything but the tombstone (only a bucket has such remains: iCloud deletes the zone).
 *
 * The grace period does not protect a blob that a push reuses instead of uploading (a photo removed long ago and added
 * again), so Clean Up reads the tips again right before it deletes and keeps whatever they name by then. What is lost in
 * the window that remains is repaired: a Mac that has the original uploads it again at its next sync (`pendingUploads`
 * derives what the remote lacks), and a later push or pull fetches or sends a preview again.
 */

/** How old an unreferenced blob must be before Clean Up deletes it: a week. */
export const cleanUpGraceMs = 7 * 24 * 60 * 60 * 1000;

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** What Clean Up would delete of a book, and what that frees. `deleted`: a book deleted from sync, emptied to its tombstone. */
export type CleanUpBook = { bookId: string; blobs: { key: string; size: number }[]; bytes: number; deleted?: true };
export type CleanUpPlan = { books: CleanUpBook[]; bytes: number; objects: number; remoteId?: string;
  /** Books left alone because what their tips name could not be read (a snapshot missing or from a newer version). */
  skipped: number };

/**
 * The blobs the tips of a book name: their originals and previews, from each tip's state blob, and their covers. Undefined
 * when that cannot be told (no commits, a snapshot that is missing, damaged or from a newer version): Clean Up then
 * leaves the book alone rather than delete what a tip might name.
 */
export async function referencedBlobs(remote: SyncRemote, bookId: string): Promise<Set<string> | undefined> {
  let commits;
  try { commits = await remoteCommits(remote, bookId); }
  catch (error) { if (error instanceof NewerSyncFormatError) return undefined; throw error; }
  const tips = deriveTips(commits);
  if (!tips.length) return undefined;
  const keys = new Set<string>();
  for (const tip of tips) {
    if (tip.coverDigest) keys.add(coverBlobKey(bookId, tip.coverDigest));
    const bytes = await remote.getBlob(contentBlobKey(bookId, tip.stateDigest));
    if (!bytes || sha(bytes) !== tip.stateDigest) return undefined;
    let parsed;
    try { parsed = stateBlobSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { return undefined; }
    if (!parsed.success) return undefined;
    for (const original of Object.values(parsed.data.originals)) keys.add(originalBlobKey(bookId, original.digest, original.ext));
    for (const [digest, proxy] of Object.entries(parsed.data.proxies)) keys.add(proxyBlobKey(bookId, digest, proxy.ext));
  }
  return keys;
}

/** The blobs of a listing that Clean Up may delete: sweepable, not referenced, and older than the grace period. */
const unreferenced = (entries: readonly StoreEntry[], referenced: ReadonlySet<string>, now: Date) =>
  entries.filter(({ key, lastModified }) => sweepableKey.test(key) && !referenced.has(key) && now.getTime() - lastModified.getTime() >= cleanUpGraceMs);

/**
 * What Clean Up would delete, book by book, without deleting anything: shown before the user confirms. Each book is
 * listed in the store itself (`full`), never from a key index, since the listing decides what is deleted.
 */
export async function planCleanUp(remote: SyncRemote, now = new Date()): Promise<CleanUpPlan> {
  const books: CleanUpBook[] = [];
  let skipped = 0;
  for (const { bookId, deleted, newer } of await remote.listBooks()) {
    if (newer) { skipped++; continue; }
    const entries = await remote.listBook(bookId, undefined, { full: true });
    let doomed: StoreEntry[];
    if (deleted) doomed = entries.filter(({ key }) => key !== tombstoneKey(bookId));
    else {
      const referenced = await referencedBlobs(remote, bookId);
      if (!referenced) { skipped++; continue; }
      doomed = unreferenced(entries, referenced, now);
    }
    if (doomed.length) books.push({ bookId, blobs: doomed.map(({ key, size }) => ({ key, size })), bytes: doomed.reduce((sum, { size }) => sum + size, 0), ...(deleted ? { deleted: true as const } : {}) });
  }
  return { books, bytes: books.reduce((sum, book) => sum + book.bytes, 0), objects: books.reduce((sum, book) => sum + book.blobs.length, 0), skipped };
}

/**
 * Deletes what a plan found (`planCleanUp`). For a book that is not deleted, the tips are read again right before, and
 * whatever they name by now stays; a book whose tips cannot be read then is left alone. Of a deleted book, only what
 * the plan listed goes (never its tombstone). Returns what was freed.
 */
export async function cleanUp(remote: SyncRemote, plan: CleanUpPlan): Promise<{ bytes: number; objects: number }> {
  let bytes = 0, objects = 0;
  for (const book of plan.books) {
    if (book.deleted) {
      // Everything under the prefix but the tombstone, also what arrived since the plan: nothing of a deleted book is used.
      const removed = await remote.deleteRemains(book.bookId);
      objects += removed.objects;
      bytes += removed.bytes;
      continue;
    }
    const referenced = await referencedBlobs(remote, book.bookId);
    if (!referenced) continue;
    const blobs = book.blobs.filter(({ key }) => !referenced.has(key));
    if (!blobs.length) continue;
    await remote.deleteBlobs(blobs.map(({ key }) => key));
    objects += blobs.length;
    bytes += blobs.reduce((sum, { size }) => sum + size, 0);
  }
  return { bytes, objects };
}

/** A book as Settings → Sync lists it: its title where its tips give one, what it stores, and the part that is originals. */
export type StorageBook = { bookId: string; title: string; bytes: number; originals: number; deleted?: true };
export type StorageReport = { bytes: number; originals: number; books: StorageBook[] };

/**
 * The storage figures of Settings → Sync, computed on demand: `SyncRemote.usage` with each book's title from its newest
 * tip, largest book first. A book whose title cannot be read is listed by its ID.
 */
export async function storageReport(remote: SyncRemote, usage?: RemoteUsage): Promise<StorageReport> {
  const counted = usage ?? await remote.usage();
  const books: StorageBook[] = [];
  for (const book of counted.books) {
    let title = '';
    if (!book.deleted) {
      try { title = deriveTips(await remoteCommits(remote, book.bookId)).at(-1)?.title ?? ''; } catch { /* listed without a title */ }
    }
    books.push({ ...book, title });
  }
  books.sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title));
  return { bytes: counted.bytes, originals: counted.originals, books };
}
