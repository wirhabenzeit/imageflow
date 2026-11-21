import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, SyncStatus as Status, SyncView } from './desktop';

const labels: Record<Status['state'], string> = {
  'in-sync': 'In sync', 'ahead': 'Changes to sync', 'behind': 'Changes to fetch', 'diverged': 'Changed on two Macs',
  'remote-syncing': 'Sync folder catching up', 'abandoned': 'Sync stopped', 'newer': 'Update to sync', 'unavailable': 'Sync folder unavailable',
};
const explanations: Record<Status['state'], string> = {
  'in-sync': 'This book matches the sync folder.',
  'ahead': 'This Mac has changes the sync folder does not have yet.',
  'behind': 'Another Mac synced changes this book does not have yet.',
  'diverged': 'The book changed here and on another Mac. Sync keeps this Mac’s version as a separate copy and continues with the other.',
  'remote-syncing': 'The sync folder has not finished receiving what another Mac synced. Sync again once it has caught up.',
  'abandoned': 'The last sync could not be finished, so the book may be partly updated. Sync again to continue with the version in the sync folder.',
  'newer': 'A newer version of ImageFlow synced this book.',
  'unavailable': 'The sync folder cannot be read.',
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
  const label = view.syncing ? 'Syncing…' : status ? labels[status.state] : 'Sync';
  const pending = status?.pendingOriginals ? ' ' + status.pendingOriginals + (status.pendingOriginals === 1 ? ' original is' : ' originals are') + ' only a preview on this Mac.' : '';
  const title = view.syncing ? 'Syncing with ' + view.folder : [status ? explanations[status.state] : '', status?.detail ?? '', pending.trim(), 'Click to sync with ' + view.folder + '.'].filter(Boolean).join('\n');
  return <button type="button" className={'sync-status' + (status && !view.syncing ? ' sync-' + status.state : '')} title={title} aria-label={label + '. ' + title}
    disabled={view.syncing} data-state={view.syncing ? 'syncing' : status?.state}
    onClick={() => void api.syncAction('sync').then((result) => { if ('error' in result) notice(result.error); })}>
    {view.syncing && <span className="status-spinner" aria-hidden="true" />}{label}{!view.syncing && status?.pendingOriginals ? <span className="sync-pending" aria-hidden="true">·</span> : null}
  </button>;
}
