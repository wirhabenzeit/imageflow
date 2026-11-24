import { realpath } from 'node:fs/promises';
import type { OpenProject } from './project';
import { ensureBookId, uploadAhead } from './sync-engine';
import { limited } from './sync-library';
import type { SyncService } from './sync-service';
import { StoreAccessError, StoreFullError } from './sync-store';
import type { StoreAccessReason } from './sync-store';

/** What a closed book's first sync is doing, or why the last one failed, for the Sync window. */
export type ClosedSyncState = { syncing?: true; sending?: { done: number; total: number };
  failed?: { message: string; full?: true; access?: StoreAccessReason } };

/** A closed book loaded to sync it, with its writer lock. */
export type HeldBook = { book: OpenProject; close: () => Promise<void> };

/**
 * Turning a book on in the Sync window while it is not open (#307), apart from Electron so it can be tested. The book is
 * recorded as syncing, and then synced here under its writer lock, so it goes up without its window: what it would do at
 * its next open. One book at a time. It only pushes or fast-forwards, like any sync nobody watches; a book changed on two
 * Macs waits for Sync Now in its window.
 *
 * Opening the book comes first: the app stops its sync (`stop`), which ends at its next request and lets go of the lock,
 * and the open book's own sync goes on from there. So does its next open after a failure or a quit.
 */
export class ClosedBookSyncs {
  private readonly jobs = new Map<string, { job: AbortController; state: ClosedSyncState; task: Promise<void> }>();
  private readonly failures = new Map<string, NonNullable<ClosedSyncState['failed']>>();
  private readonly turn = limited(1);
  private closed = false;
  constructor(private readonly options: {
    service: SyncService;
    /** Takes the writer lock alone, which starting a book needs; rejects while another process has the book open. */
    lock: (folder: string) => Promise<() => Promise<void>>;
    /** Takes the writer lock and loads the book for a sync. */
    hold: (folder: string) => Promise<HeldBook>;
    cover?: (folder: string) => Promise<Uint8Array | undefined>;
    device?: string;
    /** Told when what `state` says changes. */
    changed: (folder: string) => void;
    /** Told when a book's sync committed something or took changes; the library reads the remote again. */
    synced?: (folder: string, book: OpenProject) => void;
  }) {}

  /** Start Syncing (`SyncService.start`, whose refusals reject), then the sync in the background. */
  async start(folder: string, options: { newHistory?: boolean; trust?: boolean } = {}) {
    await this.locked(folder, () => this.options.service.start(folder, options));
    this.run(folder);
  }
  /** Sync Again on a book deleted from sync on another Mac (`SyncService.syncAgain`), then its sync in the background. */
  async syncAgain(folder: string, options: { trust?: boolean } = {}) {
    await this.locked(folder, () => this.options.service.syncAgain(folder, options));
    this.run(folder);
  }
  private async locked(folder: string, step: () => Promise<unknown>) {
    await this.stop(folder);
    const release = await this.options.lock(folder);
    try {
      await step();
      // What goes up is stored under the book's lineage ID, which a book that was never saved here lacks.
      await ensureBookId(await realpath(folder));
    } finally { await release(); }
  }

  private run(folder: string) {
    if (this.closed || this.jobs.has(folder)) return;
    this.failures.delete(folder);
    const job = new AbortController();
    const entry = { job, state: { syncing: true } as ClosedSyncState, task: Promise.resolve() };
    this.jobs.set(folder, entry);
    let waiting = true;
    const running = this.turn(() => { waiting = false; return this.sync(folder, job.signal, entry.state); });
    // One that waits for its turn ends at once; one that runs, once it let go of the book.
    const ended = new Promise<never>((_, reject) => job.signal.addEventListener('abort', () => { if (waiting) reject(job.signal.reason); }, { once: true }));
    entry.task = Promise.race([running, ended]).catch((error: unknown) => {
      if (job.signal.aborted) return;
      this.failures.set(folder, { message: error instanceof Error ? error.message : String(error), ...(error instanceof StoreFullError ? { full: true as const } : {}),
        ...(error instanceof StoreAccessError ? { access: error.reason } : {}) });
    }).finally(() => {
      if (this.jobs.get(folder) === entry) this.jobs.delete(folder);
      this.options.changed(folder);
    });
    this.options.changed(folder);
  }
  private async sync(folder: string, signal: AbortSignal, state: ClosedSyncState) {
    const { service, hold, cover, device, changed, synced } = this.options;
    signal.throwIfAborted();
    const held = await hold(folder);
    try {
      signal.throwIfAborted();
      const { remote } = await service.connect(folder);
      const ahead = new Map();
      await uploadAhead({ remote, book: held.book, ahead, signal, progress: (done, total) => { state.sending = { done, total }; changed(folder); } });
      delete state.sending;
      const outcome = await service.sync({ book: held.book, ahead, signal, fastForwardOnly: true, device, ...(cover ? { cover: () => cover(folder) } : {}) });
      if (outcome.pushed.length || outcome.changed) synced?.(folder, held.book);
    } finally { await held.close(); }
    // The originals its commit named go up in the background, without the book.
    if (!signal.aborted) void service.upload(folder).catch(() => {});
  }

  /** What a book's sync is doing here, or why the last one failed; undefined when there is nothing to say. */
  state(folder: string): ClosedSyncState | undefined {
    const running = this.jobs.get(folder);
    if (running) return { ...running.state };
    const failed = this.failures.get(folder);
    return failed && { failed };
  }

  /** Ends a book's sync and forgets its failure, and waits until it let go of the book: the book is opened, or stops syncing. */
  async stop(folder: string) {
    this.failures.delete(folder);
    const running = this.jobs.get(folder);
    running?.job.abort(new Error('The book was opened.'));
    await running?.task;
  }
  /** Quit: ends every sync and starts none after it. Each goes on at the book's next open. */
  async shutdown() {
    this.closed = true;
    const running = [...this.jobs.values()];
    for (const { job } of running) job.abort(new Error('ImageFlow is closing.'));
    await Promise.all(running.map(({ task }) => task));
  }
}
