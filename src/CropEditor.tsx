import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Rect } from './desktop';
import { centered, getCrop, maxZoom, placementOf } from './spread';
import type { Dimensions, Placement } from './spread';

// Adjusts which part of a photo fills its frame. The frame comes from the rendered book; the editor draws the
// whole photo over it (dimmed outside the frame), so dragging and zooming are instant. Nothing is saved until
// the adjustment is committed, which makes it one undo step. The toolbar sits at the bottom of the visible canvas,
// because the frame itself may extend past the visible area.
export function CropEditor({ frame, photo, src, placement: initial, inchesPerPixel, resolution, settling, commit, cancel, toolbarHost }: {
  frame: Rect; photo: Dimensions; src: string; placement?: Placement; toolbarHost?: HTMLElement | null;
  inchesPerPixel?: number; resolution?: { minimum: number; target: number };
  settling: boolean; commit: (placement: Placement) => void; cancel: () => void;
}) {
  const aspect = frame.width / frame.height;
  const [placement, setPlacement] = useState(() => placementOf(getCrop(photo, initial ?? centered, aspect), initial?.zoom ?? 1));
  const latest = useRef(placement);
  latest.current = placement;
  const surface = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; start: Placement } | undefined>(undefined);

  const crop = getCrop(photo, placement, aspect);
  const width = frame.width / crop.width;
  const height = frame.height / crop.height;
  const left = frame.x - crop.x * width;
  const top = frame.y - crop.y * height;
  const ppi = inchesPerPixel ? photo.width * crop.width / (frame.width * inchesPerPixel) : undefined;
  const quality = ppi === undefined || !resolution ? '' : ppi < resolution.minimum ? ' low' : ppi < resolution.target ? ' fair' : '';

  // Moves the view so the photo point (u, v) sits at stage point (x, y) at the given zoom, then clamps it.
  function place(zoom: number, u: number, v: number, x: number, y: number) {
    const z = Math.min(maxZoom, Math.max(1, zoom));
    const base = getCrop(photo, { ...centered, zoom: z }, aspect);
    const w = frame.width / base.width;
    const h = frame.height / base.height;
    const cropX = (frame.x - (x - u * w)) / w;
    const cropY = (frame.y - (y - v * h)) / h;
    setPlacement(placementOf(getCrop(photo, { centerX: cropX + base.width / 2, centerY: cropY + base.height / 2, zoom: z }, aspect), z));
  }
  // Zooms by `factor` around a stage point, keeping the photo point under it in place.
  function zoomAround(factor: number, x = frame.x + frame.width / 2, y = frame.y + frame.height / 2) {
    place(placement.zoom * factor, (x - left) / width, (y - top) / height, x, y);
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (settling || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, start: placement };
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    const from = getCrop(photo, start.start, aspect);
    const w = frame.width / from.width;
    const h = frame.height / from.height;
    const centerX = start.start.centerX - (event.clientX - start.x) / w;
    const centerY = start.start.centerY - (event.clientY - start.y) / h;
    setPlacement(placementOf(getCrop(photo, { centerX, centerY, zoom: start.start.zoom }, aspect), start.start.zoom));
  }
  const pointerUp = () => { drag.current = undefined; };

  // Wheel and trackpad pinch zoom around the pointer; pinch arrives as a wheel event with ctrlKey set.
  const wheel = useEffectEvent((event: WheelEvent) => {
    if (settling) return;
    event.preventDefault();
    const bounds = surface.current!.offsetParent!.getBoundingClientRect();
    zoomAround(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025)), event.clientX - bounds.left, event.clientY - bounds.top);
  });
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const listener = (event: WheelEvent) => wheel(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);

  // Canvas shortcuts apply only when no control has focus: a focused button or the zoom slider handles its own
  // Enter, Space and arrow keys (Cancel must cancel, the slider must zoom). Escape still leaves crop mode from
  // the toolbar's buttons and slider.
  const keys = useEffectEvent((event: KeyboardEvent) => {
    if (settling) return;
    const control = (event.target as HTMLElement).closest?.('button, input, select, textarea, a[href], [role="radio"], [role="option"], [contenteditable]');
    if (control) {
      if (event.key === 'Escape' && control.matches('button, input[type="range"]')) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
      return;
    }
    const step = event.shiftKey ? 0.05 : 0.01;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (event.key === 'Escape') cancel();
    else if (event.key === 'Enter') commit(latest.current);
    else if (event.key === '+' || event.key === '=') zoomAround(1.1);
    else if (event.key === '-') zoomAround(1 / 1.1);
    else if (nudge) {
      const centerX = placement.centerX + nudge[0] * crop.width;
      const centerY = placement.centerY + nudge[1] * crop.height;
      setPlacement(placementOf(getCrop(photo, { ...placement, centerX, centerY }, aspect), placement.zoom));
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  // Clicking anywhere outside the photo and its toolbar commits.
  const outside = useEffectEvent((event: PointerEvent) => {
    const target = event.target as Node;
    if (settling || surface.current?.contains(target) || toolbar.current?.contains(target)) return;
    commit(latest.current);
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => keys(event);
    const down = (event: PointerEvent) => outside(event);
    window.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', down, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', down, true);
    };
  }, []);

  const image = { width, height };
  return <div className={'crop-editor' + (settling ? ' settling' : '')} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}>
    <div ref={surface} className="crop-surface" style={{ left, top, ...image }} onPointerDown={pointerDown}
      onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
      {!settling && <img className="crop-ghost" src={src} alt="" draggable={false} style={image} />}
    </div>
    <div className="crop-window" style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
      <img src={src} alt="" draggable={false} style={{ left: left - frame.x, top: top - frame.y, ...image }} />
    </div>
    {!settling && toolbarHost && createPortal(<div ref={toolbar} className="crop-toolbar" role="toolbar" aria-label="Crop">
      <button type="button" aria-label="Zoom out" onClick={() => zoomAround(1 / 1.25)}>−</button>
      <input type="range" aria-label="Zoom" min={0} max={Math.log(maxZoom)} step={0.01} value={Math.log(placement.zoom)}
        onChange={(event) => zoomAround(Math.exp(event.target.valueAsNumber) / placement.zoom)} />
      <button type="button" aria-label="Zoom in" onClick={() => zoomAround(1.25)}>+</button>
      <span className="crop-zoom">{placement.zoom.toFixed(1)}×</span>
      {ppi !== undefined && <span className={'crop-ppi' + quality}
        title={resolution ? 'Print resolution · minimum ' + resolution.minimum + ' ppi, target ' + resolution.target + ' ppi' : 'Print resolution'}>
        {Math.round(ppi)} ppi</span>}
      <button type="button" onClick={() => setPlacement(placementOf(getCrop(photo, centered, aspect), 1))}>Fit</button>
      <button type="button" onClick={cancel}>Cancel</button>
      <button type="button" className="primary" onClick={() => commit(latest.current)}>Done</button>
    </div>, toolbarHost)}
  </div>;
}
