import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { renderOrigin, thumbsOrigin } from './desktop';
import type { BookGeometry, BookView, RenderStatus } from './desktop';
import type { PresentationView } from './presentation-model';
import { reorderOffsets, reorderTiming } from './reorder-motion';
import type { ReorderOffset } from './reorder-motion';
import type { Issue } from './desktop';
import type { PageSide } from './project';
export type PictureStatus = { type: 'pictures'; pending: number; errors: Issue[] };

type FrameState = { element?: HTMLIFrameElement; geometry?: BookGeometry; status?: RenderStatus; published?: boolean; pictures?: PictureStatus;
  reorder?: 'preparing' | 'ready' | 'skipped'; offsets?: ReorderOffset[]; preparedAt?: number; hiding?: boolean; start?: number;
  // The presentation view last sent to the frame (JSON).
  presented?: string };

// The occurrence an inline editor is drawn over, whose artwork the book view hides while it edits.
// `page` names the page of a spread shown as pages (ADR 0009); without it, the spread's own layout.
export type InlineEditing = ({ spread: string; element: string } | { spread: string; edits: string; occurrence: number }) & { page?: PageSide };

// The unsaved placement of a crop gesture on a photo box with a render callback.
export type CropPreview = { spread: string; box: string; page?: PageSide; placement: { centerX: number; centerY: number; zoom: number } };

const sameSheets = (a?: BookGeometry, b?: BookGeometry) => !!a && !!b && a.sheets.length === b.sheets.length &&
  a.sheets.every((sheet, i) => ['x', 'y', 'width', 'height'].every((key) => sheet[key as 'x'] === b.sheets[i][key as 'x']));

// Keep the displayed frame and its geometry until the latest candidate has finished rendering successfully.
export function BookFrame({ busy = false, provisional, project, view, query = '', title, onGeometry, onStatus, onPictures, viewport, hold, accept, inlineEditing, onInlineEditing, presentation, cropPreview, onPrepared, onShown, release }: {
  // Paired views reveal one revision together, on the shared animation clock.
  onPrepared?: (project: string) => void;
  // Called when a revision is shown, paired or not, so the other view does not wait for this one to prepare it again.
  onShown?: (project: string) => void;
  release?: { project: string; start: number };
  // While the app waits for an update, the frames show a progress cursor too.
  busy?: boolean;
  // The order of the spreads as edited, with the ones added since: the shown frame rearranges what it has into that
  // order at once, while the edit saves and until a newer frame shows it, so a structural edit shows immediately. An
  // edit that fails to save returns the order to the saved one.
  provisional?: { order: string[]; added: Record<string, { like?: string; copy?: boolean }> };
  project: string; view: BookView | 'cover'; query?: string; title: string;
  presentation?: PresentationView;
  hold?: boolean;
  // Told to every frame, including a candidate with its first geometry, so the template draws the gesture's crop.
  cropPreview?: CropPreview;
  // Every frame of the book view is told, including a candidate before it is shown, so the artwork never flashes.
  inlineEditing?: InlineEditing;
  // Called once the shown frame has drawn the artwork as `inlineEditing` last asked (by its key), such as shown again
  // after an inline editor closed, so the editor leaves only when the artwork is back.
  onInlineEditing?: (key: string) => void;
  accept?: (project: string) => boolean;
  // The part of the frame on screen, for frames that load photos lazily, and the grid columns of the book view (0 for
  // one column); sent when a frame asks for it.
  viewport?: () => { top: number; bottom: number; left: number; right: number; columns: number } | undefined;
  onGeometry?: (geometry: BookGeometry | undefined, animateReorder?: boolean, start?: number, revision?: string) => void;
  onStatus?: (status: RenderStatus, project: string) => void;
  // Pictures the shown frame draws after it was ready (ADR 0006): how many are still drawing, and those that failed.
  onPictures?: (pictures: PictureStatus, project: string) => void;
}) {
  // Thumbnails render from their own origin, in their own process, alongside the book view.
  const origin = view === 'thumbs' ? thumbsOrigin : renderOrigin;
  const target = hold ? undefined : origin + '/render/' + project + '?view=' + view + (query && '&' + query);
  const [shown, setShown] = useState<string>();
  // The frame shown before `shown`, kept beneath it for a moment. Without it, a tall book's replacement frame showed
  // nothing at all for a moment while Chromium painted it (F-042).
  const [retiring, setRetiring] = useState<string>();
  // The presentation and the cover likewise flickered at each revision. The layout previews are kept too, where the new
  // frame draws its previews in the same places: else the previous spread's previews would show between the new ones.
  const keepsPrevious = (next: FrameState) => view === 'book' || view === 'thumbs' || view === 'present' || view === 'cover' ||
    (view === 'layouts' && !!shown && sameSheets(latest.current.get(shown)?.geometry, next.geometry));
  const [frames, setFrames] = useState<Record<string, FrameState>>({});
  const latest = useRef(new Map<string, FrameState>());
  const refs = useRef(new Map<string, HTMLIFrameElement>());
  const projectOf = (id: string) => new URL(id).pathname.split('/').at(-1)!;
  const ids = [...new Set([retiring, shown, target].filter((id): id is string => id !== undefined))];

  function storeFrame(id: string, frame: FrameState) {
    latest.current = new Map(ids.map((key) => [key, key === id ? frame : latest.current.get(key) ?? {}]));
    setFrames(Object.fromEntries(latest.current));
  }
  const animationUntil = useRef(0);
  function publish(id: string, frame: FrameState) {
    // Finish the visible move before replacing it; intermediate candidates may be superseded.
    if (view === 'book' && performance.now() < animationUntil.current) return;
    if (frame.status?.state === 'ready' && onPrepared && release?.project !== project) {
      onPrepared(project);
      return;
    }
    if (frame.reorder === 'ready') {
      frame.start = release?.project === project ? release.start : performance.timeOrigin + performance.now();
      animationUntil.current = performance.now() + reorderTiming.duration;
    }
    frame.published = true;
    // A revision this view failed to render must not hold back the other view, which waits to show it together.
    if (frame.status?.state === 'error') onShown?.(project);
    if (frame.status?.state === 'ready') {
      if (shown && shown !== id && frame.reorder !== 'ready' && keepsPrevious(frame)) setRetiring(shown);
      setShown(id);
      onGeometry?.(frame.geometry, frame.reorder !== 'skipped', frame.start, project);
      onShown?.(project);
    }
    if (frame.status) onStatus?.(frame.status, project);
    if (frame.status?.state === 'ready' && frame.pictures) onPictures?.(frame.pictures, project);
  }
  const skipReorder = useEffectEvent((id: string, element: HTMLIFrameElement | undefined) => {
    const previous = latest.current.get(id);
    if (id !== target || refs.current.get(id) !== element || previous?.reorder !== 'preparing') return;
    const frame: FrameState = { ...previous, reorder: 'skipped' };
    element?.contentWindow?.postMessage({ type: 'cancel-reorder' }, origin);
    // A timeout may skip animation, but never bypass the render revision gate.
    if (!accept || accept(project)) publish(id, frame);
    storeFrame(id, frame);
  });

  const receive = useEffectEvent((event: MessageEvent<BookGeometry | RenderStatus | PictureStatus | { type: 'viewport-request' | 'reorder-ready' } | { type: 'inline-editing-applied'; key: string }>) => {
    if (event.origin !== origin || !event.data) return;
    const id = ids.find((key) => refs.current.get(key)?.contentWindow === event.source);
    if (!id) return;
    if (id !== shown && accept && !accept(project)) return;
    const data = event.data;
    if ('type' in data && data.type === 'viewport-request') {
      const range = viewport?.();
      if (range) (event.source as Window).postMessage({ type: 'viewport', ...range }, origin);
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
      if (!unchanged) element.contentWindow?.postMessage({ type: 'cancel-reorder' }, origin);
    } else if ('type' in data && data.type === 'pictures') {
      // Kept with the frame, and passed on once it is shown.
      frame.pictures = data;
      if (id === shown) onPictures?.(data, projectOf(id));
      storeFrame(id, frame);
      return;
    } else if ('type' in data && data.type === 'geometry') {
      if (latestCrop.current) (event.source as Window).postMessage({ type: 'crop-preview', ...latestCrop.current }, origin);
      (event.source as Window).postMessage({ type: 'busy', busy: latestBusy.current }, origin);
      // A candidate frame is shown only once it hides what the inline editor covers.
      if (latestEditing.current) {
        if (!frame.published) frame.hiding = true;
        (event.source as Window).postMessage({ type: 'inline-editing', key: latestKey.current, ...latestEditing.current }, origin);
      }
      frame.geometry = data;
      // A new presentation frame starts at the spread the presentation started on. It is sent the one on screen now,
      // before it is shown: its readiness waits for that crop's photos, which otherwise loaded only once it was shown
      // and blinked out over the previous frame.
      if (presentation && id !== shown && frame.presented !== JSON.stringify(presentation)) {
        frame.presented = JSON.stringify(presentation);
        (event.source as Window).postMessage({ type: 'present', ...presentation }, origin);
      }
      // A provisional order slides the shown sheets into place, from `motion`, on the frame's clock.
      const motion = (data as { motion?: number }).motion;
      if (id === shown) onGeometry?.(data, motion !== undefined, motion, projectOf(id));
    } else if ('type' in data && data.type === 'inline-editing-applied') {
      frame.hiding = false;
      if (id === shown && data.key === latestKey.current) latestApplied.current?.(data.key);
    } else if ('state' in data && id === target && !frame.status) {
      frame.status = data;
    } else return;

    if (id === target && !frame.published && !frame.hiding && frame.status && (frame.status.state === 'error' || view === 'cover' || frame.geometry)) {
      const offsets = (view === 'thumbs' || view === 'book') && shown && frame.status.state === 'ready' && !matchMedia('(prefers-reduced-motion: reduce)').matches
        ? reorderOffsets(latest.current.get(shown)?.geometry, frame.geometry) : [];
      if (offsets.length && !frame.reorder) {
        // Prepare the hidden candidate at its previous positions before revealing
        // it; otherwise the artwork flashes at its destination for one frame.
        frame.reorder = 'preparing';
        frame.offsets = offsets;
        frame.preparedAt = performance.now();
        element.contentWindow?.postMessage({ type: 'prepare-reorder', offsets }, origin);
      }
      if (frame.reorder !== 'preparing') {
        publish(id, frame);
      }
    }
    storeFrame(id, frame);
  });
  // The frame itself cannot tell when the window shows its pixels (its animation frames run before), so the previous
  // one stays for a fixed time. It is drawn over by the new frame wherever that has artwork.
  useEffect(() => {
    if (!retiring) return;
    const timer = setTimeout(() => setRetiring((current) => current === retiring ? undefined : current), 600);
    return () => clearTimeout(timer);
  }, [retiring]);
  const latestEditing = useRef(inlineEditing);
  latestEditing.current = inlineEditing;
  const editingKey = JSON.stringify(inlineEditing ?? null);
  const latestKey = useRef(editingKey);
  latestKey.current = editingKey;
  const latestApplied = useRef(onInlineEditing);
  latestApplied.current = onInlineEditing;
  const latestBusy = useRef(busy);
  latestBusy.current = busy;
  useEffect(() => {
    for (const { element } of latest.current.values()) element?.contentWindow?.postMessage({ type: 'busy', busy }, origin);
  }, [busy]);
  const latestCrop = useRef(cropPreview);
  latestCrop.current = cropPreview;
  const cropKey = JSON.stringify(cropPreview ?? null);
  useEffect(() => {
    for (const { element, geometry } of latest.current.values()) {
      if (geometry) element?.contentWindow?.postMessage({ type: 'crop-preview', ...(cropPreview ?? {}) }, origin);
    }
  }, [cropKey]);
  useEffect(() => {
    // Frames still loading are told with their first geometry, above.
    for (const { element, geometry } of latest.current.values()) {
      if (geometry) element?.contentWindow?.postMessage({ type: 'inline-editing', key: editingKey, ...inlineEditing }, origin);
    }
    // Without a frame to ask, nothing is hidden.
    if (![...latest.current.values()].some(({ geometry }) => geometry)) onInlineEditing?.(editingKey);
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
  const publishWaiting = useEffectEvent(() => {
    const frame = target && latest.current.get(target);
    if (target && frame && !frame.published && !frame.hiding && frame.status &&
        (frame.status.state === 'error' || view === 'cover' || frame.geometry) && frame.reorder !== 'preparing' && (!accept || accept(project))) {
      publish(target, frame);
      storeFrame(target, frame);
    }
  });
  useEffect(() => { publishWaiting(); }, [release]);
  useEffect(() => {
    if (view !== 'book' || !target || frames[target]?.published || animationUntil.current <= performance.now()) return;
    const timer = setTimeout(() => publishWaiting(), animationUntil.current - performance.now() + 1);
    return () => clearTimeout(timer);
  }, [frames, target, view]);
  useLayoutEffect(() => {
    if (shown && latest.current.get(shown)?.reorder === 'ready') {
      refs.current.get(shown)?.contentWindow?.postMessage({ type: 'play-reorder', start: latest.current.get(shown)?.start }, origin);
    }
  }, [shown]);

  const provisionalKey = JSON.stringify(provisional ?? null);
  useLayoutEffect(() => {
    if (!provisional || !shown) return;
    const sheets = latest.current.get(shown)?.geometry?.sheets.map(({ spread }) => spread);
    if (!sheets || JSON.stringify(sheets) === JSON.stringify(provisional.order)) return;
    refs.current.get(shown)?.contentWindow?.postMessage({ type: 'provisional', ...provisional }, origin);
  }, [provisionalKey, shown, target]);
  useLayoutEffect(() => {
    if (!presentation) return;
    if (shown) refs.current.get(shown)?.contentWindow?.postMessage({ type: 'present', ...presentation }, origin);
    // A candidate already drawing follows too, so it is ready on the spread shown when it is swapped in.
    const candidate = target && target !== shown ? latest.current.get(target) : undefined;
    if (candidate?.geometry && candidate.presented !== JSON.stringify(presentation)) {
      candidate.presented = JSON.stringify(presentation);
      refs.current.get(target!)?.contentWindow?.postMessage({ type: 'present', ...presentation }, origin);
    }
  }, [presentation, shown]);

  return ids.map((id) => {
    const frame = frames[id];
    const previous = id === retiring && id !== shown && id !== target;
    return <iframe key={id} title={title} tabIndex={-1}
      className={'book-frame book-frame-' + view + (id === shown ? '' : ' book-frame-pending') + (previous ? ' book-frame-retiring' : '')}
      data-current={id === target || undefined} data-revision={projectOf(id)}
      data-ready={frame?.status?.state === 'ready' && frame.published && !previous ? '' : undefined}
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
