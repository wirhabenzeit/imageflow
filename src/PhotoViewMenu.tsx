import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActionMenu } from './ActionMenu';
import { Icon } from './Icon';
import { defaultPhotoView, photoViewChange, validPhotoView } from './photo-view';
import type { PhotoView, PhotoViewCommand } from './photo-view';

const storageKey = 'imageflow.photo-view.v1';
function saved(book: string): PhotoView {
  try { return validPhotoView(JSON.parse(localStorage.getItem(storageKey) ?? '{}')[book]); } catch { return { ...defaultPhotoView }; }
}
export function usePhotoView(book?: string) {
  const [state, setState] = useState(() => ({ book, value: book ? saved(book) : { ...defaultPhotoView } }));
  if (state.book !== book) setState({ book, value: book ? saved(book) : { ...defaultPhotoView } });
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    const refresh = (event: StorageEvent) => { if (book && event.key === storageKey) setState({ book, value: saved(book) }); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [book]);
  function update(patch: Partial<PhotoView>) {
    if (!book) return;
    const value = validPhotoView({ ...state.value, ...patch });
    setState({ book, value });
    try {
      const books = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
      const recent = Object.entries(books).filter(([id]) => id !== book).slice(-49);
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries([...recent, [book, value]])));
    } catch { /* View preferences remain usable when storage is unavailable. */ }
  }
  function command(id: PhotoViewCommand) { if (id === 'photos-gap-custom') setCustom(true); else update(photoViewChange(id, state.value)); }
  return { value: state.value, update, command, custom: () => setCustom(true), dialog: custom && <TimeGapDialog minutes={state.value.gapMinutes}
    close={() => setCustom(false)} save={(gapMinutes) => { update({ group: 'gap', gapMinutes }); setCustom(false); }} /> };
}
function TimeGapDialog({ minutes, save, close }: { minutes: number; save: (minutes: number) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(minutes);
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="time-gap-dialog" aria-label="Group photos by time gap" onCancel={close}>
    <form onSubmit={(event) => { event.preventDefault(); if (value >= 1 && value <= 10080) save(value); }}>
      <label>Start a new group after <input autoFocus type="number" min={1} max={10080} step={1} required value={Number.isFinite(value) ? value : ''}
        onChange={(event) => setValue(event.target.valueAsNumber)} /> minutes</label>
      <div><button type="button" onClick={close}>Cancel</button><button type="submit">Group Photos</button></div>
    </form>
  </dialog>;
}
export type PhotoViewControl = { value: PhotoView; update: (patch: Partial<PhotoView>) => void; custom: () => void };
export function PhotoViewMenu({ view, update, custom, photos = true, children }: {
  view: PhotoView; update: (patch: Partial<PhotoView>) => void; custom: () => void; photos?: boolean; children?: ReactNode;
}) {
  return <ActionMenu className="photo-view-menu" label={<>View <Icon name="chevron" /></>}>
    {children}
    {photos && <>
      <button onClick={() => update({ sort: 'capture' })}>Capture Time{view.sort === 'capture' ? ' ✓' : ''}</button>
      <button onClick={() => update({ sort: 'name' })}>Name{view.sort === 'name' ? ' ✓' : ''}</button>
      <button onClick={() => update({ sort: 'import' })}>Import Order{view.sort === 'import' ? ' ✓' : ''}</button>
      <hr />
      <button onClick={() => update({ group: 'none' })}>No Groups{view.group === 'none' ? ' ✓' : ''}</button>
      <button onClick={() => update({ group: 'day' })}>Group by Day{view.group === 'day' ? ' ✓' : ''}</button>
      {[30, 120, 360].map((gapMinutes) => <button key={gapMinutes} onClick={() => update({ group: 'gap', gapMinutes })}>
        {gapMinutes === 30 ? '30 Minute Gap' : gapMinutes / 60 + ' Hour Gap'}{view.group === 'gap' && view.gapMinutes === gapMinutes ? ' ✓' : ''}</button>)}
      <button onClick={custom}>Custom Time Gap…</button>
      <hr />
      <button onClick={() => update({ showTime: !view.showTime })}>Show Capture Time{view.showTime ? ' ✓' : ''}</button>
    </>}
  </ActionMenu>;
}
