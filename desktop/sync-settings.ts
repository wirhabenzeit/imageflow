import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { s3BackendError, normalizeS3Backend } from './sync-backend';
import { credentialHint, credentialScope, credentialsError } from './sync-credentials';
import type { CredentialStore } from './sync-credentials';
import type { S3Credentials } from './sync-s3-signer';
import { S3Store } from './sync-store-s3';
import { cloudKitAvailability } from './sync-store-cloudkit';
import type { CloudKitStatus } from './sync-store-cloudkit';
import type { SettingsStore } from './settings';
import { channels } from '../src/desktop';
import type { Result, SyncBackendState, SyncCleanUpPlan, SyncConnectionReport, SyncCredentialsInput } from '../src/desktop';
import type { AppSettings, S3SyncBackend, SyncBackend } from '../src/settings';

/**
 * Sync through an S3-compatible bucket and through iCloud ship (#283, #292). iCloud needs a build entitled to it (a
 * release signed with the provisioning profile, `docs/signing.md`): the app says once at startup whether this build is
 * (`setICloudEntitled`, from the CloudKit addon's status), and until it does, or in a build that is not, iCloud is
 * neither offered nor used.
 */
let icloudEntitled = false;
export const setICloudEntitled = (entitled: boolean) => { icloudEntitled = entitled; };
/**
 * The folder backend is for tests and development (ADR 0012): Settings → Sync offers it, and its request answers, only
 * when ImageFlow starts with `IMAGEFLOW_SYNC_FOLDER=1`. A settings file that names a folder is used as it is.
 */
export const folderSyncFlag = () => process.env.IMAGEFLOW_SYNC_FOLDER === '1';
/**
 * The backend this Mac syncs through, as this build may use it: one that names iCloud in a build without the
 * entitlements (a development or ad-hoc build) leaves sync off, neither failing nor syncing; the setting stays for a
 * build that has them.
 */
export function usableBackend(backend: SyncBackend | undefined, icloud = icloudEntitled) {
  return backend?.kind === 'icloud' && !icloud ? undefined : backend;
}

/**
 * Why a settings patch from a window may not carry `sync`, `syncSetup` or `syncBooksUnchosen`, or undefined. A backend is set only
 * through Settings → Sync (`saveSyncBackend`), which checks it with its credentials and forgets those of the backend it
 * replaces; the generic patch may only turn sync off (`null` or `undefined`). Settings read from disk are not patches
 * from a window and keep their values.
 */
export function syncPatchError(patch: unknown) {
  // Which books may start by themselves with a backend is the main process's to say, never a window's.
  if (patch && typeof patch === 'object' && ('syncBooksUnchosen' in patch || 'syncSetup' in patch)) return 'Sync is set up in Settings → Sync.';
  if (!patch || typeof patch !== 'object' || !('sync' in patch)) return undefined;
  const value = (patch as { sync?: unknown }).sync;
  return value === null || value === undefined ? undefined : 'Choose the sync backend in Settings → Sync.';
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
/**
 * The part of a settings patch that begins a set-up (`AppSettings.syncSetup`), for a backend that replaces `previous`:
 * another backend, or the first one, begins a new one, under which no book there before starts by itself; one that stays
 * the same (only its key changed) keeps what it had.
 */
export function syncSetupPatch(previous: SyncBackend | undefined, next: SyncBackend): { syncSetup?: string; syncBooksUnchosen?: null } {
  return JSON.stringify(previous) === JSON.stringify(next) ? {} : { syncSetup: randomUUID(), syncBooksUnchosen: null };
}

export function registerSyncSettings({ ipcMain, owner, windowOwner = owner, settings, credentials, cloudKit, cleanUp, changed, setUp }: {
  ipcMain: IpcMain;
  /** What the CloudKit addon says about this build and account; undefined where there is no addon (#292). */
  cloudKit?: () => Promise<CloudKitStatus | undefined>;
  /** Clean Up (#285): `plan` finds what it would delete and deletes nothing; `run` deletes what the last plan found. */
  cleanUp?: { plan: () => Promise<SyncCleanUpPlan>;
    /** Asks in the main process, on the window that asked, then deletes; `cancelled` when the user said no. */
    run: (event: IpcMainInvokeEvent) => Promise<{ bytes: number; objects: number } | { cancelled: true }> };
  owner: (event: IpcMainInvokeEvent) => unknown;
  /** The Sync window, which Clean Up belongs to. */
  windowOwner?: (event: IpcMainInvokeEvent) => unknown;
  settings: SettingsStore;
  credentials: () => CredentialStore;
  /** Called with the new settings after the backend changed, to tell every window. */
  changed: (value: AppSettings) => void;
  /** Called once another backend (or the first one) was set up: the app opens the Sync window, where books are turned on. */
  setUp?: () => void;
}) {
  const state = async (): Promise<SyncBackendState> => {
    const backend = settings.value.sync;
    const stored = backend?.kind === 's3' ? credentialHint(await credentials().read(credentialScope(backend)).catch(() => undefined)) : undefined;
    // A setting that names iCloud in a build without the entitlements leaves sync off, and the pane says so.
    const unusable = !!backend && !usableBackend(backend);
    return { available: true, ...(stored ? { credentials: stored } : {}),
      ...(unusable ? { unusable: 'iCloud sync is not available in this build of ImageFlow, so sync is off on this Mac.' } : {}),
      ...(folderSyncFlag() ? { folder: true as const } : {}), ...await icloud() };
  };
  // iCloud is offered only by a build entitled to it; whether the account can use it now is asked each time.
  const icloud = async (): Promise<Pick<SyncBackendState, 'icloud'>> => {
    const status = await cloudKit?.().catch(() => undefined);
    if (!status?.entitled) return {};
    const availability = cloudKitAvailability(status);
    return { icloud: availability.available ? { available: true } : { available: false, message: availability.message } };
  };
  const guard = async <T>(event: IpcMainInvokeEvent, run: () => Promise<T>, allowed: typeof owner = owner, name = 'Settings'): Promise<Result<T>> => {
    if (!allowed(event)) return { error: 'Request is only available to ' + name + '.' };
    try { return { value: await run() }; } catch (error) { return { error: message(error) }; }
  };
  /** Tells every window about the backend that was saved, and begins its set-up where it is another one. */
  const saved = (previous: SyncBackend | undefined, value: AppSettings) => {
    changed(value);
    if (value.syncSetup && JSON.stringify(previous) !== JSON.stringify(value.sync)) setUp?.();
  };

  ipcMain.handle(channels.syncBackend, (event): Promise<Result<SyncBackendState>> => guard(event, state));

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
      const value = await settings.update({ sync: { kind: 'icloud' }, ...syncSetupPatch(previous, { kind: 'icloud' }) });
      await forgetOtherCredentials(credentials(), previous, value.sync);
      saved(previous, value);
      return state();
    }
    const { backend, credentials: entered } = parseRequest(request);
    const scope = credentialScope(backend);
    if (entered) await credentials().write(scope, entered);
    else if (!await credentials().read(scope)) throw new Error('Enter the access key ID and the secret access key for this bucket.');
    const value = await settings.update({ sync: backend, ...syncSetupPatch(previous, backend) });
    await forgetOtherCredentials(credentials(), previous, value.sync);
    // Told also when only the key changed: the books look at the bucket again with it.
    saved(previous, value);
    return state();
  }));

  ipcMain.handle(channels.syncCleanUpPlan, (event) => guard(event, async () => {
    if (!cleanUp || !usableBackend(settings.value.sync)) throw new Error('Sync is off on this Mac.');
    return cleanUp.plan();
  }, windowOwner, 'the Sync window'));
  ipcMain.handle(channels.syncCleanUp, (event) => guard(event, async () => {
    if (!cleanUp || !usableBackend(settings.value.sync)) throw new Error('Sync is off on this Mac.');
    return cleanUp.run(event);
  }, windowOwner, 'the Sync window'));

  ipcMain.handle(channels.testSyncConnection, (event, request: unknown) => guard(event, async (): Promise<SyncConnectionReport> => {
    const { backend, credentials: entered } = parseRequest(request);
    const used = entered ?? await credentials().read(credentialScope(backend));
    if (!used) throw new Error('Enter the access key ID and the secret access key for this bucket.');
    const store = new S3Store({ ...backend, credentials: used, retries: 1, timeout: 20_000 });
    return store.testConnection();
  }));
}
