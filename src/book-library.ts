import type { LibraryRemote, RecentDocument } from './desktop';

/**
 * The Start window as the library (ADR 0012, section 5; #283): the books on this Mac and the books on the remote in one
 * list, matched by lineage (`bookId`). Pure, so the merge is tested without a window.
 *
 * - A book on this Mac that syncs with the configured remote shows its sync state: `synced`, or `removed` when another
 *   Mac deleted it from sync (its tombstone), or `newer` when a newer ImageFlow marked it. One the remote does not have
 *   (its first sync has not happened, or did not finish) is `unsynced`, "Not synced yet".
 * - One that does not sync here (stopped, never started, or last synced with another remote) is `not-syncing`.
 * - While the remote is being read, a book that syncs here by its record is `checking`; when it cannot be read,
 *   `unavailable`. The books on this Mac are listed first, before the remote has answered.
 * - A book only on the remote is a `remote` row (`newer` when a newer ImageFlow synced it). A book deleted from sync
 *   that is on no Mac is not listed.
 * - Two copies on this Mac with the same lineage (a Finder copy) are both listed, each with its own state, and neither
 *   leaves the book listed as only on the remote. A recent book that cannot be found (`available: false`) still counts
 *   as on this Mac, so the remote copy is offered on its row (`onRemote`) instead of as a second row.
 */
export type LocalLibraryState = 'synced' | 'unsynced' | 'not-syncing' | 'removed' | 'newer' | 'checking' | 'unavailable' | 'missing';
export type LibraryRow =
  | { kind: 'local'; book: RecentDocument; state: LocalLibraryState; onRemote: boolean }
  | { kind: 'remote'; bookId: string; state: 'remote' | 'newer' };

/** Whether this Mac's sync record says the book syncs here, with the remote `remoteId` when given. */
const syncsHere = (book: RecentDocument, remoteId?: string) =>
  !!book.sync?.remoteId && book.sync.enabled !== false && (remoteId === undefined || book.sync.remoteId === remoteId);

export function libraryRows(local: readonly RecentDocument[], remote?: LibraryRemote | { error: string } | null): LibraryRow[] {
  const listing = remote && 'books' in remote ? remote : undefined;
  const byId = new Map(listing?.books.map((book) => [book.bookId, book]));
  const state = (book: RecentDocument): LocalLibraryState => {
    if (!book.available) return 'missing';
    if (!syncsHere(book)) return 'not-syncing';
    if (!remote) return 'checking';
    if (!listing) return 'unavailable';
    if (!syncsHere(book, listing.remoteId)) return 'not-syncing';
    const there = book.bookId ? byId.get(book.bookId) : undefined;
    return !there ? 'unsynced' : there.deleted ? 'removed' : there.newer ? 'newer' : 'synced';
  };
  const rows = local.map((book): LibraryRow => {
    const there = book.bookId ? byId.get(book.bookId) : undefined;
    return { kind: 'local', book, state: state(book), onRemote: !!there && !there.deleted };
  });
  const here = new Set(local.flatMap((book) => (book.bookId ? [book.bookId] : [])));
  const remoteOnly = (listing?.books ?? []).filter((book) => !book.deleted && !here.has(book.bookId))
    .map((book): LibraryRow => ({ kind: 'remote', bookId: book.bookId, state: book.newer ? 'newer' : 'remote' }));
  // Books that can be opened, then those only on the remote, then the ones that cannot be found.
  const missing = (row: LibraryRow) => row.kind === 'local' && row.state === 'missing';
  return [...rows.filter((row) => !missing(row)), ...remoteOnly, ...rows.filter(missing)];
}

/** What a row's state says under its title. */
export const libraryStateLabels: Record<LocalLibraryState | 'remote', string> = {
  synced: 'Synced', unsynced: 'Not synced yet', 'not-syncing': 'Not syncing', removed: 'Removed from sync', newer: 'Needs an update', checking: 'Synced',
  unavailable: 'Sync unavailable', missing: 'Not found', remote: 'Not on this Mac',
};
