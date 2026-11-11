import { useEffect, useState } from 'react';
import type { PointerEvent } from 'react';

type Side = 'left' | 'right';
const defaults = { left: 232, right: 276 };
const limits = { left: [220, 420], right: [260, 520] };
const key = 'imageflow.workspace.v1';
const initial = { left: 232, right: 276, leftHidden: false, rightHidden: false };
function bounded(side: Side, value: number) {
  return Math.max(limits[side][0], Math.min(limits[side][1], value));
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return { left: Number.isFinite(saved.left) ? bounded('left', saved.left) : initial.left,
      right: Number.isFinite(saved.right) ? bounded('right', saved.right) : initial.right,
      leftHidden: saved.leftHidden === true, rightHidden: saved.rightHidden === true };
  } catch { return initial; }
}
export function usePanels() {
  const [panels, setPanels] = useState(restore);
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(panels)); } catch { /* Preferences are optional. */ }
  }, [panels]);
  const toggle = (side: Side) => setPanels((value) => ({ ...value, [side + 'Hidden']: !value[side === 'left' ? 'leftHidden' : 'rightHidden'] }));
  const resize = (side: Side, width: number) => setPanels((value) => ({ ...value, [side]: bounded(side, width) }));
  return { panels, toggle, resize };
}
export function PanelDivider({ side, width, resize, onResizing }: { side: Side; width: number; resize: (side: Side, width: number) => void; onResizing: (active: boolean) => void }) {
  const [drag, setDrag] = useState<{ x: number; width: number }>();
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) resize(side, drag.width + (event.clientX - drag.x) * (side === 'left' ? 1 : -1));
  };
  return <div className="panel-divider" role="separator" tabIndex={0} aria-label={side === 'left' ? 'Resize project panel' : 'Resize Inspector'}
    aria-orientation="vertical" aria-valuemin={limits[side][0]} aria-valuemax={limits[side][1]} aria-valuenow={width}
    onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); onResizing(true); setDrag({ x: event.clientX, width }); }}
    onPointerMove={move} onPointerUp={() => setDrag(undefined)} onLostPointerCapture={() => { setDrag(undefined); onResizing(false); }}
    onDoubleClick={() => resize(side, defaults[side])} onKeyDown={(event) => {
      if (event.key === 'Home') { event.preventDefault(); resize(side, defaults[side]); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); resize(side, width + (event.key === 'ArrowRight' ? 10 : -10) * (side === 'left' ? 1 : -1));
      }
    }} />;
}
