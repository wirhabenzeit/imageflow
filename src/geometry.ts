import type { CSSProperties } from 'react';
import type { ResolvedFormat } from './format';

// Physical layout helpers for templates. A rectangle is in millimetres in spread coordinates: x from the left
// page's trim edge (the right page starts at the trim width), y from the top trim edge. Everything a helper
// returns is plain numbers; `css` turns a rectangle into absolute positioning for a node inside <Spread>.
export type Rect = { x: number; y: number; width: number; height: number };
export type Side = 'left' | 'right';
// `trim` is the page as cut. `safe` is the trim minus the format's safe insets (outside or binding by side).
// `bleed` extends the outer edges into the bleed; the edge at the fold stays at the fold, because the binding
// bleed of one page shows the facing page.
export type Area = 'trim' | 'safe' | 'bleed';
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };

export function page(format: ResolvedFormat, side: Side, area: Area = 'trim'): Rect {
  const { trim, bleed, safe } = format;
  const x = side === 'left' ? 0 : trim.width;
  if (area === 'trim') return { x, y: 0, width: trim.width, height: trim.height };
  if (area === 'safe') {
    const [start, end] = side === 'left' ? [safe.outside, safe.binding] : [safe.binding, safe.outside];
    return { x: x + start, y: safe.top, width: trim.width - start - end, height: trim.height - safe.top - safe.bottom };
  }
  return { x: side === 'left' ? -bleed.outside : x, y: -bleed.top, width: trim.width + bleed.outside, height: trim.height + bleed.top + bleed.bottom };
}

// Both pages. `safe` keeps the outer, top and bottom insets; content that crosses the fold should leave room for
// the binding itself.
export function spread(format: ResolvedFormat, area: Area = 'trim'): Rect {
  const { trim, bleed, safe } = format;
  if (area === 'trim') return { x: 0, y: 0, width: 2 * trim.width, height: trim.height };
  if (area === 'safe') {
    return { x: safe.outside, y: safe.top, width: 2 * (trim.width - safe.outside), height: trim.height - safe.top - safe.bottom };
  }
  return { x: -bleed.outside, y: -bleed.top, width: 2 * (trim.width + bleed.outside), height: trim.height + bleed.top + bleed.bottom };
}

export function inset(rect: Rect, by: Insets): Rect {
  const { top = 0, right = 0, bottom = 0, left = 0 } = typeof by === 'number' ? { top: by, right: by, bottom: by, left: by } : by;
  return { x: rect.x + left, y: rect.y + top, width: rect.width - left - right, height: rect.height - top - bottom };
}

// Equal cells in reading order (row by row). Gaps are millimetres between cells, never around them.
export function grid(rect: Rect, options: { columns: number; rows?: number; gap?: number; columnGap?: number; rowGap?: number }): Rect[] {
  const columns = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(1, Math.floor(options.rows ?? 1));
  const columnGap = options.columnGap ?? options.gap ?? 0;
  const rowGap = options.rowGap ?? options.gap ?? 0;
  const width = (rect.width - columnGap * (columns - 1)) / columns;
  const height = (rect.height - rowGap * (rows - 1)) / rows;
  return Array.from({ length: columns * rows }, (_, i) => ({
    x: rect.x + (i % columns) * (width + columnGap), y: rect.y + Math.floor(i / columns) * (height + rowGap), width, height,
  }));
}

// Design coordinates: a page drawn on a fixed design canvas (for example 290 × 290 units) that scales to the trim
// of the chosen format, horizontally with its width and vertically with its height. Only positions and sizes
// scale; type sizes stay in points. `width`/`height` convert design lengths, such as a gap, to millimetres.
export function design(format: ResolvedFormat, canvas: { width: number; height: number }) {
  const sx = format.trim.width / canvas.width, sy = format.trim.height / canvas.height;
  const on = (side: Side) => (x: number, y: number, width: number, height: number): Rect =>
    ({ x: (side === 'left' ? 0 : format.trim.width) + x * sx, y: y * sy, width: width * sx, height: height * sy });
  return { left: on('left'), right: on('right'), width: (value: number) => value * sx, height: (value: number) => value * sy };
}

export function css(rect: Rect): CSSProperties {
  return { position: 'absolute', left: rect.x + 'mm', top: rect.y + 'mm', width: rect.width + 'mm', height: rect.height + 'mm' };
}

export const geometry = { page, spread, inset, grid, design, css };

// The helpers with one spread's format applied, as `ctx.geometry`.
export function boundGeometry(format: ResolvedFormat) {
  return {
    page: (side: Side, area?: Area) => page(format, side, area),
    spread: (area?: Area) => spread(format, area),
    design: (canvas: { width: number; height: number }) => design(format, canvas),
    inset, grid, css,
  };
}
export type BoundGeometry = ReturnType<typeof boundGeometry>;
