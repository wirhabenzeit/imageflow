// The provider contract checked on paper against a provider that does not exist yet (ADR 0011, Source providers):
// Immich. Type-checked with the app (`tsc --noEmit`), never run and never bundled. Its API is only declared here, in
// the shape its real one has, so that the mapping onto the contract is real code. The file providers and Lightroom
// Classic were sketched here too and are real now (desktop/providers/files.ts, desktop/providers/lightroom.ts); a real
// provider replaces its sketch.
import { lightroomLocator, linkedLocator, packageLocator } from '../src/source-locator';
import { linkedProvider, packageProvider } from '../desktop/providers/files';
import { lightroomProvider } from '../desktop/providers/lightroom';
import type { LightroomPort } from '../desktop/providers/lightroom';
import type { LightroomLocator, LinkedLocator, Locator, LocatorKind, PackageLocator } from '../src/source-locator';
import type { Materialized, MaterializeOptions, Observed, Revisions, SourceProvider, SourceRef, Unavailable } from '../desktop/source-provider';

const unavailable = (state: Unavailable, problem: string): Observed => ({ state, problem });
declare const bridge: LightroomPort;

// --- Immich: a server with originals and previews (on paper only; its API is declared from memory, not verified) -----
type ImmichLocator = { provider: 'immich'; server: string; asset: string; name?: string };
export const immichLocator: LocatorKind<ImmichLocator> = {
  provider: 'immich',
  // Every Mac reads the server itself: the locator syncs whole, the original never (ADR 0012).
  reach: 'online',
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
export const fits = [{ kind: packageLocator, provider: packageProvider } satisfies Fits<PackageLocator>, { kind: linkedLocator, provider: linkedProvider } satisfies Fits<LinkedLocator>,
  { kind: lightroomLocator, provider: lightroomProvider(bridge) } satisfies Fits<LightroomLocator>, { kind: immichLocator, provider: immichProvider } satisfies Fits<ImmichLocator>];
