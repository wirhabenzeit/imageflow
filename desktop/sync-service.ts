import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { SyncBackend } from '../src/settings';
import { s3Opener } from './sync-backend';
import type { SyncRemoteDependencies } from './sync-backend';
import { syncBook } from './sync-engine';
import type { SyncOptions } from './sync-engine';
import { bookSync, readSyncState, startSyncing, stopSyncing } from './sync-pull';
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
/** Whether a folder is, or lies inside, a book package. */
export const insideBook = (path: string) => path.split(sep).some((part) => /\.imageflow$/i.test(part));

/**
 * What the service needs besides the setting: for a bucket, the credential store, and where the commit headers it read
 * are kept (`<userData>/Sync Cache`). Functions, so the app can make them once it is ready.
 */
export type SyncServiceDependencies = { credentials?: () => SyncRemoteDependencies['credentials']; cacheFolder?: () => string } & Pick<SyncRemoteDependencies, 'headerCache' | 's3'>;

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

  private backend() {
    const setting = this.setting();
    if (!setting) { this.current = undefined; return undefined; }
    const key = JSON.stringify(setting);
    if (this.current?.key !== key) this.current = { key, backend: openBackend(setting, this.dependencies) };
    return this.current;
  }

  /** Whether a backend is configured. */
  get configured() { return !!this.backend(); }
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

  /** Makes a book sync here (`startSyncing`); with `newHistory`, also one that last synced somewhere else. */
  async start(folder: string, options: { newHistory?: boolean } = {}) {
    const { remoteId } = await this.connect(folder);
    await startSyncing(folder, remoteId, options);
  }

  /** Stops syncing a book on this Mac; the remote is left as it is. */
  stop(folder: string) { return stopSyncing(folder); }

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
