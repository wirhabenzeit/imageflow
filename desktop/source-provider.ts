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

export type Materialized =
  /**
   * `file` is in the staging folder and the host's from now on: it hashes, checks and moves it. A file whose revision
   * differs before and after was made from a photo that changed meanwhile, and is discarded.
   */
  | { id: string; file: string; before: Revisions; after: Revisions }
  | { id: string; state: Unavailable; problem: string };

/** What can be offered to the user for a photo the provider cannot read. Retry is always offered and re-observes. */
export type Repair = 'locate' | 'locate-folder' | 'launch' | 'sign-in';

export interface SourceProvider<L extends Locator> {
  provider: L['provider'];
  /**
   * The current state of each photo, in the order given, without reading pixels: cheap enough to run for every photo
   * of a book when it opens and again before an export. Never throws for one photo's failure.
   */
  observe(book: string, refs: readonly SourceRef<L>[]): Promise<Observed[]>;
  /**
   * A screen preview (1400 px on the long edge, sRGB) written into `staging`, with the revisions it was made from.
   * Left out by a provider whose photos are files read in place: the host derives the preview from the file.
   */
  preview?(book: string, ref: SourceRef<L>, options: { staging: string; signal: AbortSignal }): Promise<Materialized>;
  /**
   * Full-resolution originals written into `staging`, one result per photo as it finishes, so the host can report
   * progress. Cancelling takes effect between the provider's own batches.
   */
  materialize(book: string, refs: readonly SourceRef<L>[], options: { staging: string; signal: AbortSignal }): AsyncIterable<Materialized>;
  /**
   * Calls `changed` with the IDs of photos whose state or revision may differ from the last `observe`; the host
   * observes them again and decides what to reload. Also reports photos that became available again. Returns a
   * function that stops watching.
   */
  watch(book: string, refs: readonly SourceRef<L>[], changed: (ids: string[]) => void): () => void;
  /** The repairs to offer for a photo in an unavailable state. */
  repairs(state: Unavailable): readonly Repair[];
}
