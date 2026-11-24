import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { assetFactSchema } from '../src/asset-facts';
import type { AssetFact } from '../src/asset-facts';
import { canonicalJson } from '../src/canonical-json';
import type { Locator } from '../src/source-locator';
import type { AssetFacts } from './asset-facts';
import type { PreviewFailure } from './preview-requests';
import { proxyStore } from './proxy-store';
import type { Observed, Previewed, PreviewRendering, ProvidedFacts, Revisions, SourceProvider, SourceRef, Unavailable } from './source-provider';

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
 *
 * An open book never waits for previews: a load hands the ones it wants to `backgroundPreviews` and shows the photo
 * without a picture (`pending`), or with its older one (`outOfDate`), until they come. A photo whose provider has no
 * new preview of it now (Lightroom, of a photo being edited) stays out of date until the provider reports it again.
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
    /**
     * The stored preview, and the size in the fact, are of the photo before its latest edit: there is no newer preview
     * yet. The fact names the photo's revision now, so an export prints that one, but not its content.
     */
    outOfDate?: boolean;
    /** Why there is no newer preview, where one was asked for. */
    problem?: string;
  }
  /** The photo has no preview yet, and one is being fetched. `fact` lays it out and is recorded nowhere. */
  | { state: 'pending'; fact: AssetFact }
  /** The provider can report the photo but no preview of it was stored; it lays out from its last fact, if any. */
  | { state: 'unreadable'; problem: string; fact?: AssetFact }
  | { state: Unavailable; problem: string };

type Reported = { ref: SourceRef<Locator>; facts: ProvidedFacts; revisions: Revisions };
// The fact recorded for what a provider reported, or undefined when what it reported is not a valid fact (a width of
// 0, say): the photo is then unreadable rather than laid out from facts that were never recorded.
const factOf = (facts: AssetFacts, id: string, digest: string, { facts: reported, revisions }: Omit<Reported, 'ref'>, verified?: string) => {
  const { width, height, captured, location, camera, provided, extra } = reported;
  return facts.provide(id, { digest, width, height, captured, location, camera, revisions, provided, extra, ...(verified ? { verified } : {}) }) === undefined ? undefined : facts.get(id);
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

// Previews are kept at most this long on their long edge, as ImageFlow's own are.
const previewEdge = 1400;
/**
 * A provider's preview as ImageFlow keeps and syncs it: without the metadata a renderer rewrites (`strippedPreview`),
 * at most 1400 px, and as a compact JPEG (mozjpeg, quality 82, 4:2:0) with its colour profile. Lightroom exports its
 * previews at full chroma and high quality, about 800 KB each; this is about a quarter of that, with no difference a
 * screen shows. Equal pixels still give equal bytes. A PNG preview (one with transparency) stays a PNG, and a preview
 * is never made larger than it came.
 */
export async function compactPreview(input: Uint8Array): Promise<Buffer> {
  const stripped = strippedPreview(input);
  const image = sharp(stripped, { failOn: 'error' });
  const { hasAlpha } = await image.metadata();
  const sized = image.resize({ width: previewEdge, height: previewEdge, fit: 'inside', withoutEnlargement: true }).keepIccProfile();
  const compact = await (hasAlpha ? sized.png({ compressionLevel: 9 }) : sized.jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:2:0' })).toBuffer();
  return compact.length < stripped.length ? compact : stripped;
}

/** A photo whose preview a load left to the background, with the content the preview is wanted of. */
export type WantedPreview = { id: string; key: string };
/**
 * Who fetches the previews of a book that is open in a session. It is told after a load which previews are wanted, and
 * answers with the problem of each it tried and could not get for that same content.
 */
export type BackgroundPreviews = { wanted: (previews: readonly WantedPreview[]) => void; problem: (preview: WantedPreview) => string | undefined };
const background = new Map<string, BackgroundPreviews>();
/** Registers who fetches a book's previews after it loads; returns a function that stops. Without one, a load waits for them. */
export function backgroundPreviews(folder: string, previews: BackgroundPreviews): () => void {
  background.set(folder, previews);
  return () => { if (background.get(folder) === previews) background.delete(folder); };
}

/** A fact for a photo that has no preview yet, to lay it out by: never recorded, and its digest is of nothing. */
const provisionalFact = ({ facts: { width, height, captured, location, camera, provided, extra }, revisions }: Omit<Reported, 'ref'>): AssetFact | undefined =>
  assetFactSchema.safeParse({ digest: '0'.repeat(64), width, height, captured, location, camera, revisions, provided, extra, verified: new Date(0).toISOString() }).data;

/**
 * The fact of a photo whose preview is of the content before its latest edit. The preview and the size it goes with
 * stay; titles and capture data are the ones reported now. The photo's revision is recorded without a content revision,
 * which no preview is stored for: the next look finds that the preview is wanted, and what prints follows the revision.
 * The fact is no newer an observation of the photo than the preview is, for a sync to take it by.
 */
function outOfDateFact(facts: AssetFacts, previous: AssetFact, { ref, facts: reported, revisions }: Reported): Extract<ProvidedOutcome, { state: 'available' }> | undefined {
  // Without a content revision of its own the two could not be told apart later.
  if (!revisions.contentRevision) return undefined;
  const fact = factOf(facts, ref.id, previous.digest, { facts: { ...reported, width: previous.width, height: previous.height }, revisions: { revision: revisions.revision } }, previous.verified);
  return fact && { state: 'available', fact, previous, outOfDate: true, change: previous.revisions?.revision === revisions.revision ? 'unchanged' : 'metadata' };
}

// Compressing a preview takes about 0.1 s of one core; several at once keep up with the provider.
const compressions = 8;
// A kept preview smaller than this on its long edge, of a larger photo, is replaced by one made from the photo.
const smallestKept = 1000;

export type RefreshOptions = {
  staging: string; signal?: AbortSignal;
  /**
   * How a load treats the previews it lacks: `background` leaves them to the book's `backgroundPreviews` where there are
   * any, and `held` asks for none for a photo that has an older one (an export, which prints originals). Without it, they are fetched here.
   */
  previews?: 'background' | 'held';
  /** Makes every preview again from its photo (Refresh from Lightroom), also where the stored one is of its content. */
  again?: boolean;
  /** Called as each photo's preview is stored or given up on. */
  settled?: (id: string, outcome: ProvidedOutcome, done: number, total: number) => void;
};

/**
 * Records what a provider reported for photos without a file (`observed`, in the order of `refs`), asks it for the
 * previews that are missing or out of date, and stores them. Photos the provider reported as files are not in its
 * answer here; `refs` holds only photos it reported facts or a failure for. `staging` is a folder of the host's for
 * the provider's files, removed afterwards.
 */
export async function refreshProvided(folder: string, provider: SourceProvider<Locator>, refs: readonly SourceRef<Locator>[], observed: readonly Observed[],
  facts: AssetFacts, options: RefreshOptions): Promise<Map<string, ProvidedOutcome>> {
  const later = options.previews === 'background' ? background.get(folder) : undefined;
  // A load that leaves the previews to the background waits for none: not even for those being fetched.
  if (later || options.previews === 'held') {
    const outcomes = new Map<string, ProvidedOutcome>();
    const missing = await recordReported(refs, observed, facts, outcomes, await proxyStore(), options.again, options.previews);
    if (later) {
      for (const { reported } of missing) {
        const problem = later.problem({ id: reported.ref.id, key: contentKey(reported.revisions) });
        const fact = provisionalFact(reported);
        outcomes.set(reported.ref.id, problem !== undefined || !fact ? { state: 'unreadable', problem: problem ?? invalidFacts } : { state: 'pending', fact });
      }
      const wanted = [...missing.map(({ reported }) => reported), ...refs.flatMap((ref, index) => {
        const result = observed[index], outcome = outcomes.get(ref.id);
        return outcome?.state === 'available' && outcome.outOfDate && result.state === 'available' ? [{ ref, revisions: result.revisions }] : [];
      })].map(({ ref, revisions }) => ({ id: ref.id, key: contentKey(revisions) }));
      if (wanted.length) later.wanted(wanted);
      return outcomes;
    }
    if (!missing.length) return outcomes;
    // An export prints originals, so a photo that has no picture at all is the only one it asks a preview of.
    const asked = new Set(missing.map(({ reported }) => reported.ref.id));
    const indexes = refs.flatMap((ref, index) => asked.has(ref.id) ? [index] : []);
    for (const [id, outcome] of await refreshProvided(folder, provider, indexes.map((index) => refs[index]), indexes.map((index) => observed[index]), facts, { ...options, previews: undefined })) outcomes.set(id, outcome);
    return outcomes;
  }
  return serialized(folder, () => fetchPreviews(folder, provider, refs, observed, facts, options));
}

type Wanted = { reported: Reported; /** Its older preview is stored. */ held: boolean; rendering: PreviewRendering;
  /** The fact from before this refresh stored a preview that another is to replace (`null`: there was none). */ first?: AssetFact | null };
/**
 * The part of a refresh that needs no preview: records the facts of the photos whose stored preview still shows them,
 * and returns the others. With `previews`, a photo that has an older preview is recorded as out of date instead.
 */
async function recordReported(refs: readonly SourceRef<Locator>[], observed: readonly Observed[], facts: AssetFacts, outcomes: Map<string, ProvidedOutcome>,
  store: Awaited<ReturnType<typeof proxyStore>>, again: boolean | undefined, previews: RefreshOptions['previews']): Promise<Wanted[]> {
  const wanted: Wanted[] = [];
  for (const [index, ref] of refs.entries()) {
    const result = observed[index];
    if (result.state !== 'available') { outcomes.set(ref.id, { state: result.state, problem: result.problem }); continue; }
    if (!result.facts) continue;
    const reported = { ref, facts: result.facts, revisions: result.revisions };
    const failed = (problem: string) => outcomes.set(ref.id, { state: 'unreadable', problem, ...(facts.get(ref.id) ? { fact: facts.get(ref.id)! } : {}) });
    // Facts that could not be recorded are not worth a preview.
    if (!usable(reported)) { failed(invalidFacts); continue; }
    // A preview may be stored in the background while this looks for the one before: then it is the one to look for.
    let previous = facts.get(ref.id), held = false;
    for (let looked: AssetFact | undefined, first = true; first || looked !== previous; first = false) {
      looked = previous;
      held = !!previous && !!await store?.path(previous.digest);
      previous = facts.get(ref.id);
    }
    // The stored preview still shows the photo: only the facts and the revisions are recorded again.
    if (!again && held && previous!.revisions && contentKey(previous!.revisions) === contentKey(result.revisions)) {
      const fact = factOf(facts, ref.id, previous!.digest, reported);
      if (!fact) failed(invalidFacts);
      else outcomes.set(ref.id, { state: 'available', fact, previous, change: previous!.revisions!.revision === result.revisions.revision ? 'unchanged' : 'metadata' });
      continue;
    }
    const stale = previews && held ? outOfDateFact(facts, previous!, reported) : undefined;
    if (stale) outcomes.set(ref.id, stale);
    else wanted.push({ reported, held, rendering: again ? 'always' : held && result.revisions.contentRevision ? 'never' : 'fallback' });
  }
  return wanted;
}

async function fetchPreviews(folder: string, provider: SourceProvider<Locator>, refs: readonly SourceRef<Locator>[], observed: readonly Observed[],
  facts: AssetFacts, { staging, signal = new AbortController().signal, again: remake, settled }: RefreshOptions): Promise<Map<string, ProvidedOutcome>> {
  const outcomes = new Map<string, ProvidedOutcome>();
  const store = await proxyStore();
  const failedOutcome = ({ ref }: Reported, problem: string): ProvidedOutcome => ({ state: 'unreadable', problem, ...(facts.get(ref.id) ? { fact: facts.get(ref.id)! } : {}) });
  const wanted = await recordReported(refs, observed, facts, outcomes, store, remake, undefined);
  if (!wanted.length) return outcomes;
  let done = 0;
  const finished = new Set<string>();
  const settle = ({ ref: { id } }: Reported, outcome: ProvidedOutcome) => {
    outcomes.set(id, outcome);
    if (!finished.has(id)) { finished.add(id); done++; }
    settled?.(id, outcome, done, wanted.length);
  };
  const failed = (reported: Reported, problem: string) => settle(reported, failedOutcome(reported, problem));
  if (!store) { for (const { reported } of wanted) failed(reported, 'Preview unavailable: ImageFlow has no proxy store.'); return outcomes; }
  if (!provider.preview) { for (const { reported } of wanted) failed(reported, 'Preview unavailable: The source provides no previews.'); return outcomes; }
  await mkdir(staging, { recursive: true });
  const directory = await mkdtemp(join(await realpath(staging), 'previews-'));
  // A photo that has a picture and could not get a newer one keeps it, marked out of date.
  const keep = ({ reported, held }: Wanted, problem: string) => {
    const previous = facts.get(reported.ref.id);
    // Stored a moment ago in this very refresh: it stays as it was reported.
    const stored = outcomes.get(reported.ref.id);
    if (held && stored?.state === 'available' && !stored.outOfDate && stored.fact === previous) { settle(reported, stored); return; }
    const stale = held && previous && (previous.revisions && contentKey(previous.revisions) === contentKey(reported.revisions)
      ? { state: 'available' as const, fact: previous, previous, change: 'unchanged' as const } : outOfDateFact(facts, previous, reported));
    settle(reported, stale ? { ...stale, problem } : failedOutcome(reported, problem));
  };
  try {
    // A preview made while its photo changed is discarded and asked for once more, as a materialization is; one the
    // provider kept that cannot be the photo's is then made from it.
    let pending = wanted;
    const changedOnce = new Set<string>();
    while (pending.length && !signal.aborted) {
      const next: Wanted[] = [];
      for (const rendering of ['fallback', 'never', 'always'] as const) {
        const group = pending.filter((entry) => entry.rendering === rendering);
        if (!group.length || signal.aborted) { next.push(...signal.aborted ? group : []); continue; }
        const byId = new Map(group.map((entry) => [entry.reported.ref.id, entry]));
        const changed: Wanted[] = [];
        const take = async (entry: Wanted, result: Extract<Previewed, { file: string }>) => {
          const { reported } = entry, { ref } = reported;
          try {
            if (result.before.revision !== result.after.revision || contentKey(result.before) !== contentKey(result.after)) {
              if (!changedOnce.has(ref.id)) { changedOnce.add(ref.id); changed.push({ ...entry, reported: { ...reported, revisions: result.after } }); }
              else keep(entry, 'Preview unavailable: The photo changed while its preview was made.');
              return;
            }
            const input = await readFile(result.file);
            const previous = facts.get(ref.id);
            // Too small to lay out by: used only until one made from the photo replaces it.
            const { width = 0, height = 0 } = result.kept ? await sharp(input).metadata() : {};
            const small = result.kept && Math.max(width, height) < Math.min(smallestKept, Math.max(reported.facts.width, reported.facts.height));
            const bytes = await compactPreview(input);
            const digest = createHash('sha256').update(bytes).digest('hex');
            const moved = !!previous?.revisions && contentKey(previous.revisions) !== contentKey(result.after);
            // Other content and the very same picture: the provider may have kept the one from before the edit.
            if (result.kept && entry.held && moved && digest === previous!.digest) {
              keep(entry, 'Preview unavailable: The source still shows the photo before its latest edit.');
              next.push({ ...entry, rendering: 'always' });
              return;
            }
            await store.put(digest, bytes);
            const fact = factOf(facts, ref.id, digest, { facts: reported.facts, revisions: result.after });
            if (!fact) { failed(reported, invalidFacts); return; }
            // What changed is told from before this refresh, not from a preview it stored a moment ago and replaces now.
            const first = entry.first === undefined ? previous : entry.first ?? undefined;
            settle(reported, { state: 'available', fact, ...(first ? { previous: first } : {}), change: first?.digest === digest ? first.revisions?.revision === result.after.revision ? 'unchanged' : 'metadata' : 'content' });
            if (small) next.push({ ...entry, held: true, first: first ?? null, rendering: 'always' });
          } catch (error) { keep({ ...entry, held: false }, 'Preview unavailable: ' + (error instanceof Error ? error.message : String(error))); }
          finally { await rm(result.file, { force: true }); }
        };
        const running = new Set<Promise<void>>();
        try {
          // `known` is what the provider was just observed at: what it makes is compared with that.
          for await (const result of provider.preview(folder, group.map(({ reported: { ref, revisions } }) => ({ ...ref, known: revisions })), { staging: directory, signal, rendering })) {
            const entry = byId.get(result.id);
            if (!entry) continue;
            byId.delete(result.id);
            if ('deferred' in result) { keep(entry, 'Preview unavailable: The source has no preview of this photo now.'); continue; }
            if (!('file' in result)) {
              // A picture asked for anew only to be sure, or on request, is no reason to lose the one there is.
              if (rendering === 'always' && entry.held && result.state === 'unreadable') keep(entry, result.problem);
              else settle(entry.reported, { state: result.state, problem: result.problem });
              continue;
            }
            const task = take(entry, result).finally(() => running.delete(task));
            running.add(task);
            if (running.size >= compressions) await Promise.race(running);
          }
        } finally { await Promise.all(running); }
        // A photo the provider skipped, or one an abort left out.
        for (const entry of byId.values()) keep({ ...entry, held: entry.held && rendering === 'always' }, 'Preview unavailable: The source produced no preview.');
        // What changed during the first preview may have changed its size or titles too: it is observed again, so the
        // facts recorded with the next preview are the ones of its revision.
        if (changed.length && !signal.aborted) next.push(...await reobserved(provider, folder, changed, settle));
        else next.push(...changed);
      }
      pending = next;
    }
    for (const entry of pending) keep(entry, 'Preview unavailable: The preview was cancelled.');
  } catch (error) {
    for (const { reported } of wanted) if (!outcomes.has(reported.ref.id)) failed(reported, 'Preview unavailable: ' + (error instanceof Error ? error.message : String(error)));
  } finally { await rm(directory, { recursive: true, force: true }); }
  return outcomes;
}

/** Photos observed again before their preview is asked for once more; those that are no longer available say why. */
async function reobserved(provider: SourceProvider<Locator>, folder: string, pending: Wanted[], unavailable: (reported: Reported, outcome: ProvidedOutcome) => void) {
  let results: Observed[];
  try { results = await provider.observe(folder, pending.map(({ reported: { ref } }) => ref)); }
  catch (error) { results = pending.map(() => ({ state: 'unreadable', problem: 'Original unavailable: ' + (error instanceof Error ? error.message : String(error)) })); }
  return pending.flatMap((entry, index): Wanted[] => {
    const result = results[index], { reported } = entry;
    if (result?.state === 'available' && result.facts && usable({ facts: result.facts, revisions: result.revisions })) return [{ ...entry, reported: { ...reported, facts: result.facts, revisions: result.revisions } }];
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
  /** The photos no preview could be had of as they are now, with why; left out where there are none. */
  problems?: Map<string, PreviewFailure>;
};
/** How the open book shows a photo, for `providedChanges` to tell what is different now. */
export type ShownPhoto = { available: boolean; outOfDate?: boolean; pending?: boolean };
export type ProvidedChangeOptions = Omit<RefreshOptions, 'previews' | 'settled'> & {
  available: (id: string) => boolean; shown?: (id: string) => ShownPhoto;
  /** The changes known so far, as each preview comes, with how many there are to come. */
  progress?: (id: string, changes: ProvidedChanges, done: number, total: number) => void;
};
const shownDifferently = (outcome: ProvidedOutcome, before: ShownPhoto) => {
  if (outcome.state !== 'available') return before.available || !!before.pending;
  // A new preview, or new titles or capture data that templates and the Inspector show, are shown at once.
  return outcome.change === 'content' || !before.available || !!outcome.outOfDate !== !!before.outOfDate ||
    (outcome.change === 'metadata' && (!outcome.previous || visibleChange(outcome.previous, outcome.fact)));
};

/**
 * Handles a provider's `watch` report for photos without a file (ADR 0011, §3): observes them again, compares the
 * content revision with the stored one, makes a new preview only where it moved, and reloads only where the stored
 * preview is another one. A metadata edit records the new revisions and provided values without a preview or reload.
 * `available` tells which photos the open book shows as available.
 */
export async function providedChanges(folder: string, provider: SourceProvider<Locator>, refs: readonly SourceRef<Locator>[], facts: AssetFacts,
  { available, shown = (id) => ({ available: available(id) }), progress, ...options }: ProvidedChangeOptions): Promise<ProvidedChanges> {
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
  // Told as they were before anything here changed them: a reload meanwhile shows the photos that have come so far.
  const before = new Map(refs.map(({ id }) => [id, shown(id)]));
  const outcomes = await refreshProvided(folder, provider, known, observed, facts, { ...options, settled: (id, outcome, done, total) => {
    progress?.(id, changesOf([[id, outcome]], before), done, total);
  } });
  const all = changesOf(outcomes, before);
  changes.reload.push(...all.reload); changes.revised.push(...all.revised); changes.reshaped.push(...all.reshaped);
  return { ...changes, ...(all.problems ? { problems: all.problems } : {}) };
}

function changesOf(outcomes: Iterable<[string, ProvidedOutcome]>, shown: ReadonlyMap<string, ShownPhoto>): ProvidedChanges {
  const changes: ProvidedChanges = { reload: [], revised: [], reshaped: [] };
  for (const [id, outcome] of outcomes) {
    const before = shown.get(id)!;
    const problem = 'problem' in outcome ? outcome.problem : undefined;
    if (problem !== undefined) (changes.problems ??= new Map()).set(id, { state: outcome.state === 'pending' ? 'unreadable' : outcome.state, problem });
    if (shownDifferently(outcome, before)) changes.reload.push(id);
    if (outcome.state !== 'available') {
      if (before.available) changes.revised.push(id);
      continue;
    }
    if (outcome.change !== 'unchanged') changes.revised.push(id);
    if (outcome.change === 'content' && outcome.previous && aspectChanged(outcome.previous, outcome.fact)) changes.reshaped.push(id);
  }
  return changes;
}
