import sharp from 'sharp';
import { coverBlobKey, NewerSyncFormatError } from '../src/sync-snapshot';
import type { LibraryBook, LibraryRemote } from '../src/desktop';
import { isCoverJpeg } from './sync-engine';
import { remoteTips } from './sync-remote';
import type { SyncRemote } from './sync-remote';

/**
 * What the Start window, as the library (ADR 0012, section 5; #283), reads from the remote, apart from Electron so it
 * can be tested. The list itself is one listing of the books and one of the deletion markers (`SyncRemote.listBooks`),
 * so a library of many books costs two requests before anything else; what a row shows of a book only on the remote
 * (its latest title and its cover) is read per book as the row comes into view (`libraryBook`), and kept for the session.
 *
 * Everything here comes from the remote and is treated as untrusted input: titles are bounded strings, counts are
 * counted here, and a cover reaches the window only as a JPEG this process decoded and encoded again.
 */

/** The books on the remote, from one listing of books and one of deletion markers. */
export async function libraryListing(remote: SyncRemote, remoteId: string, name: string): Promise<LibraryRemote> {
  const books = await remote.listBooks();
  return { remoteId, name, books: books.map(({ bookId, deleted, newer }) => ({ bookId, ...(deleted ? { deleted: true as const } : {}), ...(newer ? { newer: true as const } : {}) })) };
}

/** The largest cover the library decodes; anything beyond a 320 px JPEG is no cover ImageFlow made. */
const maximumCoverPixels = 2000;

/**
 * A cover from the remote as the window may show it: a JPEG of a cover's size that decodes, made again here at no more
 * than 320 pixels, as a data URL. Undefined for anything else.
 */
export async function coverDataUrl(bytes: Uint8Array | undefined) {
  if (!bytes || !isCoverJpeg(bytes)) return undefined;
  try {
    const metadata = await sharp(bytes, { limitInputPixels: maximumCoverPixels * maximumCoverPixels }).metadata();
    if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height || metadata.width > maximumCoverPixels || metadata.height > maximumCoverPixels || (metadata.pages ?? 1) > 1) return undefined;
    const encoded = await sharp(bytes, { failOn: 'error', limitInputPixels: maximumCoverPixels * maximumCoverPixels })
      .rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return 'data:image/jpeg;base64,' + encoded.toString('base64');
  } catch { return undefined; }
}

/**
 * What a library row shows of a book on the remote: the title and time of its latest version, how many versions it has
 * (several when Macs changed it at once; Download asks which), and its cover. A book a newer ImageFlow synced says so
 * and nothing else. Over iCloud the first read of a book lists its zone once, and the key index keeps it from then on.
 */
export async function libraryBook(remote: SyncRemote, bookId: string,
  /** Covers by digest, kept across reads: a cover is content-addressed, so an unchanged book fetches none again. */
  covers: Map<string, Promise<string | undefined>> = new Map()): Promise<LibraryBook> {
  let tips;
  try { tips = await remoteTips(remote, bookId); }
  catch (error) {
    if (error instanceof NewerSyncFormatError) return { bookId, title: '', versions: 0, newer: true };
    throw error;
  }
  const latest = [...tips].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!latest) return { bookId, title: '', versions: 0 };
  const digest = latest.coverDigest;
  let reading = digest ? covers.get(bookId + '/' + digest) : undefined;
  if (digest && !reading) {
    reading = remote.getBlob(coverBlobKey(bookId, digest)).then(coverDataUrl, () => undefined);
    covers.set(bookId + '/' + digest, reading);
  }
  const cover = await reading;
  return { bookId, title: latest.title.slice(0, 400), updatedAt: latest.createdAt, versions: tips.length, ...(cover ? { cover } : {}) };
}

/**
 * The notice a trusted book gives when its template reaches sites it was not allowed to before (ADR 0012, section 2):
 * after a pulled or edited template adds one to sites already allowed, or the first time a book downloaded from the
 * library reaches the sites its template declares. Undefined when there is nothing to say (a book made here).
 */
export function networkNotice(added: readonly string[], { known, downloaded }: { known: boolean; downloaded: boolean }) {
  if (!added.length) return undefined;
  if (downloaded && !known) return 'This book’s template loads maps or data from ' + added.join(', ') + '. It was downloaded from your sync, which ImageFlow trusts as your own.';
  return known ? 'This book’s template now also loads maps or data from ' + added.join(', ') + '.' : undefined;
}

/**
 * What Delete from Sync asks (#283), by case. The book goes from the remote for every Mac, and every Mac stops syncing it.
 * A book only on the remote (`here` false) may be on no Mac at all: then it is deleted for good. A copy on this Mac stays,
 * but originals that are not on this Mac (`away`, or unknown) go with the remote unless another Mac has them.
 */
export function deleteFromSyncQuestion({ title, backend, here, away }: { title: string; backend: string; here: boolean; away?: number }) {
  const removed = 'It is removed from “' + backend + '”, and every Mac stops syncing it.';
  const detail = !here ? removed + ' It is not on this Mac: unless another Mac still has a copy, the book is deleted for good.'
    : removed + ' The copy on this Mac stays where it is. ' + (away === undefined ? 'Originals that are not on this Mac are removed with it, unless another Mac has them.'
      : away === 0 ? 'This Mac has all its originals.'
      : (away === 1 ? '1 original of this book is' : away + ' originals of this book are') + ' not on this Mac: ' + (away === 1 ? 'it is' : 'they are') + ' removed with it, unless another Mac has ' + (away === 1 ? 'it.' : 'them.'));
  return { message: 'Delete “' + title + '” from sync?', detail, buttons: ['Delete from Sync', 'Cancel'], defaultId: 1, cancelId: 1 };
}

/**
 * Whether a book syncs with the configured remote, by its sync record (#283): what keeps it in Recents beyond the 20
 * most recent and refuses Remove from Recents. `remoteId` is the configured remote's identity, `null` with sync off
 * (then no book syncs), and undefined when it cannot be read now (offline): the answer is then undefined, and neither
 * use acts on a guess (tracking stays as it was, and removal is allowed).
 */
export function syncsWithRemote(record: { remoteId?: string; enabled?: boolean } | undefined, remoteId: string | null | undefined): boolean | undefined {
  if (remoteId === null || !record?.remoteId || record.enabled === false) return false;
  if (remoteId === undefined) return undefined;
  return record.remoteId === remoteId;
}

/** Runs at most `limit` tasks at once, in the order they were asked for (the library's rows, four at a time). */
export function limited(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try { return await task(); }
    finally { running--; waiting.shift()?.(); }
  };
}
