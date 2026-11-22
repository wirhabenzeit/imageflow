import { rm } from 'node:fs/promises';
import { assetUsage } from '../src/asset-usage';
import type { ProjectFiles } from '../src/project';
import type { PhotoSourceEntry, SourceState } from '../src/source-locations';
import type { Locator } from '../src/source-locator';
import { providerOf } from './providers';
import type { Observed, Revisions, SourceRef } from './source-provider';
import type { SourceStore, StoredSource } from './source-store';

/**
 * Full-resolution originals of photos without a file (ADR 0011, §4 and Where renders are stored). Their provider's
 * `materialize` writes them into a staging folder of the host's; the host hashes and checks each, moves it into the
 * source cache (`source-cache/content/<sha256>.<ext>`) and records it against the photo's `revision`, so a later
 * export or copy reuses it while the revision is the same and asks again once it moved. An export then pins it into
 * its job like the private copy of a file photo; Copy into Book and Save a Copy copy it into the package.
 *
 * Only what is asked for is materialized: an export asks for the placed photos (`placedPhotos`), never the whole pool
 * of candidates, and a copy for the photos chosen. Each provider is asked once for all its photos that have no valid
 * original stored, and once more for those whose result came from a photo that changed meanwhile.
 */

/** A photo to materialize, with the revisions it was last observed at: the ones a stored original must match. */
export type MaterializeRequest = { source: PhotoSourceEntry; revisions: Revisions };
/** What became of one: an original in the source cache, recorded against `revision`, or why there is none. */
export type MaterializedPhoto =
  | { state: 'available'; stored: StoredSource; revision: string; reused: boolean }
  | { state: Exclude<SourceState, 'available'>; problem: string };
/** Progress over all the photos asked for: those stored before count as done at once. */
export type MaterializeProgress = { done: number; total: number };
export type MaterializeOptions = { signal?: AbortSignal; progress?: (progress: MaterializeProgress) => void };

// How often a photo is asked for in all, when its results keep coming from a photo that changed while it was made.
// The ADR's case is an edit in Lightroom during a render: one more attempt nearly always settles it, a third covers a
// burst of edits, and more would keep an export waiting on a photo someone is still working on.
const attempts = 3;
const cancelled = 'Original unavailable: Cancelled.';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The IDs of the photos a book places: in a box of any spread or of the cover, or held by a template parameter. Unused
 * candidates are left out (ADR 0011, §4.1).
 */
export const placedPhotos = (files: ProjectFiles) => new Set(Object.keys(assetUsage(files, []).photo));

/**
 * Brings the full-resolution originals of `requests` into the source cache, reusing those stored for the current
 * revision. Never rejects for one photo's failure: that photo gets its state and problem, and the others follow. After
 * `signal` aborts, what was not stored yet stays unstored (with a problem saying so), nothing half-made is recorded, and
 * the staging folder is removed with every file in it, also those of failed and discarded results.
 */
export async function materializePhotos(folder: string, store: SourceStore, requests: readonly MaterializeRequest[],
  { signal = new AbortController().signal, progress }: MaterializeOptions = {}): Promise<Map<string, MaterializedPhoto>> {
  const results = new Map<string, MaterializedPhoto>();
  let done = 0;
  const total = requests.length;
  const finish = (id: string, result: MaterializedPhoto) => { results.set(id, result); progress?.({ done: ++done, total }); };
  progress?.({ done, total });
  const missing: MaterializeRequest[] = [];
  for (const request of requests) {
    const stored = await store.materialization(request.source, request.revisions.revision).catch(() => undefined);
    if (stored) finish(request.source.id, { state: 'available', stored, revision: request.revisions.revision, reused: true });
    else missing.push(request);
  }
  // One provider at a time: a provider renders in batches of its own, and two asking at once would share its queue
  // without either finishing sooner.
  for (const name of new Set(missing.map(({ source }) => source.locator.provider))) {
    const group = missing.filter(({ source }) => source.locator.provider === name);
    await materializeGroup(folder, store, group, signal, finish);
  }
  for (const { source } of requests) if (!results.has(source.id)) finish(source.id, { state: 'unreadable', problem: cancelled });
  return results;
}

async function materializeGroup(folder: string, store: SourceStore, group: MaterializeRequest[], signal: AbortSignal,
  finish: (id: string, result: MaterializedPhoto) => void) {
  const provider = providerOf(group[0].source.locator);
  let pending = group;
  for (let attempt = 0; pending.length && attempt < attempts && !signal.aborted; attempt++) {
    // A photo whose result came from a version that changed meanwhile is observed again first: what the next result
    // must match is the revision it has now.
    if (attempt > 0) pending = await reobserved(folder, pending, finish);
    if (!pending.length) break;
    const byId = new Map(pending.map((request) => [request.source.id, request]));
    const again: MaterializeRequest[] = [];
    let staging: string | undefined;
    try {
      staging = await store.staging();
      const refs = pending.map(({ source }): SourceRef<Locator> => ({ id: source.id, locator: source.locator }));
      for await (const result of provider.materialize(folder, refs, { staging, signal })) {
        const request = byId.get(result.id);
        try {
          // An answer for a photo not asked for, or a second one, is not used; its file goes with the staging folder.
          if (!request) continue;
          byId.delete(result.id);
          if (!('file' in result)) { finish(result.id, { state: result.state, problem: result.problem }); continue; }
          // Made from a photo that changed while it was made, or from another version than the one observed (the
          // book's facts describe that one): discarded and asked for again.
          if (result.before.revision !== result.after.revision || result.before.revision !== request.revisions.revision) {
            if (attempt + 1 < attempts) again.push(request);
            else finish(result.id, { state: 'unreadable', problem: 'Original unavailable: The photo kept changing while its original was made.' });
            continue;
          }
          // A result that arrives after a cancel is not stored: a cancelled export or copy leaves the cache as it was.
          if (signal.aborted) { byId.set(result.id, request); continue; }
          const stored = await store.keepMaterialized(request.source, result.before.revision, result.file);
          finish(result.id, { state: 'available', stored, revision: result.before.revision, reused: false });
        } catch (error) {
          if (request) finish(result.id, { state: 'unreadable', problem: 'Original unavailable: ' + message(error) });
        } finally { if ('file' in result) await rm(result.file, { force: true }); }
        if (signal.aborted) break;
      }
      // A photo the provider skipped. One a cancel left out stays without a result here, and is reported as cancelled.
      if (!signal.aborted) for (const { source } of byId.values()) finish(source.id, { state: 'unreadable', problem: 'Original unavailable: The source produced no original.' });
    } catch (error) {
      // A failure that is no photo's: every photo of this provider still waiting gets it. After a cancel they are
      // reported as cancelled instead.
      if (!signal.aborted) for (const { source } of [...byId.values(), ...again]) finish(source.id, { state: 'unreadable', problem: 'Original unavailable: ' + message(error) });
      again.length = 0;
    } finally { if (staging) await rm(staging, { recursive: true, force: true }); }
    pending = again;
  }
}

/** Photos observed again before their original is asked for once more; those no longer available say why. */
async function reobserved(folder: string, pending: MaterializeRequest[], finish: (id: string, result: MaterializedPhoto) => void) {
  let observed: Observed[];
  try {
    observed = await providerOf(pending[0].source.locator).observe(folder, pending.map(({ source, revisions }) => ({ id: source.id, locator: source.locator, known: { ...revisions } })));
    if (observed.length !== pending.length) throw new Error('The source answered for ' + observed.length + ' of ' + pending.length + ' photos.');
  } catch (error) { observed = pending.map(() => ({ state: 'unreadable', problem: 'Original unavailable: ' + message(error) })); }
  return pending.flatMap((request, index): MaterializeRequest[] => {
    const result = observed[index];
    if (result.state === 'available' && result.facts) return [{ ...request, revisions: result.revisions }];
    finish(request.source.id, result.state !== 'available' ? { state: result.state, problem: result.problem }
      : { state: 'unreadable', problem: 'Original unavailable: The source now reports this photo as a file.' });
    return [];
  });
}
