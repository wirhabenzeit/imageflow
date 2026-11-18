import { useEffect, useEffectEvent, useState } from 'react';
import type { RefObject } from 'react';

/** Canvas gestures use native listeners so pinch can cancel the browser's own page zoom. */
export function useCanvasGestures({ canvas, instance, active, zoom, zoomAt, fit, scrolling }: {
  canvas: RefObject<HTMLElement | null>; instance: number; active: boolean; zoom: number;
  zoomAt: (factor: number, point: { x: number; y: number; start: boolean }) => void;
  fit: () => void; scrolling: () => void;
}) {
  const [panReady, setPanReady] = useState(false);
  const [panning, setPanning] = useState(false);
  const available = useEffectEvent(() => ({ active, zoom }));
  const pinch = useEffectEvent(zoomAt);
  const returnToFit = useEffectEvent(fit);
  const onScrollIntent = useEffectEvent(scrolling);
  useEffect(() => {
    const view = canvas.current;
    if (!view) return;
    let held = false;
    let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
    let suppressClickUntil = 0;
    let lastPinch = -Infinity;
    let pinchFrame = 0;
    let queuedPinch: { x: number; y: number; start: boolean; delta: number } | undefined;
    const cancelPinch = () => {
      cancelAnimationFrame(pinchFrame);
      pinchFrame = 0;
      queuedPinch = undefined;
      lastPinch = -Infinity;
    };
    const control = (target: EventTarget | null) => target instanceof Element &&
      !!target.closest('input, textarea, select, button, [contenteditable], dialog, .crop-editor, .inline-editor');
    const finish = () => {
      if (drag) {
        if (view.hasPointerCapture(drag.id)) view.releasePointerCapture(drag.id);
        drag = undefined;
        suppressClickUntil = performance.now() + 250;
      }
      setPanning(false);
    };
    const release = () => { held = false; setPanReady(false); finish(); };
    const down = (event: globalThis.KeyboardEvent) => {
      const { active, zoom } = available();
      if (!active || event.defaultPrevented || !(event.target instanceof Element) ||
          event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && zoom !== 1 && (view.contains(event.target) || event.target.closest('.canvas-zoom-controls')) &&
          !event.target.closest('input, textarea, select, [contenteditable], dialog')) {
        event.preventDefault(); release(); returnToFit(); return;
      }
      if (control(event.target) || !view.contains(event.target)) return;
      if (event.code === 'Space' && zoom > 1) { event.preventDefault(); held = true; setPanReady(true); }
    };
    const up = (event: globalThis.KeyboardEvent) => { if (event.code === 'Space') release(); };
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return; // The photo cropper owns its own pinch gesture.
      if (!event.ctrlKey) { cancelPinch(); onScrollIntent(); return; }
      event.preventDefault();
      if (!available().active || control(event.target)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1);
      const now = performance.now();
      queuedPinch ??= { x: event.clientX, y: event.clientY, start: now - lastPinch > 150, delta: 0 };
      queuedPinch.delta += Math.max(-100, Math.min(100, delta));
      lastPinch = now;
      if (!pinchFrame) pinchFrame = requestAnimationFrame(() => {
        pinchFrame = 0;
        const update = queuedPinch;
        queuedPinch = undefined;
        if (update && available().active) pinch(Math.exp(-update.delta * .01), update);
      });
    };
    const pointerDown = (event: PointerEvent) => {
      if (!held || !available().active || available().zoom <= 1 || event.button !== 0 || control(event.target)) return;
      event.preventDefault(); event.stopPropagation();
      cancelPinch();
      onScrollIntent();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop };
      view.setPointerCapture(event.pointerId);
      setPanning(true);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      view.scrollTo({ left: drag.left + drag.x - event.clientX, top: drag.top + drag.y - event.clientY, behavior: 'instant' });
    };
    const pointerUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation(); finish();
    };
    const click = (event: MouseEvent) => {
      if (performance.now() >= suppressClickUntil) return;
      suppressClickUntil = 0;
      event.preventDefault(); event.stopPropagation();
    };
    view.addEventListener('wheel', wheel, { passive: false });
    view.addEventListener('pointerdown', pointerDown, true);
    view.addEventListener('pointermove', pointerMove, true);
    view.addEventListener('pointerup', pointerUp, true);
    view.addEventListener('pointercancel', pointerUp, true);
    view.addEventListener('lostpointercapture', finish);
    view.addEventListener('click', click, true);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      cancelPinch();
      release();
      view.removeEventListener('wheel', wheel);
      view.removeEventListener('pointerdown', pointerDown, true);
      view.removeEventListener('pointermove', pointerMove, true);
      view.removeEventListener('pointerup', pointerUp, true);
      view.removeEventListener('pointercancel', pointerUp, true);
      view.removeEventListener('lostpointercapture', finish);
      view.removeEventListener('click', click, true);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
    };
  }, [canvas, instance]);
  return { panReady: active && zoom > 1 && panReady, panning: active && zoom > 1 && panning };
}
