import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { SyncBackend } from '../src/settings';
import { cloudKitOpener, s3Opener } from './sync-backend';
import type { SyncRemoteDependencies } from './sync-backend';
import { bookTrusted, distrustBook, trustBook } from './source-access';
import { syncBook, uploadOriginals } from './sync-engine';
import type { SyncOptions, UploadOutcome } from './sync-engine';
import { bookSync, readSyncState, startSyncing, stopSyncing, syncedElsewhere, updateSyncState } from './sync-pull';
import type { BookSync } from './sync-pull';
import type { SyncRemote } from './sync-remote';
import { StoreAccessError } from './sync-store';
import type { StoreAccessReason } from './sync-store';
import { folderRemote } from './sync-store-folder';

/** The configured remote, with its identity and the name the app shows for it. */
export type SyncConnection = { remote: SyncRemote; remoteId: string; name: string };
/**
 * How a book stands on this Mac: as `bookSync` says against the configured remote, or `unconfigured` without a
 * backend, or `unavailable` for a book that syncs while the remote cannot be read (`error` says why).
 */
export type SyncStanding = { sync: BookSync | 'unconfigured' | 'unavailable'; connection?: SyncConnection; error?: string;
  /** Why the remote cannot be used, where it says (`StoreAccessError`): the status bar points at Settings for some. */
  access?: StoreAccessReason };

type Backend = { name: string;
  /**
   * The remote, ready to use: throws when it cannot be used now (a folder that is not there, a bucket without stored
   * credentials). Sends no request; reading the identity at `connect` is the first.
   */
  open(): Promise<SyncRemote>;
  /** Whether the backend lies inside a book's folder, which it must not sync through. */
  inside(book: string): Promise<boolean> };

/** Whether `path` is `folder` or inside it, after resolving links. */
async function contains(folder: string, path: string) {
  const [outer, inner] = await Promise.all([realpath(folder).catch(() => folder), realpath(path).catch(() => path)]);
  const between = relative(outer, inner);
  return between === '' || (!between.startsWith('..' + sep) && between !== '..' && !isAbsolute(between));
}
/**
 * A book that is not trusted on this Mac (ADR 0012, section 2) does not start syncing until the user trusts it: Start
 * Syncing asks once, and trusting it (`trustBook`) then makes it sync.
 */
export class UntrustedBookError extends Error {
  readonly code = 'SYNC_UNTRUSTED';
  constructor() {
    super('This book is not trusted on this Mac, so it does not sync. Trust it to start syncing it.');
    this.name = 'UntrustedBookError';
  }
}

/**
 * A book's background upload of originals (`uploadOriginals`), as the status bar shows it: how many went up of those
 * pending while it runs (`uploading`), and after it, why originals are left: the remote is full (`full`, paused until a
 * later sync finds room) or the upload failed (`failed`).
 */
export type UploadState = { uploading?: { done: number; total: number }; full?: { message: string; left: number }; failed?: { message: string; left: number } };

/** Whether a folder is, or lies inside, a book package. */
export const insideBook = (path: string) => path.split(sep).some((part) => /\.imageflow$/i.test(part));

/**
 * What the service needs besides the setting: for a bucket, the credential store, and where the commit headers it read
 * are kept (`<userData>/Sync Cache`). Functions, so the app can make them once it is ready.
 */
export type SyncServiceDependencies = { credentials?: () => SyncRemoteDependencies['credentials']; cacheFolder?: () => string } & Pick<SyncRemoteDependencies, 'headerCache' | 'keyIndex' | 'cloudKit' | 's3'>;

/** The remote a backend setting names. Each kind of backend is one case here. */
function openBackend(backend: SyncBackend, dependencies: SyncServiceDependencies): Backend {
  switch (backend.kind) {
    case 'folder': {
      const name = basename(backend.path);
      const remote = folderRemote(backend.path);
      return { name, open: async () => {
        // A folder on a drive that is not connected is not made again on the startup disk.
        if (!(await lstat(backend.path).catch(() => undefined))?.isDirectory()) throw new Error('The sync folder “' + name + '” is not available. Connect its drive, or choose it again in Settings → Sync.');
        return remote;
      }, inside: (book) => contains(book, backend.path) };
    }
    case 's3': {
      // The credentials are read at every use (a file, no request), so a key saved in Settings counts at once.
      const open = s3Opener(backend, { credentials: () => dependencies.credentials?.(), cacheFolder: dependencies.cacheFolder, headerCache: dependencies.headerCache, s3: dependencies.s3 });
      return { name: backend.bucket, open, inside: async () => false };
    }
    case 'icloud': {
      // The account is checked at every use; another Apple ID is another remote (`cloudKitOpener`).
      const open = cloudKitOpener({ cloudKit: dependencies.cloudKit, cacheFolder: dependencies.cacheFolder, headerCache: dependencies.headerCache, keyIndex: dependencies.keyIndex });
      return { name: 'iCloud', open, inside: async () => false };
    }
  }
}

/**
 * The app's sync service (ADR 0012): the one backend this Mac syncs through, from `AppSettings.sync`, for every open
 * book. Books do not record where they sync; a session asks the service for the remote and its identity, and the
 * service records in a book's sync state whether it syncs here (`startSyncing`, `stopSyncing`).
 *
 * It builds the remote again when the setting changes. The remote's identity is read at every `connect`, never kept:
 * a folder or bucket emptied or made again while the app runs gets a new identity, and the books that synced with the
 * old one then read as synced somewhere else instead of pushing under it. Uses that start together share one read, so
 * this Mac writes one identity to an empty remote.
 */
export class SyncService {
  private current?: { key: string; backend: Backend; identity?: Promise<string> };
  constructor(private readonly setting: () => SyncBackend | undefined, private readonly dependencies: SyncServiceDependencies = {}) {}
  /** The background uploads running, by book folder (as the open book has it), and how the last one of each book ended. */
  private readonly uploads = new Map<string, { job: AbortController; task: Promise<UploadOutcome | undefined>; again: boolean; progress: { done: number; total: number } }>();
  private readonly settled = new Map<string, Omit<UploadState, 'uploading'>>();
  private readonly listeners = new Set<(folder: string) => void>();

  private backend() {
    const setting = this.setting();
    if (!setting) { this.current = undefined; return undefined; }
    const key = JSON.stringify(setting);
    if (this.current?.key !== key) this.current = { key, backend: openBackend(setting, this.dependencies) };
    return this.current;
  }

  /** Whether a backend is configured. */
  get configured() { return !!this.backend(); }
  /** The kind of the configured backend. */
  get kind() { return this.setting()?.kind; }
  /** The name of the configured backend, for the sync status and dialogs. */
  get name() { return this.backend()?.backend.name; }

  /**
   * The configured remote and its identity, for the book in `book` when given. Throws when none is configured, it
   * cannot be reached, or it lies inside that book.
   */
  async connect(book?: string): Promise<SyncConnection> {
    const current = this.backend();
    if (!current) throw new Error('Sync is not set up on this Mac. Set it up in Settings → Sync.');
    const { name } = current.backend;
    if (book && await current.backend.inside(book)) throw new Error('The sync folder “' + name + '” is inside this book. Choose a sync folder outside every book in Settings → Sync.');
    const remote = await current.backend.open();
    // Read at every use, never kept (see above); only uses that run at once share the read.
    const identity = current.identity ??= remote.remoteId().finally(() => { if (current.identity === identity) current.identity = undefined; });
    return { remote, remoteId: await identity, name };
  }

  /** How a book stands with the configured remote. Never throws: a remote that cannot be read is reported. */
  async standing(folder: string): Promise<SyncStanding> {
    if (!this.configured) return { sync: 'unconfigured' };
    let state;
    try { state = await readSyncState(folder); }
    catch (error) { return { sync: 'unavailable', error: message(error) }; }
    try {
      const connection = await this.connect(folder);
      return { sync: bookSync(state, connection.remoteId), connection };
    } catch (error) {
      // Which remote a book synced with is known only once the remote is read; one that syncs is shown unavailable.
      return { sync: state.enabled === false ? 'stopped' : state.remoteId ? 'unavailable' : 'off', error: message(error),
        ...(error instanceof StoreAccessError ? { access: error.reason } : {}) };
    }
  }

  /**
   * Makes a book sync here (`startSyncing`); with `newHistory`, also one that last synced somewhere else. A book that is
   * not trusted starts only with `trust`, which trusts it first (`UntrustedBookError` otherwise).
   */
  async start(folder: string, options: { newHistory?: boolean; trust?: boolean } = {}) {
    const { remoteId } = await this.connect(folder);
    await this.optIn(folder, options);
    await startSyncing(folder, remoteId, options);
  }

  /**
   * The trust boundary of choosing Start Syncing (ADR 0012, section 2): only a trusted book syncs. An untrusted one
   * throws `UntrustedBookError`, so the caller asks once; with `trust` it is trusted (`trustBook`), which gives older or
   * copied books without declared sites a direct path into sync.
   */
  async optIn(folder: string, { trust = false }: { trust?: boolean } = {}) {
    if (await bookTrusted(folder)) return;
    if (!trust) throw new UntrustedBookError();
    await trustBook(folder);
  }

  /**
   * Whether a book that was just opened or created starts syncing by itself, without any setup (ADR 0012, section 3):
   * with a backend configured, a trusted book that has no sync state for this remote, or one that was chosen to sync
   * here and never synced yet. Never a book the caller `excluded` (the sample book, template previews, read-only opens),
   * an untrusted one, one stopped on this Mac (`enabled: false`, also by the first-configuration sheet) or one that last
   * synced somewhere else (asked about instead). Writes nothing; the caller syncs, which records the start.
   */
  async startsOnOpen(folder: string, { excluded = false, readOnly = false }: { excluded?: boolean; readOnly?: boolean } = {}) {
    if (excluded || readOnly || !this.configured) return false;
    if (!await bookTrusted(folder)) return false;
    const state = await readSyncState(folder);
    if (state.enabled === false) return false;
    const { remoteId } = await this.connect(folder);
    const standing = bookSync(state, remoteId);
    return standing === 'off' || (standing === 'syncing' && !state.lastSynced && !state.pull && !state.abandoned);
  }

  /**
   * The first-configuration sheet's answer (ADR 0012, section 3): the books chosen sync, each from its next open (or
   * now, for one that is open), and the others are opted out for this remote, `{ enabled: false, remoteId }`, so opening
   * them later does not start them. A chosen book that is not trusted is trusted (the sheet says so). Nothing is
   * uploaded here. A book that last synced with another remote keeps that remote's record and is only stopped, so it
   * still asks before it starts a new history here.
   */
  async chooseBooks(choices: readonly { folder: string; sync: boolean }[]) {
    const { remoteId } = await this.connect();
    for (const { folder, sync } of choices) {
      if (sync) {
        await trustBook(folder);
        await updateSyncState(folder, (state) => {
          if (state.enabled !== false || syncedElsewhere(state, remoteId)) return state;
          const { enabled: _, ...rest } = state;
          return rest;
        });
      } else {
        await this.cancelUpload(folder);
        await updateSyncState(folder, (state) => (syncedElsewhere(state, remoteId) ? (state.enabled === false ? state : { ...state, enabled: false })
          : state.enabled === false && state.remoteId === remoteId ? state : { ...state, remoteId, enabled: false }));
      }
    }
  }

  /** Stops syncing a book on this Mac, and its upload of originals; the remote is left as it is. */
  async stop(folder: string) {
    await this.cancelUpload(folder);
    await stopSyncing(folder);
  }

  /**
   * Templates → Stop Trusting This Book's Template…: an untrusted book never continues syncing, so it also stops here
   * (`enabled: false`). Local to this Mac: other Macs keep the book trusted and syncing.
   */
  async distrust(folder: string) {
    await distrustBook(folder);
    await this.stop(folder);
  }

  /** Calls `listener` with a book's folder whenever its background upload changes (`uploadState`). */
  onUploads(listener: (folder: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private tell(folder: string) { for (const listener of this.listeners) listener(folder); }

  /** How a book's background upload stands: running, or why originals are left after the last one. */
  uploadState(folder: string): UploadState {
    const running = this.uploads.get(folder);
    return { ...this.settled.get(folder), ...(running ? { uploading: { ...running.progress } } : {}) };
  }

  /**
   * Uploads a book's pending originals in the background (`uploadOriginals`), after a sync committed them, and again
   * after a restart: what is pending is derived, so an upload that stopped resumes where it was. One upload per book at
   * a time; asking while one runs makes it look again once it is done. The remote is taken from `connect` for each photo.
   * A full remote pauses it (`UploadState.full`) until a later sync finds room: each sync asks again, and the first
   * original that does not fit stops the queue. A failed upload is kept (`UploadState.failed`, with what is left) until
   * an upload ends without. Resolves with how it ended, undefined without a backend or for a book that is not trusted;
   * rejects when an upload failed (the next sync tries again).
   */
  async upload(folder: string): Promise<UploadOutcome | undefined> {
    if (!this.configured) return undefined;
    const key = folder;
    const running = this.uploads.get(key);
    if (running) { running.again = true; return running.task; }
    const job = new AbortController();
    const entry = { job, again: false, progress: { done: 0, total: 0 }, task: Promise.resolve<UploadOutcome | undefined>(undefined) };
    entry.task = (async () => {
      let outcome: UploadOutcome;
      // Nothing uploads by itself for a book that is not trusted, also one that synced before (ADR 0012, section 2).
      if (!await bookTrusted(key).catch(() => false)) return undefined;
      try {
        do {
          entry.again = false;
          outcome = await uploadOriginals({ folder: key, connect: () => this.connect(key), signal: job.signal,
            progress: (done, total) => { entry.progress = { done, total }; this.tell(key); } });
        } while (entry.again && !job.signal.aborted && !outcome.full && !outcome.stopped);
      } catch (error) {
        if (job.signal.aborted) return undefined;
        this.settled.set(key, { failed: { message: message(error), left: Math.max(0, entry.progress.total - entry.progress.done) } });
        throw error;
      }
      this.settled.set(key, outcome.full ? { full: { message: outcome.full.message, left: outcome.left } } : {});
      return outcome;
    })().finally(() => {
      if (this.uploads.get(key) === entry) this.uploads.delete(key);
      this.tell(key);
    });
    this.uploads.set(key, entry);
    this.tell(key);
    return entry.task;
  }

  /** Stops a book's background upload; the original going up is cancelled cleanly, and the next sync resumes. */
  async cancelUpload(folder: string) {
    const running = this.uploads.get(folder);
    running?.job.abort();
    await running?.task.catch(() => {});
  }

  /** The books with originals still uploading in the background, and how many are left of each: for Quit. */
  pendingUploads() {
    return [...this.uploads].map(([folder, { progress }]) => ({ folder, left: Math.max(0, progress.total - progress.done) }));
  }

  /** Cancels every background upload and waits until each has stopped; nothing half-uploaded is left on the remote. */
  async cancelUploads() {
    const running = [...this.uploads.values()];
    for (const { job } of running) job.abort();
    await Promise.allSettled(running.map(({ task }) => task));
  }

  /**
   * Syncs an open, writable book through the configured remote (`syncBook`, whose conditions apply). A book that does
   * not sync here yet starts, with no setup of its own; one that last synced somewhere else is refused with
   * `SyncElsewhereError` and nothing is pushed, so the caller asks first.
   */
  async sync(options: Omit<SyncOptions, 'remote'>) {
    const { remote, remoteId } = await this.connect(options.book.folder);
    await startSyncing(options.book.folder, remoteId);
    return syncBook({ ...options, remote });
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
