import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { gte, valid } from 'semver';
import type { LightroomLocator } from '../../src/source-locator';
import { sourceColors } from '../../src/source-properties';
import { within } from './files';
import { withPlaceOffset } from '../place-zones';
import type { PlaceZone } from '../place-zones';
import { LightroomOffline } from '../lightroom/bridge';
import type { LightroomBridge, LightroomConnection } from '../lightroom/bridge';
import { metadataResultSchema, parseResult, renderResultSchema, thumbnailsResultSchema, thumbnailsSince } from '../lightroom/protocol';
import type { PhotoRow, RenderState } from '../lightroom/protocol';
import type { Materialized, MaterializeOptions, Observed, PreviewOptions, Previewed, ProvidedFacts, Revisions, SourceProvider, SourceRef, Unavailable } from '../source-provider';

/**
 * Photos in a Lightroom Classic catalog (ADR 0011), read through the ImageFlow plugin over the loopback bridge. The
 * provider keeps no state of its own: the bridge holds the connection, and the host hands back the revisions it stored.
 *
 * - `revision` is the plugin's `lrRevision` (`uuid : lastEditTime : editCount : cropped size`): any change Lightroom
 *   records moves it, and a full-resolution render is valid for one revision only.
 * - `contentRevision` is the hash of `getDevelopSettings()`: it moves for visual edits, not for metadata edits, and keys
 *   previews. It costs an SDK call per photo, so the plugin reads it only for a photo whose revision moved since the one
 *   the host stored (`known`).
 * - Previews are the ones Lightroom keeps itself (`requestJpegThumbnail`: 25 ms per photo, against 0.2 to 0.4 s for a
 *   render), which it keys by the develop settings. While it has none, as of a photo just edited in Develop, the photo is
 *   deferred if it has an older picture and rendered if it has none (ADR 0011, §2). A plugin older than 1.1.0 renders all.
 * - A photo is `offline` while Lightroom is not running, the plugin is not connected or another catalog is open, and
 *   `missing` once it left the open catalog.
 */
export type LightroomPort = Pick<LightroomBridge, 'connection' | 'request' | 'track' | 'onChanges' | 'onConnection'>;

// One `LrExportSession` renders several photos in parallel but cannot be cancelled, so sessions are small and an abort
// takes effect between them (ADR 0011, §4.3; the spike measured 0.78 s per photo over a session).
const sessionSize = 5;
// A preview's session is larger: the more photos, the less each costs (0.32 s in sessions of 5, 0.26 s in 20, 0.19 s in
// 40, measured), and one that is no longer wanted costs a few seconds at most.
const previewSessionSize = 20;
// One thumbnails job asks for this many at once, about half a second's worth, so previews show as they come.
const thumbnailChunk = 24;
// One metadata job reads this many photos: about 35 µs each in Lightroom, and a bounded answer.
const metadataChunk = 500;

const offline = (problem: string) => ({ state: 'offline' as const, problem });
/** Why a photo cannot be reached now, or undefined when its catalog is the one open in a connected Lightroom. */
function unreachable(locator: LightroomLocator, connection: LightroomConnection | undefined) {
  if (!connection) return offline('Lightroom Classic is not running, or its ImageFlow plugin is not connected.');
  if (connection.catalog.id !== locator.catalog) return offline('Another Lightroom catalog is open' + (connection.catalog.name ? ' (' + connection.catalog.name + ')' : '') + '.');
}
const failure = (error: unknown): { state: Unavailable; problem: string } => error instanceof LightroomOffline
  ? offline(error.message) : { state: 'unreadable', problem: 'Original unavailable: ' + (error instanceof Error ? error.message : String(error)) };
const gone = { state: 'missing' as const, problem: 'No longer in the Lightroom catalog.' };
// UUIDs are compared without case: the plugin reports Lightroom's, the book may hold one written otherwise.
const uuidKey = (uuid: string) => uuid.toLowerCase();

/** Lightroom's ISO 8601 capture time, as ImageFlow's capture time: local wall clock, and its offset where it has one. */
export function captureTime(value: string | undefined): ProvidedFacts['captured'] {
  const match = value && /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)(?::(\d\d))?(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$/.exec(value.trim());
  if (!match) return undefined;
  const [, date, time, seconds = '00', zone] = match;
  const offset = !zone ? null : zone === 'Z' ? '+00:00' : zone.slice(0, 3) + ':' + zone.slice(-2);
  return { dateTime: date + 'T' + time + ':' + seconds, offset };
}

const nonEmpty = (value: string | undefined) => value?.trim() ? value : undefined;
const flags = { 1: 'pick', [-1]: 'reject' } as const;
/**
 * The marks of a photo as `extra` holds them (ADR 0014, section 2): a colour outside the five, as of a label set of the
 * user's own, is left out with its label. src/source-properties.ts drops a label that only repeats the colour's name.
 */
function lightroomMarks(row: PhotoRow) {
  const color = sourceColors.find((name) => name === row.colorNameForLabel), label = nonEmpty(row.label);
  return { ...(row.rating ? { rating: row.rating } : {}), ...(row.pickStatus ? { flag: flags[row.pickStatus] } : {}),
    ...(color ? { color, ...(label ? { colorLabel: label } : {}) } : {}) };
}
/** The facts of a photo as the plugin read them (ADR 0011, §1). */
export function lightroomFacts(row: PhotoRow): ProvidedFacts {
  const captured = captureTime(row.captured);
  const make = nonEmpty(row.cameraMake), model = nonEmpty(row.cameraModel);
  // Lightroom's copyright is the credit, its creator when there is none.
  const provided = Object.fromEntries(Object.entries({ title: nonEmpty(row.title), caption: nonEmpty(row.caption), credit: nonEmpty(row.copyright) ?? nonEmpty(row.creator),
    altText: nonEmpty(row.altText) }).filter(([, value]) => value !== undefined)) as ProvidedFacts['provided'] & {};
  return {
    width: row.width, height: row.height,
    ...(captured ? { captured } : {}),
    ...(row.gps ? { location: row.gps } : {}),
    ...(make || model ? { camera: { ...(make ? { make } : {}), ...(model ? { model } : {}) } } : {}),
    ...(Object.keys(provided).length ? { provided } : {}),
    extra: { ...(row.orientation ? { orientation: row.orientation } : {}), ...(row.fileName ? { fileName: row.fileName } : {}), ...lightroomMarks(row) },
  };
}

// The develop hash read now, else the one stored while the revision is the same: the plugin skips reading it then.
function revisionsOf(row: Pick<PhotoRow, 'revision' | 'developHash'>, known: Revisions | undefined): Revisions {
  const contentRevision = row.developHash ?? (known?.revision === row.revision ? known.contentRevision : undefined);
  return { revision: row.revision, ...(contentRevision ? { contentRevision } : {}) };
}
const rendered = (state: RenderState): Revisions => ({ revision: state.revision, ...(state.developHash ? { contentRevision: state.developHash } : {}) });

/** A file the plugin says it wrote, if it is a regular file inside the folder ImageFlow named for it. */
async function writtenFile(folder: string, file: string) {
  if (!isAbsolute(file)) return undefined;
  try {
    // The folder is a real path (mkdtemp under a real path); a link anywhere in the file's path resolves outside it.
    const actual = await realpath(file);
    const info = await lstat(actual);
    return within(folder, actual) && info.isFile() ? actual : undefined;
  } catch { return undefined; }
}

type Answer = { made: Map<string, { file: string; before: RenderState; after: RenderState }>; missing: Set<string>; failed: Map<string, string> };
type Batch = { refs: readonly SourceRef<LightroomLocator>[]; down: Map<string, { state: Unavailable; problem: string } | undefined>; folder: string;
  answer?: Answer; failure?: { state: Unavailable; problem: string } };

/** Runs one job for a batch of photos. Never rejects: a failure of the job is each photo's. */
async function runBatch(bridge: LightroomPort, refs: readonly SourceRef<LightroomLocator>[], staging: string,
  job: (reachable: readonly SourceRef<LightroomLocator>[], folder: string) => Promise<Answer>): Promise<Batch> {
  // Each photo is checked by itself: one of another catalog does not stop the others of its batch.
  const connection = bridge.connection;
  const down = new Map(refs.map(({ id, locator }) => [id, unreachable(locator, connection)]));
  const reachable = refs.filter(({ id }) => !down.get(id));
  if (!reachable.length) return { refs, down, folder: '' };
  try {
    // A folder of its own per job, inside the host's staging folder: what the plugin names must be in it.
    const folder = await mkdtemp(join(await realpath(staging), 'lightroom-'));
    try { return { refs, down, folder, answer: await job(reachable, folder) }; }
    catch (error) { return { refs, down, folder, failure: failure(error) }; }
  } catch (error) { return { refs, down, folder: '', failure: failure(error) }; }
}

/** The batches' results in order. `ahead` starts the next one while the host takes this one's files. */
async function* batches(all: readonly SourceRef<LightroomLocator>[], size: number, signal: AbortSignal, ahead: boolean,
  run: (refs: readonly SourceRef<LightroomLocator>[]) => Promise<Batch>): AsyncGenerator<Batch> {
  let next: Promise<Batch> | undefined;
  for (let start = 0; start < all.length; start += size) {
    // Between jobs only: a job cannot be stopped once Lightroom has it, and its files land in the staging folder.
    if (signal.aborted) return;
    const batch = await (next ?? run(all.slice(start, start + size)));
    next = ahead && start + size < all.length && !signal.aborted ? run(all.slice(start + size, start + 2 * size)) : undefined;
    yield batch;
  }
}

async function* results(batch: Batch, absent: string): AsyncGenerator<Materialized> {
  for (const { id, locator } of batch.refs) {
    const unavailable = batch.down.get(id) ?? batch.failure;
    if (unavailable) { yield { id, ...unavailable }; continue; }
    const { made: files, missing, failed } = batch.answer!;
    const key = uuidKey(locator.uuid);
    const made = files.get(key);
    if (!made) {
      yield missing.has(key) ? { id, ...gone } : { id, state: 'unreadable', problem: 'Original unavailable: ' + (failed.get(key) ?? absent) };
      continue;
    }
    const file = await writtenFile(batch.folder, made.file);
    if (!file) { yield { id, state: 'unreadable', problem: 'Original unavailable: The Lightroom plugin wrote its picture outside the folder ImageFlow named.' }; continue; }
    yield { id, file, before: rendered(made.before), after: rendered(made.after) };
  }
}

async function* render(bridge: LightroomPort, refs: readonly SourceRef<LightroomLocator>[], size: 'preview' | 'full', { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
  const run = (batch: readonly SourceRef<LightroomLocator>[]) => runBatch(bridge, batch, staging, async (reachable, folder) => {
    const answer = parseResult(renderResultSchema, await bridge.request('render', { uuids: reachable.map(({ locator }) => locator.uuid), size, folder },
      // Full-resolution renders take about 1.5 s each, and Lightroom may be busy with the user's own export.
      { timeout: 60_000 + reachable.length * (size === 'full' ? 30_000 : 10_000) }), 'render');
    return { made: new Map(answer.renders.map(({ uuid, ...made }) => [uuidKey(uuid), made])), missing: new Set((answer.missing ?? []).map(uuidKey)),
      failed: new Map((answer.failed ?? []).map(({ uuid, error }) => [uuidKey(uuid), error])) };
  });
  for await (const batch of batches(refs, size === 'full' ? sessionSize : previewSessionSize, signal, size === 'preview', run)) {
    yield* results(batch, 'Lightroom Classic rendered nothing for this photo.');
  }
}

const keepsThumbnails = (connection: LightroomConnection | undefined) => {
  const version = connection && valid(connection.plugin.version);
  return !!version && gte(version, thumbnailsSince);
};

async function* preview(bridge: LightroomPort, refs: readonly SourceRef<LightroomLocator>[], options: PreviewOptions): AsyncGenerator<Previewed> {
  const { staging, signal, rendering = 'fallback' } = options;
  if (rendering === 'always' || !keepsThumbnails(bridge.connection)) { yield* render(bridge, refs, 'preview', options); return; }
  const refused: SourceRef<LightroomLocator>[] = [];
  const run = (batch: readonly SourceRef<LightroomLocator>[]) => runBatch(bridge, batch, staging, async (reachable, folder) => {
    const answer = parseResult(thumbnailsResultSchema, await bridge.request('thumbnails',
      { photos: reachable.map(({ locator, known }) => ({ uuid: locator.uuid, ...(known?.contentRevision ? { known: known.revision } : {}) })), folder }, { timeout: 180_000 }), 'thumbnails');
    const knownOf = new Map(reachable.map(({ locator, known }) => [uuidKey(locator.uuid), known]));
    const made = new Map(answer.thumbnails.map(({ uuid, file, before, after }) => {
      // The develop hash comes with another revision than the one named; for that one it is the one named with it.
      const known = knownOf.get(uuidKey(uuid));
      const state = ({ revision, developHash = known?.revision === revision ? known.contentRevision : undefined }: RenderState): RenderState =>
        ({ revision, ...(developHash ? { developHash } : {}) });
      const now = state(after);
      return [uuidKey(uuid), { file, before: before.revision === after.revision ? now : state(before), after: now }] as const;
    }));
    return { made, missing: new Set((answer.missing ?? []).map(uuidKey)), failed: new Map((answer.refused ?? []).map(({ uuid, error }) => [uuidKey(uuid), error])) };
  });
  for await (const batch of batches(refs, thumbnailChunk, signal, true, run)) {
    // Refused by Lightroom, or the whole job failed without Lightroom being gone: a render may still work.
    const turned = new Set(batch.refs.filter(({ id, locator }) => !batch.down.get(id) &&
      (batch.answer ? batch.answer.failed.has(uuidKey(locator.uuid)) : batch.failure?.state === 'unreadable')));
    for (const ref of turned) {
      if (rendering === 'never') yield { id: ref.id, deferred: true };
      else refused.push(ref);
    }
    for await (const result of results({ ...batch, refs: batch.refs.filter((ref) => !turned.has(ref)) }, 'Lightroom Classic has no preview of this photo.')) {
      yield 'file' in result ? { ...result, kept: true } : result;
    }
  }
  if (refused.length) yield* render(bridge, refused, 'preview', options);
}

/** The Lightroom Classic provider over a bridge (desktop/lightroom/bridge.ts). */
/**
 * `placeZone` looks up the time zone of a place, for a capture time without an offset of its own (a drone's; API-020):
 * the Photos addon's geocoder by default.
 */
export function lightroomProvider(bridge: LightroomPort, { placeZone }: { placeZone?: PlaceZone } = {}): SourceProvider<LightroomLocator> {
  // The catalog each book last observed its photos with (null: none connected). A watch starts from it, not from the
  // connection when the watch starts: a book that loaded just before Lightroom connected has its photos offline, and
  // the plugin connecting before its watch started must still bring them back.
  const observedWith = new Map<string, string>();
  // The develop hash last read of each photo, with its revision: a photo whose preview the host does not have yet is
  // observed again with every load, and the plugin reads a hash once per revision.
  const hashes = new Map<string, Revisions>();
  const catalogKey = () => JSON.stringify(bridge.connection?.catalog.id ?? null);
  return {
    provider: 'lightroom',
    async observe(book, refs, { signal } = {}) {
      const connection = bridge.connection;
      observedWith.set(book, catalogKey());
      const results: (Observed | undefined)[] = refs.map(({ locator }) => unreachable(locator, connection));
      // Only photos of the open catalog are asked for: a UUID means nothing in another one.
      const open = refs.flatMap((ref, index) => results[index] ? [] : [{ ref, index }]);
      const hashKey = ({ catalog, uuid }: LightroomLocator) => catalog + ':' + uuidKey(uuid);
      // Without a stored develop hash there is nothing to compare: the plugin then reads it.
      const known = ({ locator, known: stored }: SourceRef<LightroomLocator>) => stored?.contentRevision ? stored : hashes.get(hashKey(locator));
      for (let start = 0; start < open.length; start += metadataChunk) {
        const chunk = open.slice(start, start + metadataChunk);
        try {
          const answer = parseResult(metadataResultSchema, await bridge.request('metadata', { photos: chunk.map(({ ref }) => {
            const revision = known(ref)?.revision;
            return { uuid: ref.locator.uuid, ...(revision ? { known: revision } : {}) };
          }) }, { timeout: 60_000, signal }), 'metadata');
          const rows = new Map(answer.photos.map((row) => [uuidKey(row.uuid), row]));
          for (const { ref, index } of chunk) {
            const row = rows.get(uuidKey(ref.locator.uuid));
            if (!row) { results[index] = gone; continue; }
            const revisions = revisionsOf(row, known(ref));
            if (revisions.contentRevision) hashes.set(hashKey(ref.locator), revisions);
            results[index] = { state: 'available', revisions, facts: await withPlaceOffset(lightroomFacts(row), placeZone) };
          }
        } catch (error) { for (const { index } of chunk) results[index] = failure(error); }
      }
      return results as Observed[];
    },
    preview: (_book, refs, options) => preview(bridge, refs, options),
    materialize: (_book, refs, options) => render(bridge, refs, 'full', options),
    watch(book, refs, changed) {
      const ids = new Map<string, string[]>();
      for (const { id, locator } of refs) ids.set(uuidKey(locator.uuid), [...ids.get(uuidKey(locator.uuid)) ?? [], id]);
      const owner = {};
      // A connection that comes, goes or opens another catalog changes every photo's state: all are observed again, so
      // photos come back as available when Lightroom reconnects.
      let seen = observedWith.get(book) ?? catalogKey();
      // Lightroom connected, quit or switched catalogs between the book's last look and this watch: look again now.
      let pending: NodeJS.Immediate | undefined;
      if (seen !== catalogKey()) { seen = catalogKey(); pending = setImmediate(() => changed(refs.map(({ id }) => id))); }
      const stops = [
        bridge.track(owner, [...new Set(refs.map(({ locator }) => locator.uuid))]),
        bridge.onChanges((uuids) => { const moved = [...new Set(uuids.flatMap((uuid) => ids.get(uuidKey(uuid)) ?? []))]; if (moved.length) changed(moved); }),
        bridge.onConnection(() => {
          const now = catalogKey();
          if (now === seen) return;
          seen = now;
          changed(refs.map(({ id }) => id));
        }),
      ];
      return () => { if (pending) clearImmediate(pending); stops.forEach((stop) => stop()); };
    },
    // Retry is always offered; an offline photo can also have Lightroom launched for it. A missing one cannot be helped.
    repairs: (state) => state === 'offline' ? ['launch'] : [],
  };
}
