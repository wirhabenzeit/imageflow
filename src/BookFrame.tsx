import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { renderOrigin } from './desktop';
import type { BookGeometry, BookView, RenderStatus } from './desktop';
import { reorderOffsets } from './reorder-motion';
import type { ReorderOffset } from './reorder-motion';
import type { Issue } from './desktop';
export type PictureStatus = { type: 'pictures'; pending: number; errors: Issue[] };

type FrameState = { element?: HTMLIFrameElement; geometry?: BookGeometry; status?: RenderStatus; published?: boolean; pictures?: PictureStatus;
  reorder?: 'preparing' | 'ready' | 'skipped'; offsets?: ReorderOffset[]; preparedAt?: number };

// The occurrence an inline editor is drawn over, whose artwork the book view hides while it edits.
export type InlineEditing = { spread: string; element: string } | { spread: string; edits: string; occurrence: number };

// Keep the displayed frame and its geometry until the latest candidate has finished rendering successfully.
export function BookFrame({ project, view, query = '', title, onGeometry, onStatus, onPictures, viewport, hold, accept, inlineEditing }: {
  project: string; view: BookView; query?: string; title: string;
  hold?: boolean;
  // Every frame of the book view is told, including a candidate before it is shown, so the artwork never flashes.
  inlineEditing?: InlineEditing;
  accept?: (project: string) => boolean;
  // The part of the frame on screen, for frames that load photos lazily, and the grid columns of the book view (0 for
  // one column); sent when a frame asks for it.
  viewport?: () => { top: number; bottom: number; left: number; right: number; columns: number } | undefined;
  onGeometry: (geometry: BookGeometry | undefined, animateReorder?: boolean) => void;
  onStatus?: (status: RenderStatus, project: string) => void;
  // Pictures the shown frame draws after it was ready (ADR 0006): how many are still drawing, and those that failed.
  onPictures?: (pictures: PictureStatus, project: string) => void;
}) {
  const target = hold ? undefined : renderOrigin + '/render/' + project + '?view=' + view + (query && '&' + query);
  const [shown, setShown] = useState<string>();
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const latest = useRef(new Map<string, FrameState>());
  const refs = useRef(new Map<string, HTMLIFrameElement>());
  const ids = [shown, shown === target ? undefined : target].filter((id): id is string => id !== undefined);

  function storeFrame(id: string, frame: FrameState) {
    latest.current = new Map(ids.map((key) => [key, key === id ? frame : latest.current.get(key) ?? {}]));
    setFrames(Object.fromEntries(latest.current));
  }
  function publish(id: string, frame: FrameState) {
    frame.published = true;
    if (frame.status?.state === 'ready') {
      setShown(id);
      onGeometry(frame.geometry, frame.reorder !== 'skipped');
    }
    if (frame.status) onStatus?.(frame.status, project);
    if (frame.status?.state === 'ready' && frame.pictures) onPictures?.(frame.pictures, project);
  }
  const skipReorder = useEffectEvent((id: string, element: HTMLIFrameElement | undefined) => {
    const previous = latest.current.get(id);
    if (id !== target || refs.current.get(id) !== element || previous?.reorder !== 'preparing') return;
    const frame: FrameState = { ...previous, reorder: 'skipped' };
    element?.contentWindow?.postMessage({ type: 'cancel-reorder' }, renderOrigin);
    // A timeout may skip animation, but never bypass the render revision gate.
    if (!accept || accept(project)) publish(id, frame);
    storeFrame(id, frame);
  });

  const receive = useEffectEvent((event: MessageEvent<BookGeometry | RenderStatus | PictureStatus | { type: 'viewport-request' | 'reorder-ready' }>) => {
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
    const element = refs.current.get(id)!;
    const previous = latest.current.get(id);
    // Revisiting a URL creates a new iframe. Readiness belongs to that instance, not its previous mount.
    const frame: FrameState = previous?.element === element ? { ...previous } : { element };
    if ('type' in data && data.type === 'reorder-ready') {
      if (frame.reorder !== 'preparing') return;
      const offsets = matchMedia('(prefers-reduced-motion: reduce)').matches ? [] :
        reorderOffsets(shown ? latest.current.get(shown)?.geometry : undefined, frame.geometry);
      const unchanged = offsets.length === frame.offsets?.length && offsets.every((offset, i) => {
        const prepared = frame.offsets![i];
        return offset.spread === prepared.spread && offset.x === prepared.x && offset.y === prepared.y;
      });
      frame.reorder = unchanged ? 'ready' : 'skipped';
      if (!unchanged) element.contentWindow?.postMessage({ type: 'cancel-reorder' }, renderOrigin);
    } else if ('type' in data && data.type === 'pictures') {
      // Kept with the frame, and passed on once it is shown.
      frame.pictures = data;
      if (id === shown) onPictures?.(data, new URL(id).pathname.split('/').at(-1)!);
      storeFrame(id, frame);
      return;
    } else if ('type' in data && data.type === 'geometry') {
      if (latestEditing.current) (event.source as Window).postMessage({ type: 'inline-editing', ...latestEditing.current }, renderOrigin);
      frame.geometry = data;
      if (id === shown) onGeometry(data);
    } else if ('state' in data && id === target && !frame.status) {
      frame.status = data;
    } else return;

    if (id === target && !frame.published && frame.status && (frame.status.state === 'error' || frame.geometry)) {
      const offsets = view === 'thumbs' && shown && frame.status.state === 'ready' && !matchMedia('(prefers-reduced-motion: reduce)').matches
        ? reorderOffsets(latest.current.get(shown)?.geometry, frame.geometry) : [];
      if (offsets.length && !frame.reorder) {
        // Prepare the hidden candidate at its previous positions before revealing
        // it; otherwise the artwork flashes at its destination for one frame.
        frame.reorder = 'preparing';
        frame.offsets = offsets;
        frame.preparedAt = performance.now();
        element.contentWindow?.postMessage({ type: 'prepare-reorder', offsets }, renderOrigin);
      }
      if (frame.reorder !== 'preparing') {
        publish(id, frame);
      }
    }
    storeFrame(id, frame);
  });
  const latestEditing = useRef(inlineEditing);
  latestEditing.current = inlineEditing;
  const editingKey = JSON.stringify(inlineEditing ?? null);
  useEffect(() => {
    // Frames still loading are told with their first geometry, above.
    for (const { element, geometry } of latest.current.values()) {
      if (geometry) element?.contentWindow?.postMessage({ type: 'inline-editing', ...inlineEditing }, renderOrigin);
    }
  }, [editingKey]);
  useEffect(() => {
    const listener = (event: MessageEvent) => receive(event);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, []);
  useEffect(() => {
    const frame = target ? frames[target] : undefined;
    if (!target || frame?.reorder !== 'preparing' || frame.preparedAt === undefined) return;
    const id = target;
    const timer = setTimeout(() => skipReorder(id, frame.element), Math.max(0, 150 - (performance.now() - frame.preparedAt)));
    return () => clearTimeout(timer);
  }, [frames, target]);
  useLayoutEffect(() => {
    if (shown && latest.current.get(shown)?.reorder === 'ready') {
      refs.current.get(shown)?.contentWindow?.postMessage({ type: 'play-reorder', start: performance.timeOrigin + performance.now() }, renderOrigin);
    }
  }, [shown]);

  return ids.map((id) => {
    const frame = frames[id];
    return <iframe key={id} title={title} tabIndex={-1}
      className={'book-frame book-frame-' + view + (id === shown ? '' : ' book-frame-pending')}
      data-current={id === target || undefined} data-ready={frame?.status?.state === 'ready' && frame.published ? '' : undefined}
      aria-hidden={id !== shown || undefined}
      style={{ height: frame?.geometry?.height }}
      ref={(element) => {
        if (!element) return;
        refs.current.set(id, element);
        if (latest.current.get(id)?.element !== element) {
          // Clear the cached ready flag before a recreated frame is measured or shown.
          const fresh = { element };
          latest.current.set(id, fresh);
          setFrames((current) => ({ ...current, [id]: fresh }));
        }
        return () => { refs.current.delete(id); };
      }}
      src={id} />;
  });
}
