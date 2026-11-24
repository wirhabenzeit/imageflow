import type { BookDownload } from '../src/desktop';
import { limited } from './sync-library';

/**
 * The books being downloaded from sync (#305), apart from Electron so it can be tested: by book, how far each is, and
 * its cancel. They belong to the app, not to the window they were started in, so every window shows the same ones and
 * a window that closes ends none. One book downloads at a time; the others wait for their turn and can be cancelled
 * before it.
 */
export class BookDownloads {
  private readonly jobs = new Map<string, { job: AbortController; state: BookDownload; task: Promise<unknown> }>();
  private readonly turn = limited(1);
  private published = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  /** `changed` is told when a download starts or ends, and at most every `throttle` ms while one progresses. */
  constructor(private readonly changed: () => void, private readonly throttle = 100) {}

  /** What the windows show: every download that runs or waits, in the order they were started. */
  list(): BookDownload[] { return [...this.jobs.values()].map(({ state }) => ({ ...state })); }
  has(bookId: string) { return this.jobs.has(bookId); }

  /** Downloads a book (`download`); undefined when it was cancelled. One that runs already is not started again. */
  async start<T>(bookId: string, download: (options: { signal: AbortSignal; progress: (done: number, total: number) => void }) => Promise<T>): Promise<T | undefined> {
    if (this.closed || this.jobs.has(bookId)) return undefined;
    const job = new AbortController();
    const state: BookDownload = { bookId, waiting: true };
    const running = this.turn(async () => {
      job.signal.throwIfAborted();
      delete state.waiting;
      this.publish();
      return download({ signal: job.signal, progress: (done, total) => {
        Object.assign(state, { done, total });
        this.publish(true);
      } });
    });
    // One that still waits for its turn is cancelled at once; one that runs once its transfer stopped.
    const cancelled = new Promise<never>((_, reject) => job.signal.addEventListener('abort', () => { if (state.waiting) reject(job.signal.reason); }, { once: true }));
    const task = Promise.race([running, cancelled]);
    this.jobs.set(bookId, { job, state, task });
    this.publish();
    try { return await task; }
    catch (error) {
      // Whatever the cancel made the transfer fail with, a cancelled download is no failure.
      if (job.signal.aborted) return undefined;
      throw error;
    } finally {
      this.jobs.delete(bookId);
      this.publish();
    }
  }

  /** Cancels a download and waits until nothing of it is left. */
  async cancel(bookId: string) {
    const running = this.jobs.get(bookId);
    running?.job.abort(new Error('The download was cancelled.'));
    await running?.task.catch(() => {});
  }

  /** Quit: cancels every download, waits for each, and starts none after it. */
  async shutdown() {
    this.closed = true;
    await Promise.all([...this.jobs.keys()].map((bookId) => this.cancel(bookId)));
  }

  private publish(progress = false) {
    clearTimeout(this.timer);
    const wait = progress ? this.published + this.throttle - Date.now() : 0;
    const now = () => { this.published = Date.now(); this.changed(); };
    if (wait > 0) this.timer = setTimeout(now, wait); else now();
  }
}
