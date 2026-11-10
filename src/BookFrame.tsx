import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { BookGeometry, BookView, RenderStatus } from './desktop';

type FrameState = { geometry?: BookGeometry; status?: RenderStatus };

// Renders the whole book in a frame. Each edit gets a new project id; the previous frame stays on screen
// until the next one has reported its status, so edits do not flash or lose the scroll position.
export function BookFrame({ project, view, query = '', title, onGeometry, onStatus }: {
  project: string; view: BookView; query?: string; title: string;
  onGeometry: (geometry: BookGeometry | undefined) => void;
  onStatus?: (status: RenderStatus, project: string) => void;
}) {
  const target = renderOrigin + '/render/' + project + '?view=' + view + (query && '&' + query);
  const [shown, setShown] = useState(target);
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const latest = useRef<Record<string, FrameState>>({});
  const refs = useRef(new Map<string, HTMLIFrameElement>());
  const ids = shown === target ? [target] : [shown, target];

  function update(id: string, change: FrameState) {
    latest.current = Object.fromEntries(ids.map((key) => [key, latest.current[key] ?? {}]));
    latest.current[id] = { ...latest.current[id], ...change };
    setFrames(latest.current);
  }

  const receive = useEffectEvent((event: MessageEvent<BookGeometry | RenderStatus>) => {
    if (event.origin !== renderOrigin || !event.data) return;
    const id = ids.find((key) => refs.current.get(key)?.contentWindow === event.source);
    if (!id) return;
    const data = event.data;
    if ('type' in data && data.type === 'geometry') {
      update(id, { geometry: data });
      if (id === shown) onGeometry(data);
    } else if ('state' in data && id === target) {
      update(id, { status: data });
      if (shown !== target) {
        setShown(target);
        onGeometry(latest.current[target]?.geometry);
      }
      onStatus?.(data, project);
    }
  });
  useEffect(() => {
    const listener = (event: MessageEvent) => receive(event);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);

  return ids.map((id) => <iframe key={id} title={title} tabIndex={-1}
    className={'book-frame book-frame-' + view + (id === shown ? '' : ' book-frame-pending')}
    data-current={id === target || undefined} data-ready={frames[id]?.status ? '' : undefined}
    aria-hidden={id !== shown || undefined} style={{ height: frames[id]?.geometry?.height }}
    ref={(element) => {
      if (element) refs.current.set(id, element);
      else refs.current.delete(id);
    }}
    src={id} />);
}
