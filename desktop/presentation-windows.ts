import { BrowserWindow, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { bookName } from '../src/book-name';
import { presentationURL } from '../src/desktop';
import type { DocumentSession } from './document-session';
import { coverInstance } from '../src/project';

type Entry = { document: DocumentSession; window: BrowserWindow; spread: string };
// A spread of the book, or its exterior cover once it has one.
const presentable = (document: DocumentSession, spread: string) =>
  spread === coverInstance ? !!document.book.project.cover : document.book.project.spreads.some(({ id }) => id === spread);

// A presentation is a read-only view of one open book. Its fullscreen state never belongs to the editor.
export class PresentationWindows {
  private entries = new Map<DocumentSession, Entry>();
  constructor(private options: {
    hidden(): boolean;
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
    if (!presentable(document, spread)) throw new Error('Choose a spread to present.');
    const existing = this.entries.get(document);
    if (existing) { this.options.focus(existing.window); return; }
    // Simple fullscreen changes application-wide menu/Dock options. Finish the previous presentation before
    // starting another book's, so the saved macOS options cannot be restored out of order.
    for (const entry of this.entries.values()) entry.window.close();
    const display = screen.getDisplayMatching(document.window.getBounds());
    const mac = process.platform === 'darwin';
    const options = this.options.window();
    // macOS reports a covered window as hidden, and Chromium then neither lays out a new frame in it (every box of a
    // revision measures 0 × 0, "has no area") nor runs its timers at speed. The full-screen presentation covers its
    // editor, whose reload after a file change must still finish so saves go through; and the presentation itself
    // renders new revisions while the user works in another app. Neither window is throttled while it presents.
    const throttled = document.window.webContents.getBackgroundThrottling();
    document.window.webContents.setBackgroundThrottling(false);
    // Start at the final screen bounds, without a frame. Simple fullscreen only hides the menu bar and Dock;
    // there is no visible resize or macOS Space transition, and the editor remains exactly where it was.
    const window = new BrowserWindow({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false },
      ...display.bounds, title: 'Presentation — ' + bookName(document.book.folder),
      frame: false, show: false, backgroundColor: '#111111', roundedCorners: false, hasShadow: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: !mac, fullscreen: !mac && !this.options.hidden() });
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
      if (!document.window.isDestroyed()) document.window.webContents.setBackgroundThrottling(throttled);
      if (!document.closing && !document.window.isDestroyed()) this.options.closed(document, entry.spread);
    });
    // Call the simple-fullscreen API directly. The generic fullscreen constructor path marks an asynchronous
    // native transition pending, which simple fullscreen never completes and can leave Close Window waiting.
    if (mac && !this.options.hidden()) window.setSimpleFullScreen(true);
    // As with document windows, loadURL can complete without a ready-to-show notification on macOS.
    void window.loadURL(presentationURL).then(() => this.options.focus(window)).catch((error) => {
      if (window.isDestroyed() || document.closing || document.window.isDestroyed()) return;
      window.close();
      this.options.error(document, error);
    });
  }
  select(entry: Entry, spread: unknown) {
    if (typeof spread === 'string' && presentable(entry.document, spread)) entry.spread = spread;
  }
  close(document: DocumentSession) { this.entries.get(document)?.window.close(); }
}
