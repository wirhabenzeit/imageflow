import type { BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { Rect } from '../src/desktop';

type MacHeader = { configure(handle: Buffer): void; setDragRegions(handle: Buffer, regions: Rect[]): void };
const macHeader = () => require(join(__dirname, 'native', 'mac-header.node')) as MacHeader;

export function validToolbarDragRegions(value: unknown): value is Rect[] {
  return Array.isArray(value) && value.length <= 128 && value.every((rect) => rect &&
    ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key])) &&
    rect.x >= 0 && rect.y >= 0 && rect.width >= 0 && rect.height >= 0 && rect.x + rect.width <= 32768 && rect.y + rect.height <= 200);
}

export function setToolbarDragRegions(window: BrowserWindow, value: unknown) {
  if (process.platform !== 'darwin' || !validToolbarDragRegions(value)) return;
  const zoom = window.webContents.getZoomFactor();
  macHeader().setDragRegions(window.getNativeWindowHandle(), value.map(({ x, y, width, height }) =>
    ({ x: x * zoom, y: y * zoom, width: width * zoom, height: height * zoom })));
}

export function configureMacHeader(window: BrowserWindow) {
  if (process.platform === 'darwin') macHeader().configure(window.getNativeWindowHandle());
}
