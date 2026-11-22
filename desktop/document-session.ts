import { bookName } from '../src/book-name';
import { agentFootprint } from '../src/agent-footprint';
import type { AgentFootprint } from '../src/agent-footprint';
import { SourceStore } from './source-store';
import { sourceEntries } from '../src/source-locations';
import type { FileSourceEntry, PhotoSourceEntry, SourceEntry } from '../src/source-locations';
import { isFileLocator } from '../src/source-locator';
import type { Locator } from '../src/source-locator';
import { providerOf } from './providers';
import { providedChanges } from './provided-photos';
import type { Revisions, SourceProvider, SourceRef } from './source-provider';
import { assetPageLabels, assetUsage } from '../src/asset-usage';
import { watchLinkedFiles } from './providers/files';
import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { lstat, mkdtemp, readdir, rm, stat, mkdir, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { channels, desktopScheme, issueText, renderOrigin, renderOrigins } from '../src/desktop';
import type { AgentLeaseReply, BookMenuState, CanvasLayout, ImportRequest, Issue, ProjectChange, ProjectSummary, Result } from '../src/desktop';
import { coverInstance, identifier } from '../src/project';
import { parseActiveEditor } from '../src/mcp-results';
import type { RenderProject } from '../src/project';
import { printBook, savePdf } from './export';
import { approveNetwork, approvedNetwork, bookTrusted, trustBook } from './source-access';
import { importIntoProject, loadProject, projectSummary, readProjectManifest } from './project';
import type { ImportProgress } from './project';
import type { OpenProject } from './project';
import { photoExtensions } from './photos';
import { bundledFontNames } from './fonts';
import { captureBookStateRevision, isProjectInputPath } from './revisions';
import type { ProjectInputIndex } from './revisions';
import { checkProject } from './check';
import { checkTemplateTypes } from './typecheck';
import type { CheckDraft } from './check';
import { captureBookPreview, checkBookRender, checkCoverRender } from './preview';
import { ProjectSession } from './project-session';
import { createAuthoringService, AuthoringError } from './authoring-service';
import type { McpClientSession } from './mcp-connection';
import { AuthoringQueue } from './authoring-queue';
import { authoringErrorResult } from './authoring-errors';
import { ImportReceipts } from './import-receipts';
import { renameSource, saveDocumentCopy } from './source-actions';
import { rebuildTemplateDependencies } from './dependency-install';
import type { DependencyRebuild } from './dependency-install';
import { AssetFacts } from './asset-facts';
import { describeLocalChange, describeSync, downloadOriginals, syncBook } from './sync-engine';
import type { SyncOptions, SyncOutcome } from './sync-engine';
import { remoteCommits } from './sync-remote';
import type { SyncRemote } from './sync-remote';
import { FolderRemote } from './sync-remote-folder';
import { readSyncState, takeAbandonedAtOpen, updateSyncState } from './sync-pull';
import type { CommitHeader } from '../src/sync-snapshot';
import type { SyncView } from '../src/desktop';
import { acquireProjectLock, CommittedProjectSaveError } from './persistence';
import type { ProjectLock, SaveCheckpoint } from './persistence';
import type { AuthoringCheckRequest } from '../src/authoring-check';
import type { McpToolName } from '../src/mcp-contract';
import { renderIdleMs } from '../src/render-budget';
import { previewPictures } from './preview-picture-cache';

// `network` lists the origins this book's frames may reach now (ADR 0006): its preview, check, export and element
// editor frames. Absent for frames that stay offline, such as template probes. `photos: 'preview'` serves the editor's
// screen-sized photo renditions to an export-mode render that only makes a small picture, such as a book cover, instead
// of re-encoding every original at print resolution.
export type RenderSessions = Map<string, { book: OpenProject; mode: RenderProject['mode']; network?: () => readonly string[];
  photos?: 'preview'; pictures?: ReturnType<typeof previewPictures.view>; pictureScope?: string }>;
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
// The export confirmation names the first few errors; Book check lists them all.
const shownExportErrors = 8;
function exportErrorList(errors: Issue[]) {
  const shown = errors.slice(0, shownExportErrors).map(issueText);
  const more = errors.length - shown.length;
  return shown.join('\n') + (more > 0 ? '\n…and ' + more + ' more ' + (more === 1 ? 'error' : 'errors') + ' in Book check.' : '');
}

/** Asks which of several versions on the remote to continue with. At most four fit; Cancel follows them and answers nothing. */
export async function chooseSyncTip(owner: BrowserWindow, tips: CommitHeader[]) {
  const shown = tips.slice(0, 4);
  const label = (tip: CommitHeader) => tip.title + ' · ' + new Date(tip.createdAt).toLocaleString();
  const { response } = await dialog.showMessageBox(owner, {
    type: 'question', buttons: [...shown.map(label), 'Cancel'], cancelId: shown.length, defaultId: 0,
    message: 'This book was changed on two Macs.',
    detail: 'Choose the version to continue with. Your version on this Mac is kept as a separate copy beside the book if it is not one of them.' +
      (tips.length > shown.length ? ' ' + (tips.length - shown.length) + ' older ' + (tips.length - shown.length === 1 ? 'version is' : 'versions are') + ' not shown.' : ''),
  });
  return shown[response]?.commitId;
}

/** What a finished sync did, for the status bar. */
export function describeOutcome(outcome: SyncOutcome) {
  const copy = outcome.conflictCopy ? ' This Mac’s version was kept as “' + basename(outcome.conflictCopy).replace(/\.imageflow$/i, '') + '”.' : '';
  const text = outcome.action === 'diverged' && !outcome.pulled ? 'Not synced: the book has several versions. Sync again to choose one.'
    : outcome.action === 'diverged' ? 'Synced: continued with the version from the sync folder.' + copy
    : outcome.action === 'fast-forward' ? 'Synced: took the changes from the sync folder' + (outcome.pushed.length ? ' and sent this Mac’s.' : '.')
    : outcome.action === 'initial-push' || outcome.action === 'push' || outcome.pushed.length ? 'Synced: sent the changes to the sync folder.'
    : 'Synced: the book is up to date.';
  const originals = outcome.originals?.pending ? ' Originals are still to be downloaded: ' + outcome.originals.pending
    : outcome.originals?.downloaded.length ? ' Downloaded ' + outcome.originals.downloaded.length + (outcome.originals.downloaded.length === 1 ? ' original.' : ' originals.') : '';
  return text + originals;
}

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
  private linkedWatch?: { signature: string; stop: () => void };
  private linkedGeneration = 0;
  private linkedReloadPending = false;
  private linkedReloading = false;
  private linkedRetry?: ReturnType<typeof setTimeout>;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private observedChanges = new Set<string>();
  private importedWrites = new ImportReceipts();
  private agentLeases = new Map<string, (reply: AgentLeaseReply) => void>();
  private renderIds = new Set<string>();
  // This window's share of the pictures cache all book windows use; closing the book releases it.
  private previewPictures = previewPictures.view(randomUUID());
  // The origins this book's frames may reach (ADR 0006), and the template hash they were last decided for. They
  // belong to the book: a changed template keeps them, and only origins it newly declares need a question.
  private network: { hash?: string; origins: readonly string[] } = { origins: [] };
  private networkPrepared = false;
  private originsFor(_book: OpenProject) {
    return this.network.origins;
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
    const origins = !hash ? [] : [...new Set([...await approvedNetwork(book.folder),
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
    const before = this.network.origins;
    // A local edit of the template keeps what its previous version could reach, including sites the library or a
    // built-in trusted for that exact version: they become this book's own approval, so editing never asks again.
    if (this.networkPrepared && before.length && this.network.hash !== this.book.templateHash) {
      await approveNetwork(this.book.folder, before, this.network.hash).catch((error) => console.warn('ImageFlow could not keep network approvals', error));
    }
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

  private viewers = new Set<BrowserWindow>();
  constructor(readonly window: BrowserWindow, book: OpenProject, private cache: string,
    private renders: RenderSessions, private unlockProject: ProjectLock | undefined,
    private changed?: (book: OpenProject) => void) {
    this.projectSession = new ProjectSession(book);
    this.queue = new AuthoringQueue({ ready: () => !this.busy && !this.closing, maxPending: 32 });
    this.service = createAuthoringService({
      session: () => this.closing ? undefined : this.projectSession, cache, docs: join(app.getAppPath(), 'docs'),
      activeEditor: () => parseActiveEditor(this.menuState?.activeEditor),
      check: (...args) => this.checkOpenBook(...args),
      changed: (next) => this.notify({ value: this.activate(next) }),
      recovery: (message) => this.notify({ error: message }),
      dependencies: (signal) => this.rebuildDependencies(signal),
      authoringTypes: () => this.authoringTypes,
      import: async (request, paths, base, checkpoint) => {
        const result = await this.importFiles(this.window, this.active.id, { ...request, paths }, base, false, checkpoint);
        if (!result) throw new AuthoringError('PROJECT_CLOSED', 'The book closed before import completed.');
        return { imported: result.imported };
      },
      // As Rename… in the Assets panel: a change of the source's location, not an Undo step.
      rename: async (key, name, base, checkpoint) => {
        const next = await renameSource(base, key, name, checkpoint);
        if (next !== base) this.projectSession!.record(next, 'Source location changed', false);
        return next;
      },
    });
    this.guardNavigation(window);
    // Watch from the moment the book was read, so edits made while the editor is still loading are not missed.
    this.watchProject(book);
  }
  /** Publishes the first revision once the editor can receive it; reloads seen before then wait for it. */
  start() {
    this.activate(this.book);
    void this.refreshSync().catch((error) => console.warn('ImageFlow could not read the sync status', error));
  }
  private guardNavigation(window: BrowserWindow) {
    window.webContents.on('will-frame-navigate', (event) => {
      const url = new URL(event.url);
      const match = viewPath.exec(url.pathname);
      if (event.isMainFrame || url.protocol !== desktopScheme + ':' || (url.host !== 'render' && url.host !== 'thumbs') || !match ||
          match[1] !== this.active?.id || match[2]) event.preventDefault();
    });
  }

  attachViewer(window: BrowserWindow) {
    this.viewers.add(window);
    this.guardNavigation(window);
    window.once('closed', () => this.viewers.delete(window));
  }

  get book() { return this.projectSession.book; }
  get summary(): ProjectSummary {
    return { ...projectSummary(this.marked(this.book), this.active.id), handle: this.projectSession.handle, history: this.projectSession.history,
      network: [...this.networkOrigins], pageLabels: this.menuState?.pageLabels, coverBoxIds: this.menuState?.coverBoxIds };
  }
  notify(change: ProjectChange) {
    if (!this.closing && !this.window.isDestroyed()) this.window.webContents.send(channels.changed, change);
    // activate publishes every new revision, including saves returned directly to the editor through IPC.
    if (!('value' in change)) this.publishViewers(change);
  }
  private publishViewers(change: ProjectChange) {
    if (!this.closing) for (const viewer of this.viewers) {
      if (!viewer.isDestroyed()) viewer.webContents.send(channels.changed, change);
    }
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
    // The old folder's facts are written and released before the directory is gone from under them.
    await AssetFacts.release(this.book.folder).catch(() => {});
    this.projectSession.relocate(folder);
    this.projectSession.book = { ...this.book, folder };
    const next = await loadProject(folder, this.cache);
    this.notify({ value: this.activate(next, true) });
    this.watchProject(next);
  }
  async moveTo(destination: string) {
    const original = this.book.folder;
    if (destination === original) return;
    await mkdir(destination); // Exclusive reservation: never replace even an empty existing package.
    // Flush and release the facts of the old folder while it is still there; the new folder gets its own afterwards.
    await AssetFacts.release(original).catch(() => {});
    try {
      await rename(original, destination);
    } catch (error) {
      await rmdir(destination).catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      // A move keeps the book's lineage (bookId); only copies start a new one.
      const copied = await saveDocumentCopy(this.book, destination, false, undefined, true);
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
        await AssetFacts.release(copied).catch(() => {});
        if (release) { await release(); await rm(copied, { recursive: true, force: true }); }
        this.watchProject(this.book);
        throw error;
      }
      return;
    }
    await this.relocate(destination);
  }
  /**
   * Syncs the book with a remote (ADR 0010, Milestone 1), serialized with every other edit of the book: the folder
   * watcher is paused while the engine pushes or pulls, and a pull is adopted as an external change, which resets
   * Undo and Redo. With several remote tips the user picks the one to continue from.
   */
  async sync(remote: SyncRemote, options: Pick<SyncOptions, 'fetchOriginals'> = {}) {
    return this.run(async () => {
      this.stopWatch();
      // What a pull changes: the book state, or (photos only) the commit this Mac last synced.
      const mark = async () => [await captureBookStateRevision(this.book.folder).catch(() => ''),
        (await readSyncState(this.book.folder).catch(() => undefined))?.lastSynced?.commitId ?? ''].join(':');
      const before = await mark();
      try {
        const outcome = await syncBook({ remote, book: this.book, ...options, chooseTip: (tips) => this.chooseTip(tips) });
        if (outcome.changed) this.notify({ value: this.activate(await loadProject(this.book.folder, this.cache), true) });
        return outcome;
      } catch (error) {
        // A sync can fail after it changed the book (a pull, then a failed push or fork commit): the editor takes what
        // is on disk now, so its next edit does not fail as a change made outside ImageFlow.
        if (await mark() !== before) {
          const next = await loadProject(this.book.folder, this.cache).catch(() => undefined);
          if (next) this.notify({ value: this.activate(next, true) });
        }
        throw error;
      } finally { this.watchProject(this.book); }
    });
  }
  private async chooseTip(tips: CommitHeader[]) {
    return this.window.isDestroyed() ? undefined : chooseSyncTip(this.window, tips);
  }

  /** What the editor shows for sync (#251): undefined for a book that does not sync on this Mac. */
  syncView?: SyncView;
  /** Called when `syncView` changes, so the app updates its menus. */
  syncChanged?: () => void;
  /** The per-Mac "keep originals" preference, read at each sync. */
  keepOriginals?: () => boolean;
  private syncing = false;
  private syncTimer?: ReturnType<typeof setTimeout>;
  /**
   * After an edit, a book that syncs shows soon whether it has changes to sync. Only the local revision is compared
   * with the last sync: the remote is read when the book opens, on focus and after a sync, never per edit, since a
   * sync folder's headers only accumulate and reading them can download evicted files.
   */
  private scheduleSyncRefresh() {
    if (!this.syncView?.status?.remote || this.syncing) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.refreshLocalSync().catch(() => {}), 1500);
  }
  private async refreshLocalSync() {
    const view = this.syncView;
    if (this.closing || this.syncing || !view?.status) return;
    const status = await describeLocalChange(this.book.folder, view.status);
    // A sync or a remote refresh that started meanwhile publishes its own, newer status.
    if (this.syncView === view && !this.syncing && status !== view.status) this.publishSync({ folder: view.folder, status });
  }
  private publishSync(view: SyncView | undefined) {
    this.syncView = view;
    if (!this.closing && !this.window.isDestroyed()) this.window.webContents.send(channels.syncChanged, view ?? null);
    this.syncChanged?.();
  }
  /** The sync folder this book syncs through on this Mac. */
  async syncFolder() { return (await readSyncState(this.book.folder).catch(() => undefined))?.folder; }
  private async folderRemote() {
    const folder = await this.syncFolder();
    if (!folder) throw new Error('This book does not sync with a folder on this Mac. Choose File → Sync → Sync with Folder… first.');
    if (!(await lstat(folder).catch(() => undefined))?.isDirectory()) throw new Error('The sync folder “' + basename(folder) + '” is not available. Connect its drive, or choose it again with Sync with Folder….');
    return new FolderRemote(folder);
  }
  /**
   * Looks at the remote again and publishes the status, with `message` for the editor to show once. A pull that was
   * given up while the book was read (when it opened, or a reload) is named once.
   */
  async refreshSync({ message }: { message?: string } = {}) {
    if (this.closing) return;
    const folder = await this.syncFolder();
    // While a sync runs, the engine owns the record; its own failures are reported by the sync.
    const abandoned = this.syncing ? undefined : await takeAbandonedAtOpen(this.book.folder).catch(() => undefined);
    const notice = message ?? (abandoned ? 'The last sync could not be finished: ' + abandoned.error.replace(/\.?$/, '.') +
      ' Sync again to continue with the version in the sync folder; this Mac’s version is kept if it holds anything new.' : undefined);
    if (!folder) {
      if (notice && !this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, notice);
      this.publishSync(undefined);
      return;
    }
    if (this.syncing) { this.publishSync({ ...this.syncView, folder, syncing: true, message: notice }); return; }
    const status = (await lstat(folder).catch(() => undefined))?.isDirectory()
      ? await describeSync(this.book.folder, new FolderRemote(folder))
      : { state: 'unavailable' as const, detail: 'The sync folder is not available.', pendingOriginals: 0 };
    if (!this.syncing) this.publishSync({ folder, status, ...(notice ? { message: notice } : {}) });
  }
  /** Syncs with the book's sync folder and says what happened in the status bar. Errors are thrown for the app to show. */
  async syncNow() {
    const remote = await this.folderRemote();
    this.syncing = true;
    this.publishSync({ ...this.syncView, folder: remote.root, syncing: true, message: undefined });
    let message: string | undefined;
    try {
      const result = await this.sync(remote, { fetchOriginals: this.keepOriginals?.() ?? false });
      if ('error' in result) throw new Error(result.error);
      message = describeOutcome(result.value);
      return result.value;
    } finally {
      this.syncing = false;
      await this.refreshSync({ message }).catch((error) => console.warn('ImageFlow could not read the sync status', error));
    }
  }
  /** Makes the book sync through `folder` on this Mac. The record of the last sync stays only if the folder has it. */
  async linkSync(folder: string) {
    const result = await this.run(async () => {
      const remote = new FolderRemote(folder);
      const bookId = this.book.project.bookId;
      const commits = bookId ? await remoteCommits(remote, bookId) : [];
      await updateSyncState(this.book.folder, ({ lastSynced, ...state }) => ({ ...state, folder,
        ...(lastSynced && commits.some(({ commitId }) => commitId === lastSynced.commitId) ? { lastSynced } : {}) }));
    });
    if ('error' in result) throw new Error(result.error);
    await this.refreshSync();
  }
  /**
   * Whether a first sync through `folder` would start the book's history there: the folder has no commit of it. Right
   * for a book new to the folder, but a folder still downloading what another Mac synced looks the same.
   */
  async startsHistory(folder: string) {
    const bookId = this.book.project.bookId;
    return !bookId || !(await remoteCommits(new FolderRemote(folder), bookId)).length;
  }
  /** Stops syncing on this Mac; the sync folder and the book are left as they are. */
  async unlinkSync() {
    const result = await this.run(() => updateSyncState(this.book.folder, ({ folder: _, ...state }) => state));
    if ('error' in result) throw new Error(result.error);
    await this.refreshSync();
  }
  /** Downloads the owned originals that are only proxies here, then shows them. */
  async downloadSyncedOriginals() {
    const remote = await this.folderRemote();
    const result = await this.run(async () => {
      this.stopWatch();
      try {
        const downloaded = await downloadOriginals({ remote, book: this.book });
        if (downloaded.length) this.notify({ value: this.activate(await loadProject(this.book.folder, this.cache), true) });
        return downloaded;
      } finally { this.watchProject(this.book); }
    });
    if ('error' in result) { await this.refreshSync(); throw new Error(result.error); }
    const count = result.value.length;
    await this.refreshSync({ message: count ? 'Downloaded ' + count + (count === 1 ? ' original.' : ' originals.') : 'Every original is on this Mac.' });
    return result.value;
  }
  async reload() {
    const next = await loadProject(this.book.folder, this.cache);
    const summary = this.activate(next, true);
    if (!this.watcher) this.watchProject(next);
    return summary;
  }
  // The window's reply crosses IPC: anything but true or a well-formed editor counts as a plain refusal.
  replyLease(id: string, reply: unknown) {
    const busy = reply && typeof reply === 'object' && typeof (reply as { busy?: unknown }).busy === 'string' ? { busy: (reply as { busy: string }).busy.slice(0, 120) } : undefined;
    this.agentLeases.get(id)?.(reply === true || busy || (parseActiveEditor(reply) ?? false));
  }
  cancelExport() { this.exportJob?.abort(); }
  cancelCheck() { this.checkJob?.abort(); }
  /** Where template packages are installed, outside every book; set by the app. */
  dependencyCache?: string;
  /** The installed app's authoring SDK, refreshed into the template's .imageflow-sdk when dependencies are rebuilt. */
  authoringTypes?: string;
  authoringSkills?: string;
  private dependencyTask?: Promise<DependencyRebuild>;
  /**
   * Installs the template's packages outside the book and rebuilds template/vendor/ (ADR 0006); the folder watcher then
   * renders the book with the new bundle. One rebuild runs at a time. A caller that stops waiting (an agent call
   * nearing its time limit) leaves it running, and the next call waits for the same one.
   */
  async rebuildDependencies(signal?: AbortSignal, waitMs = 100_000): Promise<Record<string, unknown>> {
    if (this.book.readOnly) throw new Error('Create an editable book before rebuilding its template dependencies.');
    if (!this.dependencyCache) throw new Error('Template dependencies are not available.');
    const cache = this.dependencyCache;
    this.dependencyTask ??= rebuildTemplateDependencies(join(this.book.folder, 'template'), cache, { authoringTypes: this.authoringTypes, authoringSkills: this.authoringSkills })
      .finally(() => { this.dependencyTask = undefined; });
    const task = this.dependencyTask;
    let stopWaiting = () => {};
    const waited = await Promise.race([
      task.then((result) => ({ result })),
      new Promise<undefined>((done) => {
        // Node runs a timer longer than about 24 days at once, so waiting without limit sets none.
        if (Number.isFinite(waitMs)) {
          const timer = setTimeout(() => done(undefined), waitMs);
          stopWaiting = () => clearTimeout(timer);
        }
        signal?.addEventListener('abort', () => done(undefined), { once: true });
      }),
    ]).finally(() => stopWaiting());
    signal?.throwIfAborted();
    if (!waited) return { state: 'installing', notice: 'npm is still installing the template packages. Call rebuild_dependencies again to wait for it.' };
    const { packages, imports, untyped, reused, lockfileUpdated, leftoverNodeModules } = waited.result;
    return { state: 'ready', packages, imports, untyped, reused, lockfileUpdated, leftoverNodeModules,
      notice: 'Saved the bundle in template/vendor/ and refreshed generated authoring types and agent references; the book renders it now. Run check_book.' +
        (leftoverNodeModules ? ' template/node_modules is no longer used; ask the user before deleting it.' : '') };
  }
  async agentCall(name: McpToolName, args: Record<string, unknown>, signal: AbortSignal, client?: McpClientSession) {
    let requestSignal = signal;
    try {
      return await this.queue.run(async (queuedSignal) => {
        requestSignal = queuedSignal;
        const mutation = (name === 'apply_project_changes' && args.dryRun !== true) || name === 'import_sources' || name === 'rename_source';
        let locked = false;
        try {
          if (mutation) await this.agentLease(queuedSignal, agentFootprint(name, args), name === 'import_sources' || name === 'rename_source');
          queuedSignal.throwIfAborted();
          if (mutation) {
            if (this.busy) throw new AuthoringError('EDIT_IN_PROGRESS', 'An editor operation started. Let it finish, then retry.');
            this.busy = true;
            locked = true;
          }
          return await this.service(name, args, queuedSignal, client);
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
    for (const viewer of this.viewers) if (!viewer.isDestroyed()) viewer.close();
    this.stopWatch();
    clearTimeout(this.linkedRetry);
    clearTimeout(this.syncTimer);
    this.linkedWatch?.stop();
    this.linkedWatch = undefined;
    this.exportJob?.abort();
    for (const job of this.checkJobs) job.abort();
    for (const reply of this.agentLeases.values()) reply(false);
    this.queue.close(new AuthoringError('PROJECT_CLOSED', 'This book closed. Other open books are still available.'));
    this.closeTask = (async () => {
      await this.queue.whenIdle();
      // Published saves must settle before releasing the single-writer capability.
      while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
      // Derived asset facts are written while the lock is still held (ADR 0010); failures never block closing.
      await AssetFacts.release(this.book.folder).catch(() => {});
      try { await this.unlockProject?.(); }
      finally {
        this.unlockProject = undefined;
        for (const id of this.renderIds) this.renders.delete(id);
        this.previewPictures.clear();
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
    for (const window of [this.window, ...this.viewers]) {
      if (window.isDestroyed()) continue;
      for (const frame of window.webContents.mainFrame.framesInSubtree) {
        const url = frame.url;
        const id = renderOrigins.some((origin) => url.startsWith(origin + '/')) ? viewPath.exec(new URL(url).pathname)?.[1] : undefined;
        if (id) retained.add(id);
      }
    }
    for (const [sessionId, { mode }] of this.renders) {
      if (mode === 'edit' && this.renderIds.has(sessionId) && !retained.has(sessionId)) {
        this.renders.delete(sessionId);
        this.renderIds.delete(sessionId);
      }
    }
    this.renderIds.add(id);
    this.renders.set(id, { book: this.marked(book), mode: 'edit', network: () => this.originsFor(book), pictures: this.previewPictures });
    // A changed template gets the approvals for its own hash, if any, and the frames are rendered again with them.
    if (this.networkPrepared && book.templateHash !== this.network.hash) queueMicrotask(() => void this.updateNetwork().catch(() => {}));
    this.window.setTitle(bookName(book.folder));
    this.window.setRepresentedFilename(book.folder);
    this.changed?.(book);
    this.watchLinkedSources(book);
    this.scheduleSyncRefresh();
    const summary = this.summary;
    this.publishViewers({ value: summary });
    return summary;
  }

  /**
   * Photos are watched by their providers and linked texts and files where they are (ADR 0011). A change of a file
   * invalidates the inputs and reloads the book, once nothing else is running. A change of a photo without a file is
   * observed first (`providedChanges`): it reloads the book only when the photo's preview or availability changed.
   */
  private watchLinkedSources(book: OpenProject) {
    const generation = ++this.linkedGeneration;
    void (async () => {
      const watched = sourceEntries(book).filter((source) => book.sources?.[source.key]?.state !== 'unapproved');
      const photos = watched.filter((source): source is PhotoSourceEntry => source.kind === 'photo');
      const linkedFiles = watched.filter((source): source is FileSourceEntry => source.kind !== 'photo' && source.linked);
      const store = linkedFiles.length || photos.some(({ locator }) => locator.provider === 'linked') ? await SourceStore.forBook(book.folder, this.cache) : undefined;
      const provided = photos.some(({ locator }) => !isFileLocator(locator)) ? await this.factsOf(book) : undefined;
      // What was last read of each source, so a change between that and the watch starting is seen too.
      const known = (source: SourceEntry): Revisions | undefined => source.kind === 'photo' && !isFileLocator(source.locator) ? provided?.get(source.id)?.revisions
        : book.sources?.[source.key]?.state === 'available' && store?.observed(source.key) ? { revision: store.observed(source.key)! } : undefined;
      const refs = photos.map(({ id, locator, ...source }) => ({ id, locator, known: known({ id, locator, ...source }) }));
      const files = linkedFiles.map((source) => ({ id: source.key, source, known: known(source)?.revision }));
      const signature = JSON.stringify([refs, files]);
      if (this.closing || generation !== this.linkedGeneration || signature === this.linkedWatch?.signature) return;
      this.linkedWatch?.stop();
      const changed = () => {
        this.projectSession.inputs.invalidate();
        this.linkedReloadPending = true;
        void this.reloadLinked();
      };
      const stops = [watchLinkedFiles(book.folder, files, changed),
        ...[...new Set(refs.map(({ locator }) => locator.provider))].map((name) => {
          const own = refs.filter(({ locator }) => locator.provider === name).map(({ id, locator, known }) => ({ id, locator, ...(known ? { known } : {}) }));
          const provider = providerOf(own[0].locator);
          if (isFileLocator(own[0].locator) || !provided) return provider.watch(book.folder, own, changed);
          return provider.watch(book.folder, own, (ids) => void this.providedChanged(provider, own.filter(({ id }) => ids.includes(id)), provided));
        })];
      this.linkedWatch = { signature, stop: () => stops.forEach((stop) => stop()) };
    })().catch((error) => this.notify({ error: String(error) }));
  }
  // The facts of the open book: the session's own, or a read-only set for a book this session only reads.
  private factsOf(book: OpenProject) { return book.readOnly ? AssetFacts.readOnly(book.folder) : AssetFacts.forBook(book.folder); }
  /** Photos without a file whose aspect ratio changed in their source while placed in this session (ADR 0011, §3.8). */
  private reshaped = new Set<string>();
  /**
   * A book with the session's reshaped photos marked on their statuses, as every render and the summary see it: the
   * mark lives in the session, not in what a load reads, so a reload or a check snapshot keeps the warning.
   */
  private marked(book: OpenProject): OpenProject {
    if (!this.reshaped.size || !book.sources) return book;
    return { ...book, sources: Object.fromEntries(Object.entries(book.sources).map(([key, status]) =>
      [key, status.kind === 'photo' && this.reshaped.has(status.id) ? { ...status, reshaped: true } : status])) };
  }
  // A provider reported photos without a file as changed: their facts and previews are brought up to date, and the
  // book reloads only for what it shows differently.
  private async providedChanged(provider: SourceProvider<Locator>, refs: SourceRef<Locator>[], facts: AssetFacts) {
    if (this.closing || !refs.length) return;
    try {
      const changes = await providedChanges(this.book.folder, provider, refs, facts, { staging: join(this.cache, 'provider-staging'),
        available: (id) => this.book.sources?.['photo:' + id]?.state === 'available' });
      if (this.closing) return;
      if (changes.revised.length) this.projectSession.inputs.invalidate();
      const usage = changes.reshaped.length ? assetUsage(this.book, assetPageLabels(this.summary)) : undefined;
      const placed = changes.reshaped.filter((id) => usage?.photo[id]?.length);
      if (placed.length) {
        for (const id of placed) this.reshaped.add(id);
        if (!this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, (placed.length === 1 ? 'A placed photo changed its' : placed.length + ' placed photos changed their') +
          ' aspect ratio in its source. Check how ' + (placed.length === 1 ? 'it is' : 'they are') + ' cropped.');
      }
      if (changes.reload.length) { this.linkedReloadPending = true; void this.reloadLinked(); }
    } catch (error) { this.notify({ error: error instanceof Error ? error.message : String(error) }); }
  }
  // A pending refresh is consumed after a save/export; it must not invent additional source changes.
  private async reloadLinked() {
    clearTimeout(this.linkedRetry);
    if (this.closing || !this.linkedReloadPending) return;
    const later = () => { this.linkedRetry = setTimeout(() => void this.reloadLinked(), 1500); this.linkedRetry.unref(); };
    if (this.busy || this.linkedReloading) return later();
    this.linkedReloading = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 220));
      if (this.closing) return;
      if (this.busy) return later();
      this.linkedReloadPending = false;
      let reported = false;
      try {
        await this.run(async () => {
          this.notify({ building: true });
          try { this.notify({ value: await this.reload() }); }
          catch (error) { reported = true; this.notify({ error: error instanceof Error ? error.message : String(error) }); throw error; }
        });
      } catch (error) { if (!reported) this.notify({ error: String(error) }); }
    } catch (error) { this.notify({ error: String(error) }); }
    finally { this.linkedReloading = false; }
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
      // Changes seen while the editor is still opening are reloaded once it shows the book.
      if (!this.active && !this.closing) {
        scheduleReload(250);
        return;
      }
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
          if (!watching()) return;
          // The editor was told the book is building, so the build must end with a revision or an error. A revision
          // published meanwhile (for example once network access was updated) did not see these files: read them again.
          if (this.active !== current || this.observedChanges.size) {
            // A newer edit arrived during the build. The debounced reload reads it and resolves the building state.
            for (const [i, file] of files.entries()) if (external[i]) this.observedChanges.add(file);
            scheduleReload(250);
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

  /** `report` sends progress to the owner's status bar; only the book window's own import, which clears it, asks. */
  async importFiles(owner: BrowserWindow, id: string, request: ImportRequest, base?: OpenProject, report = false, checkpoint?: SaveCheckpoint) {
    const current = this.currentBook(id);
    const book = base ?? current;
    if (request.kind !== undefined && request.kind !== 'photo' && request.kind !== 'markdown' && request.kind !== 'file') throw new Error('Unknown import type.');
    if (request.kind === 'file' && (!Array.isArray(request.accept) || !request.accept.length ||
        !request.accept.every((ext) => typeof ext === 'string' && /^\.[a-z0-9]{1,10}$/.test(ext)) || request.folder)) {
      throw new Error('Invalid file import.');
    }
    // Without a kind, `accept` lists the extensions of the template's file parameters that may be imported as files.
    if (request.kind === undefined && request.accept !== undefined && (!Array.isArray(request.accept) || request.accept.length > 100 ||
        !request.accept.every((ext) => typeof ext === 'string' && /^\.[a-z0-9]{1,10}$/.test(ext)))) {
      throw new Error('Invalid file import.');
    }
    if (request.target && (!request.kind || !identifier.safeParse(request.target.box).success || !identifier.safeParse(request.target.spread).success)) {
      throw new Error('Invalid import target.');
    }
    let paths = request.paths;
    if (!paths) {
      const photo = request.kind === 'photo';
      const file = request.kind === 'file';
      const extensions = photo ? [...photoExtensions] : file ? request.accept! : ['.md'];
      const choice = await dialog.showOpenDialog(owner, {
        title: !request.kind ? 'Import' : photo ? 'Import Photos' : file ? 'Choose File' : 'Import Markdown',
        properties: !request.kind ? ['openFile', 'openDirectory', 'multiSelections'] : request.folder ? ['openDirectory'] : file ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: !request.kind ? undefined : [{ name: photo ? 'Photos' : file ? request.accept!.join(', ') : 'Markdown', extensions: extensions.map((ext) => ext.slice(1)) }],
      });
      if (choice.canceled) return null;
      paths = choice.filePaths;
    }
    const files: string[] = [];
    const collect = async (folder: string) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (entry.isFile()) files.push(path);
      }
    };
    for (const path of paths) {
      if ((await stat(path)).isDirectory()) await collect(path);
      else files.push(path);
    }
    const noun = request.kind === 'photo' ? 'photos' : request.kind === 'markdown' ? 'texts' : 'files';
    const progress = report ? ({ done, total, saving }: ImportProgress) => {
      if (owner.isDestroyed()) return;
      owner.webContents.send(channels.progress, saving ? 'Adding ' + total + ' ' + (total === 1 ? noun.slice(0, -1) : noun) + ' to the book…'
        : total > 1 ? 'Importing ' + noun + '… ' + done + ' of ' + total : 'Importing ' + noun.slice(0, -1) + '…');
    } : undefined;
    const { book: next, imported, copied, createdDirectories, counts } = await importIntoProject(book, request, [...new Set(files)], progress, checkpoint);
    for (const file of [...createdDirectories, ...copied]) {
      const path = relative(book.folder, file);
      this.importedWrites.set(path, await fingerprint(file), this.observedChanges.has(path));
    }
    if (!imported.length || next === book) return { summary: this.summary, imported, counts };
    if (owner.isDestroyed()) return null;
    this.projectSession!.adoptExternal(book);
    // One Undo step removes what the import added, and what it placed in a box (F-044). Copied files stay in the book
    // for Redo, as when assets are removed; sources the book already held are kept.
    this.projectSession!.record(next, 'Import sources', true, false);
    return { summary: this.activate(next), imported, counts };
  }

  /** The origins the template declares that this book's frames may reach, asking once for new ones (ADR 0006):
   * element editors, and previews, checks and exports that draw <RenderedImage> pictures. Sites this book already
   * allowed, for any version of its template, and sites allowed for the template's exact version in the library
   * need no question; the question lists only the others. Declining keeps the frames offline, so such pictures
   * fail and export stops; the question comes back the next time an editor opens or the book opens. When the
   * allowed origins change, the book is rendered again under a new ID, which the summary carries. */
  async editorNetwork(id: string, declared: unknown) {
    const book = this.currentBook(id);
    const origins = Array.isArray(declared) ? [...new Set(declared.filter((origin): origin is string =>
      typeof origin === 'string' && /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/.test(origin)))].slice(0, 20) : [];
    const hash = book.templateHash;
    const before = new Set(this.originsFor(book));
    if (!origins.length || !hash) { this.network = { hash, origins: [] }; return { origins: [] as string[] }; }
    while (this.askingNetwork) await this.askingNetwork.catch(() => {});
    const ask = (async () => {
      const known = await approvedNetwork(book.folder);
      // A template that arrived through sync comes from an unauthenticated remote (ADR 0006, ADR 0010): sites it newly
      // declares are asked about even in a trusted book, once.
      const review = (await readSyncState(book.folder).catch(() => undefined))?.networkReview === true;
      const unreviewed = review && origins.some((origin) => !known.includes(origin));
      if (review && !unreviewed) await updateSyncState(book.folder, ({ networkReview: _, ...state }) => state).catch(() => {});
      // The user's own book (made here, or trusted once): every declared site, without asking. A site its template
      // newly declares is recorded and named in a quiet notice instead of a question.
      if (!unreviewed && await bookTrusted(book.folder)) {
        const added = origins.filter((origin) => !known.includes(origin));
        if (added.length) {
          await approveNetwork(book.folder, added, hash);
          if (known.length && !this.window.isDestroyed()) this.window.webContents.send(channels.appNotice,
            'This book’s template now also loads maps or data from ' + added.join(', ') + '.');
        }
        return origins;
      }
      const trusted = await this.networkTrust?.(hash, origins).catch(() => []) ?? [];
      const approved = new Set([...known, ...trusted]);
      const pending = origins.filter((origin) => !approved.has(origin));
      // Every newly declared site is allowed already, for example by the library's trust in this exact template.
      if (review && !pending.length) await updateSyncState(book.folder, ({ networkReview: _, ...state }) => state).catch(() => {});
      // A book from elsewhere, or made from a template whose sites were not allowed: the one question, for the book.
      if (pending.length && !this.window.isDestroyed()) {
        const { response } = await dialog.showMessageBox(this.window, {
          type: 'question', buttons: ['Trust This Book', 'Not Now'], defaultId: 0, cancelId: 1,
          message: 'Trust this book’s template?',
          detail: 'Its template contains code that loads maps or data from:\n' + pending.join('\n') +
            '\n\nTrust only books you made or got from someone you trust. A trusted book does not ask again, even when its template changes.',
        });
        if (response === 0) {
          await approveNetwork(book.folder, origins, hash);
          await trustBook(book.folder);
          if (review) await updateSyncState(book.folder, ({ networkReview: _, ...state }) => state).catch(() => {});
          return origins;
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


  async exportBook(owner: BrowserWindow, projectId: string, surface?: 'cover') {
    this.currentBook(projectId);
    // Cancel works from the moment the export starts, while it prepares the book and asks for a destination too.
    const job = new AbortController();
    this.exportJob = job;
    try { return await this.runExport(owner, job, surface); } finally { if (this.exportJob === job) this.exportJob = undefined; }
  }

  private async runExport(owner: BrowserWindow, job: AbortController, surface?: 'cover') {
    const before = await this.projectSession.inputs.capture();
    const privateCache = await mkdtemp(join(this.cache, 'export-'));
    const progress = (stage: string) => { if (!owner.isDestroyed()) owner.webContents.send(channels.progress, stage); };
    try {
      // Placed photos without a file are materialized first, where their provider can produce them now (ADR 0011, §4):
      // the export prints them from full-resolution originals instead of as proofs. Cancel stops it between photos.
      const book = await loadProject(this.book.folder, privateCache, true, true, { signal: job.signal,
        progress: ({ done, total }) => { if (total) progress(done < total ? 'Preparing originals: ' + done + ' of ' + total + '…' : 'Preparing export…'); } });
      if (job.signal.aborted) return null;
      const loaded = await this.projectSession.inputs.capture();
      if (before.revision !== loaded.revision || before.observation !== loaded.observation) throw new Error('Sources changed while preparing export. Please retry.');
      // An original made from a revision the open book has not seen yet (the photo changed just before the export, and
      // its provider's watch has not reported it) would print another version than the one checked and shown.
      const facts = await this.factsOf(this.book);
      if (Object.entries(book.materialized ?? {}).some(([id, revision]) => facts.get(id)?.revisions?.revision !== revision)) throw new Error('Sources changed while preparing export. Please retry.');
      const fileName = bookName(book.folder).normalize('NFC').replace(/[^\p{L}\p{M}\p{N} _-]/gu, '-').slice(0, 80) + (surface === 'cover' ? ' - Cover' : '') + '.pdf';
      const { canceled, filePath } = await dialog.showSaveDialog(owner, {
        title: surface === 'cover' ? 'Export Cover PDF' : 'Export PDF', defaultPath: join(app.getPath('documents'), fileName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath || owner.isDestroyed() || job.signal.aborted) return null;
      const id = randomUUID();
      this.renders.set(id, { book: this.marked(book), mode: 'export', network: () => this.originsFor(book) });
      try {
        const fonts = bundledFontNames(book.assets.files);
        const { bytes, warnings, errors } = await printBook(renderOrigin + '/render/' + id + (surface === 'cover' ? '?view=cover' : ''), fonts, job.signal, progress, surface);
        if (errors.length) {
          const choice = await dialog.showMessageBox(owner, { type: 'warning', message: 'Export PDF with errors?',
            detail: exportErrorList(errors) + '\n\nThe PDF may contain missing content or printing problems. Pages with unavailable originals will be marked. Export anyway?',
            buttons: ['Cancel', 'Export Anyway'], defaultId: 0, cancelId: 0 });
          if (choice.response !== 1) return null;
        }
        const after = await this.projectSession.inputs.capture({ signal: job.signal });
        if (before.revision !== after.revision || before.observation !== after.observation) throw new Error('Sources changed during export. No PDF was saved; retry after the external save finishes.');
        progress('Saving PDF…');
        await savePdf(filePath, bytes, job.signal);
        return { warnings, errors };
      } catch (error) {
        if ((job.signal.reason as { networkWithdrawn?: boolean })?.networkWithdrawn) throw job.signal.reason;
        if (job.signal.aborted) return null;
        throw error;
      } finally {
        progress('');
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
      return await checkProject(book, this.cache, request, async (snapshot, preview, signal, inspect, cover) => {
        const id = randomUUID();
        this.renders.set(id, { book: this.marked(snapshot), mode: 'export', network: () => this.originsFor(snapshot) });
        try {
          const url = renderOrigin + '/render/' + id;
          if (snapshot.fixture?.coverPages !== undefined) return { status: await checkCoverRender(url, signal, arm) };
          const coverPreview = preview && 'cover' in preview.target ? preview : undefined;
          const interiorPreview = coverPreview ? undefined : preview;
          const coverInspect = inspect?.cover ? inspect : undefined;
          const interiorInspect = coverInspect ? undefined : inspect;
          const needsCover = cover || coverPreview || coverInspect;
          const needsInterior = !needsCover || interiorPreview || interiorInspect;
          const interiorImage = interiorPreview ? await captureBookPreview(url, interiorPreview, signal, interiorInspect, arm) : undefined;
          const interior = interiorImage?.status ?? (needsInterior ? await checkBookRender(url, signal, interiorInspect, arm) : undefined);
          if (!needsCover) return { status: interior!, preview: interiorImage };
          const coverImage = coverPreview ? await captureBookPreview(url, coverPreview, signal, coverInspect, arm) : undefined;
          const checked = coverImage?.status ?? (coverInspect ? await checkBookRender(url, signal, coverInspect, arm) : await checkCoverRender(url, signal, arm));
          return { status: interior ? { ...interior, cover: checked.cover, errors: [...interior.errors, ...checked.errors],
            warnings: [...interior.warnings, ...checked.warnings], inspection: checked.inspection ?? interior.inspection } : checked,
            preview: coverImage ?? interiorImage };
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


  // Busy states end by themselves, such as the reload after a template edit, which redraws every map: a save waits
  // for them this long before it is refused (beta finding F-023).
  static busyWaitMs = 30_000;
  // The footprint says which layouts the save changes: an editor open elsewhere lets it through (#231).
  async agentLease(signal: AbortSignal, footprint: AgentFootprint = { book: true }, wholeBook = false) {
    const started = Date.now();
    while (true) {
      const reply = await this.requestLease(signal, footprint);
      if (reply && typeof reply === 'object' && 'busy' in reply) {
        if (Date.now() - started < DocumentSession.busyWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          signal.throwIfAborted();
          continue;
        }
        throw new AuthoringError('EDIT_IN_PROGRESS', 'ImageFlow is still busy with ' + reply.busy + ' after ' + Math.round(DocumentSession.busyWaitMs / 1000) +
          ' s. Retry when it finishes. No changes were made.', { busy: reply.busy });
      }
      if (reply === true) return;
      if (reply) {
        const field = reply.field ? ' for ' + reply.field : '';
        const cover = reply.spread === coverInstance;
        const location = cover ? ' on the cover' : reply.spread ? ' on spread ' + reply.spread + (reply.page ? ' (' + reply.page + ' page)' : '') : '';
        // An import or a rename is always book-wide, so no narrower change would have saved in its place.
        const meanwhile = reply.spread && reply.label !== 'crop editor' && !wholeBook
          ? 'Changes that leave ' + (cover ? 'the cover' : reply.page ? 'that page' : 'that spread') + ' and book-wide settings alone (no title, format, document parameters, photo metadata, or inserting, moving or removing spreads) can be saved meanwhile.'
          : 'Nothing can be saved while it is open.';
        throw new AuthoringError('EDIT_IN_PROGRESS', 'Finish editing in ImageFlow (' + reply.label + field + location + '), then retry. No changes were made. ' + meanwhile, { activeEditor: reply });
      }
      throw new AuthoringError('EDIT_IN_PROGRESS', 'ImageFlow did not answer in time; it may be busy rendering. Retry in a moment. No changes were made.');
    }
  }

  private async requestLease(signal: AbortSignal, footprint: AgentFootprint) {
    const owner = this.window;
    if (!owner || owner.isDestroyed()) throw new AuthoringError('PROJECT_CLOSED', 'Open a book in ImageFlow first.');
    const id = randomUUID();
    const reply = await new Promise<AgentLeaseReply>((resolve) => {
      const finish = (reply: AgentLeaseReply) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.agentLeases.delete(id);
        resolve(reply);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), 3000);
      this.agentLeases.set(id, finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return finish(false);
      owner.webContents.send(channels.agentLease, { id, footprint });
    });
    signal.throwIfAborted();
    return reply;
  }


}
