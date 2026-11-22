import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LightroomLocator } from '../../src/source-locator';
import { within } from './files';
import { LightroomOffline } from '../lightroom/bridge';
import type { LightroomBridge, LightroomConnection } from '../lightroom/bridge';
import { metadataResultSchema, parseResult, renderResultSchema } from '../lightroom/protocol';
import type { PhotoRow, RenderState } from '../lightroom/protocol';
import type { Materialized, MaterializeOptions, Observed, ProvidedFacts, Revisions, SourceProvider, SourceRef, Unavailable } from '../source-provider';

/**
 * Photos in a Lightroom Classic catalog (ADR 0011), read through the ImageFlow plugin over the loopback bridge. The
 * provider keeps no state of its own: the bridge holds the connection, and the host hands back the revisions it stored.
 *
 * - `revision` is the plugin's `lrRevision` (`uuid : lastEditTime : editCount : cropped size`): any change Lightroom
 *   records moves it, and a full-resolution render is valid for one revision only.
 * - `contentRevision` is the hash of `getDevelopSettings()`: it moves for visual edits, not for metadata edits, and keys
 *   previews. It costs an SDK call per photo, so the plugin reads it only for a photo whose revision moved since the one
 *   the host stored (`known`).
 * - A photo is `offline` while Lightroom is not running, the plugin is not connected or another catalog is open, and
 *   `missing` once it left the open catalog.
 */
export type LightroomPort = Pick<LightroomBridge, 'connection' | 'request' | 'track' | 'onChanges' | 'onConnection'>;

// One `LrExportSession` renders several photos in parallel but cannot be cancelled, so sessions are small and an abort
// takes effect between them (ADR 0011, §4.3; the spike measured 0.78 s per photo over a session).
const sessionSize = 5;
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
    extra: { ...(row.orientation ? { orientation: row.orientation } : {}), ...(row.fileName ? { fileName: row.fileName } : {}) },
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

async function* render(bridge: LightroomPort, refs: readonly SourceRef<LightroomLocator>[], size: 'preview' | 'full', { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
  for (let start = 0; start < refs.length; start += sessionSize) {
    // Between sessions only: a session cannot be stopped once Lightroom has it, and its files land in the staging folder.
    if (signal.aborted) return;
    const batch = refs.slice(start, start + sessionSize);
    // Each photo is checked by itself: one of another catalog does not stop the others of its session.
    const connection = bridge.connection;
    const down = new Map(batch.map(({ id, locator }) => [id, unreachable(locator, connection)]));
    const reachable = batch.filter(({ id }) => !down.get(id));
    let result: { renders: Map<string, { file: string; before: RenderState; after: RenderState }>; missing: Set<string>; failed: Map<string, string> } | undefined;
    let failed: { state: Unavailable; problem: string } | undefined;
    // A folder of its own per session, inside the host's staging folder: what the plugin names must be in it.
    const folder = reachable.length ? await mkdtemp(join(await realpath(staging), 'lightroom-')) : '';
    if (reachable.length) {
      try {
        const answer = parseResult(renderResultSchema, await bridge.request('render', { uuids: reachable.map(({ locator }) => locator.uuid), size, folder },
          // Full-resolution renders take about 1.5 s each, and Lightroom may be busy with the user's own export.
          { timeout: 60_000 + reachable.length * (size === 'full' ? 30_000 : 10_000) }), 'render');
        result = { renders: new Map(answer.renders.map(({ uuid, ...render }) => [uuidKey(uuid), render])), missing: new Set((answer.missing ?? []).map(uuidKey)),
          failed: new Map((answer.failed ?? []).map(({ uuid, error }) => [uuidKey(uuid), error])) };
      } catch (error) { failed = failure(error); }
    }
    for (const { id, locator } of batch) {
      const unavailable = down.get(id) ?? failed;
      if (unavailable) { yield { id, ...unavailable }; continue; }
      const key = uuidKey(locator.uuid);
      const made = result!.renders.get(key);
      if (!made) {
        yield result!.missing.has(key) ? { id, ...gone } : { id, state: 'unreadable', problem: 'Original unavailable: ' + (result!.failed.get(key) ?? 'Lightroom Classic rendered nothing for this photo.') };
        continue;
      }
      const file = await writtenFile(folder, made.file);
      if (!file) { yield { id, state: 'unreadable', problem: 'Original unavailable: The Lightroom plugin wrote its render outside the folder ImageFlow named.' }; continue; }
      yield { id, file, before: rendered(made.before), after: rendered(made.after) };
    }
  }
}

/** The Lightroom Classic provider over a bridge (desktop/lightroom/bridge.ts). */
export function lightroomProvider(bridge: LightroomPort): SourceProvider<LightroomLocator> {
  return {
    provider: 'lightroom',
    async observe(_book, refs) {
      const connection = bridge.connection;
      const results: (Observed | undefined)[] = refs.map(({ locator }) => unreachable(locator, connection));
      // Only photos of the open catalog are asked for: a UUID means nothing in another one.
      const open = refs.flatMap((ref, index) => results[index] ? [] : [{ ref, index }]);
      for (let start = 0; start < open.length; start += metadataChunk) {
        const chunk = open.slice(start, start + metadataChunk);
        try {
          const answer = parseResult(metadataResultSchema, await bridge.request('metadata', { photos: chunk.map(({ ref: { locator, known } }) =>
            // Without a stored develop hash there is nothing to compare: the plugin then reads it.
            ({ uuid: locator.uuid, ...(known?.contentRevision ? { known: known.revision } : {}) })) }, { timeout: 60_000 }), 'metadata');
          const rows = new Map(answer.photos.map((row) => [uuidKey(row.uuid), row]));
          for (const { ref, index } of chunk) {
            const row = rows.get(uuidKey(ref.locator.uuid));
            results[index] = row ? { state: 'available', revisions: revisionsOf(row, ref.known), facts: lightroomFacts(row) } : gone;
          }
        } catch (error) { for (const { index } of chunk) results[index] = failure(error); }
      }
      return results as Observed[];
    },
    preview: (_book, refs, options) => render(bridge, refs, 'preview', options),
    materialize: (_book, refs, options) => render(bridge, refs, 'full', options),
    watch(_book, refs, changed) {
      const ids = new Map<string, string[]>();
      for (const { id, locator } of refs) ids.set(uuidKey(locator.uuid), [...ids.get(uuidKey(locator.uuid)) ?? [], id]);
      const owner = {};
      // A connection that comes, goes or opens another catalog changes every photo's state: all are observed again, so
      // photos come back as available when Lightroom reconnects.
      let seen = JSON.stringify(bridge.connection?.catalog.id ?? null);
      const stops = [
        bridge.track(owner, [...new Set(refs.map(({ locator }) => locator.uuid))]),
        bridge.onChanges((uuids) => { const moved = [...new Set(uuids.flatMap((uuid) => ids.get(uuidKey(uuid)) ?? []))]; if (moved.length) changed(moved); }),
        bridge.onConnection(() => {
          const now = JSON.stringify(bridge.connection?.catalog.id ?? null);
          if (now === seen) return;
          seen = now;
          changed(refs.map(({ id }) => id));
        }),
      ];
      return () => stops.forEach((stop) => stop());
    },
    // Retry is always offered; an offline photo can also have Lightroom launched for it. A missing one cannot be helped.
    repairs: (state) => state === 'offline' ? ['launch'] : [],
  };
}
