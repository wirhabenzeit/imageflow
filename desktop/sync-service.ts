import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SyncBackend } from '../src/settings';
import { syncBook } from './sync-engine';
import type { SyncOptions } from './sync-engine';
import { bookSync, readSyncState, startSyncing, stopSyncing } from './sync-pull';
import type { BookSync } from './sync-pull';
import type { SyncRemote } from './sync-remote';
import { folderRemote } from './sync-store-folder';

/** The configured remote, with its identity and the name the app shows for it. */
export type SyncConnection = { remote: SyncRemote; remoteId: string; name: string };
/**
 * How a book stands on this Mac: as `bookSync` says against the configured remote, or `unconfigured` without a
 * backend, or `unavailable` for a book that syncs while the remote cannot be read (`error` says why).
 */
export type SyncStanding = { sync: BookSync | 'unconfigured' | 'unavailable'; connection?: SyncConnection; error?: string };

type Backend = { remote: SyncRemote; name: string; reachable(): Promise<void> };

/** The remote a backend setting names. Each kind of backend is one case here. */
function openBackend(backend: SyncBackend): Backend {
  switch (backend.kind) {
    case 'folder': {
      const name = basename(backend.path);
      return { remote: folderRemote(backend.path), name, reachable: async () => {
        // A folder on a drive that is not connected is not made again on the startup disk.
        if (!(await lstat(backend.path).catch(() => undefined))?.isDirectory()) throw new Error('The sync folder “' + name + '” is not available. Connect its drive, or choose it again in Settings.');
      } };
    }
  }
}

/**
 * The app's sync service (ADR 0012): the one backend this Mac syncs through, from `AppSettings.sync`, for every open
 * book. Books do not record where they sync; a session asks the service for the remote and its identity, and the
 * service records in a book's sync state whether it syncs here (`startSyncing`, `stopSyncing`).
 *
 * It builds the remote again when the setting changes. The remote's identity is read once per backend: the first use
 * of a remote writes it (`SyncRemote.remoteId`).
 */
export class SyncService {
  private current?: { key: string; backend: Backend; remoteId?: Promise<string> };
  constructor(private readonly setting: () => SyncBackend | undefined) {}

  private backend() {
    const setting = this.setting();
    if (!setting) { this.current = undefined; return undefined; }
    const key = JSON.stringify(setting);
    if (this.current?.key !== key) this.current = { key, backend: openBackend(setting) };
    return this.current;
  }

  /** Whether a backend is configured. */
  get configured() { return !!this.backend(); }
  /** The name of the configured backend, for the sync status and dialogs. */
  get name() { return this.backend()?.backend.name; }

  /** The configured remote and its identity. Throws when none is configured or it cannot be reached. */
  async connect(): Promise<SyncConnection> {
    const current = this.backend();
    if (!current) throw new Error('Sync is not set up on this Mac. Set it up in Settings.');
    const { remote, name } = current.backend;
    await current.backend.reachable();
    const identity = current.remoteId ??= remote.remoteId();
    try { return { remote, remoteId: await identity, name }; }
    catch (error) {
      // Read again next time: the remote may be reachable then.
      if (current.remoteId === identity) current.remoteId = undefined;
      throw error;
    }
  }

  /** How a book stands with the configured remote. Never throws: a remote that cannot be read is reported. */
  async standing(folder: string): Promise<SyncStanding> {
    if (!this.configured) return { sync: 'unconfigured' };
    let state;
    try { state = await readSyncState(folder); }
    catch (error) { return { sync: 'unavailable', error: message(error) }; }
    try {
      const connection = await this.connect();
      return { sync: bookSync(state, connection.remoteId), connection };
    } catch (error) {
      // Which remote a book synced with is known only once the remote is read; one that syncs is shown unavailable.
      return { sync: state.enabled === false ? 'stopped' : state.remoteId ? 'unavailable' : 'off', error: message(error) };
    }
  }

  /** Makes a book sync here (`startSyncing`); with `newHistory`, also one that last synced somewhere else. */
  async start(folder: string, options: { newHistory?: boolean } = {}) {
    const { remoteId } = await this.connect();
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
    const { remote, remoteId } = await this.connect();
    await startSyncing(options.book.folder, remoteId);
    return syncBook({ ...options, remote });
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
