import { Icon } from './Icon';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { Rect } from './desktop';
import { centered, getCrop, maxZoom, placementOf } from './spread';
import type { Dimensions, Placement } from './spread';

// A selected photo. Dragging it moves the photo inside its frame; pinching (or ctrl-scrolling) and the toolbar zoom
// it. While it is selected, the whole photo shows faded around the frame, so you see what can be brought in; it
// lets clicks through to neighbouring boxes. While a gesture runs, the rest of the book dims as well. Each gesture
// is saved when it ends, as its own undoable edit; there is nothing to confirm. Plain scrolling keeps scrolling the
// book. The toolbar sits at the bottom of the visible canvas, because the frame may extend past the visible area.
export function CropEditor({ frame, photo, src, placement: saved, inchesPerPixel, resolution, settling, save, close, toolbarHost, children }: {
  frame: Rect; photo: Dimensions; src: string; placement?: Placement; toolbarHost?: HTMLElement | null;
  inchesPerPixel?: number; resolution?: { minimum: number; target: number };
  settling: boolean; save: (placement: Placement) => void; close: () => void; children?: ReactNode;
}) {
  const aspect = frame.width / frame.height;
  const normal = (value?: Placement) => placementOf(getCrop(photo, value ?? centered, aspect), value?.zoom ?? 1);
  const [placement, setPlacement] = useState(() => normal(saved));
  const [active, setActive] = useState(false);
  const latest = useRef(placement);
  latest.current = placement;
  const window_ = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; start: Placement } | undefined>(undefined);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Saved values that change from elsewhere (Undo, the Inspector's crop values) show unless a gesture is running.
  const savedKey = JSON.stringify(normal(saved));
  useEffect(() => {
    if (!drag.current && !pending.current) setPlacement(normal(saved));
  }, [savedKey]);

  // Saves the current placement now, or after a pause for gestures that arrive as many small events.
  function commit() {
    clearTimeout(pending.current);
    pending.current = undefined;
    setActive(false);
    // The App compares with the project when the edit applies; an unchanged crop saves nothing.
    save(latest.current);
  }
  function commitSoon() {
    setActive(true);
    clearTimeout(pending.current);
    pending.current = setTimeout(commit, 450);
  }
  function finish() {
    if (pending.current) commit();
    close();
  }
  useEffect(() => () => clearTimeout(pending.current), []);

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
    const next = placementOf(getCrop(photo, { centerX: cropX + base.width / 2, centerY: cropY + base.height / 2, zoom: z }, aspect), z);
    latest.current = next;
    setPlacement(next);
  }
  // Zooms by `factor` around a stage point, keeping the photo point under it in place.
  function zoomAround(factor: number, x = frame.x + frame.width / 2, y = frame.y + frame.height / 2) {
    place(latest.current.zoom * factor, (x - left) / width, (y - top) / height, x, y);
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // The stage underneath would start moving the photo to another box.
    event.stopPropagation();
    if (settling || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    clearTimeout(pending.current);
    pending.current = undefined;
    drag.current = { x: event.clientX, y: event.clientY, start: latest.current };
    setActive(true);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    const from = getCrop(photo, start.start, aspect);
    const w = frame.width / from.width;
    const h = frame.height / from.height;
    const centerX = start.start.centerX - (event.clientX - start.x) / w;
    const centerY = start.start.centerY - (event.clientY - start.y) / h;
    const next = placementOf(getCrop(photo, { centerX, centerY, zoom: start.start.zoom }, aspect), start.start.zoom);
    latest.current = next;
    setPlacement(next);
  }
  function pointerUp() {
    if (!drag.current) return;
    drag.current = undefined;
    commit();
  }

  // Trackpad pinch arrives as a wheel event with ctrlKey set (so does ctrl-scrolling with a mouse); it zooms around
  // the pointer. Other wheel events scroll the book as usual.
  const wheel = useEffectEvent((event: WheelEvent) => {
    if (settling || !event.ctrlKey) return;
    event.preventDefault();
    const bounds = window_.current!.offsetParent!.getBoundingClientRect();
    zoomAround(Math.exp(-event.deltaY * 0.01), event.clientX - bounds.left, event.clientY - bounds.top);
    commitSoon();
  });
  useEffect(() => {
    const element = window_.current;
    if (!element) return;
    const listener = (event: WheelEvent) => wheel(event);
    element.addEventListener('wheel', listener, { passive: false });
    return () => element.removeEventListener('wheel', listener);
  }, []);

  // Canvas shortcuts apply only when no control has focus: a focused button or the zoom slider handles its own
  // Enter, Space and arrow keys. Escape and Enter deselect the photo, from its toolbar too.
  const keys = useEffectEvent((event: KeyboardEvent) => {
    if (settling) return;
    const control = (event.target as HTMLElement).closest?.('button, input, select, textarea, a[href], [role="radio"], [role="option"], [contenteditable]');
    if (control) {
      if (event.key === 'Escape' && toolbar.current?.contains(control)) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
      return;
    }
    const step = event.shiftKey ? 0.05 : 0.01;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (event.key === 'Escape' || event.key === 'Enter') finish();
    else if (event.key === '+' || event.key === '=') {
      zoomAround(1.1);
      commitSoon();
    } else if (event.key === '-') {
      zoomAround(1 / 1.1);
      commitSoon();
    } else if (nudge) {
      const current = latest.current;
      const now = getCrop(photo, current, aspect);
      const next = placementOf(getCrop(photo, { ...current, centerX: current.centerX + nudge[0] * now.width,
        centerY: current.centerY + nudge[1] * now.height }, aspect), current.zoom);
      latest.current = next;
      setPlacement(next);
      commitSoon();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  // Pressing anywhere outside the photo and its toolbar deselects it; what was pressed then handles the click.
  const outside = useEffectEvent((event: PointerEvent) => {
    const target = event.target as Node;
    if (settling || window_.current?.contains(target) || toolbar.current?.contains(target)) return;
    finish();
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
  const zoomButton = (factor: number) => () => {
    zoomAround(factor);
    commit();
  };
  return <div className={'crop-editor' + (settling ? ' settling' : '') + (active ? ' active' : '')}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    {!settling && <img className="crop-ghost" src={src} alt="" draggable={false} style={{ left, top, ...image }} />}
    <div ref={window_} className="crop-window" style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
      <img src={src} alt="" draggable={false} style={{ left: left - frame.x, top: top - frame.y, ...image }} />
    </div>
    {!settling && toolbarHost && createPortal(<div ref={toolbar} className="crop-toolbar" role="toolbar" aria-label="Photo">
      <button type="button" aria-label="Zoom out" onClick={zoomButton(1 / 1.25)}><Icon name="minus" /></button>
      <input type="range" aria-label="Zoom" min={0} max={Math.log(maxZoom)} step={0.01} value={Math.log(placement.zoom)}
        onChange={(event) => {
          zoomAround(Math.exp(event.target.valueAsNumber) / latest.current.zoom);
          // Keys and drags on the slider save after a pause, so a run of steps is one Undo step.
          commitSoon();
        }} onPointerUp={commit} />
      <button type="button" aria-label="Zoom in" onClick={zoomButton(1.25)}><Icon name="plus" /></button>
      <span className="crop-zoom">{placement.zoom.toFixed(1)}×</span>
      {ppi !== undefined && <span className={'crop-ppi' + quality}
        title={resolution ? 'Print resolution · minimum ' + resolution.minimum + ' ppi, target ' + resolution.target + ' ppi' : 'Print resolution'}>
        {Math.round(ppi)} ppi</span>}
      <button type="button" onClick={() => {
        latest.current = normal(centered);
        setPlacement(latest.current);
        commit();
      }}>Fit</button>
      {children}
      <button type="button" className="primary" onClick={finish}>Done</button>
    </div>, toolbarHost)}
  </div>;
}
