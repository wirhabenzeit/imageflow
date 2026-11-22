import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assetFactSchema } from '../src/asset-facts';
import type { AssetFact } from '../src/asset-facts';
import { canonicalJson } from '../src/canonical-json';
import type { Locator } from '../src/source-locator';
import type { AssetFacts } from './asset-facts';
import { proxyStore } from './proxy-store';
import type { Observed, ProvidedFacts, Revisions, SourceProvider, SourceRef, Unavailable } from './source-provider';

/**
 * Photos without a file (ADR 0011, Source providers): the host's side of a provider that reports facts. What the
 * provider reported is recorded in `assets-meta.json` with the revisions it was read at and the provider's titles, and
 * its preview is stored in the proxy store under the digest of its bytes without their metadata segments. The editor
 * then draws the photo from fact and proxy (`loadPhoto` in desktop/project.ts), as it draws a photo whose original is
 * missing on this Mac, but without a problem.
 *
 * A preview is asked for only when there is none, or when the photo's content revision moved; a digest that stays the
 * same after a new preview is no change of the photo. So a metadata edit costs no preview, and an edit that renders
 * the same pixels reloads nothing.
 */

// Markers of JPEG segments that carry metadata a renderer rewrites on every render: APP1 holds EXIF and XMP (Lightroom
// writes a fresh `xmp:MetadataDate` and a random `xmpMM:DocumentID` into each), COM a comment. APP2 holds the ICC
// profile, which stays.
const jpegMetadata = new Set([0xe1, 0xfe]);
// PNG chunks of the same kind: text, time and EXIF.
const pngMetadata = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A preview's bytes without the segments that differ between two renders of the same pixels, so equal pictures have
 * equal digests. Only JPEG and PNG are previews; anything else is refused.
 */
export function strippedPreview(input: Uint8Array): Buffer {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const kept: Buffer[] = [bytes.subarray(0, 2)];
    let at = 2;
    while (at < bytes.length) {
      if (bytes[at] !== 0xff) throw new Error('The preview is not a whole JPEG image.');
      // Fill bytes before a marker.
      let marker = at + 1;
      while (bytes[marker] === 0xff) marker++;
      const code = bytes[marker];
      if (code === undefined) throw new Error('The preview is not a whole JPEG image.');
      // Start of scan: the entropy-coded image and everything after it are kept as they are.
      if (code === 0xda || code === 0xd9) { kept.push(bytes.subarray(at)); break; }
      // Markers without a length.
      if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) { kept.push(bytes.subarray(at, marker + 1)); at = marker + 1; continue; }
      if (marker + 2 >= bytes.length) throw new Error('The preview is not a whole JPEG image.');
      // The length counts its own two bytes, so it is at least 2.
      const length = bytes.readUInt16BE(marker + 1);
      const end = marker + 1 + length;
      if (length < 2 || end > bytes.length) throw new Error('The preview is not a whole JPEG image.');
      if (!jpegMetadata.has(code)) kept.push(bytes.subarray(at, end));
      at = end;
    }
    return Buffer.concat(kept);
  }
  if (bytes.subarray(0, 8).equals(pngSignature)) {
    const kept: Buffer[] = [pngSignature];
    let at = 8;
    while (at < bytes.length) {
      if (at + 12 > bytes.length) throw new Error('The preview is not a whole PNG image.');
      const end = at + 12 + bytes.readUInt32BE(at);
      if (end > bytes.length) throw new Error('The preview is not a whole PNG image.');
      const type = bytes.toString('latin1', at + 4, at + 8);
      if (!pngMetadata.has(type)) kept.push(bytes.subarray(at, end));
      at = end;
      if (type === 'IEND') break;
    }
    return Buffer.concat(kept);
  }
  throw new Error('A preview must be a JPEG or PNG image.');
}

/** The key previews follow: the content revision where the provider has one, otherwise every revision. */
export const contentKey = (revisions: Revisions) => revisions.contentRevision ?? revisions.revision;

/** What became of a photo without a file after its provider was asked. */
export type ProvidedOutcome =
  | {
    state: 'available';
    /** The fact the photo is laid out from; its digest names its stored preview. */
    fact: AssetFact;
    /** The fact before, if there was one. */
    previous?: AssetFact;
    /**
     * `unchanged`: the provider recorded nothing new. `metadata`: it did, but the pixels are the same, so nothing needs
     * to be drawn again. `content`: the stored preview is another one.
     */
    change: 'unchanged' | 'metadata' | 'content';
  }
  /** The provider can report the photo but no preview of it was stored; it lays out from its last fact, if any. */
  | { state: 'unreadable'; problem: string; fact?: AssetFact }
  | { state: Unavailable; problem: string };

type Reported = { ref: SourceRef<Locator>; facts: ProvidedFacts; revisions: Revisions };
// The fact recorded for what a provider reported, or undefined when what it reported is not a valid fact (a width of
// 0, say): the photo is then unreadable rather than laid out from facts that were never recorded.
const factOf = (facts: AssetFacts, id: string, digest: string, { facts: reported, revisions }: Omit<Reported, 'ref'>) => {
  const { width, height, captured, location, camera, provided, extra } = reported;
  return facts.provide(id, { digest, width, height, captured, location, camera, revisions, provided, extra }) === undefined ? undefined : facts.get(id);
};
const invalidFacts = 'Original unavailable: The source reported facts ImageFlow cannot use.';
const usable = ({ facts: { width, height, captured, location, camera, provided, extra }, revisions }: Omit<Reported, 'ref'>) =>
  assetFactSchema.safeParse({ digest: '0'.repeat(64), width, height, captured, location, camera, revisions, provided, extra, verified: new Date().toISOString() }).success;

// One refresh per book at a time, so a photo is never previewed twice at once: a reload and a watch of the same book
// would otherwise both ask for it.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(folder: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(folder) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => {});
  queues.set(folder, settled);
  void settled.then(() => { if (queues.get(folder) === settled) queues.delete(folder); });
  return run;
}

/**
 * Records what a provider reported for photos without a file (`observed`, in the order of `refs`), asks it for the
 * previews that are missing or out of date, and stores them. Photos the provider reported as files are not in its
 * answer here; `refs` holds only photos it reported facts or a failure for. `staging` is a folder of the host's for
 * the provider's files, removed afterwards.
 */
export function refreshProvided(folder: string, provider: SourceProvider<Locator>, refs: readonly SourceRef<Locator>[], observed: readonly Observed[],
  facts: AssetFacts, { staging, signal = new AbortController().signal }: { staging: string; signal?: AbortSignal }): Promise<Map<string, ProvidedOutcome>> {
  return serialized(folder, async () => {
    const outcomes = new Map<string, ProvidedOutcome>();
    const store = await proxyStore();
    const wanted: Reported[] = [];
    const failed = (reported: Reported, problem: string) => outcomes.set(reported.ref.id, { state: 'unreadable', problem, ...(facts.get(reported.ref.id) ? { fact: facts.get(reported.ref.id)! } : {}) });
    for (const [index, ref] of refs.entries()) {
      const result = observed[index];
      if (result.state !== 'available') { outcomes.set(ref.id, { state: result.state, problem: result.problem }); continue; }
      if (!result.facts) continue;
      const previous = facts.get(ref.id);
      const reported = { ref, facts: result.facts, revisions: result.revisions };
      // Facts that could not be recorded are not worth a preview.
      if (!usable(reported)) { failed(reported, invalidFacts); continue; }
      // The stored preview still shows the photo: only the facts and the revisions are recorded again.
      if (previous?.revisions && contentKey(previous.revisions) === contentKey(result.revisions) && await store?.path(previous.digest)) {
        const fact = factOf(facts, ref.id, previous.digest, reported);
        if (!fact) failed(reported, invalidFacts);
        else outcomes.set(ref.id, { state: 'available', fact, previous, change: previous.revisions.revision === result.revisions.revision ? 'unchanged' : 'metadata' });
      } else wanted.push(reported);
    }
    if (!wanted.length) return outcomes;
    if (!store) { for (const reported of wanted) failed(reported, 'Preview unavailable: ImageFlow has no proxy store.'); return outcomes; }
    if (!provider.preview) { for (const reported of wanted) failed(reported, 'Preview unavailable: The source provides no previews.'); return outcomes; }
    await mkdir(staging, { recursive: true });
    const directory = await mkdtemp(join(await realpath(staging), 'previews-'));
    try {
      // A preview made while its photo changed is discarded and asked for once more, as a materialization is.
      let pending = wanted;
      for (let attempt = 0; pending.length && attempt < 2 && !signal.aborted; attempt++) {
        // What changed during the first preview may have changed its size or titles too: it is observed again, so the
        // facts recorded with the next preview are the ones of its revision.
        if (attempt > 0) pending = await reobserved(provider, folder, pending, (reported, result) => outcomes.set(reported.ref.id, result));
        if (!pending.length) break;
        const byId = new Map(pending.map((reported) => [reported.ref.id, reported]));
        const again: Reported[] = [];
        for await (const result of provider.preview(folder, pending.map(({ ref }) => ref), { staging: directory, signal })) {
          const reported = byId.get(result.id);
          if (!reported) continue;
          byId.delete(result.id);
          if (!('file' in result)) { outcomes.set(result.id, { state: result.state, problem: result.problem }); continue; }
          try {
            if (result.before.revision !== result.after.revision || contentKey(result.before) !== contentKey(result.after)) {
              if (attempt === 0) again.push({ ...reported, revisions: result.after });
              else failed(reported, 'Preview unavailable: The photo changed while its preview was made.');
              continue;
            }
            const bytes = strippedPreview(await readFile(result.file));
            const digest = createHash('sha256').update(bytes).digest('hex');
            await store.put(digest, bytes);
            const previous = facts.get(result.id);
            const fact = factOf(facts, result.id, digest, { facts: reported.facts, revisions: result.after });
            if (!fact) { failed(reported, invalidFacts); continue; }
            outcomes.set(result.id, { state: 'available', fact, ...(previous ? { previous } : {}), change: previous?.digest === digest ? previous.revisions?.revision === result.after.revision ? 'unchanged' : 'metadata' : 'content' });
          } catch (error) { failed(reported, 'Preview unavailable: ' + (error instanceof Error ? error.message : String(error))); }
          finally { await rm(result.file, { force: true }); }
        }
        // A photo the provider skipped, or one an abort left out.
        for (const reported of byId.values()) failed(reported, 'Preview unavailable: The source produced no preview.');
        pending = again;
      }
      for (const reported of pending) failed(reported, 'Preview unavailable: The preview was cancelled.');
    } catch (error) {
      for (const reported of wanted) if (!outcomes.has(reported.ref.id)) failed(reported, 'Preview unavailable: ' + (error instanceof Error ? error.message : String(error)));
    } finally { await rm(directory, { recursive: true, force: true }); }
    return outcomes;
  });
}

/** Photos observed again before their preview is asked for once more; those that are no longer available say why. */
async function reobserved(provider: SourceProvider<Locator>, folder: string, pending: Reported[], unavailable: (reported: Reported, outcome: ProvidedOutcome) => void) {
  let results: Observed[];
  try { results = await provider.observe(folder, pending.map(({ ref }) => ref)); }
  catch (error) { results = pending.map(() => ({ state: 'unreadable', problem: 'Original unavailable: ' + (error instanceof Error ? error.message : String(error)) })); }
  return pending.flatMap((reported, index): Reported[] => {
    const result = results[index];
    if (result?.state === 'available' && result.facts && usable({ facts: result.facts, revisions: result.revisions })) return [{ ...reported, facts: result.facts, revisions: result.revisions }];
    if (result?.state === 'available' && result.facts) { unavailable(reported, { state: 'unreadable', problem: invalidFacts }); return []; }
    unavailable(reported, result && result.state !== 'available' ? { state: result.state, problem: result.problem }
      : { state: 'unreadable', problem: 'Preview unavailable: The source no longer reports this photo.' });
    return [];
  });
}

/**
 * Whether a fact differs from the one before in what the book shows of it besides its pixels: its size, capture data
 * or provided titles. A change of anything else the provider records (a rating, say) moves only its revision.
 */
const shown = ({ width, height, captured, location, camera, provided }: AssetFact) => canonicalJson(Object.fromEntries(
  Object.entries({ width, height, captured, location, camera, provided }).filter(([, value]) => value !== undefined)));
export const visibleChange = (before: AssetFact, after: AssetFact) => shown(before) !== shown(after);

/** Whether a photo's aspect ratio changed enough that a crop placed on it shows another part of it (ADR 0011, §3.8). */
export const aspectChanged = (before: { width: number; height: number }, after: { width: number; height: number }) =>
  Math.abs(before.width / before.height - after.width / after.height) > 0.01 * (before.width / before.height);

/** What the host does about a change its provider reported for photos without a file. */
export type ProvidedChanges = {
  /** The photos to show again: a preview changed, or a photo became available or unavailable. The book reloads. */
  reload: string[];
  /** The photos whose revision moved: the render inputs changed, also where nothing is drawn again. */
  revised: string[];
  /** The photos whose aspect ratio changed with a new preview: a crop placed on them may frame another part. */
  reshaped: string[];
};

/**
 * Handles a provider's `watch` report for photos without a file (ADR 0011, §3): observes them again, compares the
 * content revision with the stored one, makes a new preview only where it moved, and reloads only where the stored
 * preview is another one. A metadata edit records the new revisions and provided values without a preview or reload.
 * `available` tells which photos the open book shows as available.
 */
export async function providedChanges(folder: string, provider: SourceProvider<Locator>, refs: readonly SourceRef<Locator>[], facts: AssetFacts,
  { staging, available, signal }: { staging: string; available: (id: string) => boolean; signal?: AbortSignal }): Promise<ProvidedChanges> {
  const changes: ProvidedChanges = { reload: [], revised: [], reshaped: [] };
  if (!refs.length) return changes;
  const known = refs.map((ref) => { const revisions = facts.get(ref.id)?.revisions; return { ...ref, ...(revisions ? { known: { ...revisions } } : {}) }; });
  let observed: Observed[];
  try {
    observed = await provider.observe(folder, known);
    if (observed.length !== known.length) throw new Error('The source answered for ' + observed.length + ' of ' + known.length + ' photos.');
  } catch (error) {
    const problem = 'Original unavailable: ' + (error instanceof Error ? error.message : String(error));
    observed = known.map(() => ({ state: 'unreadable', problem }));
  }
  // A photo the provider now reports as a file is no longer one the host keeps facts for: the book reads it again.
  for (const [index, ref] of known.entries()) {
    const result = observed[index];
    if (result.state === 'available' && result.file !== undefined) { changes.reload.push(ref.id); changes.revised.push(ref.id); }
  }
  const outcomes = await refreshProvided(folder, provider, known, observed, facts, { staging, signal });
  for (const [id, outcome] of outcomes) {
    const before = available(id);
    if (outcome.state !== 'available') {
      if (before) { changes.reload.push(id); changes.revised.push(id); }
      continue;
    }
    if (outcome.change !== 'unchanged') changes.revised.push(id);
    // A new preview, or new titles or capture data that templates and the Inspector show, are shown at once.
    if (outcome.change === 'content' || !before || (outcome.change === 'metadata' && (!outcome.previous || visibleChange(outcome.previous, outcome.fact)))) changes.reload.push(id);
    if (outcome.change === 'content' && outcome.previous && aspectChanged(outcome.previous, outcome.fact)) changes.reshaped.push(id);
  }
  return changes;
}
