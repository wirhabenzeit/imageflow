import { useEffect, useState } from 'react';
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
  async function act(action: 'new' | 'open' | 'locate' | 'remove', id?: string) {
    if (!api || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = id ? await api.recentDocument(id, action as 'open' | 'locate' | 'remove') : await api.openProject(action as 'new' | 'open');
      if ('error' in result) setError(result.error);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not open this book.'); }
    finally { setBusy(false); }
  }
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
      {recents.length ? <ul>{recents.map((book) => <li key={book.id}>
        <button className="recent-open" disabled={busy || !book.available} onClick={() => void act('open', book.id)}>
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
