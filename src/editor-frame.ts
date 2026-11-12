import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { renderOrigin } from './desktop';

// The messages a template-supplied editor frame (an element editor or a layout picker) posts to its dialog. Drafts
// and committed values are the frame's own report, so each dialog validates them before using them.
export type FrameMessage =
  | { type: 'editor-ready' } | { type: 'editor-draft'; values: unknown; spread?: unknown } | { type: 'editor-size'; height: number }
  | { type: 'editor-commit'; values: unknown; spread?: unknown } | { type: 'editor-flushed'; request: number; values: unknown; spread?: unknown }
  | { type: 'editor-cancel' }
  | { type: 'editor-import'; request: number; accept: unknown; mode?: unknown } | { type: 'editor-notice'; message: unknown }
  | { type: 'editor-warning'; message: unknown } | { state: 'error'; message: string };

// The plumbing both editor dialogs share: listening to their own frame only, its readiness and height, a failure
// it reports, and Done's flush round trip. A frame that does not answer a flush in time saves nothing: the dialog
// stays open with its draft and Done can be tried again. A late answer to an earlier request is ignored.
export function useEditorFrame(frame: RefObject<HTMLIFrameElement | null>, handlers: {
  // `spread` is an element editor's draft of the layout parameters it edits; other frames leave it out.
  draft(values: unknown, spread?: unknown): void;
  // Done after a flush, or the frame's own commit(); both carry the frame's complete draft.
  done(values: unknown, spread?: unknown): void;
  cancel(): void;
  warning?(message: unknown): void;
  import?(data: Extract<FrameMessage, { type: 'editor-import' }>): void;
}, flushError = 'The editor did not respond, so nothing was saved. Try Done again, or Cancel.') {
  const [height, setHeight] = useState(240);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  // Done waits for the frame to finish typing in progress: a field in the frame keeps typed text until it loses
  // focus, which clicking Done out here does not cause. The request being waited for, if any.
  const [flushing, setFlushing] = useState<number>();
  const flushes = useRef(0);

  useEffect(() => {
    if (flushing === undefined) return;
    const timeout = setTimeout(() => {
      setFlushing(undefined);
      setError(flushError);
    }, 5000);
    return () => clearTimeout(timeout);
  }, [flushing, flushError]);

  const receive = useEffectEvent((event: MessageEvent<FrameMessage>) => {
    if (event.origin !== renderOrigin || event.source !== frame.current?.contentWindow || !event.data) return;
    const data = event.data;
    if ('state' in data) {
      if (data.state === 'error') {
        setFlushing(undefined);
        setFailed(true);
        setError(data.message);
      }
    } else if (data.type === 'editor-ready') {
      setReady(true);
      frame.current?.focus();
    } else if (data.type === 'editor-draft') {
      if (!failed) setError('');
      handlers.draft(data.values, data.spread);
    } else if (data.type === 'editor-warning') {
      handlers.warning?.(data.message);
    } else if (data.type === 'editor-notice') {
      if (!failed && typeof data.message === 'string') setError(data.message);
    } else if (data.type === 'editor-import') {
      handlers.import?.(data);
    } else if (data.type === 'editor-size') {
      setHeight(Math.max(120, Math.min(data.height, window.innerHeight * 0.7)));
    } else if (data.type === 'editor-flushed') {
      if (data.request !== flushing) return;
      setFlushing(undefined);
      handlers.done(data.values, data.spread);
    } else if (data.type === 'editor-commit') handlers.done(data.values, data.spread);
    else if (data.type === 'editor-cancel') handlers.cancel();
  });
  useEffect(() => {
    const listener = (event: MessageEvent) => receive(event);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  // Asks the frame to apply what is being typed and reply with its complete draft; only that reply saves. Returns
  // false when there is no frame to ask (one still loading has nothing typed to apply), so the caller saves at once.
  function flush() {
    const target = frame.current?.contentWindow;
    if (!ready || !target) return false;
    const request = ++flushes.current;
    setFlushing(request);
    setError('');
    target.postMessage({ type: 'editor-flush', request }, renderOrigin);
    return true;
  }

  return { height, ready, error, setError, failed, flushing, flush };
}
