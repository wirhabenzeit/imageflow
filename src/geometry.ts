import type { CSSProperties } from 'react';
import type { ResolvedFormat } from './format';

// Physical layout helpers for templates. A rectangle is in millimetres in sheet coordinates: x from the left
// page's trim edge (the right page starts at the trim width), y from the top trim edge. Without facing pages the
// sheet is one page and x starts at its left trim edge. Everything a helper returns is plain numbers; `css` turns a
// rectangle into absolute positioning for a node inside <Spread>.
export type Rect = { x: number; y: number; width: number; height: number };
export type Side = 'left' | 'right';
// `trim` is the page as cut. `safe` is the trim minus the format's safe insets (outside or binding by side, or left
// and right without facing pages). `bleed` extends the outer edges into the bleed; with facing pages the edge at the
// fold stays at the fold, because the binding bleed of one page shows the facing page.
export type Area = 'trim' | 'safe' | 'bleed';
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };

// A layout drawn in a format it does not fit (a spread layout without facing pages, or a page layout with them) is
// still previewed, and the Book check reports it; `lenient` answers its geometry calls instead of throwing.
type Mode = { lenient?: boolean };
// The format a mismatched layout receives as ctx.format carries this mark, so the standalone helpers called with it,
// such as geometry.spread(ctx.format, 'bleed'), answer leniently too.
const lenientFormats = new WeakSet<object>();
export function lenientFormat<F extends ResolvedFormat>(format: F): F {
  const copy = { ...format };
  lenientFormats.add(copy);
  return copy;
}
const modeOf = (format: ResolvedFormat, mode: Mode): Mode => mode.lenient || lenientFormats.has(format) ? { lenient: true } : mode;
const sides = new Set(['left', 'right']);

function pageRect(format: ResolvedFormat, side: Side | undefined, area: Area, mode: Mode): Rect {
  const { lenient } = modeOf(format, mode);
  if (!format.facingPages) {
    if (side && !lenient) {
      throw new Error('This format has no facing pages, so a page has no side. Call page(' + (area === 'trim' ? '' : "'" + area + "'") + ') without one.');
    }
    const { trim, bleed, safe } = format;
    if (area === 'trim') return { x: 0, y: 0, width: trim.width, height: trim.height };
    if (area === 'safe') return { x: safe.left, y: safe.top, width: trim.width - safe.left - safe.right, height: trim.height - safe.top - safe.bottom };
    return { x: -bleed.left, y: -bleed.top, width: trim.width + bleed.left + bleed.right, height: trim.height + bleed.top + bleed.bottom };
  }
  if (!side) {
    if (!lenient) throw new Error("This format has facing pages. Name the page: page('left'" + (area === 'trim' ? '' : ", '" + area + "'") + ") or page('right'" + (area === 'trim' ? '' : ", '" + area + "'") + ').');
    side = 'right';
  }
  const { trim, bleed, safe } = format;
  const x = side === 'left' ? 0 : trim.width;
  if (area === 'trim') return { x, y: 0, width: trim.width, height: trim.height };
  if (area === 'safe') {
    const [start, end] = side === 'left' ? [safe.outside, safe.binding] : [safe.binding, safe.outside];
    return { x: x + start, y: safe.top, width: trim.width - start - end, height: trim.height - safe.top - safe.bottom };
  }
  return { x: side === 'left' ? -bleed.outside : x, y: -bleed.top, width: trim.width + bleed.outside, height: trim.height + bleed.top + bleed.bottom };
}

// One page: `page(format, 'left', 'safe')` with facing pages, `page(format, 'safe')` without them.
export function page(format: ResolvedFormat, side?: Side | Area, area?: Area, mode: Mode = {}): Rect {
  const named = side !== undefined && sides.has(side);
  return pageRect(format, named ? side as Side : undefined, (named ? area : side as Area | undefined) ?? 'trim', mode);
}

// Both pages. `safe` keeps the outer, top and bottom insets; content that crosses the fold should leave room for
// the binding itself. A format without facing pages has no spreads.
export function spread(format: ResolvedFormat, area: Area = 'trim', mode: Mode = {}): Rect {
  if (!format.facingPages) {
    if (modeOf(format, mode).lenient) return pageRect(format, undefined, area, mode);
    throw new Error("This format has no facing pages, so there is no spread. Use page(" + (area === 'trim' ? '' : "'" + area + "'") + ') for the page.');
  }
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
export function design(format: ResolvedFormat, canvas: { width: number; height: number }, mode: Mode = {}) {
  if (![canvas.width, canvas.height].every((value) => Number.isFinite(value) && value > 0)) throw new Error('Design canvas dimensions must be positive finite numbers.');
  const sx = format.trim.width / canvas.width, sy = format.trim.height / canvas.height;
  const at = (offset: number) => (x: number, y: number, width: number, height: number): Rect =>
    ({ x: offset + x * sx, y: y * sy, width: width * sx, height: height * sy });
  // Each function checks the format when called, so a template can hold the canvas without calling the other kind.
  const on = (side: Side | undefined) => (x: number, y: number, width: number, height: number) =>
    at(pageRect(format, side, 'trim', mode).x)(x, y, width, height);
  return { left: on('left'), right: on('right'), page: on(undefined), width: (value: number) => value * sx, height: (value: number) => value * sy,
    scaleX: sx, scaleY: sy,
    // Axis is explicit: typography can follow one axis or scale uniformly when the aspect ratio changes.
    length: (value: number, unit: 'mm' | 'pt' | 'px', axis: 'x' | 'y' | 'min' | 'max') => {
      const scale = axis === 'x' ? sx : axis === 'y' ? sy : axis === 'min' ? Math.min(sx, sy) : Math.max(sx, sy);
      return (value * scale).toFixed(2) + unit;
    } };
}

export function css(rect: Rect): CSSProperties {
  return { position: 'absolute', left: rect.x + 'mm', top: rect.y + 'mm', width: rect.width + 'mm', height: rect.height + 'mm' };
}

export const geometry = { page, spread, inset, grid, design, css };

// The helpers with one sheet's format applied, as `ctx.geometry`. `lenient` is set for a layout drawn in a format
// it does not fit.
export function boundGeometry(format: ResolvedFormat, mode: Mode = {}) {
  return {
    page: (side?: Side | Area, area?: Area) => page(format, side, area, mode),
    spread: (area?: Area) => spread(format, area, mode),
    design: (canvas: { width: number; height: number }) => design(format, canvas, mode),
    inset, grid, css,
  };
}
export type BoundGeometry = ReturnType<typeof boundGeometry>;
