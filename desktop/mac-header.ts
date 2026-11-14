import type { BrowserWindow } from 'electron';
import { join } from 'node:path';

export function configureMacHeader(window: BrowserWindow) {
  if (process.platform !== 'darwin') return;
  const header = require(join(__dirname, 'native', 'mac-header.node')) as { configure(handle: Buffer): void };
  header.configure(window.getNativeWindowHandle());
}
