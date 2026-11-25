import type { BookGeometry, Rect } from './desktop';

type Sheet = BookGeometry['sheets'][number];
export type ViewAnchor = { spread: string; page?: number; x: number; y: number; viewportX: number; viewportY: number;
  /** The pointer's place in the viewport, in pixels, for an anchor taken at one. */
  pointer?: { x: number; y: number } };
// The anchor is a position within a sheet, rather than a pixel scroll offset. It survives resizing and reflow. One taken at
// the pointer stays under it: zooming in may add a scrollbar, and the viewport it then is a part of is smaller.
export function captureViewAnchor(sheets: Sheet[], viewport: Rect, selected?: string, pages: Record<string, number> = {}, point?: { x: number; y: number }): ViewAnchor | undefined {
  const center = point ?? { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
  const containsCenter = (sheet: Sheet) => center.x >= sheet.x && center.x <= sheet.x + sheet.width && center.y >= sheet.y && center.y <= sheet.y + sheet.height;
  const sheet = sheets.find((sheet) => sheet.spread === selected && containsCenter(sheet)) ?? sheets.find(containsCenter) ?? [...sheets].sort((a, b) => {
    const distance = (sheet: Sheet) => Math.hypot(sheet.x + sheet.width / 2 - center.x, sheet.y + sheet.height / 2 - center.y);
    return distance(a) - distance(b);
  })[0];
  if (!sheet || !viewport.width || !viewport.height || !sheet.width || !sheet.height) return;
  const x = point?.x ?? Math.max(sheet.x, Math.min(sheet.x + sheet.width, center.x));
  const y = point?.y ?? Math.max(sheet.y, Math.min(sheet.y + sheet.height, center.y));
  return { spread: sheet.spread, page: pages[sheet.spread], x: (x - sheet.x) / sheet.width, y: (y - sheet.y) / sheet.height,
    viewportX: (x - viewport.x) / viewport.width, viewportY: (y - viewport.y) / viewport.height,
    ...(point ? { pointer: { x: point.x - viewport.x, y: point.y - viewport.y } } : {}) };
}
export function restoreViewAnchor(anchor: ViewAnchor, sheets: Sheet[], size: { width: number; height: number }, pages: Record<string, number[]> = {}) {
  const sheet = sheets.find(({ spread }) => spread === anchor.spread) ?? sheets.find(({ spread }) => anchor.page !== undefined && pages[spread]?.includes(anchor.page));
  return sheet && { left: sheet.x + sheet.width * anchor.x - (anchor.pointer?.x ?? size.width * anchor.viewportX),
    top: sheet.y + sheet.height * anchor.y - (anchor.pointer?.y ?? size.height * anchor.viewportY) };
}

/** The renderer lays out at Fit. Scale its measured rectangles for canvas overlays and hit testing. */
export function scaleBookGeometry(geometry: BookGeometry, zoom: number): BookGeometry {
  if (zoom === 1) return geometry;
  const scale = <T extends Rect>(rect: T): T => ({ ...rect, x: rect.x * zoom, y: rect.y * zoom,
    width: rect.width * zoom, height: rect.height * zoom });
  return { ...geometry, width: geometry.width * zoom, height: geometry.height * zoom,
    sheets: geometry.sheets.map(sheet => ({ ...scale(sheet), zoom: (sheet.zoom ?? 1) * zoom })),
    boxes: geometry.boxes.map(scale), targets: geometry.targets.map(scale) };
}
