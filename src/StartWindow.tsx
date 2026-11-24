import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { bookName } from './book-name';
import { libraryRows, libraryStateLabels } from './book-library';
import type { LibraryRow } from './book-library';
import { DownloadProgress } from './DownloadProgress';
import type { BookDownload, DesktopApi, LibraryAction, LibraryBook, LibraryRemote, PopupItem, RecentDocument } from './desktop';
import brandMark from '../resources/brand/logo/imageflow-mark.svg';
import bookIcon from '../resources/brand/book.svg';

type Remote = LibraryRemote | { error: string } | null | undefined;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The Start window, which is the library (ADR 0012, section 5; #283): the books on this Mac, listed at once, and once
 * the configured remote has answered, the books on it, matched by lineage (`libraryRows`). A book only on the remote
 * loads its title and cover as its row comes into view. The window names books and actions; the main process decides,
 * and asks before anything that changes other Macs (Delete from Sync). A download shows on its book's row and leaves
 * the other rows usable (#305).
 */
export function StartWindow({ api }: { api?: DesktopApi }) {
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const [remote, setRemote] = useState<Remote>();
  const [books, setBooks] = useState<Record<string, LibraryBook | { error: string }>>({});
  const [busy, setBusy] = useState<string | false>(false);
  const [error, setError] = useState('');
  const [downloads, setDownloads] = useState<BookDownload[]>([]);
  const asked = useRef(new Set<string>());
  // Bumped when the listing is read again, so the rows in view ask for their details again.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let lastRefresh = Date.now();
    const readRemote = (refresh = false) => { void api.libraryRemote(refresh).then((result) => {
      if (!mounted) return;
      if (refresh || 'error' in result || JSON.stringify(result.value?.books) !== JSON.stringify((remoteRef.current as LibraryRemote | undefined)?.books)) {
        // A new listing: rows of books on the remote load their details again as they come into view, and show what
        // they showed until then (no flicker to "Loading…"; covers are kept by digest in the main process).
        asked.current.clear();
        setReload((count) => count + 1);
      }
      setRemote('error' in result ? { error: result.error } : result.value);
    }, () => { if (mounted) setRemote({ error: 'ImageFlow could not complete the request.' }); }); };
    const refresh = () => { void api.recentDocuments().then((result) => {
      if (!mounted) return;
      if ('error' in result) setError(result.error);
      else setRecents(result.value);
      // The books on this Mac first; the remote's part follows when it has answered.
      readRemote();
    }); };
    const changed = api.onRecentsChanged(refresh);
    const failed = api.onAppError(setError);
    // Coming back to the window reads the remote again, at most twice a minute.
    const focus = () => { if (Date.now() - lastRefresh > 30_000) { lastRefresh = Date.now(); readRemote(true); } };
    window.addEventListener('focus', focus);
    refresh();
    return () => { mounted = false; changed(); failed(); window.removeEventListener('focus', focus); };
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let heard = false;
    const stop = api.onDownloadsChanged((value) => { heard = true; setDownloads(value); });
    void api.downloads().then((value) => { if (!heard) setDownloads(value); });
    return () => { heard = true; stop(); };
  }, [api]);
  const remoteRef = useRef<Remote>(undefined);
  remoteRef.current = remote;

  /** Loads what a book on the remote shows, once per listing. */
  function load(bookId: string) {
    if (!api || asked.current.has(bookId)) return;
    asked.current.add(bookId);
    void api.libraryBook(bookId).then((result) => setBooks((current) => ({ ...current,
      // A row that could be read before keeps what it showed when reading it again fails.
      [bookId]: 'error' in result ? (current[bookId] && 'title' in current[bookId] ? current[bookId] : { error: result.error }) : result.value })),
      () => setBooks((current) => ({ ...current, [bookId]: { error: 'ImageFlow could not complete the request.' } })));
  }

  async function run(key: string, task: () => Promise<{ error: string } | { value: unknown }>) {
    if (!api || busy) return;
    setBusy(key);
    setError('');
    try {
      const result = await task();
      if ('error' in result) setError(result.error);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not open this book.'); }
    finally { setBusy(false); }
  }
  const act = (action: 'new' | 'open' | 'locate' | 'remove' | 'reveal', id?: string) =>
    run(action, () => (id ? api!.recentDocument(id, action as 'open' | 'locate' | 'remove' | 'reveal') : api!.openProject(action as 'new' | 'open')));
  const library = (request: LibraryAction) => run(request.action, () => api!.libraryAction(request));
  const downloading = (bookId?: string) => downloads.find((download) => download.bookId === bookId);
  /** Not `busy`: the book's row shows its download, and the other rows stay usable. The panel that asks where to save is a sheet. */
  async function download(bookId: string) {
    if (!api || busy) return;
    setError('');
    const result = await api.libraryAction({ action: 'download', bookId }).catch(() => ({ error: 'Could not download this book.' }));
    if ('error' in result) setError(result.error);
  }
  const cancelDownload = (bookId: string) => void api?.libraryAction({ action: 'cancel-download', bookId });

  const configured = remote !== null;
  const rows = libraryRows(recents, remote);
  const listing = remote && 'books' in remote ? remote : undefined;

  /** The actions a row offers in its context menu, by state. */
  function menuItems(row: LibraryRow): { items: PopupItem[]; run: (id: string) => void } {
    const bookId = row.kind === 'remote' ? row.bookId : row.book.bookId;
    if (bookId && downloading(bookId)) return { items: [{ id: 'cancel', label: 'Cancel Download' }], run: () => cancelDownload(bookId) };
    if (row.kind === 'remote') {
      // A book a newer ImageFlow synced is not this version's to delete: only Update.
      return { items: row.state === 'newer' ? [{ id: 'update', label: 'Update ImageFlow…' }]
        : [{ id: 'download', label: 'Download…' }, { type: 'separator' }, { id: 'delete', label: 'Delete from Sync…' }],
      run: (id) => void (id === 'download' ? download(row.bookId) : library({ action: id as 'delete' | 'update', bookId: row.bookId })) };
    }
    const { book, state } = row;
    const syncing = configured && (state === 'synced' || state === 'unsynced' || state === 'checking' || state === 'unavailable' || state === 'newer');
    const items: PopupItem[] = [{ id: 'open', label: 'Open', enabled: book.available }, { id: 'reveal', label: 'Show in Finder', enabled: book.available }];
    if (configured && book.available) {
      items.push({ type: 'separator' });
      if (state === 'not-syncing') items.push({ id: 'start', label: 'Start Syncing' });
      if (state === 'removed') items.push({ id: 'keep-here', label: 'Keep Here Only' }, { id: 'sync-again', label: 'Sync Again' });
      if (syncing) items.push({ id: 'stop', label: 'Stop Syncing on This Mac…' });
      if (syncing && book.bookId && state !== 'unsynced' && state !== 'newer') items.push({ id: 'delete', label: 'Delete from Sync…' });
    }
    if (!book.available && row.onRemote) items.push({ type: 'separator' }, { id: 'download', label: 'Download…' });
    items.push({ type: 'separator' }, ...(!book.available ? [{ id: 'locate', label: 'Locate…' }] : []),
      { id: 'remove', label: 'Remove from Recents', enabled: !configured || !(state === 'synced' || state === 'unsynced' || state === 'newer' || state === 'removed') });
    return { items, run: (id) => {
      if (id === 'open' || id === 'reveal' || id === 'remove' || id === 'locate') void act(id, book.id);
      else if (id === 'download' && book.bookId) void download(book.bookId);
      else void library({ action: id as 'start' | 'stop' | 'keep-here' | 'sync-again' | 'delete', id: book.id });
    } };
  }
  async function menu(row: LibraryRow, point?: { x: number; y: number }) {
    if (!api || busy) return;
    const { items, run: choose } = menuItems(row);
    const chosen = await api.popupMenu(items, point);
    if (chosen) choose(chosen);
  }
  const menuHandlers = (row: LibraryRow) => ({
    onContextMenu: (event: MouseEvent) => { event.preventDefault(); void menu(row, { x: Math.round(event.clientX), y: Math.round(event.clientY) }); },
    onKeyDown: (event: KeyboardEvent) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void menu(row); } },
  });

  function localRow(row: Extract<LibraryRow, { kind: 'local' }>) {
    const { book, state } = row;
    const name = bookName(book.path);
    const syncState = configured && book.available && state !== 'not-syncing' ? libraryStateLabels[state] : configured && book.available && listing ? libraryStateLabels['not-syncing'] : undefined;
    const progress = downloading(book.bookId);
    const removable = !configured || !(state === 'synced' || state === 'unsynced' || state === 'newer' || state === 'removed');
    return <li key={book.id} className={book.available ? 'library-local library-' + state : 'missing'} data-state={state} data-book={book.bookId} {...menuHandlers(row)}>
      <button className="recent-open" disabled={!!busy} onClick={() => void act(book.available ? 'open' : 'locate', book.id)}>
        <span className="recent-cover">{book.cover ? <img src={book.cover} alt="" /> : <img className="recent-cover-icon" src={bookIcon} alt="" />}</span>
        <span className="recent-description"><strong>{name}</strong><span className="recent-location" title={book.path}>{book.path.split('/').slice(-2).join('/')}</span>
          {!progress && <span>{book.available ? [syncState, 'Opened ' + day(book.openedAt)].filter(Boolean).join(' · ') : 'Not found'}</span>}
        </span>
      </button>
      <div className="recent-actions">
        {progress && <DownloadProgress download={progress} title={name} cancel={() => cancelDownload(progress.bookId)} />}
        {!book.available && !progress && <button disabled={!!busy} onClick={() => void act('locate', book.id)}>Locate…</button>}
        {!book.available && !progress && row.onRemote && book.bookId && <button disabled={!!busy} onClick={() => void download(book.bookId!)}>Download…</button>}
        {state === 'removed' && configured && <>
          <button disabled={!!busy} title="Stop syncing this book on this Mac. It stays here." onClick={() => void library({ action: 'keep-here', id: book.id })}>Keep Here Only</button>
          <button disabled={!!busy} title="Sync this book again, as a new book." onClick={() => void library({ action: 'sync-again', id: book.id })}>Sync Again</button>
        </>}
        {state === 'newer' && configured && book.bookId && <button disabled={!!busy} onClick={() => void library({ action: 'update', bookId: book.bookId! })}>Update</button>}
        {removable && !progress && <button className="recent-remove" aria-label={'Remove ' + name + ' from Recents'} title="Remove from Recents" disabled={!!busy} onClick={() => void act('remove', book.id)}>×</button>}
      </div>
    </li>;
  }

  return <main className="studio start-window">
    <div className="start-drag" aria-hidden="true" />
    <aside className="start-actions">
      <img className="start-brand" src={brandMark} alt="" />
      <h1>Image<span className="start-brand-flow">Flow</span></h1>
      <p>Designed in code.<br />Composed by eye.</p>
      <button className="primary" disabled={!api || !!busy} onClick={() => void act('new')}>New Book…</button>
      <button disabled={!api || !!busy} onClick={() => void act('open')}>Open…</button>
    </aside>
    <section className="recent-books" aria-labelledby="recent-heading" aria-busy={remote === undefined}>
      <h2 id="recent-heading">{configured ? 'Books' : 'Recent books'}{configured && remote && 'error' in remote && <span className="library-note" role="status" title={remote.error}> · {(listing?.name ? listing.name + ' ' : '') + 'cannot be read now'}</span>}
        {configured && remote === undefined && <span className="library-note" role="status"> · Looking at sync…</span>}</h2>
      {rows.length ? <ul>{rows.map((row) => row.kind === 'local' ? localRow(row)
        : <RemoteRow key={row.bookId} row={row} book={books[row.bookId]} name={listing?.name} load={load} reload={reload} busy={!!busy} handlers={menuHandlers(row)}
          progress={downloading(row.bookId)} cancel={() => cancelDownload(row.bookId)} download={() => void download(row.bookId)} update={() => void library({ action: 'update', bookId: row.bookId })} />)}</ul>
        : <div className="recent-empty"><img src={bookIcon} alt="" /><h3>A place for your stories</h3></div>}
    </section>
    <div className="start-status" role={error ? 'alert' : 'status'}>{error || (busy === 'delete' ? 'Deleting from sync…' : busy ? 'Opening…' : '')}</div>
  </main>;
}

/** A book only on the remote: its title and cover load as it comes into view. */
function RemoteRow({ row, book, name, load, reload, busy, handlers, progress, cancel, download, update }: { row: Extract<LibraryRow, { kind: 'remote' }>; book?: LibraryBook | { error: string }; name?: string;
  load: (bookId: string) => void; reload: number; busy: boolean; handlers: Record<string, unknown>; progress?: BookDownload; cancel: () => void;
  download: () => void; update: () => void }) {
  const item = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const node = item.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') { load(row.bookId); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) load(row.bookId); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [row.bookId, reload]);
  const details = book && 'title' in book ? book : undefined;
  const newer = row.state === 'newer' || !!details?.newer;
  const title = details ? (newer ? 'A book synced by a newer ImageFlow' : details.title || 'Untitled') : book ? 'Cannot be read now' : 'Loading…';
  const line: ReactNode = newer ? libraryStateLabels.newer : details?.updatedAt ? 'In ' + (name ?? 'sync') + ' · changed ' + day(details.updatedAt) + (details.versions > 1 ? ' · ' + details.versions + ' versions' : '')
    : book && 'error' in book ? book.error : 'In ' + (name ?? 'sync');
  return <li ref={item} className="library-remote" data-state={newer ? 'newer' : 'remote'} data-book={row.bookId} {...handlers}>
    <button className="recent-open" disabled={busy || !!progress} onClick={newer ? update : download} title={progress ? 'Downloading to this Mac.' : newer ? 'Update ImageFlow to open this book.' : 'Download this book to this Mac.'}>
      <span className="recent-cover">{details?.cover ? <img src={details.cover} alt="" /> : <img className="recent-cover-icon" src={bookIcon} alt="" />}</span>
      <span className="recent-description"><strong>{title}</strong><span>{line}</span></span>
    </button>
    <div className="recent-actions">
      {progress ? <DownloadProgress download={progress} title={details?.title || 'this book'} cancel={cancel} /> : newer ? <button disabled={busy} onClick={update}>Update</button> : <button disabled={busy || !details} onClick={download}>Download…</button>}
    </div>
  </li>;
}
