import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { credentialScope } from './sync-credentials';
import type { CredentialStore } from './sync-credentials';
import { FileHeaderCache } from './sync-header-cache';
import type { CommitHeaderCache } from './sync-header-cache';
import { StoreRemote } from './sync-remote';
import { StoreAccessError } from './sync-store';
import { FolderStore } from './sync-store-folder';
import { endpointError, S3Store } from './sync-store-s3';
import type { S3StoreOptions } from './sync-store-s3';
import type { S3SyncBackend, SyncBackend } from '../src/settings';
import { splitEndpoint } from '../src/sync-endpoint';

/**
 * Builds the sync remote of this Mac's backend setting (ADR 0012, section 2; #281). The app-level sync service (#280)
 * calls `syncRemoteFor` and hands the remote to every open book; nothing here knows about books.
 */

/**
 * The server and bucket of a setting whose endpoint may be a URL with the bucket in it (R2's
 * `https://<account>.r2.cloudflarestorage.com/<bucket>`, AWS virtual-hosted): `splitEndpoint`, with the bucket field
 * filled from the URL when it is empty, and an error when the two name different buckets.
 */
function resolveEndpoint(backend: Partial<S3SyncBackend>): { endpoint: string; bucket: string; region?: string } | { error: string } {
  if (typeof backend.endpoint !== 'string' || !backend.endpoint.trim()) return { error: 'Enter the endpoint of the service.' };
  const split = splitEndpoint(backend.endpoint);
  if ('error' in split) return split;
  const typed = typeof backend.bucket === 'string' ? backend.bucket.trim() : '';
  if (split.bucket && typed && split.bucket !== typed) return { error: 'The endpoint names the bucket “' + split.bucket + '”, but Bucket is “' + typed + '”. Enter one of them.' };
  return { endpoint: split.endpoint, bucket: typed || split.bucket || '', ...(split.region ? { region: split.region } : {}) };
}

/** Whether an S3 setting can be used as it is; the message says what to fix in Settings → Sync. */
export function s3BackendError(backend: Partial<S3SyncBackend>): string | undefined {
  const resolved = resolveEndpoint(backend);
  if ('error' in resolved) return resolved.error;
  const endpoint = endpointError(resolved.endpoint);
  if (endpoint) return endpoint;
  const region = (typeof backend.region === 'string' ? backend.region.trim() : '') || resolved.region || '';
  if (!/^[a-z0-9-]{1,64}$/.test(region)) return 'Enter the region, like us-east-1 (auto for Cloudflare R2).';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,253}[A-Za-z0-9]$/.test(resolved.bucket)) return 'Enter the name of the bucket.';
  const prefix = typeof backend.prefix === 'string' ? backend.prefix.trim().replace(/^\/+/, '') : backend.prefix;
  if (prefix !== undefined && (typeof prefix !== 'string' || (prefix !== '' && !/^([A-Za-z0-9_-][A-Za-z0-9._ +()-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._ +()-]*\/?$/.test(prefix)) || prefix.length > 200)) {
    return 'The prefix is a path inside the bucket, like imageflow/.';
  }
  if (backend.addressing !== undefined && backend.addressing !== 'path' && backend.addressing !== 'virtual') return 'Choose path-style or virtual-hosted addressing.';
  return undefined;
}

/**
 * A setting as Settings stores it: the endpoint only a server (a bucket in its URL moved to `bucket`), trimmed, the
 * prefix ending in `/`, nothing unknown. Only for a setting `s3BackendError` accepts.
 */
export function normalizeS3Backend(backend: S3SyncBackend): S3SyncBackend {
  const resolved = resolveEndpoint(backend);
  if ('error' in resolved) throw new Error(resolved.error);
  const prefix = backend.prefix?.trim().replace(/^\/+/, '') ?? '';
  return { kind: 's3', endpoint: resolved.endpoint, region: (backend.region ?? '').trim() || resolved.region!, bucket: resolved.bucket,
    ...(prefix ? { prefix: prefix.endsWith('/') ? prefix : prefix + '/' } : {}), ...(backend.addressing ? { addressing: backend.addressing } : {}) };
}

export type SyncRemoteDependencies = {
  credentials: CredentialStore;
  /** Where commit headers that were read are kept (`<userData>/Sync Cache` in the app). */
  cacheFolder?: string;
  headerCache?: CommitHeaderCache;
  /** Retries, timeouts and page size of the S3 store, for tests. */
  s3?: Partial<Pick<S3StoreOptions, 'retries' | 'retryDelay' | 'timeout' | 'pageSize'>>;
};

/** The S3 store of a setting, with the credentials stored for it; `sign-in` when there are none. */
export async function s3StoreFor(backend: S3SyncBackend, { credentials, s3 }: { credentials?: CredentialStore; s3?: SyncRemoteDependencies['s3'] }) {
  const problem = s3BackendError(backend);
  if (problem) throw new Error(problem);
  const stored = await credentials?.read(credentialScope(backend));
  if (!stored) throw new StoreAccessError('sign-in', 'Sign-in needed: enter the access key for the bucket “' + backend.bucket + '” in Settings → Sync.');
  return new S3Store({ ...normalizeS3Backend(backend), ...s3, credentials: stored });
}

/**
 * Opens the remote of an S3 setting at each use, for the app's sync service (desktop/sync-service.ts): the
 * credentials are read every time (a small file, no request), and the store is made again only when they changed, so
 * a key saved in Settings → Sync counts at the next use without a restart, while a store that learned something about
 * its service (that the bucket exists, whether it takes conditional writes) keeps it. One header cache serves every
 * store of the setting. Without credentials it throws `sign-in`.
 */
export function s3Opener(backend: S3SyncBackend, { credentials, cacheFolder, headerCache, s3 }: { credentials: () => CredentialStore | undefined; cacheFolder?: () => string;
  headerCache?: CommitHeaderCache; s3?: SyncRemoteDependencies['s3'] }) {
  const cache = headerCache ?? (cacheFolder ? new FileHeaderCache(join(cacheFolder(), 'Sync Cache')) : undefined);
  let built: { fingerprint: string; remote: StoreRemote<S3Store> } | undefined;
  return async () => {
    const store = credentials();
    const stored = await store?.read(credentialScope(backend));
    if (!stored) throw new StoreAccessError('sign-in', 'Sign-in needed: enter the access key for the bucket “' + backend.bucket + '” in Settings → Sync.');
    // Compared by digest, so no copy of the secret is kept besides the store's own.
    const fingerprint = createHash('sha256').update(stored.accessKeyId + '\0' + stored.secretAccessKey).digest('hex');
    if (built?.fingerprint !== fingerprint) built = { fingerprint, remote: new StoreRemote(await s3StoreFor(backend, { credentials: store, s3 }), { headerCache: cache }) };
    return built.remote;
  };
}

/** The sync remote of a backend setting, once. */
export async function syncRemoteFor(backend: SyncBackend, dependencies: SyncRemoteDependencies): Promise<StoreRemote> {
  if (backend.kind === 'folder') return new StoreRemote(new FolderStore(backend.path));
  return s3Opener(backend, { ...dependencies, credentials: () => dependencies.credentials, cacheFolder: dependencies.cacheFolder ? () => dependencies.cacheFolder! : undefined })();
}
