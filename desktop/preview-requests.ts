import type { WantedPreview } from './provided-photos';
import type { SourceState } from '../src/source-locations';

/** Why a preview could not be had, with the state its photo was left in (`available`: its older preview stands). */
export type PreviewFailure = { state: SourceState; problem: string };

/** The progress of the previews being fetched, over all fetches of a book that run at once: what its status bar shows. */
export class PreviewFetches {
  private running = new Set<{ done: number; total: number }>();
  private published = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly publish: (progress: { done: number; total: number } | null) => void, private readonly everyMs = 250) {}

  /** Starts a fetch. `total` is 0 until it is known how many previews it asks for. */
  start(total = 0) {
    const fetch = { done: 0, total };
    this.running.add(fetch);
    if (total) this.report(true);
    return {
      progress: (done: number, total: number) => { fetch.done = done; fetch.total = total; this.report(false); },
      end: () => { if (this.running.delete(fetch) && fetch.total) this.report(true); },
    };
  }
  private report(now: boolean) {
    const wait = this.published + this.everyMs - Date.now();
    if (!now && wait > 0) {
      // Shown a little later even if no further preview comes for a while, as when Lightroom renders one.
      this.timer ??= setTimeout(() => { this.timer = undefined; this.report(true); }, wait);
      this.timer.unref?.();
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.published = Date.now();
    const all = [...this.running].reduce((sum, { done, total }) => ({ done: sum.done + done, total: sum.total + total }), { done: 0, total: 0 });
    this.publish(all.total ? all : null);
  }
}

/**
 * The previews the loads of an open book want, and what became of each (ADR 0011, §2). A load wants a preview again
 * until it is stored, so what was asked for is remembered by its content: it is asked for once, and one that could not
 * be had is remembered with why, so the photo says that instead of loading for ever. Every request ends: what was taken
 * is settled one by one as previews come, and `finish` ends those nothing was heard of.
 */
export class PreviewRequests {
  private tried = new Map<string, { key: string; open: boolean; problem?: string }>();
  private queue = new Set<string>();

  /** Queues the previews not asked for yet; whether there is anything to fetch. */
  want(previews: readonly WantedPreview[]) {
    for (const { id, key } of previews) {
      if (this.tried.get(id)?.key === key) continue;
      this.tried.set(id, { key, open: true });
      this.queue.add(id);
    }
    return this.queue.size > 0;
  }
  /** The photos to fetch now. Each is settled or finished afterwards. */
  take(): string[] {
    const ids = [...this.queue];
    this.queue.clear();
    return ids;
  }
  /** Why the preview of a photo's content could not be had, if it was asked for and could not. */
  problem({ id, key }: WantedPreview) {
    const tried = this.tried.get(id);
    return tried?.key === key ? tried.problem : undefined;
  }
  /**
   * A preview came, or could not be had. One that came is asked for again should it be lost, and so is one whose source
   * could not be reached: whether it can be is observed with every load. Any other failure stands until the content
   * changes, the source reports the photo, or Retry.
   */
  settled(id: string, failure?: PreviewFailure) {
    const tried = this.tried.get(id);
    // Queued again meanwhile, for other content: what is to come is that one's.
    if (!tried || this.queue.has(id)) return;
    if (!failure || failure.state === 'offline' || failure.state === 'needs-sign-in') this.tried.delete(id);
    else { tried.open = false; tried.problem = failure.problem; }
  }
  /** Ends the requests among `ids` nothing was heard of: failed for `failure`'s reason, or forgotten without one. */
  finish(ids: Iterable<string>, failure: (id: string) => PreviewFailure | undefined = () => undefined) {
    for (const id of ids) if (this.tried.get(id)?.open) this.settled(id, failure(id));
  }
  /** Retry: every preview may be asked for again. */
  clear() { this.tried.clear(); this.queue.clear(); }
}
