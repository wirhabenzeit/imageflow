import type { Locator } from '../src/source-locator';
import type { CaptureMetadata } from '../src/photo-metadata';

/**
 * The provider half of the source contract (ADR 0011, Source providers): how a photo's state, pixels and changes are
 * read from where it lives. It runs in the Electron main process only. The host owns everything that is the same for
 * every provider: photo IDs, `assets-meta.json`, the proxy store, the source cache, renditions, export pinning,
 * debouncing and reloads. Texts and files are not part of it: they stay files.
 *
 * A provider is stateless towards the host. Whatever it must remember between calls (a connection, a poll) is its own;
 * what the host has stored (the last revisions) is handed back in with each reference.
 */

/** Two opaque tokens. The host stores and compares them, never reads them. */
export type Revisions = {
  /** Changes with every change the provider records. A full-resolution materialization is valid for one revision only. */
  revision: string;
  /** Changes only when the pixels may have changed, and keys previews. Without it, `revision` does. */
  contentRevision?: string;
};

/** A photo as the host hands it to a provider. */
export type SourceRef<L extends Locator> = {
  id: string;
  locator: L;
  /** The revisions the host last stored for the photo, so a provider can skip work while `revision` is unchanged. */
  known?: Revisions;
};

/** What a provider reports about a photo it cannot hand over as a file the host reads. */
export type ProvidedFacts = CaptureMetadata & {
  /** Of the original after the provider's own crop and orientation, in pixels. Layout and resolution checks use it. */
  width: number;
  height: number;
  /** Read-only descriptive metadata; an override in photos.json wins over it. */
  provided?: { title?: string; caption?: string; credit?: string; altText?: string };
  /** Recorded with the fact for the provider's own later use; the host does not read it. */
  extra?: Record<string, unknown>;
};

export type Unavailable = 'missing' | 'unreadable' | 'denied' | 'unapproved' | 'offline' | 'needs-sign-in';

export type Observed =
  | ({ state: 'available'; revisions: Revisions;
      /** When the original was last modified, as an ISO instant: the photo's date when it records no capture time. */
      modified?: string; }
    & (
      /**
       * A still JPEG, PNG or WebP on this Mac that the host may read where it is. The host then reads its facts itself,
       * derives previews and renditions from it and guards every read with the file's own stamp.
       */
      | { file: string; facts?: undefined }
      /** No file to read in place: the facts stand for the original until `preview` or `materialize` produces pixels. */
      | { file?: undefined; facts: ProvidedFacts }))
  | { state: Unavailable; problem: string };

/**
 * One photo's result of `preview` or `materialize`. Both yield one per photo as it finishes, so the host can report
 * progress, and both follow the same rules:
 * - A photo that cannot be produced yields its state and problem, and the others still follow. That includes a photo
 *   that became unavailable while it was being produced. The iteration rejects only for a failure that is no photo's.
 * - After `signal` aborts, the iteration ends without results for the photos not yet produced. A provider that works
 *   in batches of its own ends between them.
 * - The staging folder is the host's: it removes whatever is left there, also files of failed and discarded results.
 */
export type Materialized =
  /**
   * `file` is in the staging folder and the host's from now on: it hashes, checks and moves it. A file whose revision
   * differs before and after was made from a photo that changed meanwhile, and is discarded and asked for again.
   */
  | { id: string; file: string; before: Revisions; after: Revisions }
  | { id: string; state: Unavailable; problem: string };
export type MaterializeOptions = { staging: string; signal: AbortSignal };

/**
 * How a preview may be made by a provider that keeps previews of its own besides making them, as Lightroom does. One
 * that has only one way ignores it.
 * - `fallback` (the default): the one the provider keeps, made from the photo where it keeps none. For a photo without
 *   any picture.
 * - `never`: only the one the provider keeps; without one the photo is `deferred`. For a photo that has an older picture.
 * - `always`: made from the photo, whatever the provider keeps.
 */
export type PreviewRendering = 'fallback' | 'never' | 'always';
export type PreviewOptions = MaterializeOptions & { rendering?: PreviewRendering };
/**
 * A preview, as `Materialized`. `kept` marks one the provider kept rather than made, which the host checks a little
 * more. A `deferred` photo has no preview now and may have one later: the host keeps the older picture, marked out of
 * date, and asks again when the provider's `watch` reports the photo.
 */
export type Previewed = (Materialized & { kept?: true }) | { id: string; deferred: true };

/** What can be offered to the user for a photo the provider cannot read. Retry is always offered and re-observes. */
export type Repair = 'locate' | 'locate-folder' | 'launch' | 'sign-in';

export interface SourceProvider<L extends Locator> {
  provider: L['provider'];
  /**
   * The current state of each photo, in the order given, without reading pixels: cheap enough to run for every photo
   * of a book when it opens and again before an export. Never throws for one photo's failure. `signal` ends the wait of a
   * caller that has given up; what is then answered is of no use.
   */
  observe(book: string, refs: readonly SourceRef<L>[], options?: { signal?: AbortSignal }): Promise<Observed[]>;
  /**
   * Screen previews (1400 px on the long edge, sRGB) written into `staging`, each with the revisions it was made from.
   * Several at once, like `materialize`, because an import or an edit of many photos asks for many. Left out by a
   * provider whose photos are files read in place: the host derives the preview from the file. `known` of each
   * reference is the revisions just observed. Results come in any order, and the provider may work ahead of the host.
   */
  preview?(book: string, refs: readonly SourceRef<L>[], options: PreviewOptions): AsyncIterable<Previewed>;
  /** Full-resolution originals written into `staging`. */
  materialize(book: string, refs: readonly SourceRef<L>[], options: MaterializeOptions): AsyncIterable<Materialized>;
  /**
   * Calls `changed` with the IDs of photos whose state or revision may differ from the last `observe`; the host
   * observes them again and decides what to reload. Also reports photos that became available again. Returns a
   * function that stops watching.
   */
  watch(book: string, refs: readonly SourceRef<L>[], changed: (ids: string[]) => void): () => void;
  /** The repairs to offer for a photo in an unavailable state. */
  repairs(state: Unavailable): readonly Repair[];
}
