import { useEffect, useState } from 'react';
import { emptyMenuState } from './commands';
import { bookName } from './book-name';
import type { DesktopApi, RecentDocument } from './desktop';

export function StartWindow({ api }: { api?: DesktopApi }) {
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const refresh = () => { void api.recentDocuments().then((result) => {
      if (!mounted) return;
      if ('error' in result) setError(result.error);
      else setRecents(result.value);
    }); };
    const changed = api.onRecentsChanged(refresh);
    const failed = api.onAppError(setError);
    refresh();
    return () => { mounted = false; changed(); failed(); };
  }, [api]);
  async function act(action: 'new' | 'open' | 'locate' | 'remove' | 'reveal', id?: string) {
    if (!api || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = id ? await api.recentDocument(id, action as 'open' | 'locate' | 'remove' | 'reveal') : await api.openProject(action as 'new' | 'open');
      if ('error' in result) setError(result.error);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not open this book.'); }
    finally { setBusy(false); }
  }
  async function menu(book: RecentDocument) {
    const result = await api?.showContextMenu([{ command: 'recent-open', enabled: book.available },
      { command: 'recent-reveal', enabled: book.available }, 'recent-remove', ...(!book.available ? ['recent-locate' as const] : [])], { ...emptyMenuState, busy });
    if (result) void act(({ 'recent-open': 'open', 'recent-reveal': 'reveal', 'recent-remove': 'remove', 'recent-locate': 'locate' } as const)[result.command as 'recent-open'], book.id);
  }
  // Books that can't be found stay listed so they can be located, but below the ones that can be opened.
  const ordered = [...recents.filter((book) => book.available), ...recents.filter((book) => !book.available)];
  return <main className="studio start-window">
    <div className="start-drag" aria-hidden="true" />
    <aside className="start-actions">
      <div className="start-brand" aria-hidden="true">◫</div>
      <h1>ImageFlow</h1>
      <p>Your photographs.<br />A book of their own.</p>
      <button className="primary" disabled={!api || busy} onClick={() => void act('new')}>New Book…</button>
      <button disabled={!api || busy} onClick={() => void act('open')}>Open…</button>
    </aside>
    <section className="recent-books" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent books</h2>
      {ordered.length ? <ul>{ordered.map((book) => <li key={book.id} className={book.available ? undefined : 'missing'} onContextMenu={(event) => { event.preventDefault(); void menu(book); }} onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void menu(book); } }}>
        <button className="recent-open" disabled={busy} onClick={() => void act(book.available ? 'open' : 'locate', book.id)}>
          <span className="recent-cover">{book.cover ? <img src={book.cover} alt="" /> : <span aria-hidden="true">◫</span>}</span>
          <span className="recent-description"><strong>{bookName(book.path)}</strong><span className="recent-location" title={book.path}>{book.path.split('/').slice(-2).join('/')}</span>
            <span>{book.available ? 'Opened ' + new Date(book.openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not found'}</span>
          </span>
        </button>
        <div className="recent-actions">
          {!book.available && <button disabled={busy} onClick={() => void act('locate', book.id)}>Locate…</button>}
          <button className="recent-remove" aria-label={'Remove ' + bookName(book.path) + ' from Recents'} title="Remove from Recents" disabled={busy} onClick={() => void act('remove', book.id)}>×</button>
        </div>
      </li>)}</ul> : <div className="recent-empty"><span aria-hidden="true">◫</span><h3>A place for your stories</h3></div>}
    </section>
    <div className="start-status" role={error ? 'alert' : 'status'}>{error || (busy ? 'Opening…' : '')}</div>
  </main>;
}
