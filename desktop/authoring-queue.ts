type QueueEntry = {
  controller: AbortController;
  removeAbortListener: () => void;
  reject: (reason: unknown) => void;
  execute: () => Promise<void>;
};

export class AuthoringQueueError extends Error {
  constructor(readonly code: 'AUTHORING_QUEUE_FULL' | 'AUTHORING_QUEUE_CLOSED', message: string) {
    super(message);
    this.name = 'AuthoringQueueError';
  }
}

/** One queue belongs to one enabled agent connection. Running tasks keep their slot until they settle,
 * including after cancellation, so the next task cannot overlap unfinished project work. */
export class AuthoringQueue {
  private readonly maxPending: number;
  private readonly pollMs: number;
  private readonly pending: QueueEntry[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private active?: QueueEntry;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closeReason: unknown;

  constructor(private readonly options: { ready: () => boolean; maxPending?: number; pollMs?: number }) {
    this.maxPending = options.maxPending ?? 32;
    this.pollMs = options.pollMs ?? 20;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) throw new RangeError('maxPending must be a positive integer.');
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 1) throw new RangeError('pollMs must be a positive integer.');
  }

  run<T>(task: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(this.closeReason);
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new AuthoringQueueError('AUTHORING_QUEUE_FULL', 'ImageFlow’s agent work queue is full. Wait for an earlier request to finish, then retry.'));
    }
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const abort = () => {
        controller.abort(signal!.reason);
        const index = this.pending.indexOf(entry);
        if (index < 0) return;
        this.pending.splice(index, 1);
        entry.removeAbortListener();
        reject(signal!.reason);
        this.pump();
        this.resolveIdle();
      };
      const entry: QueueEntry = {
        controller,
        removeAbortListener: () => signal?.removeEventListener('abort', abort),
        reject,
        execute: async () => {
          try { resolve(await task(controller.signal)); }
          catch (error) { reject(error); }
          finally {
            entry.removeAbortListener();
            this.active = undefined;
            this.pump();
            this.resolveIdle();
          }
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.push(entry);
      this.pump();
    });
  }

  close(reason: unknown = new AuthoringQueueError('AUTHORING_QUEUE_CLOSED', 'ImageFlow’s agent connection closed. Enable the connection again before sending more work.')) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.clearTimer();
    for (const entry of this.pending.splice(0)) {
      entry.removeAbortListener();
      entry.reject(reason);
    }
    this.active?.controller.abort(reason);
    this.resolveIdle();
  }

  whenIdle(): Promise<void> {
    if (!this.active && !this.pending.length) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.add(resolve); });
  }

  private pump() {
    if (this.closed || this.active || !this.pending.length) {
      if (!this.pending.length) this.clearTimer();
      return;
    }
    let ready: boolean;
    try { ready = this.options.ready(); }
    catch (error) {
      const entry = this.pending.shift()!;
      entry.removeAbortListener();
      entry.reject(error);
      queueMicrotask(() => { this.pump(); this.resolveIdle(); });
      return;
    }
    if (this.closed || !this.pending.length) return;
    if (!ready) {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.pump(); }, this.pollMs);
      return;
    }
    this.clearTimer();
    const entry = this.pending.shift()!;
    this.active = entry;
    void entry.execute();
  }

  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private resolveIdle() {
    if (this.active || this.pending.length) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

export function isAuthoringCancellation(error: unknown, signal: AbortSignal) {
  return signal.aborted && (error === signal.reason ||
    error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason);
}
