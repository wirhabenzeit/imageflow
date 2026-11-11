import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { BookGeometry, BookView, RenderStatus } from './desktop';

type FrameState = { geometry?: BookGeometry; status?: RenderStatus; published?: boolean };

// Keep the displayed frame and its geometry until the latest candidate has finished rendering successfully.
export function BookFrame({ project, view, query = '', title, onGeometry, onStatus, viewport, hold, accept }: {
  project: string; view: BookView; query?: string; title: string;
  hold?: boolean;
  accept?: (project: string) => boolean;
  // The part of the frame on screen, for frames that load photos lazily; sent when a frame asks for it.
  viewport?: () => { top: number; bottom: number } | undefined;
  onGeometry: (geometry: BookGeometry | undefined) => void;
  onStatus?: (status: RenderStatus, project: string) => void;
}) {
  const target = hold ? undefined : renderOrigin + '/render/' + project + '?view=' + view + (query && '&' + query);
  const [shown, setShown] = useState<string>();
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const latest = useRef(new Map<string, FrameState>());
  const refs = useRef(new Map<string, HTMLIFrameElement>());
  const ids = [shown, shown === target ? undefined : target].filter((id): id is string => id !== undefined);

  const receive = useEffectEvent((event: MessageEvent<BookGeometry | RenderStatus | { type: 'viewport-request' }>) => {
    if (event.origin !== renderOrigin || !event.data) return;
    const id = ids.find((key) => refs.current.get(key)?.contentWindow === event.source);
    if (!id) return;
    if (id !== shown && accept && !accept(project)) return;
    const data = event.data;
    if ('type' in data && data.type === 'viewport-request') {
      const range = viewport?.();
      if (range) (event.source as Window).postMessage({ type: 'viewport', ...range }, renderOrigin);
      return;
    }
    const frame = { ...latest.current.get(id) };
    if ('type' in data && data.type === 'geometry') {
      frame.geometry = data;
      if (id === shown) onGeometry(data);
    } else if ('state' in data && id === target && !frame.status) {
      frame.status = data;
    } else return;

    if (id === target && !frame.published && frame.status && (frame.status.state === 'error' || frame.geometry)) {
      frame.published = true;
      if (frame.status.state === 'ready') {
        setShown(id);
        onGeometry(frame.geometry);
      }
      onStatus?.(frame.status, project);
    }
    latest.current = new Map(ids.map((key) => [key, key === id ? frame : latest.current.get(key) ?? {}]));
    setFrames(Object.fromEntries(latest.current));
  });
  useEffect(() => {
    const listener = (event: MessageEvent) => receive(event);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  return ids.map((id) => <iframe key={id} title={title} tabIndex={-1}
    className={'book-frame book-frame-' + view + (id === shown ? '' : ' book-frame-pending')}
    data-current={id === target || undefined} data-ready={frames[id]?.status?.state === 'ready' && frames[id]?.published ? '' : undefined}
    aria-hidden={id !== shown || undefined} style={{ height: frames[id]?.geometry?.height }}
    ref={(element) => {
      if (!element) return;
      refs.current.set(id, element);
      return () => { refs.current.delete(id); };
    }}
    src={id} />);
}
