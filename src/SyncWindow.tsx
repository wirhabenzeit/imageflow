import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { bookName } from './book-name';
import { libraryRows } from './book-library';
import type { LibraryRow } from './book-library';
import { DownloadProgress } from './DownloadProgress';
import type { BookDownload, DesktopApi, LibraryAction, LibraryBook, LibraryRemote, PopupItem, RecentDocument, SyncBook, SyncCleanUpPlan, SyncStatus } from './desktop';
import type { AppSettings } from './settings';
import { syncPlace, syncRows, syncRowState, syncSwitch } from './sync-rows';
import type { SyncRowState } from './sync-rows';
import { cleanUpText, formatStorage } from './sync-storage-text';
import bookIcon from '../resources/brand/book.svg';

type Remote = LibraryRemote | { error: string } | null | undefined;
const failed = { error: 'ImageFlow could not complete the request.' };
const keyOf = (row: LibraryRow) => (row.kind === 'remote' ? row.bookId : row.book.id);
const bookIdOf = (row: LibraryRow) => (row.kind === 'remote' ? row.bookId : row.book.bookId);

/**
 * The Sync window (#307): the books on this Mac and the books on the configured remote in one table, matched as in the
 * Start window (`libraryRows`), with a switch for each book on this Mac, what it takes up, and what sync does with it.
 * Nothing is uploaded until a switch is turned on. Everything but the list itself fills in as it is read. The window
 * names books and actions; the main process decides, and asks what has to be asked.
 */
export function SyncWindow({ api }: { api?: DesktopApi }) {
  const [settings, setSettings] = useState<AppSettings>();
  const [recents, setRecents] = useState<RecentDocument[]>();
  const [remote, setRemote] = useState<Remote>();
  const [downloads, setDownloads] = useState<BookDownload[]>([]);
  const [active, setActive] = useState<Record<string, SyncBook>>({});
  const [statuses, setStatuses] = useState<Record<string, SyncStatus | null>>({});
  const [details, setDetails] = useState<Record<string, LibraryBook | { error: string }>>({});
  const [sizes, setSizes] = useState<Record<string, number | 'unknown'>>({});
  const [switching, setSwitching] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  // Bumped when the list is read again: rows ask for what they show of the remote again, and keep it until it is here.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!api) return;
    let mounted = true, lastRefresh = Date.now(), reading = 0;
    const read = async (refresh = false) => {
      const turn = ++reading;
      const local = await api.recentDocuments().catch(() => failed);
      if (!mounted || turn !== reading) return;
      if ('error' in local) setError(local.error); else setRecents(local.value);
      const listed = await api.libraryRemote(refresh).catch(() => failed);
      if (!mounted || turn !== reading) return;
      setRemote('error' in listed ? { error: listed.error } : listed.value);
      setReload((count) => count + 1);
    };
    const readBooks = () => void api.syncBooks().then((result) => {
      if (mounted && 'value' in result) setActive(Object.fromEntries(result.value.map((book) => [book.id, book])));
    });
    void api.getSettings().then((result) => { if (mounted && 'value' in result) setSettings(result.value); });
    let heard = false;
    void api.downloads().then((value) => { if (mounted && !heard) setDownloads(value); });
    const stops = [api.onRecentsChanged(() => void read()), api.onSyncBooksChanged(readBooks), api.onAppError(setError), api.onSettingsChanged(setSettings),
      api.onDownloadsChanged((value) => { heard = true; setDownloads(value); })];
    // Coming back to the window reads the remote again, at most twice a minute.
    const focus = () => { if (Date.now() - lastRefresh > 30_000) { lastRefresh = Date.now(); void read(true); } };
    window.addEventListener('focus', focus);
    void read(true);
    readBooks();
    return () => { mounted = false; for (const stop of stops) stop(); window.removeEventListener('focus', focus); };
  }, [api]);

  const listing = remote && 'books' in remote ? remote : undefined;
  const icloud = settings?.sync?.kind === 'icloud';
  const name = icloud ? 'iCloud' : listing?.name ? '“' + listing.name + '”' : 'sync';
  const rows = syncRows(libraryRows(recents ?? [], remote));
  const downloading = (row: LibraryRow) => downloads.find(({ bookId }) => bookId === bookIdOf(row));
  const busyWith = (row: LibraryRow) => (row.kind === 'local' ? active[row.book.id] : undefined);

  // What a closed book's row shows of the remote, read for each listing; the main process reads two at a time.
  useEffect(() => {
    if (!api || !listing) return;
    let current = true;
    for (const row of rows) {
      if (row.kind === 'remote') {
        void api.libraryBook(row.bookId).catch(() => failed).then((result) => { if (current) setDetails((all) => ({ ...all,
          // A row that could be read before keeps what it showed when reading it again fails.
          [row.bookId]: 'value' in result ? result.value : all[row.bookId] && 'title' in all[row.bookId] ? all[row.bookId] : { error: result.error } })); });
      } else if (syncSwitch(row) && !active[row.book.id]?.open) {
        void api.syncBookStatus(row.book.id).catch(() => failed).then((result) => { if (current && 'value' in result) setStatuses((all) => ({ ...all, [row.book.id]: result.value })); });
      }
    }
    return () => { current = false; };
  }, [api, reload, rows.map((row) => keyOf(row) + (busyWith(row) ? '+' : '')).join()]);

  // What each book takes up: counted once the list is there, again when an upload of it ended, never waited for.
  const counted = useRef(new Set<string>());
  const uploading = useRef(new Set<string>());
  const onRemote = listing ? rows.filter((row) => row.kind === 'remote' || row.onRemote).map(bookIdOf).filter((id): id is string => !!id) : [];
  const size = (bookId: string) => void api?.syncBookSize(bookId, true).catch(() => failed).then((result) => setSizes((all) => ({ ...all,
    [bookId]: 'value' in result ? result.value.bytes : all[bookId] ?? 'unknown' })));
  useEffect(() => { counted.current.clear(); setSizes({}); setDetails({}); setStatuses({}); }, [JSON.stringify(settings?.sync)]);
  useEffect(() => { for (const bookId of onRemote) if (!counted.current.has(bookId)) { counted.current.add(bookId); size(bookId); } }, [onRemote.join(), JSON.stringify(settings?.sync)]);
  useEffect(() => {
    for (const row of rows) {
      const bookId = bookIdOf(row), view = busyWith(row)?.view;
      if (!bookId) continue;
      if (view?.syncing || view?.uploading) uploading.current.add(bookId);
      else if (uploading.current.delete(bookId)) size(bookId);
    }
  }, [active]);

  async function library(request: LibraryAction, key?: string) {
    if (!api || (key && switching[key])) return;
    setError('');
    if (key) setSwitching((all) => ({ ...all, [key]: true }));
    const result = await api.libraryAction(request).catch(() => failed);
    if ('error' in result) setError(result.error);
    if (key) setSwitching((all) => ({ ...all, [key]: false }));
  }
  /** The switch: Start Syncing or Stop Syncing on This Mac, and Sync Again for a book removed on another Mac. */
  const turn = (row: Extract<LibraryRow, { kind: 'local' }>) =>
    library({ action: syncSwitch(row) ? 'stop' : row.state === 'removed' ? 'sync-again' : 'start', id: row.book.id }, row.book.id);
  function act(row: LibraryRow, action: NonNullable<SyncRowState['action']>) {
    const bookId = bookIdOf(row);
    if (action === 'settings') void api?.showSettings('sync');
    else if (action === 'manage-storage') void api?.manageSyncStorage().then((result) => { if ('error' in result) setError(result.error); });
    else if (bookId) void library({ action, bookId });
  }

  /** The other actions of a row, in its context menu. */
  async function menu(row: LibraryRow, point?: { x: number; y: number }) {
    if (!api) return;
    const items: PopupItem[] = [];
    const bookId = bookIdOf(row);
    if (downloading(row)) items.push({ id: 'cancel-download', label: 'Cancel Download' });
    else if (row.kind === 'remote' || row.state === 'missing') {
      const newer = (row.kind === 'remote' && row.state === 'newer') || (!!bookId && !!(details[bookId] as LibraryBook | undefined)?.newer);
      // A book a newer ImageFlow synced is not this version's to delete: only Update.
      if (newer) items.push({ id: 'update', label: 'Update ImageFlow…' });
      else items.push({ id: 'download', label: 'Download…' }, { type: 'separator' }, { id: 'delete', label: 'Delete from Sync…' });
    } else {
      const on = syncSwitch(row);
      if (row.state === 'removed') items.push({ id: 'keep-here', label: 'Keep Here Only' }, { id: 'sync-again', label: 'Sync Again' });
      else items.push(on ? { id: 'stop', label: 'Stop Syncing on This Mac…' } : { id: 'start', label: 'Start Syncing' });
      if (row.onRemote && row.state !== 'newer') items.push({ id: 'delete', label: 'Delete from Sync…' });
      items.push({ type: 'separator' }, { id: 'open', label: 'Open' }, { id: 'reveal', label: 'Show in Finder' });
    }
    const chosen = await api.popupMenu(items, point);
    if (!chosen) return;
    if (chosen === 'open' || chosen === 'reveal') {
      const result = await api.recentDocument(keyOf(row), chosen).catch(() => failed);
      if ('error' in result) setError(result.error);
    } else if (chosen === 'cancel-download' || chosen === 'download' || chosen === 'update' || row.kind === 'remote') { if (bookId) void library({ action: chosen as 'download', bookId }); }
    else if (chosen === 'delete') void library(bookId ? { action: 'delete', bookId } : { action: 'delete', id: row.book.id });
    else void library({ action: chosen as 'start', id: row.book.id }, row.book.id);
  }

  const total = onRemote.reduce((sum, bookId) => sum + (typeof sizes[bookId] === 'number' ? sizes[bookId] : 0), 0);
  const counting = onRemote.some((bookId) => sizes[bookId] === undefined);
  const unknown = onRemote.some((bookId) => sizes[bookId] === 'unknown');
  const summary = !listing ? '' : counting ? (total ? formatStorage(total) + ' so far…' : 'Counting…') : !onRemote.length ? 'Nothing in ' + name + ' yet' : formatStorage(total) + ' in ' + name + (unknown ? ', without what cannot be read now' : '');

  if (remote === null) return <main className="studio sync-window sync-window-off" aria-label="Synced Books">
    <p>Sync is off on this Mac.</p><button onClick={() => void api?.showSettings('sync')}>Set Up Sync…</button></main>;
  return <main className="studio sync-window" aria-label="Synced Books" aria-busy={recents === undefined || remote === undefined}>
    <div className="sync-table" role="table" aria-label="Synced books">
      <div className="sync-row sync-head" role="row">
        <span role="columnheader" aria-label="Cover" /><span role="columnheader">Book</span><span role="columnheader" className="sync-size">{icloud ? 'In iCloud' : 'In sync'}</span>
        <span role="columnheader">State</span><span role="columnheader" className="sync-size">Sync</span>
      </div>
      <div className="sync-rows" role="rowgroup">
        {rows.map((row) => <Row key={keyOf(row)} row={row} place={syncPlace(row, name, !!downloading(row))} details={row.kind === 'remote' ? details[row.bookId] : undefined}
          size={onRemote.includes(bookIdOf(row) ?? '') ? sizes[bookIdOf(row)!] ?? 'counting' : undefined} download={downloading(row)}
          state={syncRowState(row, { download: downloading(row), view: busyWith(row)?.view, status: row.kind === 'local' ? statuses[row.book.id] : undefined,
            details: row.kind === 'remote' ? details[row.bookId] : undefined, switching: row.kind === 'local' && switching[row.book.id] })}
          disabled={!settings || (row.kind === 'local' && (switching[row.book.id] || row.state === 'checking'))} turn={() => { if (row.kind === 'local') void turn(row); }}
          act={(action) => act(row, action)} cancel={() => { const bookId = bookIdOf(row); if (bookId) void library({ action: 'cancel-download', bookId }); }} menu={(point) => void menu(row, point)} />)}
        {recents && remote !== undefined && !rows.length && <p className="sync-empty">No books on this Mac or in {name}.</p>}
      </div>
    </div>
    <footer className="sync-foot">
      <CleanUp api={api} disabled={!listing} summary={error || (remote && 'error' in remote ? remote.error : '') || summary} problem={!!error || (!!remote && 'error' in remote)}
        cleaned={() => { counted.current.clear(); for (const bookId of onRemote) { counted.current.add(bookId); size(bookId); } }} />
    </footer>
  </main>;
}

function Row({ row, place, details, size, download, state, disabled, turn, act, cancel, menu }: { row: LibraryRow; place: string; details?: LibraryBook | { error: string };
  size?: number | 'unknown' | 'counting'; download?: BookDownload; state: SyncRowState; disabled: boolean; turn: () => void; act: (action: NonNullable<SyncRowState['action']>) => void; cancel: () => void;
  menu: (point?: { x: number; y: number }) => void }) {
  const loaded = details && 'title' in details ? details : undefined;
  const title = row.kind === 'local' ? bookName(row.book.path) : loaded ? (loaded.newer ? 'A book from a newer ImageFlow' : loaded.title || 'Untitled') : details ? 'Cannot be read now' : 'Loading…';
  const cover = row.kind === 'local' ? row.book.cover : loaded?.cover;
  // A book that is being downloaded will sync here.
  const on = syncSwitch(row) ?? (download ? true : undefined);
  const onContextMenu = (event: MouseEvent) => { event.preventDefault(); menu({ x: Math.round(event.clientX), y: Math.round(event.clientY) }); };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); menu(); } };
  const labels = { download: 'Download…', update: 'Update…', 'manage-storage': 'Manage Storage…', settings: 'Settings…' };
  return <div className="sync-row" role="row" tabIndex={0} aria-label={title} data-book={bookIdOf(row)} data-state={row.state} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
    <span className="sync-cover" role="cell">{cover ? <img src={cover} alt="" /> : <img className="sync-cover-icon" src={bookIcon} alt="" />}</span>
    <span className="sync-book" role="cell"><strong title={row.kind === 'local' ? row.book.path : undefined}>{title}</strong><span>{place}</span></span>
    <span className="sync-size" role="cell">{size === undefined || size === 'unknown' ? '–' : size === 'counting' ? '' : formatStorage(size)}</span>
    <span className={'sync-state' + (state.tone ? ' sync-state-' + state.tone : '')} role="cell" title={state.detail}>
      {download ? <DownloadProgress download={download} title={title} cancel={cancel} /> : <>
        {state.bar && <progress className="task-status-bar" max={state.bar.total || 1} value={Math.min(state.bar.done, state.bar.total)} aria-label={state.text} />}
        {state.text && <span>{state.text}</span>}
        {state.action && <button onClick={() => act(state.action!)}>{labels[state.action]}</button>}</>}
    </span>
    <span className="sync-switch-cell" role="cell">{on !== undefined && <button className="sync-switch" role="switch" aria-checked={on} aria-label={'Sync ' + title} disabled={disabled || !!download} onClick={turn} />}</span>
  </div>;
}

/** The footer: what the books take up, and Clean Up (#285), which says what it would free and asks before it deletes. */
function CleanUp({ api, disabled, summary, problem, cleaned }: { api?: DesktopApi; disabled: boolean; summary: string; problem: boolean; cleaned: () => void }) {
  const [state, setState] = useState<{ at: 'looking' } | { at: 'found' | 'cleaning'; plan: SyncCleanUpPlan } | { at: 'done'; text: string; error?: boolean }>();
  async function look() {
    if (!api) return;
    setState({ at: 'looking' });
    const answer = await api.syncCleanUpPlan().catch(() => failed);
    setState('value' in answer ? (answer.value.objects ? { at: 'found', plan: answer.value } : { at: 'done', text: cleanUpText(answer.value) }) : { at: 'done', text: answer.error, error: true });
  }
  async function run(plan: SyncCleanUpPlan) {
    if (!api) return;
    setState({ at: 'cleaning', plan });
    const answer = await api.syncCleanUp().catch(() => failed);
    if ('error' in answer) { setState({ at: 'done', text: answer.error, error: true }); return; }
    const done = answer.value;
    // Not confirmed in the question the app asked: what it would free stays shown.
    if ('cancelled' in done) { setState({ at: 'found', plan }); return; }
    setState({ at: 'done', text: done.objects ? 'Freed ' + formatStorage(done.bytes) + '.' : 'Nothing was deleted: the books use everything they store by now.' });
    cleaned();
  }
  const planned = state && (state.at === 'found' || state.at === 'cleaning') ? state : undefined;
  const text = problem ? summary : planned ? cleanUpText(planned.plan) : state?.at === 'looking' ? 'Looking for what no book uses…' : state?.at === 'done' ? state.text : summary;
  const wrong = problem || (state?.at === 'done' && !!state.error);
  return <>
    <span className={'sync-summary' + (wrong ? ' sync-state-problem' : '')} role={wrong ? 'alert' : 'status'} title={text}>{text}</span>
    {planned ? <><button disabled={planned.at === 'cleaning'} onClick={() => setState(undefined)}>Cancel</button>
      <button className="primary" disabled={planned.at === 'cleaning'} onClick={() => void run(planned.plan)}>{planned.at === 'cleaning' ? 'Cleaning Up…' : 'Clean Up'}</button></>
      : <button disabled={!api || disabled || state?.at === 'looking'} title="Deletes originals, previews and covers no book has used for a week, and what is left of deleted books. It asks first."
        onClick={() => void look()}>Clean Up…</button>}
  </>;
}
