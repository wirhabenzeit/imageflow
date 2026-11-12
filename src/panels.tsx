import { useEffect, useState } from 'react';
import { gridColumns } from './desktop';
import type { CanvasLayout } from './desktop';
import type { PointerEvent } from 'react';

type Side = 'left' | 'right' | 'bottom';
const defaults = { left: 232, right: 276, bottom: 170 };
const limits = { left: [220, 420], right: [260, 520], bottom: [170, 600] };
const key = 'imageflow.workspace.v1';
const initial = { ...defaults, leftHidden: false, rightHidden: false, bottomHidden: false };
function bounded(side: Side, value: number) {
  return Math.max(limits[side][0], Math.min(limits[side][1], value));
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return { left: Number.isFinite(saved.left) ? bounded('left', saved.left) : initial.left,
      right: Number.isFinite(saved.right) ? bounded('right', saved.right) : initial.right,
      bottom: Number.isFinite(saved.bottom) ? bounded('bottom', saved.bottom) : initial.bottom,
      leftHidden: saved.leftHidden === true, rightHidden: saved.rightHidden === true, bottomHidden: saved.bottomHidden === true };
  } catch { return initial; }
}
export function usePanels() {
  const [panels, setPanels] = useState(restore);
  const [windowHeight, setWindowHeight] = useState(() => innerHeight);
  useEffect(() => {
    const resized = () => setWindowHeight(innerHeight);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  const bottomMaximum = Math.max(limits.bottom[0], Math.min(limits.bottom[1], Math.floor(windowHeight / 2)));
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(panels)); } catch { /* Preferences are optional. */ }
  }, [panels]);
  const hiddenKey = (side: Side) => (side + 'Hidden') as 'leftHidden' | 'rightHidden' | 'bottomHidden';
  const toggle = (side: Side) => setPanels((value) => ({ ...value, [hiddenKey(side)]: !value[hiddenKey(side)] }));
  const show = (side: Side) => setPanels((value) => value[hiddenKey(side)] ? { ...value, [hiddenKey(side)]: false } : value);
  const resize = (side: Side, size: number) => setPanels((value) => ({ ...value,
    [side]: side === 'bottom' ? Math.min(bottomMaximum, bounded(side, size)) : bounded(side, size) }));
  return { panels: { ...panels, bottom: Math.min(panels.bottom, bottomMaximum) }, bottomMaximum, toggle, show, resize };
}
export function PanelDivider({ side, size, maximum = limits[side][1], resize, onResizing }: {
  side: Side; size: number; maximum?: number; resize: (side: Side, size: number) => void; onResizing: (active: boolean) => void;
}) {
  const [drag, setDrag] = useState<{ at: number; size: number }>();
  const horizontal = side === 'bottom';
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) resize(side, drag.size + ((horizontal ? event.clientY : event.clientX) - drag.at) * (side === 'left' ? 1 : -1));
  };
  return <div className={'panel-divider' + (horizontal ? ' panel-divider-bottom' : '')} role="separator" tabIndex={0}
    aria-label={side === 'left' ? 'Resize project panel' : side === 'right' ? 'Resize Inspector' : 'Resize Sources'}
    aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuemin={limits[side][0]} aria-valuemax={maximum} aria-valuenow={size}
    onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); onResizing(true);
      setDrag({ at: horizontal ? event.clientY : event.clientX, size }); }}
    onPointerMove={move} onPointerUp={() => setDrag(undefined)} onLostPointerCapture={() => { setDrag(undefined); onResizing(false); }}
    onDoubleClick={() => resize(side, defaults[side])} onKeyDown={(event) => {
      if (event.key === 'Home') { event.preventDefault(); resize(side, defaults[side]); }
      const increase = horizontal ? 'ArrowUp' : 'ArrowRight', decrease = horizontal ? 'ArrowDown' : 'ArrowLeft';
      if (event.key === increase || event.key === decrease) {
        event.preventDefault(); resize(side, size + (event.key === increase ? 10 : -10) * (side === 'right' ? -1 : 1));
      }
    }} />;
}

// The canvas layout of each book window, remembered per book like the panel sizes. A book opened for the first
// time starts with the layout used last.
const layoutKey = 'imageflow.canvas-layout.v1';
const defaultLayout: CanvasLayout = { mode: 'vertical', columns: 2 };
type SavedLayouts = { last?: CanvasLayout; books?: Record<string, CanvasLayout> };
function validLayout(value: unknown): CanvasLayout | undefined {
  const layout = value as (Partial<CanvasLayout> & { rows?: number }) | undefined;
  if (!layout || (layout.mode !== 'vertical' && layout.mode !== 'grid')) return undefined;
  // Preserve the chosen density from the former sideways grid preference.
  const columns = layout.columns ?? layout.rows;
  return { mode: layout.mode, columns: gridColumns.includes(columns as typeof gridColumns[number]) ? columns! : defaultLayout.columns };
}
function savedLayouts(): SavedLayouts {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}
export function useCanvasLayout(book?: string) {
  const [layout, setLayout] = useState<CanvasLayout>(() => validLayout(savedLayouts().last) ?? defaultLayout);
  const [loaded, setLoaded] = useState<string>();
  if (book && loaded !== book) {
    // Adopt the book's own layout while rendering, so its first frame is already laid out that way.
    const saved = savedLayouts();
    setLoaded(book);
    setLayout(validLayout(saved.books?.[book]) ?? validLayout(saved.last) ?? layout);
  }
  useEffect(() => {
    if (!book || loaded !== book) return;
    try {
      const saved = savedLayouts();
      const books = { ...saved.books, [book]: layout };
      // Keep the most recent books only.
      const recent = Object.fromEntries(Object.entries(books).filter(([key]) => key !== book).slice(-49).concat([[book, layout]]));
      localStorage.setItem(layoutKey, JSON.stringify({ last: layout, books: recent }));
    } catch { /* Preferences are optional. */ }
  }, [book, loaded, layout]);
  return [layout, setLayout] as const;
}
