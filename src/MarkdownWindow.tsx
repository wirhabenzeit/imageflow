import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopApi, MarkdownAction, MarkdownState } from './desktop';
import { markdownToHtml } from './markdown';
import { words } from './source-items';

export function MarkdownWindow({ api }: { api?: DesktopApi }) {
  const [state, setState] = useState<MarkdownState>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const version = useRef(0);
  const basis = useRef(0);
  const latestText = useRef('');
  const deferred = useDeferredValue(text);
  const html = useMemo(() => markdownToHtml(deferred), [deferred]);
  const adopt = (next: MarkdownState) => {
    setState(next);
    if (next.version >= version.current) { version.current = next.version; basis.current = next.basis; latestText.current = next.text; setText(next.text); }
  };
  useEffect(() => {
    if (!api) return;
    let active = true;
    let changed = false;
    const stopClosing = api.onMarkdownPrepareClose(() => {
      void api.markdownAction({ action: 'closing', text: latestText.current, version: version.current, basis: basis.current }).catch(() => {});
    });
    const stop = api.onMarkdownChanged((next) => { changed = true; if (active) adopt(next); });
    void api.markdownAction({ action: 'state' }).then((result) => {
      if (!active || changed) return;
      if ('value' in result) adopt(result.value); else setError(result.error);
    }).catch(() => { if (active) setError('Could not load this text.'); });
    return () => { active = false; stop(); stopClosing(); };
  }, [api]);
  useEffect(() => { if (state) document.title = state.name + ' — Markdown'; }, [state?.name]);
  async function act(request: MarkdownAction) {
    if (!api) return;
    try {
      const result = await api.markdownAction(request);
      if ('error' in result) setError(result.error);
      // Changes and status are delivered in order over the subscription, not through overlapping replies.
      else setError('');
    } catch { setError('Could not send your changes to the editor. Keep this window open and retry.'); }
  }
  let status = state ? 'Saved' : 'Loading…';
  if (state?.dirty || (state && version.current > state.version)) status = 'Unsaved changes';
  if (state?.error) status = state.dirty ? 'Save failed' : 'Source unavailable';
  if (error) status = 'Changes not delivered';
  if (state?.conflict !== undefined) status = 'Outside changes';
  if (state?.saving) status = 'Saving…';
  return <main className="studio markdown-window">
    <header className="markdown-header">
      <div><strong>{state?.name ?? 'Markdown'}</strong><small title={state?.path}>{state?.external ? 'Editing external original · ' + state.path : 'Saved inside this book'}</small></div>
      <span role="status" aria-live="polite">{status}</span>
      <button disabled={!state || state.saving || state.closing} onClick={() => void act({ action: 'save' })}>Save Now</button>
    </header>
    {(error || state?.error) && <div className="markdown-message error-text" role="alert">{error || state?.error}<button onClick={() => void act(error ? { action: 'change', text, version: ++version.current, basis: basis.current } : { action: 'save' })}>Retry</button></div>}
    {state?.conflict !== undefined && <section className="markdown-conflict" aria-label="Outside changes">
      <p>This file changed outside ImageFlow. Your text is preserved below. Choose which version to keep.</p>
      <details><summary>Review outside text</summary><pre>{state.conflict}</pre></details>
      <button onClick={() => void act({ action: 'reload', conflict: state.conflict! })}>Use Outside Text</button>
      <button onClick={() => void act({ action: 'keep', conflict: state.conflict! })}>Keep My Text</button>
    </section>}
    <div className="markdown-split">
      <section className="markdown-source"><h2>Markdown</h2><textarea aria-label="Markdown source" autoFocus spellCheck value={text} disabled={!state || state.closing}
        onChange={(event) => { const next = event.target.value; latestText.current = next; setText(next); void act({ action: 'change', text: next, version: ++version.current, basis: basis.current }); }}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void act({ action: 'save' }); } }} /></section>
      <section className="markdown-preview" aria-label="Formatted preview"><h2>Preview</h2><div className="markdown-preview-scroll"><article className="ql-markdown" dangerouslySetInnerHTML={{ __html: html }} /></div></section>
    </div>
    <footer className="markdown-footer muted">{words(text)} words · Markdown preview · Check page layout in the book window</footer>
  </main>;
}
