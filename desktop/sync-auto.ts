/**
 * Automatic sync of an open book (ADR 0012, section 2; #284), apart from Electron so it can be tested: when it looks at
 * the remote, when it syncs, what waits, and how failures back off.
 *
 * - **Open, focus and a push from iCloud** look at the remote (the sync status: one listing of the book's commits) and
 *   sync only when it shows something to do: a fast-forward to pull, or changes of this Mac to push. A status that shows
 *   nothing to do costs no sync.
 * - **A save** pushes once the book has been idle for `idle` (30 s), when the book changed since its last sync. Reading
 *   that is local and sends no request.
 * - **A pull waits** while it would disturb the user (`AutoSyncHost.blocked`: edits in flight, an export, an agent, an
 *   open text or element editor), checked locally every `gate`, and runs once nothing blocks it. A push meanwhile goes
 *   ahead without changing the book (`pushOnly`).
 * - **Failures back off** from 30 s, doubling, up to 15 min, and every trigger waits until then. A network change and a
 *   manual Sync Now (`reset`) end the wait. A full remote is no failure to back off from; the next save or focus tries
 *   again. A book deleted from sync, or synced by a newer ImageFlow, stops the scheduler until `reset`.
 * - **Uploads of originals** that failed are tried again with the same backoff, on a counter of their own. One the
 *   remote has no room for is not: it waits for Sync Now or the next open (`SyncService.upload`).
 *
 * The sync itself is the host's: a fast-forward-only sync (`SyncOptions.fastForwardOnly`), which never keeps both.
 */

/** What a look at the remote found an automatic sync would do. */
export type AutoLook = 'pull' | 'push' | 'none' | 'stop';
/**
 * How the host reads a failed automatic sync: `stop` (the book was deleted from sync, or a newer ImageFlow synced it),
 * `full` (the remote is full: no backoff), `later` (the book was busy for a moment: again after `gate`), `retry` (back off).
 */
export type AutoFailure = 'stop' | 'full' | 'later' | 'retry';

export type AutoSyncHost = {
  /**
   * Whether the book syncs by itself now: the preference, a configured backend, a trusted, writable book that syncs on
   * this Mac and is not excluded, the first-configuration sheet answered, and nothing deleting it. Local, no request.
   */
  allowed(): Promise<boolean>;
  /** Why a pull may not change the book now, or undefined. Local, no request. */
  blocked(): string | undefined;
  /** The first sync by itself when the book opens (`FirstSync`), which decides on its own whether the book starts. */
  start(): Promise<void>;
  /** Reads the sync status (one listing of the book's commits) and says what an automatic sync would do. */
  look(): Promise<AutoLook>;
  /** Whether the book changed here since its last sync. Local, no request. */
  edited(): Promise<boolean>;
  /**
   * A fast-forward-only sync; with `pushOnly`, one that does not change the book. Resolves `deferred` when the sync
   * found it would have to change the book and did not, `stop` when it may not sync any more.
   */
  sync(options: { pushOnly: boolean; signal: AbortSignal }): Promise<'deferred' | 'stop' | void>;
  failure(error: unknown): AutoFailure;
  /** Uploads the book's pending originals again; rejects when the upload failed. */
  upload?(): Promise<void>;
};

export type AutoSyncTiming = { idle: number; gate: number; notified: number; backoff: (failures: number) => number };
export const autoSyncTiming: AutoSyncTiming = { idle: 30_000, gate: 2_000, notified: 1_000,
  backoff: (failures) => Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1)) };

/** What a trigger asks for, in rising order: a later one of higher rank takes the place of a lower one that waits. */
type Intent = 'push' | 'look' | 'pull' | 'open';
const rank: Record<Intent, number> = { push: 1, look: 2, pull: 3, open: 4 };

export class AutoSync {
  private wanted?: Intent;
  private running?: Promise<void>;
  private job?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private gateTimer?: ReturnType<typeof setTimeout>;
  private uploadTimer?: ReturnType<typeof setTimeout>;
  /** A pull that waits for nothing to block it. */
  private waitingForGate = false;
  private failures = 0;
  private until = 0;
  private uploadFailures = 0;
  /** Why the scheduler stopped: the book may not sync by itself any more (`removed`), or it closed. */
  stopped?: 'removed' | 'closed';

  constructor(private readonly host: AutoSyncHost, private readonly timing: AutoSyncTiming = autoSyncTiming, private readonly now: () => number = Date.now) {}

  /** The book opened: its first sync by itself, then a look at the remote. */
  opened() { this.want('open'); }
  /** The book's window came to the front (the caller throttles it). */
  focused() { this.want('look'); }
  /** The remote said something changed (an iCloud push); several at once count as one. */
  notified() {
    if (this.stopped || this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.want('look'); }, this.timing.notified);
  }
  /** The book was saved: it pushes once it has been idle for a while. */
  saved() {
    if (this.stopped) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.idleTimer = undefined; this.want('push'); }, this.timing.idle);
  }
  /** The network changed: what waits for a backoff runs now, and so does a failed upload. */
  networkChanged() {
    this.failures = 0;
    this.until = 0;
    if (this.uploadFailures) { this.uploadFailures = 0; this.retryUpload(0); }
    this.kick();
  }
  /** A manual sync (Sync Now, Sync Again, Keep Here Only): the backoff ends, and a stopped scheduler runs again. */
  reset() {
    if (this.stopped === 'closed') return;
    this.stopped = undefined;
    this.failures = 0;
    this.until = 0;
    this.uploadFailures = 0;
    clearTimeout(this.uploadTimer);
    this.kick();
  }
  /** Stops for good: what waits is dropped, and a sync that runs is aborted. Resolves once it has ended. */
  close() {
    this.stopped = 'closed';
    for (const timer of [this.timer, this.idleTimer, this.notifyTimer, this.gateTimer, this.uploadTimer]) clearTimeout(timer);
    this.wanted = undefined;
    this.job?.abort(new Error('The book closed.'));
    return this.running ?? Promise.resolve();
  }

  /** The background upload of originals failed: it is tried again after a backoff of its own. */
  uploadFailed() {
    if (this.stopped || !this.host.upload) return;
    this.uploadFailures++;
    this.retryUpload(this.timing.backoff(this.uploadFailures));
  }
  /** The background upload ended without failing (also full, which waits for Sync Now). */
  uploadEnded() {
    this.uploadFailures = 0;
    clearTimeout(this.uploadTimer);
  }
  private retryUpload(delay: number) {
    clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      if (this.stopped) return;
      void this.host.upload?.().then(() => this.uploadEnded(), () => this.uploadFailed());
    }, delay);
  }

  /** For tests and the status: what waits, and until when. */
  get state() {
    return { wanted: this.wanted, running: !!this.running, waitingForGate: this.waitingForGate, failures: this.failures,
      backoffUntil: this.until, uploadFailures: this.uploadFailures, stopped: this.stopped };
  }
  /** Resolves once nothing runs. */
  async settled() { while (this.running) await this.running; }

  private want(intent: Intent) {
    if (this.stopped) return;
    if (!this.wanted || rank[intent] > rank[this.wanted]) this.wanted = intent;
    this.kick();
  }
  private kick() {
    clearTimeout(this.timer);
    if (this.running || !this.wanted || this.stopped) return;
    const wait = this.until - this.now();
    if (wait > 0) { this.timer = setTimeout(() => this.kick(), wait); return; }
    const intent = this.wanted;
    this.wanted = undefined;
    const running = this.attempt(intent).finally(() => {
      if (this.running === running) this.running = undefined;
      this.kick();
    });
    this.running = running;
  }
  /** Waits, without a request, until nothing blocks a pull, then pulls. */
  private awaitGate() {
    this.waitingForGate = true;
    clearTimeout(this.gateTimer);
    this.gateTimer = setTimeout(() => {
      this.gateTimer = undefined;
      if (this.stopped) return;
      if (this.host.blocked()) { this.awaitGate(); return; }
      this.waitingForGate = false;
      this.want('pull');
    }, this.timing.gate);
  }

  private async attempt(intent: Intent) {
    const job = new AbortController();
    this.job = job;
    try {
      if (intent === 'open') await this.host.start();
      if (this.stopped || !await this.host.allowed()) return;
      let pull = intent === 'pull';
      if (intent === 'push') {
        if (!await this.host.edited()) return;
      } else if (!pull) {
        const look = await this.host.look();
        if (look === 'stop') { this.stop(); return; }
        if (look === 'none') { this.succeeded(); return; }
        pull = look === 'pull';
      }
      if (this.stopped) return;
      const blocked = !!this.host.blocked();
      // A pull that would disturb the user waits; a push goes ahead without changing the book.
      if (blocked && pull) { this.awaitGate(); return; }
      const result = await this.host.sync({ pushOnly: blocked, signal: job.signal });
      if (result === 'stop') { this.stop(); return; }
      if (result === 'deferred') this.awaitGate();
      this.succeeded();
    } catch (error) {
      if (job.signal.aborted || this.stopped) return;
      const kind = this.host.failure(error);
      if (kind === 'stop') { this.stop(); return; }
      // A full remote is shown by the status; trying again every few seconds would not make room.
      if (kind === 'full') return;
      if (kind === 'later') {
        setTimeout(() => this.want(intent === 'open' ? 'look' : intent), this.timing.gate);
        return;
      }
      this.failures++;
      this.until = this.now() + this.timing.backoff(this.failures);
      // Tried again once the backoff ends; a first sync that failed is tried again as such.
      this.want(intent);
    } finally {
      if (this.job === job) this.job = undefined;
    }
  }
  private succeeded() { this.failures = 0; this.until = 0; }
  private stop() {
    this.stopped = 'removed';
    this.wanted = undefined;
    this.waitingForGate = false;
    clearTimeout(this.gateTimer);
    clearTimeout(this.idleTimer);
  }
}

/**
 * Whether a remote notification is CloudKit's (#284): its payload carries a `ck` dictionary. Anything else the app may
 * receive is ignored.
 */
export function cloudKitPush(userInfo: unknown) {
  const ck = userInfo && typeof userInfo === 'object' ? (userInfo as { ck?: unknown }).ck : undefined;
  return !!ck && typeof ck === 'object';
}
