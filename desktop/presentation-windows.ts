import { BrowserWindow, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { bookName } from '../src/book-name';
import { presentationURL } from '../src/desktop';
import type { DocumentSession } from './document-session';

type Entry = { document: DocumentSession; window: BrowserWindow; spread: string };

// A presentation is a read-only view of one open book. Its fullscreen state never belongs to the editor.
export class PresentationWindows {
  private entries = new Map<DocumentSession, Entry>();
  constructor(private options: {
    window(): Electron.BrowserWindowConstructorOptions;
    secure(window: BrowserWindow): void;
    focus(window: BrowserWindow): void;
    focused(document: DocumentSession): void;
    closed(document: DocumentSession, spread: string): void;
    error(document: DocumentSession, error: unknown): void;
  }) {}
  documentFor(window: BrowserWindow) { return [...this.entries.values()].find((entry) => entry.window === window)?.document; }
  owner(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
    return [...this.entries.values()].find(({ window }) => !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === presentationURL);
  }
  show(document: DocumentSession, spread: string) {
    if (document.closing || document.window.isDestroyed()) throw new Error('This book is closing.');
    if (!document.book.project.spreads.some(({ id }) => id === spread)) throw new Error('Choose a spread to present.');
    const existing = this.entries.get(document);
    if (existing) { this.options.focus(existing.window); return; }
    // Simple fullscreen changes application-wide menu/Dock options. Finish the previous presentation before
    // starting another book's, so the saved macOS options cannot be restored out of order.
    for (const entry of this.entries.values()) entry.window.close();
    const display = screen.getDisplayMatching(document.window.getBounds());
    const mac = process.platform === 'darwin';
    // Start at the final screen bounds, without a frame. Simple fullscreen only hides the menu bar and Dock;
    // there is no visible resize or macOS Space transition, and the editor remains exactly where it was.
    const window = new BrowserWindow({ ...this.options.window(), ...display.bounds, title: 'Presentation — ' + bookName(document.book.folder),
      frame: false, show: false, backgroundColor: '#111111', roundedCorners: false, hasShadow: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: !mac, fullscreen: !mac });
    const entry = { document, window, spread };
    this.entries.set(document, entry);
    this.options.secure(window);
    window.on('page-title-updated', (event) => event.preventDefault());
    document.attachViewer(window);
    window.on('focus', () => this.options.focused(document));
    window.once('ready-to-show', () => this.options.focus(window));
    window.on('close', () => {
      // Restore macOS application presentation options while this disposable window still exists.
      window.hide();
      if (mac && window.isSimpleFullScreen()) window.setSimpleFullScreen(false);
    });
    window.once('closed', () => {
      if (this.entries.get(document) === entry) this.entries.delete(document);
      if (!document.closing && !document.window.isDestroyed()) this.options.closed(document, entry.spread);
    });
    // Call the simple-fullscreen API directly. The generic fullscreen constructor path marks an asynchronous
    // native transition pending, which simple fullscreen never completes and can leave Close Window waiting.
    if (mac) window.setSimpleFullScreen(true);
    void window.loadURL(presentationURL).catch((error) => {
      if (window.isDestroyed() || document.closing || document.window.isDestroyed()) return;
      window.close();
      this.options.error(document, error);
    });
  }
  select(entry: Entry, spread: unknown) {
    if (typeof spread === 'string' && entry.document.book.project.spreads.some(({ id }) => id === spread)) entry.spread = spread;
  }
  close(document: DocumentSession) { this.entries.get(document)?.window.close(); }
}
