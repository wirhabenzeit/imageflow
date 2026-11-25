import { createHash } from 'node:crypto';
import { contentBlobKey, coverBlobKey, deriveTips, NewerSyncFormatError, originalBlobKey, proxyBlobKey, stateBlobSchema, tombstoneKey } from '../src/sync-snapshot';
import type { CommitHeader } from '../src/sync-snapshot';
import type { SyncCleanUpPlan, UnusedStorage } from '../src/desktop';
import { cleanUpText } from '../src/sync-storage-text';
import { remoteCommits, sweepableKey } from './sync-remote';
import type { SyncRemote } from './sync-remote';
import type { StoreEntry } from './sync-store';

/**
 * Storage figures and Clean Up (ADR 0012, sections 4 and 5; #285).
 *
 * Commit headers and everything under `content/` stay for good: they are small, and a three-way merge needs the common
 * ancestor's state and content. What Clean Up deletes are originals, previews and covers that the book has not used for
 * a grace period (`keptBlobs`): no tip names them, and no commit made within the period dropped them. A Mac that has not
 * pulled the removal yet still has the photo's file; after a week every Mac that syncs has had the chance to keep it.
 * A blob is also kept while it is younger than the period by the store's time of last change, so a Mac in the middle of
 * a push, which uploads blobs before its commit, loses nothing; and while another book's tip names the same original
 * without having it yet (a copy still copying it from the book it was made from). Of a book deleted from sync it
 * deletes everything but the tombstone (only a bucket has such remains: iCloud deletes the zone).
 *
 * The grace period does not protect a blob that a push reuses instead of uploading (a photo removed long ago and added
 * again), so Clean Up reads the book's commits again right before it deletes and keeps whatever they keep by then. What
 * is lost in the window that remains is repaired: a Mac that has the original uploads it again at its next sync
 * (`pendingUploads` derives what the remote lacks), and a Mac that has the preview uploads it again at its next sync
 * (a push checks the previews it carries forward, a sync with nothing to push the previews of its snapshot).
 */

/** How long Clean Up keeps a blob the book no longer uses, and one just uploaded: a week. */
export const cleanUpGraceMs = 7 * 24 * 60 * 60 * 1000;

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** What Clean Up would delete of a book, and what that frees. `deleted`: a book deleted from sync, emptied to its tombstone. */
export type CleanUpBook = { bookId: string; blobs: { key: string; size: number }[]; bytes: number; deleted?: true };
export type CleanUpPlan = { books: CleanUpBook[]; bytes: number; objects: number; remoteId?: string;
  /** Books left alone because what their tips name could not be read (a snapshot missing or from a newer version). */
  skipped: number;
  /** Originals (`originals/<digest><ext>`) a book's tip names that the book does not have yet: kept in every book. */
  wanted: string[] };

/** A blob key without its book: `originals/<digest>.jpg`. */
const blobName = (key: string) => key.split('/').slice(2).join('/');

/**
 * The blobs Clean Up keeps of a book: what its tips name, and what the commits that removed something within the grace
 * period still named (the parents of every commit made since `now - cleanUpGraceMs`), so the week counts from the
 * removal, not from the upload. Their originals, previews and covers. Undefined when that cannot be told (no commits, a
 * snapshot that is missing, damaged or from a newer version): Clean Up then leaves the book alone rather than delete what
 * a commit might name.
 */
export async function keptBlobs(remote: SyncRemote, bookId: string, now = new Date()): Promise<{ keys: Set<string>; originals: Set<string> } | undefined> {
  let commits: CommitHeader[];
  try { commits = await remoteCommits(remote, bookId); }
  catch (error) { if (error instanceof NewerSyncFormatError) return undefined; throw error; }
  const tips = deriveTips(commits);
  if (!tips.length) return undefined;
  const recent = new Set(commits.filter(({ createdAt }) => now.getTime() - Date.parse(createdAt) < cleanUpGraceMs).flatMap(({ parents }) => parents));
  const named = new Map([...tips, ...commits.filter(({ commitId }) => recent.has(commitId))].map((commit) => [commit.commitId, commit]));
  const keys = new Set<string>();
  const originals = new Set<string>();
  for (const commit of named.values()) {
    const blobs = await blobsOf(remote, bookId, commit);
    if (!blobs) return undefined;
    for (const key of blobs.keys) keys.add(key);
    for (const key of blobs.originals) originals.add(key);
  }
  return { keys, originals };
}

/** The originals, previews and cover a commit names; undefined when its snapshot cannot be read. */
async function blobsOf(remote: SyncRemote, bookId: string, commit: CommitHeader): Promise<{ keys: string[]; originals: string[] } | undefined> {
  const bytes = await remote.getBlob(contentBlobKey(bookId, commit.stateDigest));
  if (!bytes || sha(bytes) !== commit.stateDigest) return undefined;
  let parsed;
  try { parsed = stateBlobSchema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { return undefined; }
  if (!parsed.success) return undefined;
  const originals = Object.values(parsed.data.originals).map(({ digest, ext }) => originalBlobKey(bookId, digest, ext));
  return { originals, keys: [...commit.coverDigest ? [coverBlobKey(bookId, commit.coverDigest)] : [], ...originals,
    ...Object.entries(parsed.data.proxies).map(([digest, { ext }]) => proxyBlobKey(bookId, digest, ext))] };
}

/**
 * What a book stores that it no longer uses, for the Sync window (UI-009): what Clean Up can free now, and what it can
 * free later, once a week has passed since the upload and since the commit that removed it, as `keptBlobs` counts. For
 * one book alone, so without what another book still copies from it (`planCleanUp`), which Clean Up then keeps.
 * Undefined when it cannot be told.
 */
export async function unusedStorage(remote: SyncRemote, bookId: string, now = new Date()): Promise<UnusedStorage | undefined> {
  let commits: CommitHeader[];
  try { commits = await remoteCommits(remote, bookId); }
  catch (error) { if (error instanceof NewerSyncFormatError) return undefined; throw error; }
  const tips = deriveTips(commits);
  if (!tips.length) return undefined;
  const used = new Set<string>();
  for (const tip of tips) {
    const blobs = await blobsOf(remote, bookId, tip);
    if (!blobs) return undefined;
    for (const key of blobs.keys) used.add(key);
  }
  // A commit keeps what its parents named for a week: the last such commit counts.
  const keptUntil = new Map<string, number>();
  const byId = new Map(commits.map((commit) => [commit.commitId, commit]));
  const until = new Map<string, number>();
  for (const { createdAt, parents } of commits) {
    const at = Date.parse(createdAt) + cleanUpGraceMs;
    if (at > now.getTime()) for (const parent of parents) until.set(parent, Math.max(until.get(parent) ?? 0, at));
  }
  for (const [id, at] of until) {
    const commit = byId.get(id);
    const blobs = commit && await blobsOf(remote, bookId, commit);
    if (!commit) continue;
    if (!blobs) return undefined;
    for (const key of blobs.keys) keptUntil.set(key, Math.max(keptUntil.get(key) ?? 0, at));
  }
  const result: UnusedStorage = { now: 0, later: 0 };
  for (const { key, size, lastModified } of await remote.listBook(bookId)) {
    if (!sweepableKey.test(key) || used.has(key)) continue;
    const at = Math.max(lastModified.getTime() + cleanUpGraceMs, keptUntil.get(key) ?? 0);
    if (at <= now.getTime()) { result.now += size; continue; }
    result.later += size;
    result.from = Math.min(result.from ?? at, at);
    result.until = Math.max(result.until ?? at, at);
  }
  return result;
}

/** The blobs of a listing that Clean Up may delete: sweepable, not kept, not wanted by another book, and older than the grace period. */
const unused = (entries: readonly StoreEntry[], kept: ReadonlySet<string>, wanted: ReadonlySet<string>, now: Date) =>
  entries.filter(({ key, lastModified }) => sweepableKey.test(key) && !kept.has(key) && !wanted.has(blobName(key)) && now.getTime() - lastModified.getTime() >= cleanUpGraceMs);

/**
 * What Clean Up would delete, book by book, without deleting anything: shown before the user confirms. Each book is
 * listed in the store itself (`full`), never from a key index, since the listing decides what is deleted.
 */
export async function planCleanUp(remote: SyncRemote, now = new Date()): Promise<CleanUpPlan> {
  let skipped = 0;
  const looked: { bookId: string; entries: StoreEntry[]; deleted?: true; kept?: Set<string> }[] = [];
  const wanted = new Set<string>();
  for (const { bookId, deleted, newer } of await remote.listBooks()) {
    if (newer) { skipped++; continue; }
    const entries = await remote.listBook(bookId, undefined, { full: true });
    if (deleted) { looked.push({ bookId, entries, deleted: true }); continue; }
    const kept = await keptBlobs(remote, bookId, now);
    if (!kept) { skipped++; continue; }
    // Named here and not here: a copy still waiting to copy it from the book it was made from keeps it there.
    const present = new Set(entries.map(({ key }) => key));
    for (const key of kept.originals) if (!present.has(key)) wanted.add(blobName(key));
    looked.push({ bookId, entries, kept: kept.keys });
  }
  const books: CleanUpBook[] = [];
  for (const { bookId, entries, deleted, kept } of looked) {
    const doomed = deleted ? entries.filter(({ key }) => key !== tombstoneKey(bookId)) : unused(entries, kept!, wanted, now);
    if (doomed.length) books.push({ bookId, blobs: doomed.map(({ key, size }) => ({ key, size })), bytes: doomed.reduce((sum, { size }) => sum + size, 0), ...(deleted ? { deleted: true as const } : {}) });
  }
  return { books, bytes: books.reduce((sum, book) => sum + book.bytes, 0), objects: books.reduce((sum, book) => sum + book.blobs.length, 0), skipped, wanted: [...wanted] };
}

/**
 * Deletes what a plan found (`planCleanUp`). For a book that is not deleted, its commits are read again right before,
 * and whatever they keep by now stays; a book whose commits cannot be read then is left alone. Of a deleted book,
 * everything but its tombstone goes. Returns what was freed.
 */
export async function cleanUp(remote: SyncRemote, plan: CleanUpPlan, now = new Date()): Promise<{ bytes: number; objects: number }> {
  let bytes = 0, objects = 0;
  const wanted = new Set(plan.wanted);
  for (const book of plan.books) {
    if (book.deleted) {
      // Everything under the prefix but the tombstone, also what arrived since the plan: nothing of a deleted book is used.
      const removed = await remote.deleteRemains(book.bookId);
      objects += removed.objects;
      bytes += removed.bytes;
      continue;
    }
    const kept = await keptBlobs(remote, book.bookId, now);
    if (!kept) continue;
    const blobs = book.blobs.filter(({ key }) => !kept.keys.has(key) && !wanted.has(blobName(key)));
    if (!blobs.length) continue;
    await remote.deleteBlobs(blobs.map(({ key }) => key));
    objects += blobs.length;
    bytes += blobs.reduce((sum, { size }) => sum + size, 0);
  }
  return { bytes, objects };
}

/** What a plan says in the Sync window and in the question before Clean Up: totals, without keys. */
export const cleanUpSummary = (plan: CleanUpPlan): SyncCleanUpPlan => ({ bytes: plan.bytes, objects: plan.objects,
  books: plan.books.filter(({ deleted }) => !deleted).length, deletedBooks: plan.books.filter(({ deleted }) => deleted).length, skipped: plan.skipped });

/**
 * The question the main process asks before Clean Up deletes anything (as Delete from Sync does): what it deletes
 * removes it for every Mac, so no window may start it by itself.
 */
export function cleanUpQuestion(plan: CleanUpPlan, backend: string) {
  return { message: 'Clean up “' + backend + '”?', buttons: ['Clean Up', 'Cancel'], defaultId: 1, cancelId: 1,
    detail: cleanUpText(cleanUpSummary(plan)) + ' They are deleted for every Mac. Every book’s text, files and history stay.' };
}
