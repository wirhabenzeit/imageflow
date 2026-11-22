// The provider contract checked on paper against four providers (ADR 0011, Source providers): `package` and `linked`,
// which move today's file behaviour behind it, Lightroom Classic and Immich. Type-checked with the app (`tsc --noEmit`), never
// run and never bundled. Each provider's own API is only declared here, in the shape its real one has, so that the
// mapping onto the contract is real code. The real providers replace these sketches one by one.
import { linkedLocator, packageLocator } from '../src/source-locator';
import type { LinkedLocator, Locator, LocatorKind, PackageLocator } from '../src/source-locator';
import type { Materialized, MaterializeOptions, Observed, ProvidedFacts, Revisions, SourceProvider, SourceRef, Unavailable } from '../desktop/source-provider';

const unavailable = (state: Unavailable, problem: string): Observed => ({ state, problem });
const iso = (ms: number) => new Date(ms).toISOString();

// --- package and linked: files, read in place -------------------------------------------------------------------
// Declared from desktop/source-store.ts and desktop/source-access.ts as they are today. Both providers read a file
// the same way; these helpers are also what texts and files keep using.
type FileLocator = PackageLocator | LinkedLocator;
declare const files: {
  /** The package branch of `originalPath`: inside `photos/`, also after symlinks are resolved. Throws an errno error. */
  inPackage(book: string, path: string): Promise<string>;
  /** The linked branch of `originalPath`: approved, absolute, its own realpath, outside the book. Throws SourceAccessError too. */
  approved(book: string, id: string, path: string): Promise<string>;
  /** `stat` with `fileStamp`: `ino:size:mtimeNs:ctimeNs`. */
  stat(path: string): Promise<{ stamp: string; size: number; mtimeMs: number; file: boolean }>;
  clone(from: string, to: string): Promise<void>;
  /** The state an error of the above stands for (the catch block of `SourceStore.resolve`). */
  failure(error: unknown, locator: FileLocator): { state: Unavailable; problem: string };
  /** The linked-folder poll and directory watches of `DocumentSession.watchLinkedSources`. */
  watchFiles(paths: string[], changed: (path: string) => void): () => void;
};
type FileObserved = Observed & { file?: string };
async function observeFile(locator: FileLocator, original: () => Promise<string>, limit?: number): Promise<FileObserved> {
  try {
    const file = await original();
    const info = await files.stat(file);
    if (!info.file || (limit && info.size > limit)) return unavailable('unreadable', 'Original unavailable: Expected a regular file' + (limit ? ' up to 50 MB.' : '.'));
    // One token: a file has no cheaper sign that only its metadata changed.
    return { state: 'available', revisions: { revision: info.stamp }, modified: iso(info.mtimeMs), file };
  } catch (error) { return files.failure(error, locator); }
}
// An export reads every photo from a private copy. The same check as today's 'Source changed while being read': the
// path still resolves to the same file with the same stamp after the copy.
async function* cloneFiles<L extends FileLocator>(refs: readonly SourceRef<L>[], observe: (ref: SourceRef<L>) => Promise<FileObserved>,
  { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
  for (const ref of refs) {
    if (signal.aborted) return;
    const before = await observe(ref);
    if (before.state !== 'available') { yield { id: ref.id, state: before.state, problem: before.problem }; continue; }
    const file = staging + '/' + ref.id;
    // A file that goes missing or unreadable between the two is this photo's failure, not the export's.
    const failed = await files.clone(before.file!, file).then(() => undefined, (error) => files.failure(error, ref.locator));
    const after = failed ?? await observe(ref);
    yield after.state === 'available' ? { id: ref.id, file, before: before.revisions, after: after.revisions } : { id: ref.id, state: after.state, problem: after.problem };
  }
}
const fileRepairs = (state: Unavailable) => state === 'offline' || state === 'needs-sign-in' ? [] : ['locate', 'locate-folder'] as const;

// The book package: the host's own storage. It needs no approval, has no size limit and is never offline.
const observeOwned = (book: string) => ({ locator }: SourceRef<PackageLocator>) => observeFile(locator, () => files.inPackage(book, locator.path));
export const packageProvider: SourceProvider<PackageLocator> = {
  provider: 'package',
  observe: (book, refs) => Promise.all(refs.map(observeOwned(book))),
  // No `preview`: the host derives it from the file.
  materialize: (book, refs, options) => cloneFiles(refs, observeOwned(book), options),
  // The book folder is the host's, and its own watcher covers `photos/`.
  watch: () => () => {},
  repairs: fileRepairs,
};

// A file somewhere else on this Mac: approved per path, limited in size, and watched where it is.
const observeLinked = (book: string) => ({ id, locator }: SourceRef<LinkedLocator>) => observeFile(locator, () => files.approved(book, id, locator.path), 50 * 1024 * 1024);
export const linked: SourceProvider<LinkedLocator> = {
  provider: 'linked',
  observe: (book, refs) => Promise.all(refs.map(observeLinked(book))),
  materialize: (book, refs, options) => cloneFiles(refs, observeLinked(book), options),
  watch: (_book, refs, changed) => files.watchFiles(refs.map(({ locator }) => locator.path),
    (path) => changed(refs.filter(({ locator }) => locator.path === path).map(({ id }) => id))),
  repairs: fileRepairs,
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
const lightroomUnreachable = (locator: LightroomLocator): { state: Unavailable; problem: string } | undefined => {
  const open = plugin.catalog();
  return !open ? { state: 'offline', problem: 'Lightroom Classic is not running' } : open !== locator.catalog ? { state: 'offline', problem: 'Another Lightroom catalog is open' } : undefined;
};
const gone = { state: 'missing', problem: 'No longer in the Lightroom catalog' } as const;
// One session renders several photos in parallel but cannot be cancelled, so sessions are small and cancelling takes
// effect between them. Previews and full-resolution renders share this.
async function* renderInLightroom(refs: readonly SourceRef<LightroomLocator>[], size: 1400 | 'full', { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
  for (let i = 0; i < refs.length && !signal.aborted; i += 5) {
    const batch = refs.slice(i, i + 5);
    // Each photo is checked by itself: one of another catalog does not stop the others of its session.
    const down = new Map(batch.map(({ id, locator }) => [id, lightroomUnreachable(locator)]));
    const reachable = batch.filter(({ id }) => !down.get(id));
    // A session that fails as a whole (the plugin disconnected) fails its photos, not the photos of other sessions.
    const renders = reachable.length ? await plugin.render(reachable.map(({ locator }) => locator.uuid), size, staging).catch(() => undefined) : [];
    for (const { id, locator, known } of batch) {
      const unreachable = down.get(id) ?? (renders ? undefined : lightroomUnreachable(locator) ?? { state: 'offline' as const, problem: 'Lightroom Classic stopped responding' });
      const render = renders?.find(({ uuid }) => uuid === locator.uuid);
      if (unreachable || !render) { yield { id, ...(unreachable ?? gone) }; continue; }
      // Print keys on `revision` alone, so the develop hash is read for previews only, and once when nothing moved.
      const before = size === 'full' ? { revision: lrRevision(render.before) } : await lightroomRevisions(render.before, known);
      yield { id, file: render.file, before, after: size === 'full' ? { revision: lrRevision(render.after) } : await lightroomRevisions(render.after, before) };
    }
  }
}
export const lightroom: SourceProvider<LightroomLocator> = {
  provider: 'lightroom',
  async observe(_book, refs) {
    // Only photos of the open catalog are asked for: a UUID means nothing in another one.
    const open = refs.filter(({ locator }) => !lightroomUnreachable(locator));
    const raws = open.length ? await plugin.metadata(open.map(({ locator }) => locator.uuid)) : new Map<string, LightroomRaw>();
    return Promise.all(refs.map(async ({ locator, known }): Promise<Observed> => {
      const raw = raws.get(locator.uuid);
      return lightroomUnreachable(locator) ?? (raw ? { state: 'available', revisions: await lightroomRevisions(raw, known), facts: lightroomFacts(raw) } : gone);
    }));
  },
  preview: (_book, refs, options) => renderInLightroom(refs, 1400, options),
  materialize: (_book, refs, options) => renderInLightroom(refs, 'full', options),
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
  } catch (error) { return immichFailure(error); }
}
const immichFailure = (error: unknown) => {
  const status = (error as { status?: number }).status;
  return status === 401 || status === 403 ? { state: 'needs-sign-in' as const, problem: 'Sign in to Immich' } : status === 404 || status === 400 ? { state: 'missing' as const, problem: 'No longer in Immich' }
    : { state: 'offline' as const, problem: 'The Immich server cannot be reached' };
};
async function* fetchAssets(refs: readonly SourceRef<ImmichLocator>[], what: 'preview' | 'original', { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
  for (const ref of refs) {
    if (signal.aborted) return;
    const before = await observeAsset(ref);
    if (before.state !== 'available') { yield { id: ref.id, state: before.state, problem: before.problem }; continue; }
    const file = staging + '/' + ref.id;
    const failed = await immich.download(ref.locator.server, ref.locator.asset, what, file, signal).then(() => undefined, immichFailure);
    // A download the host cancelled is not a result.
    if (signal.aborted) return;
    const after = failed ?? await observeAsset(ref);
    yield after.state === 'available' ? { id: ref.id, file, before: before.revisions, after: after.revisions } : { id: ref.id, state: after.state, problem: after.problem };
  }
}
export const immichProvider: SourceProvider<ImmichLocator> = {
  provider: 'immich',
  observe: (_book, refs) => Promise.all(refs.map(observeAsset)),
  preview: (_book, refs, options) => fetchAssets(refs, 'preview', options),
  materialize: (_book, refs, options) => fetchAssets(refs, 'original', options),
  watch(_book, refs, changed) {
    const stops = [...new Set(refs.map(({ locator }) => locator.server))].map((server) =>
      immich.onAssets(server, (assets) => changed(refs.filter(({ locator }) => locator.server === server && assets.includes(locator.asset)).map(({ id }) => id))));
    return () => stops.forEach((stop) => stop());
  },
  repairs: (state) => state === 'needs-sign-in' ? ['sign-in'] : [],
};

// Every provider is held to the same contract, whatever its locator.
type Fits<L extends Locator> = { kind: LocatorKind<L>; provider: SourceProvider<L> };
export const fits = [{ kind: packageLocator, provider: packageProvider } satisfies Fits<PackageLocator>, { kind: linkedLocator, provider: linked } satisfies Fits<LinkedLocator>,
  { kind: lightroomLocator, provider: lightroom } satisfies Fits<LightroomLocator>, { kind: immichLocator, provider: immichProvider } satisfies Fits<ImmichLocator>];
