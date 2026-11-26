import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { panPresentation, presentationFit, zoomPresentationAt } from './presentation-model';
import type { PresentationZoom } from './presentation-model';

/**
 * Pinch to zoom the presentation (UI-021). The editing canvas's gestures scroll an element and pan with Space held;
 * here the whole screen is scaled instead, a two-finger swipe turns the spread while it is whole, and a scroll or a
 * drag pans while it is enlarged. Native listeners, so a pinch can cancel Chromium's own page zoom.
 */
export function usePresentationZoom({ host, enabled, swipe }: {
  host: RefObject<HTMLElement | null>; enabled: boolean; swipe: (direction: 1 | -1) => void;
}) {
  const [view, setView] = useState(presentationFit);
  const [panning, setPanning] = useState(false);
  // Read and written synchronously, since several wheel events can arrive before React renders the previous one.
  const current = useRef(view);
  const apply = (next: (view: PresentationZoom) => PresentationZoom) => {
    const node = host.current;
    if (!node) return;
    const updated = next(current.current);
    if (updated === current.current) return;
    current.current = updated;
    setView(updated);
  };
  const size = () => ({ width: host.current?.clientWidth ?? 0, height: host.current?.clientHeight ?? 0 });
  const reset = () => apply(() => presentationFit);
  const zoomBy = (factor: number, point = { x: size().width / 2, y: size().height / 2 }) =>
    apply((view) => zoomPresentationAt(view, factor, point, size()));
  const allowed = useEffectEvent(() => enabled);
  const onSwipe = useEffectEvent(swipe);
  const pinch = useEffectEvent(zoomBy);
  const pan = useEffectEvent((dx: number, dy: number) => apply((view) => panPresentation(view, dx, dy, size())));
  const fit = useEffectEvent(reset);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    // A swipe's momentum continues after a pinch or a pan that ends whole; it must not turn the spread as well.
    let quietUntil = 0;
    let drag: { id: number; x: number; y: number } | undefined;
    const control = (target: EventTarget | null) => target instanceof Element && !!target.closest('button, .presentation-help');
    const wheel = (event: WheelEvent) => {
      const now = performance.now();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      if (event.ctrlKey) {
        event.preventDefault();
        quietUntil = now + 500;
        if (allowed()) pinch(Math.exp(-Math.max(-100, Math.min(100, event.deltaY * unit)) * .01), { x: event.clientX, y: event.clientY });
      } else if (current.current.scale > 1) {
        event.preventDefault();
        quietUntil = now + 500;
        pan(event.deltaX * unit, event.deltaY * unit);
      } else if (allowed() && Math.abs(event.deltaX) >= 25 && now >= quietUntil) {
        quietUntil = now + 500;
        onSwipe(event.deltaX > 0 ? 1 : -1);
      }
    };
    const finish = () => {
      if (drag && node.hasPointerCapture(drag.id)) node.releasePointerCapture(drag.id);
      drag = undefined;
      setPanning(false);
    };
    const pointerDown = (event: PointerEvent) => {
      if (current.current.scale <= 1 || !allowed() || event.button !== 0 || control(event.target)) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      node.setPointerCapture(event.pointerId);
      setPanning(true);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      pan(drag.x - event.clientX, drag.y - event.clientY);
      drag = { ...drag, x: event.clientX, y: event.clientY };
    };
    const pointerUp = (event: PointerEvent) => { if (drag?.id === event.pointerId) finish(); };
    const doubleClick = (event: MouseEvent) => { if (current.current.scale > 1 && !control(event.target)) fit(); };
    node.addEventListener('wheel', wheel, { passive: false });
    node.addEventListener('pointerdown', pointerDown);
    node.addEventListener('pointermove', pointerMove);
    node.addEventListener('pointerup', pointerUp);
    node.addEventListener('pointercancel', pointerUp);
    node.addEventListener('lostpointercapture', finish);
    node.addEventListener('dblclick', doubleClick);
    window.addEventListener('blur', finish);
    return () => {
      finish();
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('pointerdown', pointerDown);
      node.removeEventListener('pointermove', pointerMove);
      node.removeEventListener('pointerup', pointerUp);
      node.removeEventListener('pointercancel', pointerUp);
      node.removeEventListener('lostpointercapture', finish);
      node.removeEventListener('dblclick', doubleClick);
      window.removeEventListener('blur', finish);
    };
  }, [host]);
  const zoomed = view.scale > 1;
  return { zoomed, panning: zoomed && panning, reset, zoomBy, scale: view.scale,
    transform: zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined };
}
