import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { s3BackendError, normalizeS3Backend } from './sync-backend';
import { credentialHint, credentialScope, credentialsError } from './sync-credentials';
import type { CredentialStore } from './sync-credentials';
import type { S3Credentials } from './sync-s3-signer';
import { S3Store } from './sync-store-s3';
import { cloudKitAvailability } from './sync-store-cloudkit';
import type { CloudKitStatus } from './sync-store-cloudkit';
import type { SettingsStore } from './settings';
import { channels } from '../src/desktop';
import type { Result, SyncBackendState, SyncConnectionReport, SyncCredentialsInput } from '../src/desktop';
import type { AppSettings, S3SyncBackend, SyncBackend } from '../src/settings';

/**
 * The development flag of sync (ADR 0012; #280–#283 ship behind it until the library does), the same as #280's:
 * Settings → Sync and its requests exist only when ImageFlow starts with `IMAGEFLOW_SYNC=1`, in a development or a
 * packaged build (`IMAGEFLOW_SYNC=1 /Applications/ImageFlow.app/Contents/MacOS/ImageFlow`).
 */
export const syncFlag = () => process.env.IMAGEFLOW_SYNC === '1';

/**
 * Why a settings patch from a window may not carry `sync`, or undefined. A backend is set only through Settings → Sync
 * (`saveSyncBackend`), which checks it with its credentials and forgets those of the backend it replaces; the generic
 * patch may only turn sync off (`null` or `undefined`), and only with the flag. Settings read from disk are not patches
 * from a window and keep their backend.
 */
export function syncPatchError(patch: unknown, enabled = syncFlag()) {
  if (!patch || typeof patch !== 'object' || !('sync' in patch)) return undefined;
  const value = (patch as { sync?: unknown }).sync;
  return enabled && (value === null || value === undefined) ? undefined : 'Choose the sync backend in Settings → Sync.';
}

/**
 * One backend at a time: when the setting moves from a bucket to anything else (another bucket, a folder, off), the
 * key stored for that bucket is forgotten.
 */
export async function forgetOtherCredentials(store: CredentialStore, previous: SyncBackend | undefined, next: SyncBackend | undefined) {
  if (previous?.kind !== 's3') return;
  if (next?.kind === 's3' && credentialScope(next) === credentialScope(previous)) return;
  await store.remove(credentialScope(previous));
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'ImageFlow could not complete the request.');

/** Validates a request from Settings; credentials, when given, are checked but never echoed in a message. */
function parseRequest(request: unknown): { backend: S3SyncBackend; credentials?: S3Credentials } {
  const { backend, credentials } = (request ?? {}) as Partial<{ backend: S3SyncBackend; credentials: SyncCredentialsInput }>;
  if (!backend || typeof backend !== 'object' || backend.kind !== 's3') throw new Error('Choose an S3-compatible bucket.');
  const problem = s3BackendError(backend);
  if (problem) throw new Error(problem);
  if (credentials === undefined) return { backend: normalizeS3Backend(backend) };
  const invalid = credentialsError(credentials);
  if (invalid) throw new Error(invalid);
  return { backend: normalizeS3Backend(backend), credentials: { accessKeyId: credentials.accessKeyId.trim(), secretAccessKey: credentials.secretAccessKey } };
}

/**
 * The requests of Settings → Sync, from the Settings window only. The secret access key goes from the renderer to the
 * main process once, when it is entered, and is kept by `credentials` alone: never in `settings.json`, never in an
 * answer, an error or the log.
 */
export function registerSyncSettings({ ipcMain, owner, settings, credentials, cloudKit, changed }: {
  ipcMain: IpcMain;
  /** What the CloudKit addon says about this build and account; undefined where there is no addon (#292). */
  cloudKit?: () => Promise<CloudKitStatus | undefined>;
  owner: (event: IpcMainInvokeEvent) => unknown;
  settings: SettingsStore;
  credentials: () => CredentialStore;
  /** Called with the new settings after the backend changed, to tell every window. */
  changed: (value: AppSettings) => void;
}) {
  const state = async (): Promise<SyncBackendState> => {
    const backend = settings.value.sync;
    const stored = backend?.kind === 's3' ? credentialHint(await credentials().read(credentialScope(backend)).catch(() => undefined)) : undefined;
    return { available: true, ...(stored ? { credentials: stored } : {}), ...await icloud() };
  };
  // iCloud is offered only by a build entitled to it; whether the account can use it now is asked each time.
  const icloud = async (): Promise<Pick<SyncBackendState, 'icloud'>> => {
    const status = await cloudKit?.().catch(() => undefined);
    if (!status?.entitled) return {};
    const availability = cloudKitAvailability(status);
    return { icloud: availability.available ? { available: true } : { available: false, message: availability.message } };
  };
  const guard = async <T>(event: IpcMainInvokeEvent, run: () => Promise<T>): Promise<Result<T>> => {
    if (!owner(event)) return { error: 'Request is only available to Settings.' };
    if (!syncFlag()) return { error: 'Sync backends are not available in this version.' };
    try { return { value: await run() }; } catch (error) { return { error: message(error) }; }
  };

  ipcMain.handle(channels.syncBackend, (event): Promise<Result<SyncBackendState>> => {
    if (owner(event) && !syncFlag()) return Promise.resolve({ value: { available: false } });
    return guard(event, state);
  });

  ipcMain.handle(channels.saveSyncBackend, (event, request: unknown) => guard(event, async () => {
    const previous = settings.value.sync;
    if (request === null) {
      const value = await settings.update({ sync: null });
      await credentials().remove();
      changed(value);
      return state();
    }
    if ((request as { backend?: { kind?: unknown } } | undefined)?.backend?.kind === 'icloud') {
      if (Object.keys((request as { backend: object }).backend).length !== 1) throw new Error('Invalid sync setting.');
      const offered = (await icloud()).icloud;
      if (!offered) throw new Error('iCloud sync is not available in this build of ImageFlow.');
      if (!offered.available) throw new Error(offered.message);
      const value = await settings.update({ sync: { kind: 'icloud' } });
      await forgetOtherCredentials(credentials(), previous, value.sync);
      changed(value);
      return state();
    }
    const { backend, credentials: entered } = parseRequest(request);
    const scope = credentialScope(backend);
    if (entered) await credentials().write(scope, entered);
    else if (!await credentials().read(scope)) throw new Error('Enter the access key ID and the secret access key for this bucket.');
    const value = await settings.update({ sync: backend });
    await forgetOtherCredentials(credentials(), previous, value.sync);
    // Told also when only the key changed: the books look at the bucket again with it.
    changed(value);
    return state();
  }));

  ipcMain.handle(channels.testSyncConnection, (event, request: unknown) => guard(event, async (): Promise<SyncConnectionReport> => {
    const { backend, credentials: entered } = parseRequest(request);
    const used = entered ?? await credentials().read(credentialScope(backend));
    if (!used) throw new Error('Enter the access key ID and the secret access key for this bucket.');
    const store = new S3Store({ ...backend, credentials: used, retries: 1, timeout: 20_000 });
    return store.testConnection();
  }));
}
