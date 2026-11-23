import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';

/**
 * How a book starts syncing by itself (ADR 0012, section 3; #282), apart from Electron so it can be tested: which books
 * never do, and the first sync after a book opens, tried again after a save when it did not happen.
 */

/**
 * Whether a book never starts syncing by itself because of where it lies: inside one of `roots`, the sample books that
 * ship with the app and the app's cache, where template preview books are staged. Read-only opens and untrusted books
 * are told apart by the sync service.
 */
export async function syncExcludedBook(folder: string, roots: readonly (string | undefined)[]) {
  const resolved = await realpath(folder).catch(() => folder);
  const real = await Promise.all(roots.filter((root): root is string => !!root).map((root) => realpath(root).catch(() => root)));
  return real.some((root) => {
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    return resolved === base || resolved.startsWith(base + sep);
  });
}

/**
 * The first sync of a book that starts by itself. `attempt` decides again each time whether the book starts (the sync
 * service's `startsOnOpen`: exclusions, trust, opt-out, the unanswered first-configuration sheet, a book synced
 * elsewhere being asked about) and syncs it when it does. One that fails (the book was busy, the remote could not be
 * read) is tried again after the book's next save (`saved`), once per save and after `delay`, never in a loop. A save
 * made while the attempt was still running counts as that save.
 */
export class FirstSync {
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  constructor(private readonly attempt: () => Promise<void>, private readonly delay = 1500,
    private readonly failed: (error: unknown) => void = (error) => console.warn('ImageFlow could not start syncing the book', error)) {}

  /** Runs the attempt now, or joins the one that runs. Rejects with its error, and it is then tried after the next save. */
  run() {
    if (!this.running) {
      this.savedMeanwhile = false;
      this.running = this.attempt().catch((error: unknown) => {
        this.pending = true;
        // A save made while the attempt ran (the edit that interrupted it, #284) is the save it waits for.
        if (this.savedMeanwhile) this.saved();
        throw error;
      }).finally(() => { this.running = undefined; });
    }
    return this.running;
  }
  /** A save came while an attempt ran: when that attempt fails, the save counts. */
  private savedMeanwhile = false;

  /** The book was saved: an attempt that failed is tried again, after `delay`. */
  saved() {
    if (this.running) this.savedMeanwhile = true;
    if (!this.pending || this.timer) return;
    this.pending = false;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run().catch(this.failed);
    }, this.delay);
  }

  /** Whether an attempt failed and waits for the next save. */
  get waiting() { return this.pending || !!this.timer; }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
  }
}
