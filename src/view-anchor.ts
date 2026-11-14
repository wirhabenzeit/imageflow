import type { BookGeometry, Rect } from './desktop';

type Sheet = BookGeometry['sheets'][number];
export type ViewAnchor = { spread: string; page?: number; x: number; y: number; viewportX: number; viewportY: number };
// The anchor is a position within a sheet, rather than a pixel scroll offset. It survives resizing and reflow.
export function captureViewAnchor(sheets: Sheet[], viewport: Rect, selected?: string, pages: Record<string, number> = {}): ViewAnchor | undefined {
  const visible = (sheet: Sheet) => sheet.y < viewport.y + viewport.height && sheet.y + sheet.height > viewport.y &&
    sheet.x < viewport.x + viewport.width && sheet.x + sheet.width > viewport.x;
  const center = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
  const sheet = sheets.find((sheet) => sheet.spread === selected && visible(sheet)) ?? [...sheets].sort((a, b) => {
    const distance = (sheet: Sheet) => Math.hypot(sheet.x + sheet.width / 2 - center.x, sheet.y + sheet.height / 2 - center.y);
    return distance(a) - distance(b);
  })[0];
  if (!sheet || !viewport.width || !viewport.height || !sheet.width || !sheet.height) return;
  const x = Math.max(sheet.x, Math.min(sheet.x + sheet.width, center.x));
  const y = Math.max(sheet.y, Math.min(sheet.y + sheet.height, center.y));
  return { spread: sheet.spread, page: pages[sheet.spread], x: (x - sheet.x) / sheet.width, y: (y - sheet.y) / sheet.height,
    viewportX: (x - viewport.x) / viewport.width, viewportY: (y - viewport.y) / viewport.height };
}
export function restoreViewAnchor(anchor: ViewAnchor, sheets: Sheet[], size: { width: number; height: number }, pages: Record<string, number[]> = {}) {
  const sheet = sheets.find(({ spread }) => spread === anchor.spread) ?? sheets.find(({ spread }) => anchor.page !== undefined && pages[spread]?.includes(anchor.page));
  return sheet && { left: sheet.x + sheet.width * anchor.x - size.width * anchor.viewportX,
    top: sheet.y + sheet.height * anchor.y - size.height * anchor.viewportY };
}
