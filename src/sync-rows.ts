import type { BookDownload, LibraryBook, SyncStatus, SyncView } from './desktop';
import type { LibraryRow } from './book-library';

/**
 * The Sync window's rows (#307), pure so what they say is tested without a window: which books are listed, whether the
 * switch is on, and the state in a few words. The switch stands for this Mac's record (does the book sync here), the
 * state for what sync does with it now.
 */

/** The rows of the library the Sync window lists: everything that syncs or could. A book that cannot be found here counts only while the remote has it. */
export const syncRows = (rows: readonly LibraryRow[]) => rows.filter((row) => row.kind === 'remote' || (!row.book.syncExcluded && (row.book.available || row.onRemote)));

/** Whether the row's switch is on; undefined for a book without one (it is not on this Mac). */
export function syncSwitch(row: LibraryRow): boolean | undefined {
  if (row.kind === 'remote' || row.state === 'missing') return undefined;
  return row.state !== 'not-syncing' && row.state !== 'removed';
}

/** What a row says: `bar` for a transfer, `problem` in the color of errors, `action` as a button in its place. */
export type SyncRowState = { text?: string; detail?: string; tone?: 'muted' | 'problem'; bar?: { done: number; total: number };
  action?: 'download' | 'update' | 'manage-storage' | 'settings' };

const statusTexts: Record<SyncStatus['state'], SyncRowState> = {
  'in-sync': { text: 'Up to date' },
  'ahead': { text: 'Changes to send' },
  'behind': { text: 'Changes to fetch' },
  'diverged': { text: 'Changed on two Macs', tone: 'problem', detail: 'Open the book and choose File → Sync → Sync Now. It keeps both versions.' },
  'remote-syncing': { text: 'Still arriving', detail: 'Another Mac has not sent everything yet.' },
  'abandoned': { text: 'Sync stopped', tone: 'problem', detail: 'The last sync could not be finished. Open the book and choose File → Sync → Sync Now.' },
  'newer': { text: 'Needs an update', action: 'update' },
  'unavailable': { text: 'Cannot sync now', tone: 'problem' },
  'removed': { text: 'Removed on another Mac', tone: 'problem', detail: 'Turn it on to sync it again as a new book.' },
};

/** A status as a row says it. */
function statusState(status: SyncStatus): SyncRowState {
  const state = statusTexts[status.state];
  if (status.signIn) return { text: 'Sign-in needed', tone: 'problem', detail: status.detail, action: 'settings' };
  if (status.checkSettings) return { text: 'Check settings', tone: 'problem', detail: status.detail, action: 'settings' };
  return { ...state, ...(status.detail ? { detail: status.detail } : {}) };
}

/**
 * A row's state. `download` is a download of the book, `view` what sync does with it now (an open book, or a closed one
 * it is busy with), `status` how a closed book stands with the remote (undefined until it was read, null when it does
 * not sync here), `details` what a book on the remote shows.
 */
export function syncRowState(row: LibraryRow, { download, view, status, details, switching }: { download?: BookDownload; view?: SyncView | null; status?: SyncStatus | null;
  details?: LibraryBook | { error: string }; switching?: boolean } = {}): SyncRowState {
  if (download) return { bar: { done: download.done ?? 0, total: download.total ?? 0 }, text: download.waiting ? 'Waiting…' : download.total === undefined ? 'Starting…' : count(download.done ?? 0, download.total) };
  if (row.kind === 'remote' || row.state === 'missing') {
    if ((row.kind === 'remote' && row.state === 'newer') || (details && 'newer' in details && details.newer)) return statusTexts.newer;
    if (details && 'error' in details) return { text: 'Cannot be read now', tone: 'problem', detail: details.error };
    return { action: 'download' };
  }
  if (switching) return { text: 'One moment…', tone: 'muted' };
  if (row.state === 'not-syncing') return { text: 'Not syncing', tone: 'muted' };
  if (row.state === 'removed') return statusTexts.removed;
  if (row.state === 'newer') return statusTexts.newer;
  if (view?.syncing) return view.sending?.total ? { bar: view.sending, text: 'Uploading ' + count(view.sending.done, view.sending.total) } : { text: 'Syncing…' };
  if (view?.storageFull) return { text: view.storageFull.manage ? 'iCloud full' : 'Storage full', tone: 'problem', detail: view.storageFull.message, ...(view.storageFull.manage ? { action: 'manage-storage' as const } : {}) };
  if (view?.uploading && view.uploading.done < view.uploading.total) return { bar: view.uploading, text: 'Uploading ' + count(view.uploading.done, view.uploading.total) };
  if (view?.downloading) return { bar: view.downloading, text: 'Downloading ' + count(view.downloading.done, view.downloading.total) };
  if (view?.uploadFailed) {
    const { left, message } = view.uploadFailed;
    return { text: left === undefined ? 'Originals not uploaded' : left + (left === 1 ? ' original not uploaded' : ' originals not uploaded'), tone: 'problem', detail: message };
  }
  const known = view?.status ?? status;
  if (known) return statusState(known);
  if (row.state === 'unavailable') return statusTexts.unavailable;
  if (row.state === 'unsynced') return { text: 'Not synced yet', tone: 'muted', detail: 'It syncs when you open it.' };
  // Recorded as syncing, and how it stands is not read yet.
  return { text: 'Looking…', tone: 'muted' };
}
const count = (done: number, total: number) => done.toLocaleString('en') + ' of ' + total.toLocaleString('en');

/** Where a book is, under its title. */
export function syncPlace(row: LibraryRow, name: string, downloading: boolean) {
  if (downloading) return 'Downloading to this Mac';
  if (row.kind === 'remote') return 'Only in ' + name;
  return row.state === 'missing' ? 'Not found on this Mac' : 'On this Mac';
}
