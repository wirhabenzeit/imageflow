import { BrowserWindow, dialog } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { basename } from 'node:path';
import { MarkdownBuffer } from './markdown-buffer';
import { readMarkdownFile, writeMarkdownFile } from './markdown-file';
import { createMarkdownSource, relocateSource } from './source-actions';
import { textSourcePath } from './document-actions';
import { channels, markdownURL } from '../src/desktop';
import type { MarkdownAction, MarkdownState } from '../src/desktop';
import type { DocumentSession } from './document-session';

type Entry = { document: DocumentSession; id: string; window: BrowserWindow; buffer: MarkdownBuffer;
  poll: ReturnType<typeof setInterval>; closing: boolean; closeTask?: Promise<boolean>; acknowledge?: () => void };

/** All editor capabilities are bound to one registered source and one authorized book. */
export class MarkdownWindows {
  private entries = new Set<Entry>();
  private refreshes = new Map<DocumentSession, ReturnType<typeof setTimeout>>();
  constructor(private options: { window(): Electron.BrowserWindowConstructorOptions; secure(window: BrowserWindow): void;
    focus(window: BrowserWindow): void; focused(document: DocumentSession): void }) {}
  windows() { return [...this.entries].map(({ window }) => window); }
  documentFor(window: BrowserWindow) { return [...this.entries].find((entry) => entry.window === window)?.document; }
  owner(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
    return [...this.entries].find(({ window }) => !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === markdownURL);
  }
  private publish(entry: Entry, state = entry.buffer.state) {
    if (entry.window.isDestroyed()) return;
    entry.window.setDocumentEdited(state.dirty);
    entry.window.webContents.send(channels.markdownChanged, { ...state, closing: entry.closing });
  }
  private refreshBook(document: DocumentSession) {
    clearTimeout(this.refreshes.get(document));
    const refresh = async () => {
      this.refreshes.delete(document);
      if (document.closing) return;
      const result = await document.run(async () => document.notify({ value: await document.reload() }));
      if ('error' in result && result.code === 'BOOK_BUSY') this.refreshes.set(document, setTimeout(() => void refresh(), 200));
      else if ('error' in result) document.notify(result);
    };
    this.refreshes.set(document, setTimeout(() => void refresh(), 100));
  }
  async open(document: DocumentSession, request: { id: string } | { name: string }) {
    if (document.book.readOnly) throw new Error('Create an editable book before editing text.');
    let id: string;
    if ('id' in request) {
      id = request.id;
      const existing = [...this.entries].find((entry) => entry.document === document && entry.id === id);
      if (existing) { this.options.focus(existing.window); return; }
      const source = document.book.project.texts[id];
      if (!source) throw new Error('This text source is no longer registered.');
      if (typeof source !== 'string' && source.linked) {
        const choice = await dialog.showMessageBox(document.window, { type: 'question', message: 'Edit this external Markdown source?',
          detail: source.path + '\n\nEdit external saves changes to the original file. Copy first edits a copy inside this book and keeps all existing placements.',
          buttons: ['Edit external', 'Copy first', 'Abort'], defaultId: 1, cancelId: 2 });
        if (choice.response === 2) return;
        if (choice.response === 1) {
          const next = await relocateSource(document.book, 'markdown:' + id, undefined, true);
          document.projectSession.record(next, 'Copy text into book', false);
          document.notify({ value: document.activate(next) });
        }
      }
    } else {
      const created = await createMarkdownSource(document.book, request.name);
      id = created.id;
      document.projectSession.record(created.book, 'Create text source');
      document.notify({ value: document.activate(created.book) });
    }
    const reference = JSON.stringify(document.book.project.texts[id]);
    const folder = document.book.folder;
    const validate = async () => {
      if (document.closing || document.book.readOnly) throw new Error('This book is no longer editable.');
      const source = document.book.project.texts[id];
      if (!source || document.book.folder !== folder || JSON.stringify(source) !== reference) throw new Error('This source was removed or moved. Keep your text here and reopen the source before editing it further.');
      return textSourcePath(folder, source, id);
    };
    const path = await validate();
    const initial = await readMarkdownFile(path);
    const window = new BrowserWindow({ ...this.options.window(), title: basename(path) + ' — Markdown',
      width: 1060, height: 720, minWidth: 680, minHeight: 420, show: false, parent: document.window });
    this.options.secure(window);
    window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    const entry: Entry = { document, id, window, closing: false, poll: undefined!, buffer: undefined! };
    entry.buffer = new MarkdownBuffer({ id, name: basename(path).replace(/^tx-[a-f0-9-]{12}-/, ''), path,
      external: typeof document.book.project.texts[id] !== 'string' }, initial, {
      read: async () => {
        if (await validate() !== path) throw new Error('The source location changed. Reopen its editor.');
        return readMarkdownFile(path);
      },
      write: async (expected, text) => {
        for (let attempt = 0; ; attempt++) {
          const result = await document.run(async () => writeMarkdownFile(path, expected, text, validate));
          if ('value' in result) break;
          if (result.code !== 'BOOK_BUSY' || attempt >= 50) throw new Error(result.error);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        document.projectSession.inputs.invalidate();
        this.refreshBook(document);
      },
    }, (state) => this.publish(entry, state));
    entry.poll = setInterval(() => { if (!entry.closing) void entry.buffer.refresh(); }, 1000);
    this.entries.add(entry);
    window.on('focus', () => { this.options.focused(document); void entry.buffer.refresh(); });
    window.on('close', (event) => {
      event.preventDefault();
      void this.closeEntry(entry).catch((error) => {
        entry.closing = false; this.publish(entry);
        console.error('Could not close the Markdown editor', error);
      });
    });
    window.once('closed', () => { clearInterval(entry.poll); entry.buffer.dispose(); this.entries.delete(entry); });
    window.once('ready-to-show', () => this.options.focus(window));
    try { await window.loadURL(markdownURL); }
    catch (error) { window.destroy(); throw error; }
  }
  async action(entry: Entry, request: MarkdownAction) {
    if (!request || typeof request !== 'object') throw new Error('Invalid Markdown request.');
    if (request.action === 'change' || request.action === 'closing') {
      if (typeof request.text !== 'string' || !Number.isSafeInteger(request.version) || request.version < (request.action === 'closing' ? 0 : 1)) throw new Error('Invalid Markdown edit.');
      if (!entry.closing || request.action === 'closing') entry.buffer.change(request.text, request.version);
      if (request.action === 'closing') entry.acknowledge?.();
    } else if (request.action === 'save') await entry.buffer.flush();
    else if ((request.action === 'reload' || request.action === 'keep') && typeof request.conflict === 'string') await entry.buffer.resolve(request.action, request.conflict);
    else if (request.action !== 'state') throw new Error('Unknown Markdown action.');
    return { ...entry.buffer.state, closing: entry.closing };
  }
  private closeEntry(entry: Entry): Promise<boolean> {
    if (entry.closeTask) return entry.closeTask;
    entry.closeTask = (async () => {
      entry.closing = true; this.publish(entry);
      // Drain the renderer's latest input before flushing, including IPC still in flight when Close was clicked.
      const acknowledged = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { entry.acknowledge = undefined; resolve(false); }, 2500);
        entry.acknowledge = () => { clearTimeout(timer); entry.acknowledge = undefined; resolve(true); };
        entry.window.webContents.send(channels.markdownPrepareClose);
      });
      await entry.buffer.flush();
      if (!acknowledged || entry.buffer.state.dirty) {
        const answer = await dialog.showMessageBox(entry.window, { type: 'warning', message: 'This text could not finish saving.',
          detail: entry.buffer.state.conflict !== undefined ? 'The file changed outside ImageFlow. Return to the editor to resolve the conflict.' : entry.buffer.state.error ?? 'Return to the editor to retry, or explicitly discard pending changes.',
          buttons: ['Return to Editor', 'Discard Changes'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) { entry.closing = false; this.publish(entry); this.options.focus(entry.window); return false; }
      }
      entry.window.destroy();
      return true;
    })().finally(() => { entry.closeTask = undefined; });
    return entry.closeTask;
  }
  async closeFor(document: DocumentSession) {
    for (const entry of [...this.entries].filter((entry) => entry.document === document)) if (!await this.closeEntry(entry)) return false;
    clearTimeout(this.refreshes.get(document)); this.refreshes.delete(document);
    return true;
  }
}
