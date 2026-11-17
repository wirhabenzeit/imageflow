import { useEffect, useState } from 'react';
import { gridColumns } from './desktop';
import type { CanvasLayout } from './desktop';
import type { PointerEvent } from 'react';

// `settings` is the height of Book settings above the spread list, inside the project panel.
type Side = 'left' | 'right' | 'bottom' | 'settings';
const defaults = { left: 232, right: 276, bottom: 170, settings: 260 };
const limits = { left: [220, 420], right: [260, 520], bottom: [170, 600], settings: [80, 1200] };
// Which way a drag or arrow key grows a panel: the side panels and Book settings grow away from their edge, Sources
// grows upwards.
const growth = { left: 1, right: -1, bottom: -1, settings: 1 };
const labels = { left: 'Resize project panel', right: 'Resize Inspector', bottom: 'Resize Sources', settings: 'Resize Book settings' };
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
      settings: Number.isFinite(saved.settings) ? bounded('settings', saved.settings) : initial.settings,
      leftHidden: saved.leftHidden === true, rightHidden: saved.rightHidden === true, bottomHidden: saved.bottomHidden === true };
  } catch { return initial; }
}
export function usePanels(resizing = false) {
  const [panels, setPanels] = useState(restore);
  const [windowHeight, setWindowHeight] = useState(() => innerHeight);
  useEffect(() => {
    const resized = () => setWindowHeight(innerHeight);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  const bottomMaximum = Math.max(limits.bottom[0], Math.min(limits.bottom[1], Math.floor(windowHeight / 2)));
  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(key, JSON.stringify(panels)); } catch { /* Preferences are optional. */ }
  }, [panels, resizing]);
  const hiddenKey = (side: Exclude<Side, 'settings'>) => (side + 'Hidden') as 'leftHidden' | 'rightHidden' | 'bottomHidden';
  const toggle = (side: Exclude<Side, 'settings'>) => setPanels((value) => ({ ...value, [hiddenKey(side)]: !value[hiddenKey(side)] }));
  const show = (side: Exclude<Side, 'settings'>) => setPanels((value) => value[hiddenKey(side)] ? { ...value, [hiddenKey(side)]: false } : value);
  const resize = (side: Side, size: number) => setPanels((value) => {
    const next = side === 'bottom' ? Math.min(bottomMaximum, bounded(side, size)) : bounded(side, size);
    return value[side] === next ? value : { ...value, [side]: next };
  });
  return { panels: { ...panels, bottom: Math.min(panels.bottom, bottomMaximum) }, bottomMaximum, toggle, show, resize };
}
export function PanelDivider({ side, size, maximum = limits[side][1], resize, onResizing }: {
  side: Side; size: number; maximum?: number; resize: (side: Side, size: number) => void; onResizing: (active: boolean) => void;
}) {
  const [drag, setDrag] = useState<{ at: number; size: number }>();
  const horizontal = side === 'bottom' || side === 'settings';
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) resize(side, drag.size + ((horizontal ? event.clientY : event.clientX) - drag.at) * growth[side]);
  };
  return <div className={'panel-divider' + (horizontal ? ' panel-divider-bottom' : '') + (side === 'settings' ? ' panel-divider-settings' : '')} role="separator" tabIndex={0}
    aria-label={labels[side]}
    aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuemin={limits[side][0]} aria-valuemax={maximum} aria-valuenow={Math.min(size, maximum)}
    onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); onResizing(true);
      setDrag({ at: horizontal ? event.clientY : event.clientX, size }); }}
    onPointerMove={move} onPointerUp={() => setDrag(undefined)} onLostPointerCapture={() => { setDrag(undefined); onResizing(false); }}
    onDoubleClick={() => resize(side, defaults[side])} onKeyDown={(event) => {
      if (event.key === 'Home') { event.preventDefault(); resize(side, defaults[side]); }
      // An arrow key moves the divider its way, as a drag does.
      const forward = horizontal ? 'ArrowDown' : 'ArrowRight', back = horizontal ? 'ArrowUp' : 'ArrowLeft';
      if (event.key === forward || event.key === back) {
        event.preventDefault(); resize(side, Math.min(size, maximum) + (event.key === forward ? 10 : -10) * growth[side]);
      }
    }} />;
}

// Whether each sidebar section is open, remembered across books and launches like the panel sizes.
const sectionsKey = 'imageflow.sections.v1';
function savedSections(): Record<string, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(sectionsKey) ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}
export function useSectionOpen(id: string, initiallyOpen: boolean) {
  const [open, setOpen] = useState(() => savedSections()[id] ?? initiallyOpen);
  const change = (next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(sectionsKey, JSON.stringify({ ...savedSections(), [id]: next })); } catch { /* Preferences are optional. */ }
  };
  return [open, change] as const;
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
