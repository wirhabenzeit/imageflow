import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { PhotosLocator } from '../../src/source-locator';
import type { PhotosAccess, PhotosFacts, PhotosLibrary } from '../photos-library';
import type { Materialized, MaterializeOptions, Observed, ProvidedFacts, Repair, Revisions, SourceProvider, SourceRef, Unavailable } from '../source-provider';

/**
 * Photos in the Photos library of this Mac (ADR 0013), read through PhotoKit (desktop/native/photos.mm). The provider
 * keeps no state the host needs: what it remembers is which local identifier a cloud identifier has on this Mac.
 *
 * - `contentRevision` is the time of the photo's last edit or revert (`adjustmentTimestamp`), with its size and whether
 *   it renders from RAW. It moves for every visual edit and for nothing else (spikes/apple-photos, section 4), and
 *   Photos renders an unchanged photo to the same bytes, so it keys previews.
 * - `revision` adds the caption, so a caption edit reaches the book. `modificationDate` is no revision: it moves for
 *   many things that are no edit, and on its own.
 * - Neither holds the favourite, which goes into `extra` only: a heart tapped in Photos changes no picture, and must
 *   not discard a full-resolution download from iCloud that `revision` keys in the source cache.
 * - The capture time is the creation date at the offset the original records (EXIF OffsetTimeOriginal), which the
 *   addon reads in the background from originals on this Mac and then reports as a change, so a book records it
 *   anew. Until then, or where the original records none, it is at this Mac's offset, marked `offsetGuessed`.
 * - Previews and originals are rendered by Photos as they are now, downloaded from iCloud where the photo is not on
 *   this Mac (with Optimize Mac Storage, most are not): about a second per preview, two to four per original.
 * - A photo is `denied` while ImageFlow may not read the library, `offline` while its library or iCloud cannot be
 *   reached, and `missing` once it left the library.
 */
export type PhotosPort = Pick<PhotosLibrary, 'status' | 'localIdentifiers' | 'facts' | 'image' | 'cancel' | 'onChanges' | 'track'>;

// Requests in flight at once: Photos downloads and renders several in parallel, and an abort cancels them all.
const previewsAtOnce = 4;
const originalsAtOnce = 2;

type Problem = { state: Unavailable; problem: string };
const denied: Problem = { state: 'denied', problem: 'ImageFlow may not read the Photos library. Allow it in System Settings → Privacy & Security → Photos.' };
const gone: Problem = { state: 'missing', problem: 'No longer in the Photos library.' };
/** Why no photo of the library can be read now, or undefined when ImageFlow may read it. */
export function accessProblem(access: PhotosAccess | undefined): Problem | undefined {
  if (access === 'authorized') return undefined;
  if (access === 'unsupported-system') return { state: 'unreadable', problem: 'Photos from Apple Photos need macOS 15.2 or later.' };
  if (access === undefined || access === 'unsupported-build') return { state: 'unreadable', problem: 'This build of ImageFlow cannot read the Photos library.' };
  return denied;
}
/** A PhotoKit error as a photo's state. */
export function photosFailure(error: unknown): Problem {
  const code = (error as { code?: unknown })?.code;
  // A download from iCloud that failed for the network, wrapped in PhotoKit's own errors.
  if (typeof (error as { underlying?: unknown })?.underlying === 'string') return { state: 'offline', problem: 'Not downloaded from iCloud, and iCloud cannot be reached now.' };
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'PHPhotosErrorDomain:3164': case 'PHPhotosErrorDomain:3169':
      return { state: 'offline', problem: 'Not downloaded from iCloud, and iCloud cannot be reached now.' };
    case 'PHPhotosErrorDomain:3114':
      return { state: 'offline', problem: 'The Photos library is on a disk that is not connected.' };
    case 'PHPhotosErrorDomain:3142': case 'PHPhotosErrorDomain:3143':
      return { state: 'offline', problem: 'The Photos library was moved or another one was chosen in Photos.' };
    case 'PHPhotosErrorDomain:3201': case 'PHPhotosErrorDomain:3303':
      return gone;
    case 'PHPhotosErrorDomain:3310': case 'PHPhotosErrorDomain:3311': case 'ImageFlowPhotos:3311':
      return denied;
    default:
      return { state: 'unreadable', problem: 'Original unavailable: ' + message };
  }
}

const twoDigits = (value: number) => String(Math.floor(value)).padStart(2, '0');
/**
 * A PhotoKit creation date as ImageFlow's capture time: the wall clock at the photo's offset (its original's own, or
 * this Mac's as a guess, see `PhotosFacts`), with that offset.
 */
export function capturedAt(created: number | undefined, offsetMinutes: number | undefined): ProvidedFacts['captured'] {
  if (created === undefined || !Number.isFinite(created)) return undefined;
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes! : 0;
  const local = new Date(created + offset * 60_000);
  if (Number.isNaN(local.getTime())) return undefined;
  const sign = offset < 0 ? '-' : '+';
  return { dateTime: local.toISOString().slice(0, 19), offset: sign + twoDigits(Math.abs(offset) / 60) + ':' + twoDigits(Math.abs(offset) % 60) };
}

/** The revisions of a photo as it is now (see above). */
export function photosRevisions(facts: PhotosFacts): Revisions {
  const contentRevision = [facts.adjusted ?? 'none', facts.width + 'x' + facts.height, facts.base ?? 'compressed'].join(':');
  const caption = facts.caption ? ':' + createHash('sha256').update(facts.caption).digest('hex').slice(0, 16) : '';
  return { revision: contentRevision + caption, contentRevision };
}

/** The facts the host records for a photo. */
export function photosFacts(facts: PhotosFacts): ProvidedFacts {
  const captured = capturedAt(facts.created, facts.offsetMinutes);
  const caption = facts.caption?.trim() ? facts.caption : undefined;
  return {
    width: facts.width, height: facts.height,
    ...(captured ? { captured } : {}),
    ...(Number.isFinite(facts.latitude) && Number.isFinite(facts.longitude) ? { location: { latitude: facts.latitude!, longitude: facts.longitude! } } : {}),
    ...(caption ? { provided: { caption } } : {}),
    extra: { ...(facts.type ? { type: facts.type } : {}), ...(facts.filename ? { fileName: facts.filename } : {}), ...(facts.favorite === true ? { favorite: true } : {}),
      // The offset of `captured` is this Mac's, not the photo's own: not known yet, or the original records none.
      ...(captured && facts.offsetGuessed === true ? { offsetGuessed: true } : {}) },
  };
}

let requestIds = 0;

/** The Apple Photos provider over the PhotoKit addon. */
export function photosProvider(library: PhotosPort | undefined): SourceProvider<PhotosLocator> {
  // This Mac's local identifier of each cloud identifier, once looked up: the one in the locator may be another Mac's
  // or out of date, and the lookup of a cloud identifier is costly.
  const locals = new Map<string, string>();
  // The photos each book watches, by its local identifier: PhotoKit reports changes of the photos tracked, one set
  // for the whole app.
  const watchers = new Map<object, { ids: Map<string, string[]>; changed: (ids: string[]) => void }>();
  let listening = false;
  // Photos reported as changed that no book watched then, by local identifier: a capture offset the addon read for a
  // photo observed before any book watched it (one dropped from Photos, say). The next book to watch one is told.
  const unreported = new Set<string>();
  const unreportedLimit = 10_000;
  const listen = () => {
    if (listening || !library) return;
    listening = true;
    library.onChanges((changedLocals) => {
      const everything = changedLocals.includes('*');
      const covered = new Set<string>();
      for (const { ids, changed: report } of watchers.values()) {
        const moved = everything ? [...ids.values()].flat() : [...new Set(changedLocals.flatMap((local) => ids.get(local) ?? []))];
        if (!everything) for (const local of changedLocals) if (ids.has(local)) covered.add(local);
        if (moved.length) report(moved);
      }
      if (everything) return;
      for (const local of changedLocals) {
        if (covered.has(local)) { unreported.delete(local); continue; }
        unreported.delete(local);
        unreported.add(local);
        if (unreported.size > unreportedLimit) unreported.delete(unreported.values().next().value!);
      }
    });
  };
  const retrack = () => library?.track([...new Set([...watchers.values()].flatMap(({ ids }) => [...ids.keys()]))]);

  /** The local identifier and facts of each reference; both undefined for a photo this library does not have. */
  async function resolve(refs: readonly SourceRef<PhotosLocator>[]) {
    // Before `facts`, which may read capture offsets in the background and report them as changes.
    listen();
    const localOf: (string | undefined)[] = refs.map(({ locator }) => locals.get(locator.cloud) ?? locator.local);
    const facts: (PhotosFacts | null)[] = await library!.facts(localOf.map((local) => local ?? ''));
    // A local identifier that names nothing, or none at all: the cloud identifier is asked, and the facts again.
    const ask = refs.flatMap((_, index) => facts[index] ? [] : [index]);
    if (ask.length) {
      const found = await library!.localIdentifiers(ask.map((index) => refs[index].locator.cloud));
      const again = await library!.facts(found.map((local) => local ?? ''));
      ask.forEach((index, at) => {
        localOf[index] = found[at] && again[at] ? found[at]! : undefined;
        facts[index] = localOf[index] ? again[at] : null;
        if (localOf[index]) locals.set(refs[index].locator.cloud, localOf[index]!);
      });
    }
    return { localOf, facts };
  }

  async function observe(refs: readonly SourceRef<PhotosLocator>[]): Promise<{ results: Observed[]; localOf: (string | undefined)[] }> {
    const blocked = accessProblem(library?.status());
    if (blocked) return { results: refs.map(() => blocked), localOf: refs.map(() => undefined) };
    try {
      const { localOf, facts } = await resolve(refs);
      return { localOf, results: facts.map((row): Observed => row ? { state: 'available', revisions: photosRevisions(row), facts: photosFacts(row) } : gone) };
    } catch (error) {
      const problem = photosFailure(error);
      return { results: refs.map(() => problem), localOf: refs.map(() => undefined) };
    }
  }

  /** Pictures of `refs` into `staging`, a few at once, each with the revisions before and after. */
  async function* pictures(refs: readonly SourceRef<PhotosLocator>[], full: boolean, { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
    const { results: before, localOf } = await observe(refs);
    const folder = join(await realpath(staging), 'photos-' + randomUUID());
    await mkdir(folder);
    const queue = refs.map((ref, index) => ({ ref, index }));
    const running = new Map<number, Promise<{ key: number; result: Materialized }>>();
    const inFlight = new Set<number>();
    const stop = () => { for (const id of inFlight) library!.cancel(id); };
    signal.addEventListener('abort', stop);
    let key = 0;
    const start = ({ ref, index }: { ref: SourceRef<PhotosLocator>; index: number }) => {
      const mine = key++;
      const observed = before[index];
      const local = localOf[index];
      const work = (async (): Promise<Materialized> => {
        if (observed.state !== 'available' || !local) return { id: ref.id, ...(observed as Problem) };
        const id = ++requestIds;
        inFlight.add(id);
        const file = join(folder, ref.id + (full ? '-original' : '-preview') + '.jpg');
        try { await library!.image(local, { file, full, id }); }
        catch (error) { return { id: ref.id, ...photosFailure(error) }; }
        finally { inFlight.delete(id); }
        const [after] = (await observe([ref])).results;
        if (after.state !== 'available') return { id: ref.id, ...(after as Problem) };
        return { id: ref.id, file, before: observed.revisions, after: after.revisions };
      })();
      running.set(mine, work.then((result) => ({ key: mine, result })));
    };
    try {
      const atOnce = full ? originalsAtOnce : previewsAtOnce;
      while (queue.length || running.size) {
        while (!signal.aborted && queue.length && running.size < atOnce) start(queue.shift()!);
        if (!running.size) return;
        const { key: done, result } = await Promise.race(running.values());
        running.delete(done);
        // After an abort, what was cancelled is not reported; what finished still is, and the host decides.
        if (signal.aborted && !('file' in result)) continue;
        yield result;
      }
    } finally {
      signal.removeEventListener('abort', stop);
      stop();
    }
  }

  return {
    provider: 'photos',
    async observe(_book, refs) { return (await observe(refs)).results; },
    preview: (_book, refs, options) => pictures(refs, false, options),
    materialize: (_book, refs, options) => pictures(refs, true, options),
    watch(_book, refs, changed) {
      const owner = {};
      if (!library) return () => {};
      listen();
      const ids = new Map<string, string[]>();
      void resolve(refs).then(({ localOf }) => {
        if (!watchers.has(owner)) return;
        localOf.forEach((local, index) => { if (local) ids.set(local, [...ids.get(local) ?? [], refs[index].id]); });
        retrack();
        // Changed while nothing watched them: observed again now.
        const missed = [...ids.keys()].filter((local) => unreported.delete(local)).flatMap((local) => ids.get(local)!);
        if (missed.length) changed(missed);
      }, () => {});
      watchers.set(owner, { ids, changed });
      return () => { watchers.delete(owner); retrack(); };
    },
    // Access is given in System Settings, or by answering the question that asks for it.
    repairs: (state): readonly Repair[] => state === 'denied' ? ['allow'] : [],
  };
}
