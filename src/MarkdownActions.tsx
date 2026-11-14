import { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from './desktop';
import { Icon } from './Icon';

async function openMarkdown(api: DesktopApi, request: { id: string } | { name: string }) {
  for (let attempt = 0; ; attempt++) {
    const result = await api.showMarkdown(request);
    if (!('error' in result) || result.code !== 'BOOK_BUSY' || attempt >= 30) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function EditMarkdown({ id, name, api = window.imageflow, disabled = false, failure }: {
  id: string; name: string; api?: DesktopApi; disabled?: boolean; failure: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return <button type="button" className="markdown-edit" aria-label={'Edit ' + name} title="Edit Markdown" disabled={disabled || busy || !api}
    onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()} onClick={async (event) => {
      event.stopPropagation(); if (!api || busy) return;
      setBusy(true);
      try { const result = await openMarkdown(api, { id }); if ('error' in result) failure(result.error); }
      catch { failure('Could not open the Markdown editor.'); }
      finally { setBusy(false); }
    }}><Icon name="pencil" /></button>;
}

export function NewMarkdown({ api = window.imageflow, disabled = false }: {
  api?: DesktopApi; disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  return <>
    <button type="button" className="new-markdown" aria-label="New Text" title="New Markdown text" disabled={disabled || !api}
      onClick={() => { setName(''); setError(''); setOpen(true); }}><Icon name="plus" /> New Text</button>
    {open && <dialog ref={dialog} className="new-markdown-dialog" aria-label="New Text" onCancel={(event) => { if (busy) event.preventDefault(); }} onClose={() => setOpen(false)}>
      <form onSubmit={async (event) => {
        event.preventDefault(); if (!api || busy || !name.trim()) return;
        setBusy(true); setError('');
        try {
          const result = await openMarkdown(api, { name: name.trim() });
          if ('error' in result) setError(result.error); else dialog.current?.close();
        } catch { setError('Could not create the Markdown source.'); }
        finally { setBusy(false); }
      }}>
        <h2>New Text</h2>
        <label>Name<input autoFocus value={name} maxLength={100} placeholder="Introduction" disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
        <p className="muted">Saved as a Markdown file inside this book.</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button className="primary" type="submit" disabled={busy || !name.trim()}>Create</button></footer>
      </form>
    </dialog>}
  </>;
}
