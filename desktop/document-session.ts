import { bookName } from '../src/book-name';
import { agentFootprint } from '../src/agent-footprint';
import type { AgentFootprint } from '../src/agent-footprint';
import { SourceStore } from './source-store';
import { cachedPreviewNote, sourceEntries } from '../src/source-locations';
import type { FileSourceEntry, PhotoSourceEntry, SourceEntry } from '../src/source-locations';
import { isFileLocator } from '../src/source-locator';
import type { Locator, PhotoLocator } from '../src/source-locator';
import { providerOf } from './providers';
import { backgroundPreviews, providedChanges } from './provided-photos';
import type { ProvidedChanges, WantedPreview } from './provided-photos';
import { PreviewRequests } from './preview-requests';
import type { Revisions, SourceProvider, SourceRef } from './source-provider';
import { assetPageLabels, assetUsage } from '../src/asset-usage';
import { watchLinkedFiles } from './providers/files';
import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, realpath, readdir, rm, stat, mkdir, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { channels, desktopScheme, issueText, renderOrigin, renderOrigins } from '../src/desktop';
import type { AgentLeaseReply, BookMenuState, CanvasLayout, ImportRequest, Issue, ProjectChange, ProjectSummary, Result, TaskProgress } from '../src/desktop';
import { coverInstance, identifier } from '../src/project';
import { parseActiveEditor } from '../src/mcp-results';
import type { RenderProject } from '../src/project';
import { printBook, printProof, savePdf } from './export';
import { isProofDensity, proofDensities } from '../src/proof-sheet';
import type { ProofDensity } from '../src/proof-sheet';
import { approveNetwork, approvedNetwork, bookTrusted, distrustBook, trustBook } from './source-access';
import { importIntoProject, importProvidedPhotos, loadProject, projectSummary, readProjectManifest } from './project';
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
import type { CopyOptions } from './source-actions';
import { rebuildTemplateDependencies } from './dependency-install';
import type { DependencyRebuild } from './dependency-install';
import { AssetFacts } from './asset-facts';
import { StoreFullError } from './sync-store';
import { describeLocalChange, describeSync, originalsNotHere, placeOriginals, stageOriginals, ensureBookId, syncBook, unavailableStatus, uploadAhead } from './sync-engine';
import type { SyncOptions, SyncOutcome, UploadedPreviews } from './sync-engine';
import { BookDeletedError } from './sync-remote';
import type { SyncRemote } from './sync-remote';
import { AutomaticRuns, AutoSync, autoSyncTiming, SyncInterruptedError, whenUnblocked } from './sync-auto';
import type { AutoFailure, AutoLook, AutoSyncTiming } from './sync-auto';
import { bookSync, readSyncState, startSyncing, SyncElsewhereError, syncedElsewhere, SyncStoppedError, takeAbandonedAtOpen } from './sync-pull';
import type { SyncState } from './sync-pull';
import { UntrustedBookError } from './sync-service';
import type { SyncService, SyncStanding } from './sync-service';
import { FirstSync } from './sync-start';
import { networkNotice } from './sync-library';
import { NewerSyncFormatError } from '../src/sync-snapshot';
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
/** A request named a revision of the book that is no longer the current one (`currentBook`). */
export class StaleBookError extends Error {
  constructor(message = 'The project changed. Try again using the current project.') { super(message); this.name = 'StaleBookError'; }
}

/** The book is held by another operation (a save, a reload, a sync); `run` reports it as `BOOK_BUSY`. */
export class BookBusyError extends Error {
  readonly code = 'BOOK_BUSY';
  constructor() { super('ImageFlow is finishing another operation in this book.'); this.name = 'BookBusyError'; }
}
/** This Mac's name as other Macs see it in "never uploaded from …": its network name without `.local`. */
function macName() { return hostname().replace(/\.local$/i, '').slice(0, 100) || undefined; }
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
/**
 * The errors an export asks about. Unavailable originals are summed up by their cause, one line for all the photos of a
 * Lightroom Classic that is not running, say, instead of one line per box; the other errors are listed as they are.
 */
function exportErrorList(errors: Issue[]) {
  const unavailable = new Map<string, Issue[]>();
  const other: Issue[] = [];
  for (const issue of errors) {
    if (issue.code !== 'source-unavailable') { other.push(issue); continue; }
    const cause = issue.message.endsWith(cachedPreviewNote) ? issue.message.slice(0, -cachedPreviewNote.length) : issue.message;
    unavailable.set(cause, [...unavailable.get(cause) ?? [], issue]);
  }
  const summaries = [...unavailable].map(([cause, issues]) => {
    const photos = new Set(issues.map(({ source, spread, box }) => source ?? spread + ':' + box)).size;
    const spreads = new Set(issues.map(({ spread }) => spread)).size;
    return cause + ': ' + (photos === 1 ? '1 photo' : photos + ' photos') + ' on ' + (spreads === 1 ? '1 spread' : spreads + ' spreads') + ' will print from cached previews.';
  });
  const shown = other.slice(0, Math.max(0, shownExportErrors - summaries.length)).map(issueText);
  const more = other.length - shown.length;
  return [...summaries, ...shown].join('\n') + (more > 0 ? '\n…and ' + more + ' more ' + (more === 1 ? 'error' : 'errors') + ' in Book check.' : '');
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

/**
 * A sync of the open book (`DocumentSession.syncNow`): `start` makes a book that does not sync here start, `auto` is
 * the first sync by itself when it opens, and `automatic` a sync nobody asked for (#284), which applies only a
 * fast-forward, with `pushOnly` without changing the book, and stops with `signal`.
 */
export type SyncRequest = { start?: boolean; auto?: boolean; trust?: boolean; automatic?: { pushOnly: boolean; signal?: AbortSignal } };

/** How a failed automatic sync is taken (`AutoSync`): what may not sync by itself stops, a full remote waits, a busy book tries again soon. */
export function automaticFailure(error: unknown): AutoFailure {
  if (error instanceof BookDeletedError || error instanceof NewerSyncFormatError || error instanceof SyncElsewhereError || error instanceof UntrustedBookError) return 'stop';
  if (error instanceof SyncInterruptedError) return 'interrupted';
  if (error instanceof StoreFullError) return 'full';
  if (error instanceof BookBusyError) return 'later';
  return 'retry';
}

/** What a finished sync did, for the status bar. */
export function describeOutcome(outcome: SyncOutcome) {
  const copy = outcome.conflictCopy ? ' This Mac’s version was kept as “' + basename(outcome.conflictCopy).replace(/\.imageflow$/i, '') + '”.' : '';
  const text = outcome.action === 'diverged' && !outcome.pulled ? 'Not synced: the book has several versions. Sync again to choose one.'
    : outcome.action === 'diverged' ? 'Synced: continued with the version on the remote.' + copy
    : outcome.action === 'fast-forward' ? 'Synced: took the changes from the remote' + (outcome.pushed.length ? ' and sent this Mac’s.' : '.')
    : outcome.action === 'initial-push' || outcome.action === 'push' || outcome.pushed.length ? 'Synced: sent the changes to the remote.'
    : outcome.action === 'deferred' ? 'Not synced: the changes from the remote wait until nothing is being edited.'
    : 'Synced: the book is up to date.';
  const originals = outcome.originals?.pending ? ' Originals are still to be downloaded: ' + outcome.originals.pending
    : outcome.originals?.downloaded.length ? ' Downloaded ' + outcome.originals.downloaded.length + (outcome.originals.downloaded.length === 1 ? ' original.' : ' originals.') : '';
  // Named by the commit but not on the remote yet: another Mac is still uploading them, which is no error.
  const away = outcome.originals?.notUploaded;
  const uploading = away ? ' ' + away + (away === 1 ? ' original is' : ' originals are') + ' still uploading from another Mac.' : '';
  return text + originals + uploading;
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
  /**
   * The book was just downloaded from the library (#283): it arrives trusted, so its template reaches the sites it
   * declares without a question, and the first time it does, a notice names them once. Set by the app.
   */
  announceSites = false;

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
    this.previewSource(book.folder);
    this.guardNavigation(window);
    // Watch from the moment the book was read, so edits made while the editor is still loading are not missed.
    this.watchProject(book);
  }
  /** Publishes the first revision once the editor can receive it; reloads seen before then wait for it. */
  start() {
    this.activate(this.book);
    void this.refreshSync().then(() => this.syncOnOpen()).catch((error) => console.warn('ImageFlow could not sync the book it opened', error));
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
    try { return { value: await this.holdAfterAutomatic(task) }; }
    catch (error) {
      if (error instanceof BookBusyError) return { error: error.message, code: 'BOOK_BUSY' };
      if (error instanceof CommittedProjectSaveError) this.notify({ error: error.message });
      return { error: errorMessage(error) };
    }
  }
  /**
   * An edit never fails because of a sync nobody asked for (#284). A request from the editor (`run`: a save, Undo,
   * Redo, an import) that finds the book held by an automatic sync waits for it, and stops it first unless it is already
   * applying a pull: an automatic push is aborted (`SyncInterruptedError`), and the save starts its idle wait again. A
   * pull being applied finishes; the request then finds a newer revision of the book, which it never overwrites: a
   * request made against the revision before is refused with a message that says why.
   */
  private async holdAfterAutomatic<T>(task: () => Promise<T>): Promise<T> {
    const revision = this.active?.id;
    const waited = !this.closing && await this.automaticRuns.yieldTo(() => this.busy);
    try { return await this.hold(task); }
    catch (error) {
      if (waited && error instanceof StaleBookError && this.active?.id !== revision) {
        throw new StaleBookError('The book took changes from another Mac just now, so this edit was not made. Make it again.');
      }
      throw error;
    }
  }
  /** The automatic sync that runs, which an edit stops or waits for. */
  private readonly automaticRuns = new AutomaticRuns();
  /**
   * Runs `task` holding the book, as `run` does, but rejects with the task's own error (`BookBusyError` while the book
   * is busy), so callers in the main process can tell errors apart by their class instead of their text.
   */
  async hold<T>(task: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('This book is closing.');
    if (this.busy) throw new BookBusyError();
    this.busy = true;
    try { return await task(); }
    finally { this.busy = false; }
  }
  async relocate(folder: string) {
    if (this.unlockProject && !await this.unlockProject.tryRelocate(folder)) throw new Error('Could not verify the moved book’s writer lock.');
    this.stopWatch();
    // The old folder's facts are written and released before the directory is gone from under them.
    await AssetFacts.release(this.book.folder).catch(() => {});
    this.projectSession.relocate(folder);
    this.projectSession.book = { ...this.book, folder };
    this.previewSource(await realpath(folder));
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
        this.previewSource(await realpath(copied));
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
        this.previewSource(this.book.folder);
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
  async sync(remote: SyncRemote, options: Pick<SyncOptions, 'fetchOriginals' | 'fastForwardOnly' | 'pushOnly' | 'signal' | 'ahead' | 'beforeApply'> & { remoteId?: string;
    /** Told when the sync fails because the remote is full (its commit or a preview did not fit). */
    full?: (error: StoreFullError) => void;
    /** Whether sync was turned off since the sync began (`startSyncing`). */
    unless?: (state: SyncState) => boolean } = {}) {
    return this.hold(async () => {
      // The book may have been sending for minutes: an untrusted one never syncs. Withdrawing the trust needs the hold.
      if (options.unless && !await bookTrusted(this.book.folder)) throw new SyncStoppedError();
      // Syncing turns on only once the sync holds the book: one that finds it busy changes nothing.
      if (options.remoteId) await startSyncing(this.book.folder, options.remoteId, { unless: options.unless });
      this.stopWatch();
      // What a pull changes: the book state, or (photos only) the commit this Mac last synced.
      const mark = async () => [await captureBookStateRevision(this.book.folder).catch(() => ''),
        (await readSyncState(this.book.folder).catch(() => undefined))?.lastSynced?.commitId ?? ''].join(':');
      const before = await mark();
      try {
        // Tests of automatic sync stand in for a slow remote (`IMAGEFLOW_SYNC_TEST_SLOW_MS`, development builds only).
        const slow = DocumentSession.automaticSyncDelay;
        const { signal } = options;
        if (slow) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, slow);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal!.reason); }, { once: true });
        });
        const outcome = await syncBook({ remote, book: this.book, fetchOriginals: options.fetchOriginals, chooseTip: (tips) => this.chooseTip(tips), cover: this.cover, device: macName(),
          fastForwardOnly: options.fastForwardOnly, pushOnly: options.pushOnly, signal: options.signal, ahead: options.ahead, beforeApply: options.beforeApply });
        if (outcome.changed) this.notify({ value: this.activate(await loadProject(this.book.folder, this.cache), true) });
        return outcome;
      } catch (error) {
        if (error instanceof StoreFullError) options.full?.(error);
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
  /** The book's cached cover (a JPEG the app made for the recent books), for a push to record (#283); set by the app. */
  cover?: () => Promise<Uint8Array | undefined>;
  /** The per-Mac "keep originals" preference, read at each sync. */
  keepOriginals?: () => boolean;
  private syncing = false;
  private syncTimer?: ReturnType<typeof setTimeout>;
  /**
   * After an edit, a book that syncs shows soon whether it has changes to sync. Only the local revision is compared
   * with the last sync: the remote is read when the book opens, on focus and after a sync, never per edit, since a
   * remote's headers only accumulate.
   */
  private scheduleSyncRefresh() {
    // A book whose first sync by itself did not happen (busy, offline) tries again after the next save, through the
    // same checks as at open: exclusions, trust, opt-out, and a book synced elsewhere is asked about, never started.
    if (!this.syncing && !this.closing) this.firstSync.saved();
    // The book pushes by itself once it has been idle for a while; a revision a pull brought is no edit, which the push
    // finds out locally.
    if (!this.syncing && !this.closing) this.autoSync.saved();
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
  /** A download of originals running in the background, and how far it is; every published view carries it. */
  private downloadJob?: AbortController;
  private downloading?: { done: number; total: number };
  /**
   * The photos whose originals the last sync has and this Mac does not yet, and of those the ones another Mac is still
   * uploading: their problem says so (`marked`).
   */
  private notDownloaded = new Set<string>();
  private stillUploading = new Set<string>();
  /** Of the originals not here, those a commit named a week or more ago that never arrived, with the Mac that named them. */
  private neverUploaded = new Map<string, string | undefined>();
  /** A sync that failed because the remote is full (its commit or a preview did not fit); cleared by the next sync. */
  private storageFull?: SyncView['storageFull'];
  private publishSync(view: SyncView | undefined) {
    if (view) {
      const { downloading: _, storageFull: __, uploading: ___, uploadFailed: ____, sending: _____, ...rest } = view;
      // This Mac's originals going up in the background after the commit, or paused because the remote is full.
      const uploads = this.syncService?.uploadState(this.book.folder) ?? {};
      const manage = this.syncService?.kind === 'icloud' ? { manage: true as const } : {};
      const full = this.storageFull ?? (uploads.full && { message: uploads.full.message, notUploaded: uploads.full.left, ...manage });
      view = { ...rest, ...(this.downloading ? { downloading: this.downloading } : {}), ...(rest.syncing && this.sending ? { sending: this.sending } : {}), ...(uploads.uploading?.total ? { uploading: uploads.uploading } : {}),
        ...(full ? { storageFull: full } : {}), ...(!uploads.uploading && uploads.failed && uploads.failed.left !== 0 ? { uploadFailed: uploads.failed } : {}) };
    }
    this.syncView = view;
    if (!this.closing && !this.window.isDestroyed()) this.window.webContents.send(channels.syncChanged, view ?? null);
    this.syncChanged?.();
  }
  /** The app's sync service (ADR 0012): the one remote every book syncs through on this Mac. */
  syncService?: SyncService;
  /** The per-Mac preference *Sync automatically* (#284), read at each use; on unless the app says otherwise. */
  syncAutomatically?: () => boolean;
  /** Whether a Markdown editor window of this book is open (the app's); a pull waits while one is. */
  textEditorsOpen?: () => boolean;
  /** Delete from Sync is deleting this book (#283): nothing pushes it by itself, also not when it closes. Set by the app. */
  deleting = false;
  /** A sync found the book deleted from sync: the status says so until the user decides or a sync succeeds. */
  private removed = false;
  /** When the sync status was last read from the remote; a look right after uses it instead of reading again. */
  private statusRead = 0;
  /**
   * Automatic sync (#284): pull on open, focus and an iCloud push, push after the book was idle following a save, and
   * the bounded push when it closes (`close`). Only a fast-forward is applied by itself.
   */
  /** When automatic sync acts; development builds may shorten the idle wait for tests (`IMAGEFLOW_SYNC_IDLE_MS`). */
  static autoSyncTiming: AutoSyncTiming = autoSyncTiming;
  /** Development builds only: how long an automatic sync waits, holding the book, before it starts (a slow remote). */
  static automaticSyncDelay = 0;
  /** Development builds only: how long a sync sends before it holds the book (a large first sync). */
  static sendingDelay = 0;
  readonly autoSync = new AutoSync({
    allowed: () => this.autoAllowed(),
    blocked: () => this.pullBlocked(),
    start: () => this.firstSync.run(),
    look: () => this.lookForAuto(),
    edited: () => this.editedSinceSync(),
    sync: async ({ pushOnly, signal }) => {
      const outcome = await this.syncNow({ automatic: { pushOnly, signal } });
      return outcome?.action === 'deferred' ? 'deferred' : undefined;
    },
    failure: automaticFailure,
    refresh: () => this.refreshSync(),
    upload: async () => {
      const service = this.syncService;
      if (!service || this.closing) return;
      await service.uploadAfterSync(this.book.folder, { automatic: true });
      if (this.syncView && !this.closing) this.publishSync(this.syncView);
    },
  }, DocumentSession.autoSyncTiming);
  private readonly autoSyncTiming = DocumentSession.autoSyncTiming;
  /** Whether automatic sync is on: the preference, with a backend configured. */
  private automatic() { return !!this.syncService?.configured && this.syncAutomatically?.() !== false; }
  /**
   * Whether the book syncs by itself now (ADR 0012, section 3): never a read-only, excluded, untrusted or stopped book,
   * one that syncs with another remote, one Delete from Sync is deleting, nor any while the first-configuration sheet
   * waits for an answer. Local: reads the sync record and the trust, sends no request.
   */
  private async autoAllowed() {
    const service = this.syncService;
    if (!service || !this.automatic() || this.closing || this.deleting || this.book.readOnly || this.syncExcluded || service.booksUnchosen) return false;
    const state = await readSyncState(this.book.folder).catch(() => undefined);
    if (!state?.remoteId || state.enabled === false) return false;
    const known = service.knownRemoteId;
    if (known !== undefined && state.remoteId !== known) return false;
    return bookTrusted(this.book.folder).catch(() => false);
  }
  /**
   * Why a pull may not change the book now (#284), or undefined: it reloads the book and resets Undo and Redo, so it
   * waits for edits in flight or unsaved, an export, a copy, a check, an agent, and an open text or element editor.
   */
  pullBlocked({ holding = false }: { holding?: boolean } = {}): string | undefined {
    const menu = this.menuState;
    if ((this.busy && !holding) || this.exportJob || this.copyJob || this.checkJobs.size || this.agentLeases.size || !this.queue.idle) return 'The book is busy.';
    if (menu && (menu.busy || menu.saving || menu.textEditing || menu.activeEditor)) return 'The book is being edited.';
    if (this.textEditorsOpen?.()) return 'A text of the book is open in its editor.';
    return undefined;
  }
  /** What an automatic sync would do, from the status read just now, or a new read of it. */
  private async lookForAuto(): Promise<AutoLook> {
    if (Date.now() - this.statusRead > 3000) await this.refreshSync();
    if (this.removed) return 'stop';
    const state = this.syncView?.status?.state;
    if (state === 'removed' || state === 'newer') return 'stop';
    if (state === 'unavailable') throw new Error(this.syncView?.status?.detail ?? 'The remote cannot be read.');
    return state === 'behind' ? 'pull' : state === 'ahead' ? 'push' : 'none';
  }
  /** Whether the book changed since its last sync, from its revision and the sync record alone. */
  private async editedSinceSync() {
    const state = await readSyncState(this.book.folder).catch(() => undefined);
    if (!state?.lastSynced) return true;
    return await captureBookStateRevision(this.book.folder).catch(() => '') !== state.lastSynced.bookStateRevision;
  }
  /**
   * Whether this book never starts syncing by itself (ADR 0012, section 3): the sample book or a template preview book;
   * set by the app. Read-only opens and untrusted books are told apart by the service.
   */
  syncExcluded = false;
  private stopUploads?: () => void;
  /** The first sync by itself, tried again after the next save when it did not happen (`FirstSync`). */
  private readonly firstSync = new FirstSync(() => this.startByItself());
  /** Whether the book's first sync by itself ran, which uploads its originals after the commit. */
  private startedByItself = false;
  private async startByItself() {
    const service = this.syncService;
    if (!service || this.closing) return;
    if (!await service.startsOnOpen(this.book.folder, { excluded: this.syncExcluded, readOnly: this.book.readOnly })) return;
    // Waits for the book while a reload or the first save holds it.
    for (let attempt = 0; attempt < 50 && this.busy && !this.closing; attempt++) await new Promise((resolve) => setTimeout(resolve, 200));
    if (this.closing) return;
    // Automatic: a book edited elsewhere and here before its first sync shows as changed on two Macs, and the user
    // chooses with Sync Now; nothing is kept both by itself.
    await this.syncNow({ start: true, auto: true, automatic: { pushOnly: false } });
    this.startedByItself = true;
  }
  /**
   * Starts what sync does by itself when the book opens, outside the open path so opening is not slower: a trusted book
   * with no sync state for this remote starts syncing (its first sync), and a book that syncs here resumes uploading
   * the originals its last commits named. Failures say so in the status bar; nothing here fails the open.
   */
  async syncOnOpen() {
    const service = this.syncService;
    if (!service || this.closing) return;
    this.stopUploads ??= service.onUploads((folder) => { if (folder === this.book.folder && this.syncView && !this.closing) this.publishSync(this.syncView); });
    this.startedByItself = false;
    // With Sync automatically, the scheduler runs the first sync, tries it again with its backoff when the remote cannot
    // be reached, and then pulls what another Mac pushed.
    if (this.automatic()) this.autoSync.opened();
    else await this.firstSync.run();
    // A book that synced before resumes its upload; a sync by itself uploads after its commit.
    if (!this.startedByItself && this.bookSync === 'syncing') this.uploadOriginals();
  }
  /**
   * Uploads the originals the last commits named, in the background (`SyncService.upload`). One that failed is tried
   * again with the scheduler's backoff and shows in the status bar; only a manual sync also says so in a notice.
   */
  private uploadOriginals(manual = true) {
    const service = this.syncService;
    if (!service || this.book.readOnly) return;
    void service.uploadAfterSync(this.book.folder, { automatic: !manual }).then(() => {
      this.autoSync.uploadEnded();
      if (this.syncView && !this.closing) this.publishSync(this.syncView);
    }, (error) => {
      if (this.closing) return;
      this.autoSync.uploadFailed();
      if (manual && !this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, 'Originals are still to be uploaded: ' + errorMessage(error));
    });
  }
  /** How the book stands with the configured remote, as last read; the app's menus follow it. */
  bookSync: SyncStanding['sync'] = 'unconfigured';
  /**
   * Asks whether a book that last synced somewhere else starts here as a new history, and saves the answer: declining
   * stops syncing it on this Mac, so it is not asked again. Rejects when the answer could not be saved, and the book is
   * then asked about again at its next look at the remote.
   */
  syncElsewhere?: () => Promise<void>;
  private askingElsewhere = false;
  /** The configured remote, for a book that syncs with it on this Mac. A stopped book has no traffic with it. */
  private async syncedRemote() {
    if (!this.syncService) throw new Error('Sync is not available.');
    const connection = await this.syncService.connect(this.book.folder);
    const state = await readSyncState(this.book.folder);
    if (state.remoteId !== connection.remoteId || state.enabled === false) throw new Error('This book does not sync with “' + connection.name + '” on this Mac. Choose File → Sync → Start Syncing first.');
    return connection.remote;
  }
  /**
   * Looks at the remote again and publishes the status, with `message` for the editor to show once. A pull that was
   * given up while the book was read (when it opened, or a reload) is named once.
   */
  async refreshSync({ message }: { message?: string } = {}) {
    if (this.closing) return;
    const standing = this.syncService ? await this.syncService.standing(this.book.folder) : { sync: 'unconfigured' as const };
    this.bookSync = standing.sync;
    // While a sync runs, the engine owns the record; its own failures are reported by the sync.
    const abandoned = this.syncing ? undefined : await takeAbandonedAtOpen(this.book.folder).catch(() => undefined);
    const notice = message ?? (abandoned ? 'The last sync could not be finished: ' + abandoned.error.replace(/\.?$/, '.') +
      ' Sync again to continue with the version on the remote; this Mac’s version is kept if it holds anything new.' : undefined);
    // Not while a sync runs: the answer needs the book. Once it is saved, the book no longer reads as synced elsewhere.
    if (standing.sync === 'elsewhere' && !this.syncing && !this.askingElsewhere && !this.book.readOnly && this.syncElsewhere) {
      this.askingElsewhere = true;
      void this.syncElsewhere().catch((error) => { if (!this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, errorMessage(error)); })
        .finally(() => { this.askingElsewhere = false; });
    }
    if (standing.sync !== 'syncing' && standing.sync !== 'unavailable') {
      if (notice && !this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, notice);
      this.publishSync(undefined);
      return;
    }
    const name = this.syncService?.name ?? '';
    if (this.syncing) { this.publishSync({ ...this.syncView, folder: name, syncing: true, message: notice }); return; }
    const remote = standing.connection?.remote;
    const described = remote ? await describeSync(this.book.folder, remote) : unavailableStatus(standing.error ?? 'The remote cannot be read.', standing.access);
    // A sync that found the book deleted from sync stays the status until the user decides: over a bucket a status
    // read does not see a tombstone over commits another Mac pushed after the deletion (#283).
    const status = this.removed && described.state !== 'unavailable' ? { state: 'removed' as const, pendingOriginals: 0 } : described;
    this.statusRead = Date.now();
    const none = { ids: [] as string[], notUploaded: [] as string[], neverUploaded: undefined };
    const away: Awaited<ReturnType<typeof originalsNotHere>> = remote && (status.pendingOriginals || status.neverUploaded) ? await originalsNotHere(this.book.folder, remote).catch(() => none) : none;
    const lost = new Map((away.neverUploaded ?? []).map(({ id, by }) => [id, by]));
    if (away.ids.join() !== [...this.notDownloaded].join() || away.notUploaded.join() !== [...this.stillUploading].join() || JSON.stringify([...lost]) !== JSON.stringify([...this.neverUploaded])) {
      this.notDownloaded = new Set(away.ids);
      this.stillUploading = new Set(away.notUploaded);
      this.neverUploaded = lost;
      // The book check and the asset statuses say so at once: the book renders again with the new statuses. While
      // the book is busy, the save or load that follows renders them anyway.
      if (!this.closing && !this.busy) this.notify({ value: this.activate(this.book) });
    }
    if (!this.syncing) this.publishSync({ folder: name, status, ...(notice ? { message: notice } : {}) });
  }
  /**
   * Syncs with the configured remote and says what happened in the status bar. Only a book that syncs here, unless
   * `start`, which makes one that does not sync here start (Start Syncing): only a trusted book, so an untrusted one
   * throws `UntrustedBookError` unless `trust` (the user agreed to trust it). `auto` is the start when the book opened,
   * which never starts a book stopped on this Mac. Errors are thrown for the app to show: `SyncElsewhereError`, before
   * anything is written or pushed, for a book that last synced somewhere else, so the app asks first. The book's record
   * changes only once the sync holds the book. The originals the commit names upload after it, in the background.
   */
  syncNow(options: SyncRequest = {}): Promise<SyncOutcome | undefined> {
    // An automatic sync never joins or waits: whatever syncs the book already does its work.
    if (options.automatic && this.syncTask) return Promise.resolve(undefined);
    // A manual sync waits for an automatic one, which never keeps both, and then syncs as asked.
    if (!options.automatic && this.syncTask && this.syncAutomatic) {
      const running = this.syncTask;
      return running.catch(() => undefined).then(() => this.syncNow(options));
    }
    // One that is being stopped is not joined: Start Syncing right after Stop Syncing starts again once it ended.
    if (!options.automatic && this.syncTask && this.syncRun?.stopped) return this.syncTask.catch(() => undefined).then(() => this.syncNow(options));
    // A second request while a sync runs (Start Syncing during the first sync by itself, a click on the status) joins
    // it before it touches anything, so only the request that set the syncing state clears it.
    if (this.syncTask) return this.syncTask;
    // A sync the user asked for ends the backoff, and a book that stopped syncing by itself (deleted from sync, an
    // untrusted book) is looked at again.
    if (!options.automatic && !options.auto) this.autoSync.reset();
    const run = this.syncRun = { stopped: false };
    const task = this.runSync(options, run).finally(() => { if (this.syncTask === task) { this.syncTask = undefined; this.syncAutomatic = false; } });
    this.syncTask = task;
    this.syncAutomatic = !!options.automatic;
    return task;
  }
  private syncTask?: Promise<SyncOutcome | undefined>;
  /** The sync that runs, as what turns sync off sees it: one `stopped` before it holds the book ends without a sync. */
  private syncRun?: { stopped: boolean };
  /** Stop Syncing being written; a sync it stopped ends after it, so nothing starts again before. */
  private stopTask?: Promise<void>;
  private stopSending() {
    if (this.syncTask && this.syncRun) this.syncRun.stopped = true;
    this.aheadJob?.abort(new SyncStoppedError());
  }
  /**
   * What a sync sends before it holds the book (`uploadAhead`): its content files and previews, which take minutes for a
   * large first sync. Stopped by Stop Syncing and by closing the book. The previews that went up are kept for the remote
   * they are on, so a sync tried again does not read them back.
   */
  private aheadJob?: AbortController;
  private ahead?: { remoteId: string; previews: UploadedPreviews };
  private sending?: { done: number; total: number };
  private sendingTask?: Promise<UploadedPreviews>;
  /** Whether a sync sends previews now, without holding the book; Stop Syncing then ends it. */
  get sendingAhead() { return !!this.aheadJob; }
  private async sendAhead(connection: { remoteId: string; remote: SyncRemote }, run: { stopped: boolean }, closing?: AbortSignal) {
    if (run.stopped) throw new SyncStoppedError();
    if (this.ahead?.remoteId !== connection.remoteId) this.ahead = { remoteId: connection.remoteId, previews: new Map() };
    const { previews } = this.ahead;
    const job = this.aheadJob = new AbortController();
    const stop = () => job.abort(closing?.reason);
    if (closing?.aborted) stop();
    closing?.addEventListener('abort', stop, { once: true });
    if (this.closing) job.abort(new Error('The book closed.'));
    let published = 0;
    try {
      this.syncChanged?.();
      if (DocumentSession.sendingDelay) {
        this.sending = { done: 0, total: 1 };
        this.publishSync(this.syncView);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, DocumentSession.sendingDelay);
          job.signal.addEventListener('abort', () => { clearTimeout(timer); reject(job.signal.reason); }, { once: true });
        });
      }
      await uploadAhead({ remote: connection.remote, book: this.book, ahead: previews, signal: job.signal, progress: (done, total) => {
        this.sending = { done, total };
        if (done < total && Date.now() - published < 250) return;
        published = Date.now();
        if (this.syncView && !job.signal.aborted) this.publishSync(this.syncView);
      } });
      return previews;
    } finally {
      closing?.removeEventListener('abort', stop);
      this.aheadJob = undefined;
      this.sending = undefined;
      // The sync holds the book from here on: no progress is shown, and Stop Syncing is not offered.
      if (this.syncView && !this.closing) this.publishSync(this.syncView);
    }
  }
  /** Whether the sync that runs is automatic. */
  private syncAutomatic = false;
  private async runSync({ start = false, auto = false, trust = false, automatic }: SyncRequest, run: { stopped: boolean }): Promise<SyncOutcome | undefined> {
    if (!this.syncService) throw new Error('Sync is not available.');
    const connection = await this.syncService.connect(this.book.folder);
    const state = await readSyncState(this.book.folder);
    const standing = bookSync(state, connection.remoteId);
    // A stopped book whose last sync belongs to another remote starts here only as a new history, too.
    if (standing === 'elsewhere' || (start && standing === 'stopped' && syncedElsewhere(state, connection.remoteId))) throw new SyncElsewhereError();
    if (standing !== 'syncing' && !start) throw new Error('This book does not sync on this Mac. Choose File → Sync → Start Syncing.');
    if (auto && standing === 'stopped') return undefined;
    // Only a trusted book syncs, also one that synced before it was trusted here.
    await this.syncService.optIn(this.book.folder, { trust });
    this.syncing = true;
    this.storageFull = undefined;
    this.publishSync({ ...this.syncView, folder: connection.name, syncing: true, message: undefined });
    let message: string | undefined;
    let synced = false;
    try {
      // Originals come after the sync, in the background (`downloadSyncedOriginals`), so the book stays usable.
      const manage = this.syncService.kind === 'icloud' ? { manage: true as const } : {};
      let ahead: UploadedPreviews;
      try {
        // A book that was never saved here since it was made (imports alone) gets its lineage ID first: what goes up is
        // stored under it.
        if (!this.book.project.bookId && !automatic?.pushOnly) {
          await this.hold(async () => {
            this.stopWatch();
            try { if (await ensureBookId(this.book.folder)) this.notify({ value: this.activate(await loadProject(this.book.folder, this.cache), true) }); }
            finally { this.watchProject(this.book); }
          });
        }
        this.sendingTask = this.sendAhead(connection, run, automatic?.signal);
        ahead = await this.sendingTask;
      }
      catch (error) {
        // Closing the book ends what it was sending; that is no failure to report either.
        if (this.closing) return undefined;
        if (error instanceof StoreFullError) this.storageFull = { message: error.message, ...manage };
        throw error;
      }
      // A save, a reload or an agent's change made meanwhile may hold the book for a moment.
      await this.whenIdle();
      if (this.closing) return undefined;
      const begun = automatic ? this.automaticRuns.begin(automatic.signal) : undefined;
      let result: SyncOutcome;
      try {
        result = await this.sync(connection.remote, { remoteId: connection.remoteId, ahead,
          // Turned off meanwhile, here or by its record (Delete from Sync, the sheet that asks which books sync).
          unless: (now) => run.stopped || (now.enabled === false && state.enabled !== false), full: (error) => { this.storageFull = { message: error.message, ...manage }; },
          ...(automatic && begun ? { fastForwardOnly: true, pushOnly: automatic.pushOnly, signal: begun.run.job.signal,
            // The gate is read again as the pull is applied: an editor may have opened while the sync read the remote.
            beforeApply: () => begun.mayApply(() => this.closing || !!this.pullBlocked({ holding: true })) } : {}) });
      } finally { begun?.end(); }
      // Errors keep their class (`hold`): a tombstone is a `BookDeletedError`, and the app asks what becomes of the book.
      // An automatic sync says only what changed the book; the status bar shows the rest.
      message = !automatic || result.changed ? describeOutcome(result) : undefined;
      synced = !automatic || (result.action !== 'deferred' && !(result.action === 'diverged' && !result.pulled));
      if (synced) this.removed = false;
      return result;
    } catch (error) {
      if (error instanceof SyncStoppedError) { await this.stopTask?.catch(() => {}); return undefined; }
      if (error instanceof BookDeletedError) this.removed = true;
      throw error;
    } finally {
      this.syncing = false;
      await this.refreshSync({ message }).catch((error) => console.warn('ImageFlow could not read the sync status', error));
      // The originals the commit named go up now, in the background. A remote that was full pauses them until Sync Now
      // (or the book's next open): an automatic sync does not try the same original again at every idle.
      if (synced && !run.stopped) this.uploadOriginals(!automatic);
      // Placing downloaded originals reloads the book, which an automatic sync does only when nothing blocks a pull.
      if (!run.stopped && (!automatic || !automatic.pushOnly) && this.keepOriginals?.() && this.syncView?.status && this.syncView.status.pendingOriginals > (this.syncView.status.notUploaded ?? 0)) void this.downloadSyncedOriginals({ automatic: !!automatic }).catch((error) => { if (!automatic && !this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, 'Originals are still to be downloaded: ' + errorMessage(error)); });
    }
  }
  /**
   * Makes the book sync on this Mac without syncing it yet; with `newHistory`, also one that last synced somewhere
   * else, whose interrupted pull is finished first under the writer lock.
   */
  async startSyncing(options: { newHistory?: boolean; trust?: boolean } = {}) {
    const service = this.syncService;
    if (!service) throw new Error('Sync is not available.');
    const result = await this.run(() => service.start(this.book.folder, options));
    if ('error' in result) throw new Error(result.error);
    this.autoSync.reset();
    await this.refreshSync();
  }
  /**
   * The book's window came to the front (the app throttles it): with Sync automatically, a look at the remote that pulls
   * a fast-forward and pushes what is waiting; otherwise only the status is read again.
   */
  focused() {
    if (this.closing || !this.syncView) return;
    if (this.automatic()) this.autoSync.focused();
    else void this.refreshSync().catch((error) => console.warn('ImageFlow could not read the sync status', error));
  }
  /** The remote said something changed (an iCloud push, #284): a look like a focus, for every book on that remote. */
  notified() {
    if (!this.closing && this.automatic()) this.autoSync.notified();
  }

  /** Waits until a sync of the book that is running has ended (Delete from Sync waits for it before it deletes). */
  async settleSync() {
    // One that is still sending is stopped: it would go on for minutes.
    this.stopSending();
    await this.syncTask?.catch(() => {});
  }
  /** Waits, up to 10 s, while a reload or the first save holds the book (a book the library just opened). */
  async whenIdle() {
    for (let attempt = 0; attempt < 50 && this.busy && !this.closing; attempt++) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  /**
   * Sync Again on a book deleted from sync on another Mac (#283): through the session, which holds the writer lock, the
   * book gets a new lineage and a fresh history (`SyncService.syncAgain`), the editor takes the new project.json, and
   * the book syncs as a new book. An untrusted book throws `UntrustedBookError` unless `trust`.
   */
  async syncAgain(options: { trust?: boolean } = {}) {
    const service = this.syncService;
    if (!service) throw new Error('Sync is not available.');
    await this.settleSync();
    await this.whenIdle();
    // Rejects with the service's own error, so an untrusted book is an `UntrustedBookError` the app asks about.
    const { reverted } = await this.hold(async () => {
      this.stopWatch();
      try {
        const result = await service.syncAgain(this.book.folder, options);
        this.notify({ value: this.activate(await loadProject(this.book.folder, this.cache), true) });
        return result;
      } finally { this.watchProject(this.book); }
    });
    // Photos whose newer originals were only in the deleted book go back to the files this Mac has.
    if (reverted && !this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, (reverted === 1 ? '1 photo shows' : reverted + ' photos show') +
      ' the version on this Mac again: ' + (reverted === 1 ? 'its newer original was' : 'their newer originals were') + ' only in the deleted book.');
    return this.syncNow();
  }
  /**
   * Templates → Stop Trusting This Book's Template…: withdraws the trust, and an untrusted book stops syncing on this
   * Mac (`SyncService.distrust`). Serialized with the book's other work, so it is refused while a sync of the book runs
   * instead of stopping it halfway.
   */
  async stopTrusting() {
    // Without a backend no sync record is written; the book is only untrusted.
    const service = this.syncService?.configured ? this.syncService : undefined;
    const result = await this.run(() => (service ? service.distrust(this.book.folder) : distrustBook(this.book.folder)));
    if ('error' in result) throw new Error(result.code === 'BOOK_BUSY' ? 'Wait for the book to finish syncing, then stop trusting it.' : result.error);
    // A sync that does not hold the book yet sends nothing more of it.
    this.stopSending();
    await this.updateNetwork();
    if (service) await this.refreshSync();
  }
  /**
   * Stops syncing on this Mac; the remote and the book are left as they are. It changes only the sync record, which is
   * serialized on its own (`updateSyncState`), so it does not wait for the book.
   */
  async stopSyncing() {
    if (!this.syncService) throw new Error('Sync is not available.');
    // First, so a sync that is about to hold the book does not turn sync on again.
    this.stopSending();
    const stopping = this.stopTask = this.syncService.stop(this.book.folder);
    try { await stopping; } finally { if (this.stopTask === stopping) this.stopTask = undefined; }
    this.removed = false;
    await this.refreshSync();
  }
  /**
   * Downloads the owned originals that are only previews here, in the background: the book stays usable while they are
   * fetched and checked (`stageOriginals`), the sync status shows how far it is with Cancel, and they go into place in
   * one short step at the end, when the book reloads to show them. A second request while one runs waits for nothing.
   * Cancel keeps the originals downloaded by then.
   */
  async downloadSyncedOriginals({ automatic = false }: { automatic?: boolean } = {}) {
    if (this.downloadJob) return [];
    const remote = await this.syncedRemote();
    const job = new AbortController();
    this.downloadJob = job;
    const show = (downloading?: { done: number; total: number }) => {
      this.downloading = downloading;
      if (this.syncView) this.publishSync(this.syncView);
    };
    let placed: string[] = [];
    let total = 0;
    let away = 0;
    try {
      const staged = await stageOriginals({ remote, folder: this.book.folder, signal: job.signal, notUploaded: (count) => { away = count; },
        progress: (done, all) => { total = all; if (all) show({ done, total: all }); } });
      // After an automatic sync, placing them (which reloads the book and resets Undo) waits like a pull until nothing
      // blocks one (#284); the staged files stay meanwhile.
      if (automatic && staged.length) await whenUnblocked(() => this.pullBlocked(), () => this.closing, this.autoSyncTiming.gate);
      if (staged.length && this.closing) {
        await Promise.all(staged.map(({ staging }) => rm(staging, { force: true })));
        return [];
      }
      if (staged.length) {
        const place = async () => {
          this.stopWatch();
          try {
            const ids = await placeOriginals(this.book.folder, staged);
            if (ids.length) this.notify({ value: this.activate(await loadProject(this.book.folder, this.cache), true) });
            return ids;
          } finally { this.watchProject(this.book); }
        };
        // Placing never stops an automatic sync (as an edit does): it waited for the book to be free.
        const result: Result<string[]> = automatic ? await this.hold(place).then((value) => ({ value }), (error: unknown) => ({ error: errorMessage(error) })) : await this.run(place);
        if ('error' in result) { await Promise.all(staged.map(({ staging }) => rm(staging, { force: true }))); throw new Error(result.error); }
        placed = result.value;
      }
    } catch (error) {
      show(undefined);
      await this.refreshSync();
      throw error;
    } finally { if (this.downloadJob === job) this.downloadJob = undefined; }
    show(undefined);
    const left = total - placed.length;
    // Named by a commit, not on the remote yet: still uploading from another Mac, and downloaded once they have arrived.
    const uploading = away ? ' ' + away + (away === 1 ? ' original is' : ' originals are') + ' still uploading from another Mac.' : '';
    await this.refreshSync({ message: (!total ? (away ? 'Nothing to download yet.' : 'Every original is on this Mac.') : job.signal.aborted && left > 0
      ? 'Downloaded ' + placed.length + ' of ' + total + ' originals. The rest stay previews until you download them.'
      : 'Downloaded ' + placed.length + (placed.length === 1 ? ' original.' : ' originals.')) + uploading });
    return placed;
  }
  /** Stops a download of originals; those downloaded so far are kept. */
  cancelDownload() { this.downloadJob?.abort(); }
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
  /** A Copy into Book or Duplicate that materializes photos without a file: Cancel stops it as it stops an export. */
  copyJob?: AbortController;
  cancelExport() { this.exportJob?.abort(); this.copyJob?.abort(); }
  /**
   * Runs a copy that may materialize photos (`collectSources`, `saveDocumentCopy`) with this session's cancel and the
   * status bar's progress. Only one at a time: a second waits for nothing and is refused.
   */
  async copying<T>(owner: BrowserWindow, task: (options: CopyOptions) => Promise<T>, label = 'Copying into book') {
    if (this.copyJob) throw new Error('Wait for the copy in progress to finish.');
    const job = new AbortController();
    this.copyJob = job;
    // The window's own task clears its status when it ends; only what is still running is reported. The count is of
    // the originals its sources render, such as Lightroom's; the files copied besides them are quick.
    const progress = (value: TaskProgress) => { if (!owner.isDestroyed()) owner.webContents.send(channels.progress, value); };
    progress({ text: label, cancel: true });
    try {
      return await task({ signal: job.signal, progress: ({ done, total }) => { if (total && done < total) progress({ text: label, done, total, cancel: true }); } });
    } finally { if (this.copyJob === job) this.copyJob = undefined; }
  }
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
    this.firstSync.stop();
    // A sync that is still sending, also one the user asked for, does not hold the book and stops.
    this.aheadJob?.abort(new Error('The book closed before it finished syncing.'));
    // An automatic sync that runs stops at its next request (it is aborted), so closing never waits for the remote.
    const automatic = this.autoSync.close();
    // A background upload goes on after the book closes: it needs no writer lock, and Quit cancels it.
    this.stopUploads?.();
    this.linkedWatch?.stop();
    this.linkedWatch = undefined;
    this.stopPreviewSource?.();
    this.previewJob.abort();
    this.exportJob?.abort();
    for (const job of this.checkJobs) job.abort();
    for (const reply of this.agentLeases.values()) reply(false);
    this.queue.close(new AuthoringError('PROJECT_CLOSED', 'This book closed. Other open books are still available.'));
    this.closeTask = (async () => {
      await this.queue.whenIdle();
      // Sync work when closing shares one bound: an automatic sync still reading the remote's identity then finds the
      // book closing, and the push gets what is left of it.
      const deadline = Date.now() + DocumentSession.closePushMs;
      await Promise.race([Promise.all([automatic.catch(() => {}), this.sendingTask?.catch(() => {})]), new Promise((resolve) => setTimeout(resolve, DocumentSession.closePushMs))]);
      // Published saves must settle before releasing the single-writer capability.
      while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
      // What changed since the last sync goes up while the writer lock is still held, for at most a few seconds.
      await this.pushOnClose(deadline).catch((error) => console.warn('ImageFlow could not sync the book it closed', error));
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
  /**
   * How long sync work may delay closing a book (#284); the originals the push names upload afterwards, in the
   * background. The bound stops every request to the remote at once, and the push checks it between its local steps
   * (each photo's fact, each content file, each preview). A commit request that was sent is waited for until the store
   * gives up, so the commit is recorded (`abortableRemote`). What it cannot stop is one local step under way: reading the
   * book's files to know its state, hashing an original whose digest is not known yet (a photo just imported) or
   * reading and decoding one preview. Those take milliseconds for a book's own files and up to seconds for a large
   * original the book has not hashed yet.
   */
  static closePushMs = 5000;
  /**
   * The push when the book closes (#284), with the writer lock held: state and previews of what changed since the last
   * sync, never a pull, a conflict copy or anything that changes the book (`pushOnly`). Bounded by `closePushMs`: a
   * remote that is slow or out of reach stops it (`SyncOptions.signal`), and the next sync pushes. Only for a book that
   * syncs by itself here, not one Delete from Sync is deleting, and not one that is unchanged (no request then).
   */
  private async pushOnClose(deadline = Date.now() + DocumentSession.closePushMs) {
    const service = this.syncService;
    // Ends with `closing`, which `autoAllowed` refuses: asked here without it.
    if (!service || !this.automatic() || this.deleting || this.book.readOnly || this.syncExcluded || service.booksUnchosen || this.removed) return;
    const state = await readSyncState(this.book.folder).catch(() => undefined);
    if (!state?.remoteId || state.enabled === false || !state.lastSynced || state.pull || state.abandoned) return;
    if (!await this.editedSinceSync() || !await bookTrusted(this.book.folder).catch(() => false)) return;
    const job = new AbortController();
    const timer = setTimeout(() => job.abort(new Error('The book closed before it finished syncing.')), Math.max(0, deadline - Date.now()));
    try {
      const connection = await new Promise<Awaited<ReturnType<SyncService['connect']>>>((resolve, reject) => {
        job.signal.addEventListener('abort', () => reject(job.signal.reason), { once: true });
        service.connect(this.book.folder).then(resolve, reject);
      });
      if (connection.remoteId !== state.remoteId) return;
      const outcome = await syncBook({ remote: connection.remote, book: this.book, cover: this.cover, device: macName(), pushOnly: true, signal: job.signal });
      // Its originals go up after it in the app's service, without the writer lock; a full remote waits for Sync Now.
      if (outcome.pushed.length) void service.uploadAfterSync(this.book.folder, { automatic: true }).catch(() => {});
    } finally { clearTimeout(timer); }
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
    if ((!this.reshaped.size && !this.notDownloaded.size && !this.neverUploaded.size) || !book.sources) return book;
    return { ...book, sources: Object.fromEntries(Object.entries(book.sources).map(([key, status]) => {
      if (status.kind !== 'photo') return [key, status];
      let marked = this.reshaped.has(status.id) ? { ...status, reshaped: true } : status;
      // An original another Mac synced and this one has not downloaded yet is not missing: it is on its way.
      if (status.state === 'missing' && this.neverUploaded.has(status.id)) {
        const by = this.neverUploaded.get(status.id);
        marked = { ...marked, problem: 'Original never uploaded' + (by ? ' from “' + by + '”' : ' from the Mac that added it') };
      } else if (status.state === 'missing' && this.stillUploading.has(status.id)) marked = { ...marked, problem: 'Original still uploading from another Mac' };
      else if (status.state === 'missing' && this.notDownloaded.has(status.id)) marked = { ...marked, problem: 'Original not downloaded yet' +
        (this.downloading ? ' (downloading)' : ' (File → Sync → Download Originals)') };
      return [key, marked];
    })) };
  }
  // --- Previews of photos without a file ---------------------------------------------------------------------------
  // A load shows the photos that have no preview yet, or an older one, and leaves the previews to this session: they
  // are fetched after it, and the book loads again as they come (ADR 0011, §2).
  private readonly previewJob = new AbortController();
  private stopPreviewSource?: () => void;
  private readonly previewRequests = new PreviewRequests();
  private fetchingPreviews = false;
  /** `folder` is the book's real path, as a load names it. */
  private previewSource(folder: string) {
    this.stopPreviewSource?.();
    this.stopPreviewSource = backgroundPreviews(folder, { wanted: (previews) => this.wantPreviews(previews), problem: (preview) => this.previewRequests.problem(preview) });
  }
  /** Previews a load of this book wants; those of the load that opened it are handed in once the session has it. */
  wantPreviews(previews: readonly WantedPreview[]) {
    // After the load that wanted them, so the book it loads is the one they are fetched for.
    if (this.previewRequests.want(previews)) setImmediate(() => void this.fetchPreviews());
  }
  private async fetchPreviews() {
    if (this.fetchingPreviews || this.closing) return;
    this.fetchingPreviews = true;
    try {
      for (;;) {
        // An import saves and loads the book before it becomes the open one.
        while (this.busy && !this.closing) await new Promise((resolve) => setTimeout(resolve, 100));
        const ids = this.closing ? [] : this.previewRequests.take();
        if (!ids.length) return;
        try {
          const facts = await this.factsOf(this.book);
          for (const [provider, refs] of this.providedRefs(ids)) await this.providedChanged(provider, refs, facts);
        } catch (error) { this.previewsFailed(ids, error); }
        // Those no longer in the book (an import undone meanwhile) are asked for again if they come back.
        this.previewRequests.finish(ids);
      }
    } finally { this.fetchingPreviews = false; }
  }
  // A fetch that failed as a whole: its photos say so instead of loading for ever.
  private previewsFailed(ids: readonly string[], error: unknown) {
    const problem = 'Preview unavailable: ' + errorMessage(error);
    this.previewRequests.finish(ids, () => ({ state: 'unreadable', problem }));
    this.notify({ error: errorMessage(error) });
    if (!this.closing && ids.some((id) => this.book.sources?.['photo:' + id]?.pending)) { this.linkedReloadPending = true; void this.reloadLinked(); }
  }
  // The photos without a file among `ids`, by their provider.
  private providedRefs(ids: readonly string[]): Map<SourceProvider<Locator>, SourceRef<Locator>[]> {
    const wanted = new Set(ids);
    const groups = new Map<SourceProvider<Locator>, SourceRef<Locator>[]>();
    for (const entry of sourceEntries(this.book)) {
      if (entry.kind !== 'photo' || !wanted.has(entry.id) || isFileLocator(entry.locator)) continue;
      const provider = providerOf(entry.locator);
      groups.set(provider, [...groups.get(provider) ?? [], { id: entry.id, locator: entry.locator }]);
    }
    return groups;
  }
  /** Refresh from Lightroom: makes the previews of these photos again from the photos themselves. Runs in the background. */
  refreshPreviews(ids: readonly string[]) {
    const groups = this.providedRefs(ids);
    void (async () => {
      const facts = await this.factsOf(this.book);
      for (const [provider, refs] of groups) await this.providedChanged(provider, refs, facts, true);
    })().catch((error) => this.notify({ error: errorMessage(error) }));
    return [...groups.values()].reduce((sum, refs) => sum + refs.length, 0);
  }
  /** Retry asks again for previews that failed before. */
  retryPreviews() { this.previewRequests.clear(); }

  // Reloads as previews come: soon for the first ones, then less often, since each reload renders the book again. Not
  // while a text is being edited, which a reload would end.
  private static previewReloadMs = [1500, 5000, 10_000];
  // A provider reported photos without a file as changed, or a load wants their previews: their facts and previews are
  // brought up to date, and the book reloads only for what it shows differently. `again` makes every preview anew.
  private async providedChanged(provider: SourceProvider<Locator>, refs: SourceRef<Locator>[], facts: AssetFacts, again = false) {
    if (this.closing || !refs.length) return;
    const ids = refs.map(({ id }) => id);
    const noticed = new Set<string>();
    let reloads = 0, last = Date.now();
    try {
      const status = (id: string) => this.book.sources?.['photo:' + id];
      const changes = await providedChanges(this.book.folder, provider, refs, facts, { staging: join(this.cache, 'provider-staging'), signal: this.previewJob.signal, again,
        available: (id) => status(id)?.state === 'available',
        shown: (id) => ({ available: status(id)?.state === 'available', outOfDate: !!status(id)?.outOfDate, pending: !!status(id)?.pending }),
        progress: (id, changed, done, total) => {
          this.previewRequests.settled(id, changed.problems?.get(id));
          if (!changed.reload.length || done === total || this.closing || this.menuState?.textEditing || this.menuState?.activeEditor) return;
          const steps = DocumentSession.previewReloadMs;
          if (Date.now() - last < steps[Math.min(reloads, steps.length - 1)]) return;
          reloads++; last = Date.now();
          this.showProvided(changed, noticed);
        } });
      // Photos the provider answered for without a preview being asked for: offline now, say.
      this.previewRequests.finish(ids, (id) => changes.problems?.get(id));
      if (this.closing) return;
      this.showProvided(changes, noticed);
      if (again && changes.problems?.size && !this.window.isDestroyed()) {
        const [{ problem }] = changes.problems.values();
        this.window.webContents.send(channels.appNotice, (changes.problems.size === 1 ? 'One preview could not be refreshed. ' : changes.problems.size + ' previews could not be refreshed. ') + problem);
      }
    } catch (error) { this.previewsFailed(ids, error); }
  }
  // `noticed`: the photos a notice of this refresh named already, as it shows what has come so far.
  private showProvided(changes: ProvidedChanges, noticed: Set<string>) {
    if (changes.revised.length) this.projectSession.inputs.invalidate();
    const usage = changes.reshaped.length ? assetUsage(this.book, assetPageLabels(this.summary)) : undefined;
    const placed = changes.reshaped.filter((id) => usage?.photo[id]?.length && !noticed.has(id));
    if (placed.length) {
      for (const id of placed) { this.reshaped.add(id); noticed.add(id); }
      if (!this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, (placed.length === 1 ? 'A placed photo changed its' : placed.length + ' placed photos changed their') +
        ' aspect ratio in its source. Check how ' + (placed.length === 1 ? 'it is' : 'they are') + ' cropped.');
    }
    if (changes.reload.length) { this.linkedReloadPending = true; void this.reloadLinked(); }
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
    if (!this.active || this.active.id !== id) throw new StaleBookError();
    return this.active.book;
  }

  /**
   * Imports photos that are not files, by their locators (Lightroom Classic, ADR 0011), as one undoable step. Photos
   * the book holds already are counted, not added again. The new photos show at once; their previews follow as their
   * provider hands them over.
   */
  async importProvided(locators: readonly PhotoLocator[], label: string) {
    const book = this.book;
    const { book: next, imported, counts } = await importProvidedPhotos(book, locators, { checkpoint: { origin: 'app', label } });
    if (next === book) return { summary: this.summary, imported, counts };
    this.projectSession.adoptExternal(book);
    this.projectSession.record(next, label, true, false);
    return { summary: this.activate(next), imported, counts };
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
      owner.webContents.send(channels.progress, saving ? { text: 'Adding ' + total + ' ' + (total === 1 ? noun.slice(0, -1) : noun) + ' to the book…' }
        : total > 1 ? { text: 'Importing ' + noun, done, total } : { text: 'Importing ' + noun.slice(0, -1) + '…' });
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
      // The user's own book (made here, or trusted once): every declared site, without asking. A site its template
      // newly declares is recorded and named in a quiet notice instead of a question. This holds for a template change
      // that a sync pulled too: a book syncs only while it is trusted here, through a backend inside the user's trust
      // boundary (ADR 0012).
      if (await bookTrusted(book.folder)) {
        const added = origins.filter((origin) => !known.includes(origin));
        const notice = networkNotice(added, { known: known.length > 0, downloaded: this.announceSites });
        if (added.length) {
          await approveNetwork(book.folder, added, hash);
          this.announceSites = false;
          if (notice && !this.window.isDestroyed()) this.window.webContents.send(channels.appNotice, notice);
        }
        return origins;
      }
      const trusted = await this.networkTrust?.(hash, origins).catch(() => []) ?? [];
      const approved = new Set([...known, ...trusted]);
      const pending = origins.filter((origin) => !approved.has(origin));
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


  async exportBook(owner: BrowserWindow, projectId: string, surface?: 'cover' | 'proof') {
    this.currentBook(projectId);
    // Cancel works from the moment the export starts, while it prepares the book and asks for a destination too.
    const job = new AbortController();
    this.exportJob = job;
    try { return await (surface === 'proof' ? this.runProof(owner, job) : this.runExport(owner, job, surface)); }
    finally { if (this.exportJob === job) this.exportJob = undefined; }
  }

  // The density chosen last, for the next proof of any book.
  static proofDensity: ProofDensity = 4;
  /**
   * A design proof (src/proof-sheet): the open book as it is on screen, spreads kept together, several to an A4 sheet.
   * It renders the editor's revision with the editor's photo renditions and pictures, so it takes seconds where the
   * print PDF prepares every original; it has none of the print checks and nothing in it is for print.
   */
  private async runProof(owner: BrowserWindow, job: AbortController) {
    const opened = this.book;
    const { response } = await dialog.showMessageBox(owner, { type: 'question', message: 'Export Proof',
      detail: 'A quick PDF of the spreads for reading and sharing, on A4 sheets. It uses screen-sized photos and is not for print.\n\nSpreads per sheet:',
      buttons: [...proofDensities.map((n) => n + (n === 1 ? ' Spread' : ' Spreads')), 'Cancel'],
      defaultId: proofDensities.indexOf(DocumentSession.proofDensity), cancelId: proofDensities.length });
    const perPage = proofDensities[response];
    if (!isProofDensity(perPage) || owner.isDestroyed() || job.signal.aborted) return null;
    DocumentSession.proofDensity = perPage;
    const name = bookName(opened.folder).normalize('NFC');
    const fileName = name.replace(/[^\p{L}\p{M}\p{N} _-]/gu, '-').slice(0, 80) + ' - Proof.pdf';
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: 'Export Proof', defaultPath: join(app.getPath('documents'), fileName), filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath || owner.isDestroyed() || job.signal.aborted) return null;
    // The book as it is now: an agent's save or a reload may have come in while the dialogs were open. It must not
    // change again until the proof is saved, or the proof would show a revision that no longer exists.
    const book = this.book;
    const before = await this.projectSession.inputs.capture();
    const moved = async () => {
      const after = await this.projectSession.inputs.capture({ signal: job.signal });
      return this.book !== book || before.revision !== after.revision || before.observation !== after.observation;
    };
    const id = randomUUID();
    this.renders.set(id, { book: this.marked(book), mode: 'export', network: () => this.originsFor(book), pictures: this.previewPictures });
    // Cancel stops an export at any stage.
    const progress = (stage: string, count?: { done: number; total: number }) => { if (!owner.isDestroyed()) owner.webContents.send(channels.progress, stage ? { text: stage, ...count, cancel: true } : ''); };
    try {
      const query = new URLSearchParams({ view: 'proof', per: String(perPage), title: book.project.title || name,
        date: new Date().toLocaleDateString(app.getLocale(), { dateStyle: 'medium' }) });
      const { bytes, warnings, errors } = await printProof(renderOrigin + '/render/' + id + '?' + query, job.signal, progress);
      if (await moved()) throw new Error('The book changed while the proof was made. No proof was saved; export it again.');
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
  }

  private async runExport(owner: BrowserWindow, job: AbortController, surface?: 'cover') {
    const before = await this.projectSession.inputs.capture();
    const privateCache = await mkdtemp(join(this.cache, 'export-'));
    // Cancel stops an export at any stage.
    const progress = (stage: string, count?: { done: number; total: number }) => { if (!owner.isDestroyed()) owner.webContents.send(channels.progress, stage ? { text: stage, ...count, cancel: true } : ''); };
    try {
      // Placed photos without a file are materialized first, where their provider can produce them now (ADR 0011, §4):
      // the export prints them from full-resolution originals instead of as proofs. Cancel stops it between photos.
      const book = await loadProject(this.book.folder, privateCache, true, true, { signal: job.signal,
        progress: ({ done, total }) => { if (total) { if (done < total) progress('Preparing originals', { done, total }); else progress('Preparing export…'); } } });
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
          // Only unavailable originals: the PDF is a proof of the cached previews, and says so on its pages.
          const previewsOnly = errors.every(({ code }) => code === 'source-unavailable');
          const choice = await dialog.showMessageBox(owner, { type: 'warning', message: previewsOnly ? 'Export PDF with cached previews?' : 'Export PDF with errors?',
            detail: exportErrorList(errors) + (previewsOnly ? '\n\nThose pages will be marked ORIGINAL UNAVAILABLE. Export anyway?'
              : '\n\nThe PDF may contain missing content or printing problems. Pages with unavailable originals will be marked. Export anyway?'),
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
