// The provider contract checked on paper against three providers (ADR 0011, Source providers): `local`, which moves
// today's file behaviour behind it, Lightroom Classic and Immich. Type-checked with the app (`tsc --noEmit`), never
// run and never bundled. Each provider's own API is only declared here, in the shape its real one has, so that the
// mapping onto the contract is real code. The real providers replace these sketches one by one.
import { localLocator } from '../src/source-locator';
import type { Locator, LocatorKind, LocalLocator } from '../src/source-locator';
import type { Materialized, Observed, ProvidedFacts, Revisions, SourceProvider, SourceRef, Unavailable } from '../desktop/source-provider';

const unavailable = (state: Unavailable, problem: string): Observed => ({ state, problem });
const iso = (ms: number) => new Date(ms).toISOString();

// --- local: files, read in place -------------------------------------------------------------------------------------
// Declared from desktop/source-store.ts and desktop/source-access.ts as they are today.
declare const files: {
  /** `originalPath`: approval, realpath and containment. Throws SourceAccessError or an errno error. */
  original(book: string, id: string, locator: LocalLocator): Promise<string>;
  /** `stat` with `fileStamp`: `ino:size:mtimeNs:ctimeNs`. */
  stat(path: string): Promise<{ stamp: string; size: number; mtimeMs: number; file: boolean }>;
  clone(from: string, to: string): Promise<void>;
  /** The state an error of `original` or `stat` stands for (the catch block of `SourceStore.resolve`). */
  failure(error: unknown, locator: LocalLocator): { state: Unavailable; problem: string };
  /** The linked-folder poll and directory watches of `DocumentSession.watchLinkedSources`. */
  watchFiles(paths: string[], changed: (path: string) => void): () => void;
};
const linkedLimit = 50 * 1024 * 1024;
async function observeFile(book: string, { id, locator }: SourceRef<LocalLocator>): Promise<Observed & { file?: string }> {
  try {
    const file = await files.original(book, id, locator);
    const info = await files.stat(file);
    if (!info.file || (locator.linked && info.size > linkedLimit)) return unavailable('unreadable', 'Original unavailable: Expected a regular file up to 50 MB.');
    // One token: a file has no cheaper sign that only its metadata changed.
    return { state: 'available', revisions: { revision: info.stamp }, modified: iso(info.mtimeMs), file };
  } catch (error) { return files.failure(error, locator); }
}
export const local: SourceProvider<LocalLocator> = {
  provider: 'local',
  observe: (book, refs) => Promise.all(refs.map((ref) => observeFile(book, ref))),
  // No `preview`: the host derives it from the file.
  async *materialize(book, refs, { staging, signal }) {
    for (const ref of refs) {
      if (signal.aborted) return;
      const before = await observeFile(book, ref);
      if (before.state !== 'available' || !before.file) { yield { id: ref.id, ...(before as { state: Unavailable; problem: string }) }; continue; }
      const file = staging + '/' + ref.id;
      await files.clone(before.file, file);
      // The same check as today's 'Source changed while being read': the path still resolves to the same file and stamp.
      const after = await observeFile(book, ref);
      yield { id: ref.id, file, before: before.revisions, after: after.state === 'available' ? after.revisions : { revision: '' } };
    }
  },
  // Owned photos are not watched here: the book folder is the host's, and its own watcher covers `photos/`.
  watch(_book, refs, changed) {
    const linked = refs.filter(({ locator }) => locator.linked);
    return files.watchFiles(linked.map(({ locator }) => locator.path), (path) => changed(linked.filter(({ locator }) => locator.path === path).map(({ id }) => id)));
  },
  repairs: (state) => state === 'offline' || state === 'needs-sign-in' ? [] : ['locate', 'locate-folder'],
};

// --- Lightroom Classic: a catalog behind the companion plugin --------------------------------------------------------
type LightroomLocator = { provider: 'lightroom'; catalog: string; uuid: string; name?: string };
export const lightroomLocator: LocatorKind<LightroomLocator> = {
  provider: 'lightroom',
  fields: ['lightroom'],
  read: (entry) => {
    const value = entry.lightroom as Partial<LightroomLocator> | undefined;
    return typeof value?.catalog === 'string' && typeof value.uuid === 'string' ? { provider: 'lightroom', catalog: value.catalog, uuid: value.uuid, ...(value.name ? { name: value.name } : {}) } : undefined;
  },
  write: ({ provider: _provider, ...lightroom }) => ({ lightroom }),
  // The catalog identity is portable (the catalog's path is not, and stays in local settings); the name is a hint.
  portable: ({ catalog, uuid }) => ({ lightroom: { catalog, uuid } }),
  shared: (locator) => locator,
  adopt: (shared) => shared,
  key: ({ catalog, uuid }) => catalog + ':' + uuid,
  name: ({ name }) => name,
  owned: () => false,
};
// Declared from the plugin bridge of ADR 0011, section 5, and the SDK calls its spike measured.
type LightroomRaw = { uuid: string; lastEditTime: number; editCount: number; croppedDimensions: { width: number; height: number }; dateTimeOriginal?: string;
  gps?: { latitude: number; longitude: number }; cameraMake?: string; cameraModel?: string; title?: string; caption?: string; copyright?: string };
declare const plugin: {
  /** Undefined while the plugin is not connected. */
  catalog(): string | undefined;
  /** One `batchGetRawMetadata` and `getFormattedMetadata`; a UUID the catalog does not hold is left out. */
  metadata(uuids: string[]): Promise<Map<string, LightroomRaw>>;
  /** The hash of `getDevelopSettings()`, one SDK call per photo. */
  developHash(uuid: string): Promise<string>;
  /** One `LrExportSession` of a few photos: the revision is read before and after each render. */
  render(uuids: string[], size: 1400 | 'full', folder: string): Promise<{ uuid: string; file: string; before: LightroomRaw; after: LightroomRaw }[]>;
  onRevisions(uuids: string[], changed: (uuids: string[]) => void): () => void;
  onConnection(changed: () => void): () => void;
};
const lrRevision = (raw: LightroomRaw) => [raw.uuid, raw.lastEditTime, raw.editCount, raw.croppedDimensions.width + 'x' + raw.croppedDimensions.height].join(':');
const lightroomFacts = (raw: LightroomRaw): ProvidedFacts => ({
  ...raw.croppedDimensions,
  ...(raw.dateTimeOriginal ? { captured: { dateTime: raw.dateTimeOriginal, offset: null } } : {}),
  ...(raw.gps ? { location: raw.gps } : {}),
  ...(raw.cameraMake || raw.cameraModel ? { camera: { make: raw.cameraMake, model: raw.cameraModel } } : {}),
  provided: { title: raw.title, caption: raw.caption, credit: raw.copyright },
});
// The develop hash costs an SDK call, so it is read only for a photo whose revision moved: this is what `known` is for.
async function lightroomRevisions(raw: LightroomRaw, known?: Revisions): Promise<Revisions> {
  const revision = lrRevision(raw);
  return { revision, contentRevision: known?.revision === revision && known.contentRevision ? known.contentRevision : await plugin.developHash(raw.uuid) };
}
const lightroomUnreachable = (locator: LightroomLocator): Observed | undefined => {
  const open = plugin.catalog();
  return !open ? unavailable('offline', 'Lightroom Classic is not running') : open !== locator.catalog ? unavailable('offline', 'Another Lightroom catalog is open') : undefined;
};
export const lightroom: SourceProvider<LightroomLocator> = {
  provider: 'lightroom',
  async observe(_book, refs) {
    const raws = plugin.catalog() ? await plugin.metadata(refs.map(({ locator }) => locator.uuid)) : new Map<string, LightroomRaw>();
    return Promise.all(refs.map(async ({ locator, known }) => {
      const raw = raws.get(locator.uuid);
      return lightroomUnreachable(locator) ?? (raw ? { state: 'available' as const, revisions: await lightroomRevisions(raw, known), facts: lightroomFacts(raw) }
        : unavailable('missing', 'No longer in the Lightroom catalog'));
    }));
  },
  async preview(_book, ref, { staging }) {
    const down = lightroomUnreachable(ref.locator);
    if (down && down.state !== 'available') return { id: ref.id, state: down.state, problem: down.problem };
    const [render] = await plugin.render([ref.locator.uuid], 1400, staging);
    return { id: ref.id, file: render.file, before: await lightroomRevisions(render.before, ref.known), after: await lightroomRevisions(render.after) };
  },
  async *materialize(_book, refs, { staging, signal }) {
    // A session cannot be cancelled, so sessions are small and cancelling takes effect between them.
    for (let i = 0; i < refs.length && !signal.aborted; i += 5) {
      const batch = refs.slice(i, i + 5);
      const down = batch.map(({ locator }) => lightroomUnreachable(locator)).find((state) => state && state.state !== 'available');
      if (down && down.state !== 'available') { for (const { id } of batch) yield { id, state: down.state, problem: down.problem }; continue; }
      const renders = await plugin.render(batch.map(({ locator }) => locator.uuid), 'full', staging);
      for (const { id, locator } of batch) {
        const render = renders.find(({ uuid }) => uuid === locator.uuid);
        // Print keys on `revision` alone, so the develop hash is not read for a full-resolution render.
        yield render ? { id, file: render.file, before: { revision: lrRevision(render.before) }, after: { revision: lrRevision(render.after) } }
          : { id, state: 'missing', problem: 'No longer in the Lightroom catalog' } satisfies Materialized;
      }
    }
  },
  watch(_book, refs, changed) {
    const ids = (uuids: string[]) => refs.filter(({ locator }) => uuids.includes(locator.uuid)).map(({ id }) => id);
    const stops = [plugin.onRevisions(refs.map(({ locator }) => locator.uuid), (uuids) => changed(ids(uuids))),
      plugin.onConnection(() => changed(refs.map(({ id }) => id)))];
    return () => stops.forEach((stop) => stop());
  },
  repairs: (state) => state === 'offline' ? ['launch'] : [],
};

// --- Immich: a server with originals and previews (on paper only; its API is declared from memory, not verified) -----
type ImmichLocator = { provider: 'immich'; server: string; asset: string; name?: string };
export const immichLocator: LocatorKind<ImmichLocator> = {
  provider: 'immich',
  fields: ['immich'],
  read: (entry) => {
    const value = entry.immich as Partial<ImmichLocator> | undefined;
    return typeof value?.server === 'string' && typeof value.asset === 'string' ? { provider: 'immich', server: value.server, asset: value.asset, ...(value.name ? { name: value.name } : {}) } : undefined;
  },
  write: ({ provider: _provider, ...immich }) => ({ immich }),
  // `server` names the server in the book; its URL and API key are local settings, like a catalog's path.
  portable: ({ server, asset }) => ({ immich: { server, asset } }),
  shared: (locator) => locator,
  adopt: (shared) => shared,
  key: ({ server, asset }) => server + ':' + asset,
  name: ({ name }) => name,
  owned: () => false,
};
type ImmichAsset = { id: string; checksum: string; updatedAt: string; isTrashed: boolean; fileModifiedAt: string;
  exifInfo?: { exifImageWidth?: number; exifImageHeight?: number; orientation?: string; dateTimeOriginal?: string; timeZone?: string;
    latitude?: number; longitude?: number; make?: string; model?: string; description?: string } };
declare const immich: {
  /** `GET /api/assets/{id}`. Rejects with the HTTP status, or without one when the server cannot be reached. */
  asset(server: string, id: string): Promise<ImmichAsset>;
  /** `GET /api/assets/{id}/thumbnail?size=preview` or `/original`, streamed to a file. */
  download(server: string, id: string, what: 'preview' | 'original', file: string, signal: AbortSignal): Promise<void>;
  /** The `on_asset_update` and `on_asset_trash` events of the server's websocket, or a poll. */
  onAssets(server: string, changed: (ids: string[]) => void): () => void;
};
// The bytes have a checksum; a changed description moves `updatedAt` only.
const immichRevisions = (asset: ImmichAsset): Revisions => ({ revision: asset.checksum + ':' + asset.updatedAt, contentRevision: asset.checksum });
async function observeAsset({ locator }: SourceRef<ImmichLocator>): Promise<Observed & { revisions?: Revisions }> {
  try {
    const asset = await immich.asset(locator.server, locator.asset);
    const exif = asset.exifInfo;
    if (asset.isTrashed) return unavailable('missing', 'In the Immich trash');
    if (!exif?.exifImageWidth || !exif.exifImageHeight) return unavailable('unreadable', 'Immich has not read this photo yet');
    // EXIF orientations 5 to 8 turn the image, as in photoDetails.
    const turned = Number(exif.orientation ?? 1) >= 5;
    return { state: 'available', revisions: immichRevisions(asset), modified: asset.fileModifiedAt, facts: {
      width: turned ? exif.exifImageHeight : exif.exifImageWidth, height: turned ? exif.exifImageWidth : exif.exifImageHeight,
      ...(exif.dateTimeOriginal ? { captured: { dateTime: exif.dateTimeOriginal.slice(0, 19), offset: null } } : {}),
      ...(exif.latitude !== undefined && exif.longitude !== undefined ? { location: { latitude: exif.latitude, longitude: exif.longitude } } : {}),
      ...(exif.make || exif.model ? { camera: { make: exif.make, model: exif.model } } : {}),
      provided: { caption: exif.description },
    } };
  } catch (error) {
    const status = (error as { status?: number }).status;
    return status === 401 || status === 403 ? unavailable('needs-sign-in', 'Sign in to Immich') : status === 404 || status === 400 ? unavailable('missing', 'No longer in Immich')
      : unavailable('offline', 'The Immich server cannot be reached');
  }
}
async function fetchAsset(ref: SourceRef<ImmichLocator>, what: 'preview' | 'original', staging: string, signal: AbortSignal): Promise<Materialized> {
  const before = await observeAsset(ref);
  if (before.state !== 'available') return { id: ref.id, state: before.state, problem: before.problem };
  const file = staging + '/' + ref.id;
  await immich.download(ref.locator.server, ref.locator.asset, what, file, signal);
  const after = await observeAsset(ref);
  return { id: ref.id, file, before: before.revisions, after: after.state === 'available' ? after.revisions : { revision: '' } };
}
export const immichProvider: SourceProvider<ImmichLocator> = {
  provider: 'immich',
  observe: (_book, refs) => Promise.all(refs.map(observeAsset)),
  preview: (_book, ref, { staging, signal }) => fetchAsset(ref, 'preview', staging, signal),
  async *materialize(_book, refs, { staging, signal }) {
    for (const ref of refs) { if (signal.aborted) return; yield await fetchAsset(ref, 'original', staging, signal); }
  },
  watch(_book, refs, changed) {
    const stops = [...new Set(refs.map(({ locator }) => locator.server))].map((server) =>
      immich.onAssets(server, (assets) => changed(refs.filter(({ locator }) => locator.server === server && assets.includes(locator.asset)).map(({ id }) => id))));
    return () => stops.forEach((stop) => stop());
  },
  repairs: (state) => state === 'needs-sign-in' ? ['sign-in'] : [],
};

// Every provider is held to the same contract, whatever its locator.
type Fits<L extends Locator> = { kind: LocatorKind<L>; provider: SourceProvider<L> };
export const fits = [{ kind: localLocator, provider: local } satisfies Fits<LocalLocator>,
  { kind: lightroomLocator, provider: lightroom } satisfies Fits<LightroomLocator>, { kind: immichLocator, provider: immichProvider } satisfies Fits<ImmichLocator>];
