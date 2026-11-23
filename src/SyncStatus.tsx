import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, SyncStatus as Status, SyncView } from './desktop';
import { TaskStatus } from './TaskStatus';

const labels: Record<Status['state'], string> = {
  'in-sync': 'In sync', 'ahead': 'Changes to sync', 'behind': 'Changes to fetch', 'diverged': 'Changed on two Macs',
  'remote-syncing': 'Remote catching up', 'abandoned': 'Sync stopped', 'newer': 'Update to sync', 'unavailable': 'Sync unavailable',
};
const explanations: Record<Status['state'], string> = {
  'in-sync': 'This book matches its synced version.',
  'ahead': 'This Mac has changes the remote does not have yet.',
  'behind': 'Another Mac synced changes this book does not have yet.',
  'diverged': 'The book changed here and on another Mac. Sync keeps this Mac’s version as a separate copy and continues with the other.',
  'remote-syncing': 'The remote does not have everything another Mac synced yet. Sync again once it has caught up.',
  'abandoned': 'The last sync could not be finished, so the book may be partly updated. Sync again to continue with the version on the remote.',
  'newer': 'A newer version of ImageFlow synced this book.',
  'unavailable': 'The remote cannot be read.',
};

/** The book's sync status in the status bar (#251): hidden for a book that does not sync; a click syncs. */
export function SyncStatus({ api, notice }: { api?: DesktopApi; notice: (message: string) => void }) {
  const [view, setView] = useState<SyncView | null>(null);
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!api) return;
    let current = true;
    void api.syncState().then((result) => { if (current && 'value' in result) setView(result.value); });
    const stop = api.onSyncChanged(setView);
    return () => { current = false; stop(); };
  }, [api]);
  useEffect(() => {
    if (view?.message && view.message !== shown.current) notice(view.message);
    shown.current = view?.message;
  }, [view?.message, notice]);
  if (!api || !view) return null;
  const status = view.status;
  // A remote that refuses this Mac's access key: the click opens Settings → Sync instead of syncing.
  const signIn = !view.syncing && status?.state === 'unavailable' && status.signIn;
  const settings = signIn || (!view.syncing && status?.state === 'unavailable' && status.checkSettings);
  const label = view.syncing ? 'Syncing…' : signIn ? 'Sign-in needed' : settings ? 'Check sync settings' : status ? labels[status.state] : 'Sync';
  const pending = status?.pendingOriginals ? ' ' + status.pendingOriginals + (status.pendingOriginals === 1 ? ' original is' : ' originals are') + ' only a preview on this Mac.' : '';
  // Named by a commit but not on the remote yet: still uploading from another Mac, which is no sync error.
  const elsewhere = status?.notUploaded ? status.notUploaded + (status.notUploaded === 1 ? ' original is' : ' originals are') + ' still uploading from another Mac.' : '';
  // This Mac's originals going up after the commit: the book has synced, its originals have not all arrived yet.
  const left = view.uploading ? view.uploading.total - view.uploading.done : 0;
  const uploadingHere = left > 0 ? left + (left === 1 ? ' original is' : ' originals are') + ' still uploading from this Mac.' : '';
  // The last background upload failed: the book synced, these originals of this Mac did not go up yet.
  const failed = !view.syncing && view.uploadFailed;
  const failedText = failed ? failed.left + (failed.left === 1 ? ' original' : ' originals') + ' not uploaded: ' + failed.message.replace(/\.?$/, '.') : '';
  const title = view.syncing ? 'Syncing with ' + view.folder : settings ? [status!.detail ?? '', 'Click to open Settings → Sync.'].filter(Boolean).join('\n')
    : [status ? explanations[status.state] : '', status?.detail ?? '', uploadingHere, failedText, pending.trim(), elsewhere, 'Click to sync with ' + view.folder + '.'].filter(Boolean).join('\n');
  // Originals downloading in the background: how far, with Cancel, beside the status.
  const download = view.downloading && <span className="sync-download" role="status"><TaskStatus progress={{ text: 'Downloading originals', ...view.downloading }}
    cancel={() => void api.syncAction('cancel-download')} /></span>;
  const upload = left > 0 && <span className="sync-download sync-uploading" role="status"><TaskStatus progress={{ text: 'Uploading originals', ...view.uploading! }} /></span>;
  // iCloud storage full: originals wait for room, or the sync itself did not fit; System Settings is where to make some.
  const waiting = !view.syncing && view.storageFull;
  const full = waiting && <span className="sync-download sync-full" role="status">
    <span>{waiting.notUploaded ? waiting.message.replace(/\.$/, '') + ': ' + waiting.notUploaded + (waiting.notUploaded === 1 ? ' original' : ' originals') + ' not uploaded' : waiting.message}</span>
    {waiting.manage && <button type="button" className="sync-manage" onClick={() => void api.syncAction('manage-storage').then((result) => { if ('error' in result) notice(result.error); })}>Manage Storage…</button>}
  </span>;
  // Stop Syncing on This Mac from the status bar too, as in File → Sync; the app asks before it stops.
  const menu = (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
    event.preventDefault();
    if (view.syncing) return;
    void api.popupMenu([{ id: 'stop', label: 'Stop Syncing on This Mac…' }], { x: Math.round(event.clientX), y: Math.round(event.clientY) })
      .then((chosen) => (chosen === 'stop' ? api.syncAction('stop') : undefined)).then((result) => { if (result && 'error' in result) notice(result.error); });
  };
  const notUploaded = failed && <span className="sync-download sync-full sync-upload-failed" role="status" title={failedText}>
    <span>{failed.left + (failed.left === 1 ? ' original' : ' originals') + ' not uploaded'}</span></span>;
  return <>{download}{upload}{full}{notUploaded}<button type="button" className={'sync-status' + (status && !view.syncing ? ' sync-' + status.state : '')} title={title} aria-label={label + '. ' + title}
    disabled={view.syncing} data-state={view.syncing ? 'syncing' : status?.state} data-uploading={left > 0 ? left : undefined} onContextMenu={menu}
    onClick={() => void (settings ? api.showSettings('sync') : api.syncAction('sync').then((result) => { if ('error' in result) notice(result.error); }))}>
    {view.syncing && <span className="status-spinner" aria-hidden="true" />}{label}{!view.syncing && status?.pendingOriginals ? <span className="sync-pending" aria-hidden="true">·</span> : null}
  </button></>;
}
