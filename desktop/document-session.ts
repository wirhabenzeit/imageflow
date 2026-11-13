import { bookName } from '../src/book-name';
import { SourceStore } from './source-store';
import { captureProjectInputs } from './revisions';
import { sourceEntries } from '../src/source-locations';
import { isUnavailableSource } from '../src/source-diagnostics';
import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, readdir, rm, stat, mkdir, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { channels, desktopScheme, renderOrigin } from '../src/desktop';
import type { BookMenuState, CanvasLayout, ExportMode, ImportRequest, ProjectChange, ProjectSummary, Result } from '../src/desktop';
import { identifier } from '../src/project';
import type { RenderProject } from '../src/project';
import { printBook, saveProof } from './export';
import { approveNetwork, approvedNetwork } from './source-access';
import { rebuildDependencies } from './dependencies';
import { templateFolder } from './document-actions';
import { importIntoProject, loadProject, projectSummary, readProjectManifest } from './project';
import type { OpenProject } from './project';
import { photoExtensions } from './photos';
import { bundledFontNames } from './fonts';
import { isProjectInputPath } from './revisions';
import type { ProjectInputIndex } from './revisions';
import { checkProject } from './check';
import { checkTemplateTypes } from './typecheck';
import type { CheckDraft } from './check';
import { captureBookPreview, checkBookRender } from './preview';
import { ProjectSession } from './project-session';
import { createAuthoringService, AuthoringError } from './authoring-service';
import { AuthoringQueue } from './authoring-queue';
import { authoringErrorResult } from './authoring-errors';
import { ImportReceipts } from './import-receipts';
import { saveDocumentCopy } from './source-actions';
import { acquireProjectLock, CommittedProjectSaveError } from './persistence';
import type { ProjectLock } from './persistence';
import type { AuthoringCheckRequest } from '../src/authoring-check';
import type { McpToolName } from '../src/mcp-contract';
import { renderIdleMs } from '../src/render-budget';

// `network` lists the origins this book's frames may reach now (ADR 0006): its preview, check, export and element
// editor frames. Absent for frames that stay offline, such as template probes.
export type RenderSessions = Map<string, { book: OpenProject; mode: RenderProject['mode']; network?: () => readonly string[] }>;
const viewPath = /^\/render\/([a-f0-9-]{36})(?:\/(.*))?$/;
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'ImageFlow could not complete the request.'; }
async function fingerprint(path: string) {
  try {
    const info = await stat(path, { bigint: true });
    return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch {
    return '';
  }
}


/** A window owns its writer, history, watchers, jobs and agent queue until all work has settled. */
export class DocumentSession {
  active!: { id: string; book: OpenProject };
  busy = false;
  closing = false;
  private closeTask?: Promise<void>;
  readonly projectSession: ProjectSession;
  readonly queue: AuthoringQueue;
  readonly service: ReturnType<typeof createAuthoringService>;
  private exportJob?: AbortController;
  private checkJob?: AbortController;
  private checkJobs = new Set<AbortController>();
  private watcher?: FSWatcher;
  private linkedTimer?: ReturnType<typeof setInterval>;
  private linkedScanRunning = false;
  private linkedReloadPending = false;
  private linkedRetryAt = new Map<string, number>();
  private linkedStamp = new Map<string, string>();
  private linkedWatchers = new Map<string, FSWatcher>();
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private observedChanges = new Set<string>();
  private importedWrites = new ImportReceipts();
  private agentLeases = new Map<string, (allowed: boolean) => void>();
  private renderIds = new Set<string>();
  // The origins this book's frames may reach (ADR 0006), and the template hash they were allowed for. A frame of a
  // book whose template has another hash gets none, so a changed template never inherits an earlier approval.
  private network: { hash?: string; origins: readonly string[] } = { origins: [] };
  private networkPrepared = false;
  private originsFor(book: OpenProject) {
    return book.templateHash && book.templateHash === this.network.hash ? this.network.origins : [];
  }
  /** The network origins the user allowed for this book's template; its render frames may reach them (ADR 0006). */
  get networkOrigins() { return this.originsFor(this.book); }
  private askingNetwork?: Promise<string[]>;
  /** The declared sites the library trusts for a template with this hash (ADR 0006); set by the app. */
  networkTrust?: (hash: string, declared?: readonly string[]) => Promise<string[]>;

  /** Lets the frames reach the origins already allowed for this book's template, or trusted for it, before it renders. */
  async prepareNetwork() {
    const book = this.book;
    const hash = book.templateHash;
    const origins = book.readOnly || !hash ? [] : [...new Set([...await approvedNetwork(book.folder, hash),
      ...await this.networkTrust?.(hash).catch(() => []) ?? []])];
    this.network = { hash, origins };
    this.networkPrepared = true;
  }

  /**
   * Applies a change to what this book may reach: its template changed, or Settings allowed or revoked trust. Open
   * frames are rendered again under the new policy. When origins are withdrawn, a running export or check stops,
   * since its frames loaded under the old policy; export saves nothing and says why.
   */
  async updateNetwork() {
    if (this.closing) return;
    const before = this.network.hash === this.book.templateHash ? this.network.origins : [];
    await this.prepareNetwork();
    if (this.closing) return;
    const after = this.originsFor(this.book);
    if (before.length === after.length && before.every((origin) => after.includes(origin))) return;
    if (before.some((origin) => !after.includes(origin))) {
      const reason = Object.assign(new Error('Network access for this book’s template was withdrawn during the export. No PDF was saved.'), { networkWithdrawn: true });
      this.exportJob?.abort(reason);
      for (const job of this.checkJobs) job.abort(reason);
    }
    this.notify({ value: this.activate(this.book) });
  }
  sidebar = true;
  inspector = true;
  sources = true;
  guides = false;
  menuState?: BookMenuState;
  layout: CanvasLayout = { mode: 'vertical', columns: 2 };

  constructor(readonly window: BrowserWindow, book: OpenProject, private cache: string,
    private renders: RenderSessions, private unlockProject: ProjectLock | undefined,
    private changed?: (book: OpenProject) => void) {
    this.projectSession = new ProjectSession(book);
    this.queue = new AuthoringQueue({ ready: () => !this.busy && !this.closing, maxPending: 32 });
    this.service = createAuthoringService({
      session: () => this.closing ? undefined : this.projectSession, cache, docs: join(app.getAppPath(), 'docs/template-api.md'),
      check: (...args) => this.checkOpenBook(...args),
      changed: (next) => this.notify({ value: this.activate(next) }),
      recovery: (message) => this.notify({ error: message }),
      import: async (request, paths, base) => {
        const result = await this.importFiles(this.window, this.active.id, { ...request, paths }, base);
        if (!result) throw new AuthoringError('PROJECT_CLOSED', 'The book closed before import completed.');
        return { imported: result.imported };
      },
    });
    this.activate(book);
    this.watchProject(book);
    window.webContents.on('will-frame-navigate', (event) => {
      const url = new URL(event.url);
      const match = viewPath.exec(url.pathname);
      if (event.isMainFrame || url.protocol !== desktopScheme + ':' || url.host !== 'render' || !match ||
          match[1] !== this.active.id || match[2]) event.preventDefault();
    });
  }

  get book() { return this.projectSession.book; }
  get summary(): ProjectSummary {
    return { ...projectSummary(this.book, this.active.id), handle: this.projectSession.handle, history: this.projectSession.history,
      network: [...this.networkOrigins] };
  }
  notify(change: ProjectChange) {
    if (!this.closing && !this.window.isDestroyed()) this.window.webContents.send(channels.changed, change);
  }
  async run<T>(task: () => Promise<T>): Promise<Result<T>> {
    if (this.closing) return { error: 'This book is closing.' };
    if (this.busy) return { error: 'ImageFlow is finishing another operation in this book.', code: 'BOOK_BUSY' };
    this.busy = true;
    try { return { value: await task() }; }
    catch (error) {
      if (error instanceof CommittedProjectSaveError) this.notify({ error: error.message });
      return { error: errorMessage(error) };
    } finally { this.busy = false; }
  }
  async relocate(folder: string) {
    if (this.unlockProject && !await this.unlockProject.tryRelocate(folder)) throw new Error('Could not verify the moved book’s writer lock.');
    this.stopWatch();
    this.projectSession.relocate(folder);
    this.projectSession.book = { ...this.book, folder };
    const next = await loadProject(folder, this.cache, this.book.readOnly);
    this.notify({ value: this.activate(next, true) });
    this.watchProject(next);
  }
  async moveTo(destination: string) {
    const original = this.book.folder;
    if (destination === original) return;
    await mkdir(destination); // Exclusive reservation: never replace even an empty existing package.
    try {
      await rename(original, destination);
    } catch (error) {
      await rmdir(destination).catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      const copied = await saveDocumentCopy(this.book, destination, false);
      let release: ProjectLock | undefined;
      try {
        release = await acquireProjectLock(copied);
        const next = await loadProject(copied, this.cache, false);
        this.stopWatch();
        await shell.trashItem(original);
        await this.unlockProject?.();
        this.unlockProject = release; release = undefined;
        this.projectSession.relocate(copied);
        this.notify({ value: this.activate(next) }); this.watchProject(next);
      } catch (error) {
        if (release) { await release(); await rm(copied, { recursive: true, force: true }); }
        this.watchProject(this.book);
        throw error;
      }
      return;
    }
    await this.relocate(destination);
  }
  async reload() {
    const next = await loadProject(this.book.folder, this.cache, this.book.readOnly);
    const summary = this.activate(next, true);
    if (!this.watcher) this.watchProject(next);
    return summary;
  }
  /** Bundles the template's installed packages into template/vendor/ and reloads the book with them (ADR 0006). */
  async rebuildDependencies() {
    if (this.book.readOnly) throw new Error('Create a project to change its template.');
    await rebuildDependencies(await templateFolder(this.book.folder));
    const summary = await this.reload();
    this.notify({ value: summary });
    return summary;
  }
  replyLease(id: string, allowed: boolean) { this.agentLeases.get(id)?.(allowed === true); }
  cancelExport() { this.exportJob?.abort(); }
  cancelCheck() { this.checkJob?.abort(); }
  async agentCall(name: McpToolName, args: Record<string, unknown>, signal: AbortSignal) {
    let requestSignal = signal;
    try {
      return await this.queue.run(async (queuedSignal) => {
        requestSignal = queuedSignal;
        const mutation = name === 'apply_project_changes' || name === 'import_sources';
        let locked = false;
        try {
          if (mutation) await this.agentLease(queuedSignal);
          queuedSignal.throwIfAborted();
          if (mutation) {
            if (this.busy) throw new AuthoringError('EDIT_IN_PROGRESS', 'An editor operation started. Let it finish, then retry.');
            this.busy = true;
            locked = true;
          }
          return await this.service(name, args, queuedSignal);
        } finally {
          if (mutation) {
            if (locked) this.busy = false;
            if (!this.window.isDestroyed()) this.window.webContents.send(channels.agentRelease);
          }
        }
      }, signal);
    } catch (error) { return authoringErrorResult(error, requestSignal); }
  }
  close() {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.stopWatch();
    clearInterval(this.linkedTimer);
    for (const watcher of this.linkedWatchers.values()) watcher.close();
    this.linkedWatchers.clear();
    this.exportJob?.abort();
    for (const job of this.checkJobs) job.abort();
    for (const reply of this.agentLeases.values()) reply(false);
    this.queue.close(new AuthoringError('PROJECT_CLOSED', 'This book closed. Other open books are still available.'));
    this.closeTask = (async () => {
      await this.queue.whenIdle();
      // Published saves must settle before releasing the single-writer capability.
      while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
      try { await this.unlockProject?.(); }
      finally {
        this.unlockProject = undefined;
        for (const id of this.renderIds) this.renders.delete(id);
        await this.projectSession.close();
      }
    })();
    return this.closeTask;
  }
  activate(book: OpenProject, external = false): ProjectSummary {
    if (this.closing) throw new AuthoringError('PROJECT_CLOSED', 'The book window closed.');
    if (external) this.projectSession.adoptExternal(book);
    else this.projectSession.book = book;
    const previous = this.active;
    const id = randomUUID();
    this.active = { id, book };
    // The editor keeps its last ready frames while newer candidates render. Those frames still request lazy photos.
    const retained = new Set([id, previous?.id]);
    for (const frame of this.window?.webContents.mainFrame.framesInSubtree ?? []) {
      const url = frame.url;
      const id = url.startsWith(renderOrigin + '/') ? viewPath.exec(new URL(url).pathname)?.[1] : undefined;
      if (id) retained.add(id);
    }
    for (const [sessionId, { mode }] of this.renders) {
      if (mode === 'edit' && this.renderIds.has(sessionId) && !retained.has(sessionId)) {
        this.renders.delete(sessionId);
        this.renderIds.delete(sessionId);
      }
    }
    this.renderIds.add(id);
    this.renders.set(id, { book, mode: 'edit', network: () => this.originsFor(book) });
    // A changed template gets the approvals for its own hash, if any, and the frames are rendered again with them.
    if (this.networkPrepared && !book.readOnly && book.templateHash !== this.network.hash) queueMicrotask(() => void this.updateNetwork().catch(() => {}));
    this.window.setTitle(bookName(book.folder));
    if (!book.readOnly) this.window.setRepresentedFilename(book.folder);
    this.changed?.(book);
    this.watchLinkedSources(book);
    return this.summary;
  }

  /** Parent-directory watches survive atomic replacement; reconciliation also covers reconnects and missed events. */
  private watchLinkedSources(book: OpenProject) {
    const linked = sourceEntries(book).filter((source) => source.linked && book.sources?.[source.key]?.state !== 'unapproved');
    const desired = new Set(linked.map((source) => dirname(source.path)));
    for (const [path, watcher] of this.linkedWatchers) if (!desired.has(path)) { watcher.close(); this.linkedWatchers.delete(path); }
    const changed = () => { this.projectSession.inputs.invalidate(); void scan(); };
    const scan = async () => {
      if (this.closing || this.linkedScanRunning) return;
      this.linkedScanRunning = true;
      try {
        const current = sourceEntries(this.book).filter((source) => source.linked && this.book.sources?.[source.key]?.state !== 'unapproved');
        let dirty = false;
        for (const source of current) {
          const value = await fingerprint(source.path);
          const previous = this.linkedStamp.get(source.key);
          this.linkedStamp.set(source.key, value);
          if (previous !== undefined && previous !== value) dirty = true;
          if (!dirty && this.book.sources?.[source.key]?.state !== 'available' && Date.now() > (this.linkedRetryAt.get(source.key) ?? 0)) {
            this.linkedRetryAt.set(source.key, Date.now() + 10_000);
            const store = await SourceStore.forBook(this.book.folder, this.cache);
            const probe = await store.resolve(this.book.folder, source);
            if (probe.status.state === 'available') { await store.settled(); dirty = true; }
          }
        }
        if (this.closing) return;
        for (const path of new Set(current.map((source) => dirname(source.path)))) {
          if (this.linkedWatchers.has(path)) continue;
          try {
            const watcher = watch(path, (_event, name) => {
              if (!name || sourceEntries(this.book).some((source) => source.linked && source.path === join(path, String(name)))) changed();
            });
            watcher.on('error', () => { watcher.close(); this.linkedWatchers.delete(path); this.projectSession.inputs.invalidate(); });
            this.linkedWatchers.set(path, watcher);
          } catch { /* Polling retries unavailable locations when their drive reconnects. */ }
        }
        if (dirty) { this.projectSession.inputs.invalidate(); this.linkedReloadPending = true; }
        if (this.linkedReloadPending && !this.busy) {
          // A pending refresh is consumed after a save/export; it must not invent additional source changes.
          await new Promise((resolve) => setTimeout(resolve, 220));
          if (!this.closing && !this.busy) {
            this.linkedReloadPending = false;
            await this.run(async () => {
              this.notify({ building: true });
              try { this.notify({ value: await this.reload() }); }
              catch (error) { this.notify({ error: error instanceof Error ? error.message : String(error) }); throw error; }
            });
          }
        }
      } finally { this.linkedScanRunning = false; }
    };
    if (linked.length && !this.linkedTimer) {
      this.linkedTimer = setInterval(() => { void scan().catch((error) => this.notify({ error: String(error) })); }, 1500);
      this.linkedTimer.unref();
    }
    if (!linked.length && this.linkedTimer) { clearInterval(this.linkedTimer); this.linkedTimer = undefined; this.linkedStamp.clear(); }
    void scan().catch((error) => this.notify({ error: String(error) }));
  }

  stopWatch() {
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
    this.observedChanges.clear();
    this.importedWrites.clear();
  }

  watchProject(book: OpenProject) {
    this.stopWatch();
    if (book.readOnly) return;
    const folder = book.folder;
    const inputs = this.projectSession?.inputs;
    let checkingChanges = false;
    // After a failed reload the editor shows an error, so a revert to the bytes it last loaded must still reload.
    let reloadFailed = false;
    const scheduleReload = (delay = 220) => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(reload, delay);
    }
    const reload = () => {
      const current = this.active;
      const owner = this.window;
      if (current?.book.folder !== folder || !owner || !this.observedChanges.size) return;
      if (this.busy || checkingChanges) {
        scheduleReload(250);
        return;
      }
      const runningWatcher = this.watcher;
      const watching = () => !owner.isDestroyed() && this.watcher === runningWatcher;
      const notify = (change: ProjectChange) => {
        if (watching()) owner.webContents.send(channels.changed, change);
      };
      const files = [...this.observedChanges];
      this.observedChanges.clear();
      checkingChanges = true;
      void (async () => {
        const external = await Promise.all(files.map(async (file) => {
          if (file === 'project.json' || file === 'photos.json') {
            // The event may arrive after an in-app save or manual reload already adopted these exact bytes.
            const source = await readProjectManifest(folder, file).catch(() => undefined);
            return !source || !current.book.manifests[file].equals(source);
          }
          const imported = this.importedWrites.get(file);
          return !imported || await fingerprint(join(folder, file)) !== imported;
        }));
        if (!watching()) return;
        // Comparing receipts must not block edits. Recheck the events if an edit started or changed the active book.
        if (this.busy || this.active !== current) {
          for (const file of files) this.observedChanges.add(file);
          scheduleReload(250);
          return;
        }
        for (const [i, file] of files.entries()) {
          if (!external[i]) {
            const receipt = this.importedWrites.get(file);
            if (receipt) {
              this.importedWrites.consume(file, receipt);
              if (this.observedChanges.has(file)) this.importedWrites.observe(file);
            }
          }
        }
        if (!external.some(Boolean) && !reloadFailed) return;
        this.busy = true;
        try {
          notify({ building: true });
          const next = await loadProject(folder, this.cache).then((book) => ({ book }), (error: unknown) => ({ error: errorMessage(error) }));
          if (!watching() || this.active !== current) return;
          if (this.observedChanges.size) {
            // A newer edit arrived during the build. The debounced reload will read it and resolve the building state.
            for (const [i, file] of files.entries()) if (external[i]) this.observedChanges.add(file);
            return;
          }
          for (const [i, file] of files.entries()) if (external[i]) this.importedWrites.delete(file);
          reloadFailed = 'error' in next;
          notify('error' in next ? { error: next.error } : { value: this.activate(next.book, true) });
        } finally {
          this.busy = false;
        }
      })().catch((error: unknown) => {
        notify({ error: errorMessage(error) });
      }).finally(() => { checkingChanges = false; });
    }
    try {
      const installed = watch(folder, { recursive: true }, (_event, file) => {
        if (this.watcher !== installed || this.projectSession?.inputs !== inputs) return;
        if (!file) {
          inputs?.invalidate();
          this.observedChanges.add('template');
          scheduleReload();
          return;
        }
        if (!isProjectInputPath(file)) return;
        inputs?.invalidate(file);
        this.importedWrites.observe(file);
        this.observedChanges.add(file);
        scheduleReload();
      });
      this.watcher = installed;
      installed.on('error', (error) => {
        if (this.watcher !== installed) return;
        inputs?.invalidate();
        this.window?.webContents.send(channels.changed, { error: 'Book watcher stopped. ' + error.message });
        this.stopWatch();
      });
    } catch (error) {
      inputs?.invalidate();
      this.window?.webContents.send(channels.changed, { error: 'Book watcher could not start. ' + errorMessage(error) });
    }
  }


  currentBook(id: string) {
    if (!this.active || this.active.id !== id) throw new Error('The project changed. Try again using the current project.');
    return this.active.book;
  }

  async importFiles(owner: BrowserWindow, id: string, request: ImportRequest, base?: OpenProject) {
    const current = this.currentBook(id);
    const book = base ?? current;
    if (book.readOnly) throw new Error('Create a project to import files.');
    if (request.kind !== 'photo' && request.kind !== 'markdown' && request.kind !== 'file') throw new Error('Unknown import type.');
    if (request.kind === 'file' && (!Array.isArray(request.accept) || !request.accept.length ||
        !request.accept.every((ext) => typeof ext === 'string' && /^\.[a-z0-9]{1,10}$/.test(ext)) || request.folder)) {
      throw new Error('Invalid file import.');
    }
    if (request.target && (!identifier.safeParse(request.target.box).success || !identifier.safeParse(request.target.spread).success)) {
      throw new Error('Invalid import target.');
    }
    let paths = request.paths;
    if (!paths) {
      const photo = request.kind === 'photo';
      const file = request.kind === 'file';
      const extensions = photo ? [...photoExtensions] : file ? request.accept! : ['.md'];
      const choice = await dialog.showOpenDialog(owner, {
        title: photo ? 'Import Photos' : file ? 'Choose File' : 'Import Markdown',
        properties: request.folder ? ['openDirectory'] : file ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [{ name: photo ? 'Photos' : file ? request.accept!.join(', ') : 'Markdown', extensions: extensions.map((ext) => ext.slice(1)) }],
      });
      if (choice.canceled) return null;
      paths = choice.filePaths;
    }
    const files: string[] = [];
    for (const path of paths) {
      if ((await stat(path)).isDirectory()) {
        const entries = await readdir(path, { recursive: true, withFileTypes: true });
        files.push(...entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
          .map((entry) => join(entry.parentPath, entry.name)));
      } else files.push(path);
    }
    const destination = join(book.folder, request.kind === 'photo' ? 'photos' : request.kind === 'file' ? 'files' : 'texts');
    const createdDirectory = !await fingerprint(destination);
    const { book: next, imported, copied } = await importIntoProject(book, request, [...new Set(files)]);
    for (const file of createdDirectory ? [destination, ...copied] : copied) {
      const path = relative(book.folder, file);
      this.importedWrites.set(path, await fingerprint(file), this.observedChanges.has(path));
    }
    if (owner.isDestroyed()) return null;
    this.projectSession!.adoptExternal(book);
    this.projectSession!.record(next, 'Import sources', !!request.target);
    return { summary: this.activate(next), imported };
  }

  /** The origins the template declares that this book's frames may reach, asking once for new ones (ADR 0006):
   * element editors, and previews, checks and exports that draw <RenderedImage> pictures. Sites allowed for the
   * template's exact version in the library need no question. Declining keeps the frames offline, so such pictures
   * fail and export stops; the question comes back the next time an editor opens or the book opens. When the
   * allowed origins change, the book is rendered again under a new ID, which the summary carries. */
  async editorNetwork(id: string, declared: unknown) {
    const book = this.currentBook(id);
    const origins = Array.isArray(declared) ? [...new Set(declared.filter((origin): origin is string =>
      typeof origin === 'string' && /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/.test(origin)))].slice(0, 20) : [];
    const hash = book.templateHash;
    const before = new Set(this.originsFor(book));
    if (!origins.length || book.readOnly || !hash) { this.network = { hash, origins: [] }; return { origins: [] as string[] }; }
    while (this.askingNetwork) await this.askingNetwork.catch(() => {});
    const ask = (async () => {
      const trusted = await this.networkTrust?.(hash, origins).catch(() => []) ?? [];
      const approved = new Set([...await approvedNetwork(book.folder, hash), ...trusted]);
      const pending = origins.filter((origin) => !approved.has(origin));
      if (pending.length && !this.window.isDestroyed()) {
        const { response } = await dialog.showMessageBox(this.window, {
          type: 'question', buttons: ['Allow', 'Not Now'], defaultId: 0, cancelId: 1,
          message: 'Allow this book’s template to connect to the internet?',
          detail: 'This template loads maps or data from:\n' + pending.join('\n') + '\n\nAllow only templates you trust.',
        });
        if (response === 0) {
          await approveNetwork(book.folder, pending, hash);
          for (const origin of pending) approved.add(origin);
        }
      }
      return origins.filter((origin) => approved.has(origin));
    })();
    this.askingNetwork = ask;
    let allowed: string[];
    try { allowed = await ask; }
    finally { this.askingNetwork = undefined; }
    // The template changed while asking: the answer was for the old one, and the new one is decided afresh.
    if (this.book.templateHash !== hash) return { origins: [] as string[] };
    this.network = { hash, origins: allowed };
    const changed = allowed.length !== before.size || allowed.some((origin) => !before.has(origin));
    return changed && this.active.id === id ? { origins: allowed, summary: this.activate(this.book) } : { origins: allowed };
  }


  async exportBook(owner: BrowserWindow, projectId: string, mode: ExportMode) {
    this.currentBook(projectId);
    const before = await this.projectSession.inputs.capture();
    const privateCache = await mkdtemp(join(this.cache, 'export-'));
    try {
      const book = await loadProject(this.book.folder, privateCache, true, true);
      const loaded = await this.projectSession.inputs.capture();
      if (before.revision !== loaded.revision || before.observation !== loaded.observation) throw new Error('Sources changed while preparing export. Please retry.');
      if (mode !== 'proof' && mode !== 'print') throw new Error('Unknown export mode.');
      const proof = mode === 'proof';
      const fileName = bookName(book.folder).replace(/[^\p{L}\p{N} _-]/gu, '-').slice(0, 80) + (proof ? ' - Proof.pdf' : '.pdf');
      const { canceled, filePath } = await dialog.showSaveDialog(owner, {
        title: proof ? 'Export Proof PDF' : 'Export Print PDF', defaultPath: join(app.getPath('documents'), fileName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath || owner.isDestroyed()) return null;
      const id = randomUUID();
      const job = new AbortController();
      this.exportJob = job;
      this.renders.set(id, { book, mode: 'export', network: () => this.originsFor(book) });
      const progress = (stage: string) => { if (!owner.isDestroyed()) owner.webContents.send(channels.progress, stage); };
      try {
        const fonts = mode === 'print' ? bundledFontNames(book.assets.files) : [];
        const { bytes, warnings, errors } = await printBook(renderOrigin + '/render/' + id, mode, fonts, job.signal, progress);
        if (proof && errors.some(isUnavailableSource)) {
          const choice = await dialog.showMessageBox(owner, { type: 'warning', message: 'Save a proof with unavailable sources?',
            detail: 'This proof may contain cached previews or placeholders. Originals are required for print. Missing-source errors remain in Book check.',
            buttons: ['Cancel', 'Save Proof'], defaultId: 0, cancelId: 0 });
          if (choice.response !== 1) return null;
        }
        const after = await this.projectSession.inputs.capture({ signal: job.signal });
        if (before.revision !== after.revision || before.observation !== after.observation) throw new Error('Sources changed during export. No PDF was saved; retry after the external save finishes.');
        progress('Saving PDF…');
        await saveProof(filePath, bytes, job.signal);
        return { warnings, errors };
      } catch (error) {
        if ((job.signal.reason as { networkWithdrawn?: boolean })?.networkWithdrawn) throw job.signal.reason;
        if (job.signal.aborted) return null;
        throw error;
      } finally {
        this.exportJob = undefined;
        this.renders.delete(id);
      }
    } finally { await rm(privateCache, { recursive: true, force: true }); }
  }

  async checkOpenBook(book: OpenProject, request: AuthoringCheckRequest, externalSignal?: AbortSignal,
    inputs: ProjectInputIndex | undefined = this.projectSession?.book.folder === book.folder ? this.projectSession.inputs : undefined, draft?: CheckDraft) {
    const renditions = this.projectSession?.inputs === inputs ? this.projectSession?.renditions : undefined;
    const job = new AbortController();
    // The check may take as long as its renders keep making progress (render-budget); it times out only when they
    // stall for longer than a waiting render allows, or other work stalls as long.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => job.abort(new Error('The authoring check timed out.')), renderIdleMs('check') + 30_000);
    };
    arm();
    this.checkJobs.add(job);
    if (!externalSignal) this.checkJob = job;
    try {
      return await checkProject(book, this.cache, request, async (snapshot, preview, signal, inspect) => {
        const id = randomUUID();
        this.renders.set(id, { book: snapshot, mode: 'export', network: () => this.originsFor(snapshot) });
        try {
          const url = renderOrigin + '/render/' + id;
          if (preview) {
            const image = await captureBookPreview(url, preview, signal, inspect, arm);
            return { status: image.status, preview: image };
          }
          return { status: await checkBookRender(url, signal, inspect, arm) };
        } finally {
          this.renders.delete(id);
        }
      }, externalSignal ? AbortSignal.any([job.signal, externalSignal]) : job.signal, inputs, renditions, draft,
      (folder, signal) => checkTemplateTypes(folder, signal, app.getAppPath()));
    } finally {
      clearTimeout(timeout);
      if (this.checkJob === job) this.checkJob = undefined;
      this.checkJobs.delete(job);
    }
  }


  async agentLease(signal: AbortSignal) {
    const owner = this.window;
    if (!owner || owner.isDestroyed()) throw new AuthoringError('PROJECT_CLOSED', 'Open a book in ImageFlow first.');
    const id = randomUUID();
    const allowed = await new Promise<boolean>((resolve) => {
      const finish = (allowed: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.agentLeases.delete(id);
        resolve(allowed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), 3000);
      this.agentLeases.set(id, finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return finish(false);
      owner.webContents.send(channels.agentLease, id);
    });
    signal.throwIfAborted();
    if (!allowed) throw new AuthoringError('EDIT_IN_PROGRESS', 'Finish or close the active editor in ImageFlow, then retry. No changes were made.');
  }


}
