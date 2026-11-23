import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChangeTokenExpiredError, childPrefix, requireStoreKey, requireStorePrefix, StoreAccessError, StoreFullError, uploadClonePrefix } from './sync-store';
import type { PutOptions, StoreAccessReason, StoreChanges, StoreEntry, StoreSource, SyncStore, TransferOptions } from './sync-store';

/*
 * The iCloud sync store (ADR 0012 as amended after the CloudKit spike; #292): the object store of `SyncStore` over the
 * user's private CloudKit database, through the addon in desktop/native/cloudkit.mm.
 *
 * Keys map onto record zones and records:
 *   books/<bookId>/deleted.json  → zone `index`, record `books/<bookId>/deleted.json`, so deleting a book's zone keeps
 *                                   its tombstone
 *   books/<bookId>/<rest>        → zone `<bookId>`, record `<rest>`
 *   anything else (remote.json)  → zone `index`, record `<key>`
 * A book segment that cannot name a zone (or is `index`) keeps its keys in `index` too, so every key has a place; book
 * IDs are UUIDs and always get a zone of their own.
 *
 * Every record has the type `Blob` with `size`, `sha256` and either `data` (up to `inlineLimit`, inline) or `asset`.
 * `putIfAbsent` is a conditional create (`serverRecordChanged` means the record existed); `listPrefixes('books/')`
 * lists zones; a listing is the zone's change feed without a token, and `changes` the same feed with one. There is no
 * server-side `copy`. A zone is created on the first write to it, and deleted when a delete leaves it empty.
 */

export type CloudKitAccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'couldNotDetermine';
export type CloudKitStatus = { entitled: false } | { entitled: true; container: string; environment: string; accountStatus: CloudKitAccountStatus };
export type CloudKitRecord = { name: string; size: number; lastModified: number; sha256?: string; bytes?: Uint8Array };
type Operation = { id?: number; onProgress?: (fraction: number) => void };

/** The addon's interface (desktop/native/cloudkit.mm). Errors carry `code`, the CKError name, and `retryAfter`. */
export interface CloudKitNative {
  /** Never touches CloudKit without the entitlements; every other call fails until this has found them. */
  status(): Promise<CloudKitStatus>;
  userRecordId(): Promise<string>;
  saveZone(zone: string): Promise<void>;
  deleteZones(zones: string[]): Promise<void>;
  listZones(): Promise<string[]>;
  putIfAbsent(zone: string, name: string, value: { data?: Uint8Array; file?: string; sha256?: string }, options?: Operation): Promise<{ created: boolean }>;
  /** Undefined when the record or its zone is not there. In file mode, `file` must not exist yet. */
  fetch(zone: string, name: string, options: Operation & { mode: 'head' | 'bytes' | 'file'; file?: string }): Promise<CloudKitRecord | undefined>;
  changes(zone: string, token?: string, options?: { limit?: number }): Promise<{ changed: CloudKitRecord[]; deleted: string[]; token?: string; more: boolean }>;
  deleteRecords(zone: string, names: string[]): Promise<void>;
  cancel(id: number): boolean;
  onAccountChange(listener: () => void): void;
}

/** The addon of this build, or undefined where there is none (not a Mac, or not staged). */
export function loadCloudKitNative(): CloudKitNative | undefined {
  if (process.platform !== 'darwin') return undefined;
  try { return require(join(__dirname, 'native', 'cloudkit.node')) as CloudKitNative; }
  catch { return undefined; }
}

/** Why iCloud cannot be used now, as the sync status says it. */
export type CloudKitReason = 'not-entitled' | 'sign-in' | 'restricted' | 'offline' | 'unavailable' | 'quota' | 'deleted' | 'other';
const reasons: Record<string, CloudKitReason> = {
  notEntitled: 'not-entitled', notInitialized: 'not-entitled', missingEntitlement: 'not-entitled', badContainer: 'not-entitled',
  notAuthenticated: 'sign-in', noAccount: 'sign-in',
  restricted: 'restricted',
  networkUnavailable: 'offline', networkFailure: 'offline',
  serviceUnavailable: 'unavailable', requestRateLimited: 'unavailable', zoneBusy: 'unavailable',
  temporarilyUnavailable: 'unavailable', accountTemporarilyUnavailable: 'unavailable', couldNotDetermine: 'unavailable',
  quotaExceeded: 'quota',
  userDeletedZone: 'deleted',
};
const messages: Record<CloudKitReason, string> = {
  'not-entitled': 'iCloud sync is not available in this build of ImageFlow.',
  // CloudKit does not tell the two apart.
  'sign-in': 'Sign in to iCloud, or turn on iCloud for ImageFlow.',
  restricted: 'iCloud is restricted on this Mac.',
  offline: 'This Mac is offline.',
  unavailable: 'iCloud is not available at the moment. Sync again later.',
  quota: 'iCloud storage full.',
  deleted: 'The book’s data was deleted from iCloud.',
  other: 'iCloud reported an error.',
};
/** The reason behind a CKError name or an account status. */
export const cloudKitReason = (code: string): CloudKitReason => reasons[code] ?? 'other';

const messageOf = (code: string, detail?: string) => {
  const reason = cloudKitReason(code);
  return reason === 'other' ? messages.other + (detail ? ' ' + detail : '') + ' (' + code + ')' : messages[reason];
};
/** What iCloud cannot be used for now maps onto the store access reasons the sync status shows (`StoreAccessError`). */
const access: Partial<Record<CloudKitReason, StoreAccessReason>> = { 'not-entitled': 'unavailable', 'sign-in': 'sign-in', restricted: 'unavailable', offline: 'unavailable', unavailable: 'unavailable' };

/**
 * An error CloudKit answered with: storage full, a zone the user deleted, anything else. `code` is the CKError name and
 * `cloudKitReason` what it means for sync. An iCloud that cannot be used at all is a `CloudKitAccessError` instead.
 */
export class CloudKitError extends Error {
  readonly cloudKitReason: CloudKitReason;
  constructor(readonly code: string, detail?: string, readonly retryAfter?: number) {
    super(messageOf(code, detail));
    this.name = 'CloudKitError';
    this.cloudKitReason = cloudKitReason(code);
  }
}
/**
 * iCloud cannot be used now (offline, signed out, unavailable, a build without the entitlements): a `StoreAccessError`,
 * so the sync status reads it like an S3 bucket out of reach or refusing its key.
 */
export class CloudKitAccessError extends StoreAccessError {
  readonly cloudKitReason: CloudKitReason;
  constructor(readonly code: string, detail?: string, readonly retryAfter?: number) {
    const reason = cloudKitReason(code);
    super(access[reason] ?? 'unavailable', messageOf(code, detail));
    this.name = 'CloudKitAccessError';
    this.cloudKitReason = reason;
  }
}
/** iCloud storage full (`quotaExceeded`): a `StoreFullError`, which a push handles as such. */
export class CloudKitFullError extends StoreFullError {
  readonly cloudKitReason: CloudKitReason = 'quota';
  constructor(readonly code: string, detail?: string, readonly retryAfter?: number) {
    super(messageOf(code, detail));
    this.name = 'CloudKitFullError';
  }
}
export type AnyCloudKitError = CloudKitError | CloudKitAccessError | CloudKitFullError;
/**
 * The error for a CKError name: an access error where iCloud cannot be used now, a full error for storage full, a
 * `CloudKitError` otherwise.
 */
export function cloudKitError(code: string, detail?: string, retryAfter?: number): AnyCloudKitError {
  if (cloudKitReason(code) === 'quota') return new CloudKitFullError(code, detail, retryAfter);
  return access[cloudKitReason(code)] ? new CloudKitAccessError(code, detail, retryAfter) : new CloudKitError(code, detail, retryAfter);
}
export const isCloudKitError = (error: unknown): error is AnyCloudKitError =>
  error instanceof CloudKitError || error instanceof CloudKitAccessError || error instanceof CloudKitFullError;

/** Whether this Mac can sync through iCloud now, from `status()`: available, or why not, as the status shows it. */
export function cloudKitAvailability(status: CloudKitStatus): { available: true } | { available: false; reason: CloudKitReason; message: string } {
  if (!status.entitled) return { available: false, reason: 'not-entitled', message: messages['not-entitled'] };
  if (status.accountStatus === 'available') return { available: true };
  const reason = cloudKitReason(status.accountStatus);
  return { available: false, reason, message: messages[reason] };
}

const retryable = new Set(['requestRateLimited', 'zoneBusy', 'serviceUnavailable', 'networkFailure']);
/**
 * A zone that is not there: never made, deleted by a Mac deleting its book, or deleted by the user (System Settings →
 * iCloud → Manage Storage, `userDeletedZone`). All read as holding nothing. A write makes the zone again: what guards
 * against writing into a database the user emptied is the remote's identity, not the store. Emptying it removes
 * `remote.json` too, so the next use reads a new identity, every book that synced reads as synced elsewhere and is
 * asked about, and nothing is written for it until the user agrees.
 */
const missingZone = (error: unknown) => isCloudKitError(error) && (error.code === 'zoneNotFound' || error.code === 'userDeletedZone');

/** Waits `seconds`, or rejects with the signal's reason once it is aborted. */
function pause(seconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(done, seconds * 1000);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fileSha(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
const byKey = (a: StoreEntry, b: StoreEntry) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export type CloudKitStoreOptions = {
  /** Put before every zone name, so tests get zones of their own in a real database. Empty in the app. */
  namespace?: string;
  /** How often a call CloudKit asks to retry is tried in all. */
  attempts?: number;
  /** Seconds to wait before a retry when CloudKit names no time. */
  backoff?: (attempt: number) => number;
  onRetry?: (error: AnyCloudKitError, seconds: number) => void;
};

export class CloudKitStore implements SyncStore {
  /** Blobs up to this size go inline in their record (a record holds at most 1 MB in all); larger ones as an asset. */
  static readonly inlineLimit = 256 * 1024;
  readonly indexZone: string;
  private readonly namespace: string;
  private readonly attempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly onRetry?: (error: AnyCloudKitError, seconds: number) => void;
  private ready?: Promise<void>;
  private readonly zones = new Map<string, Promise<void>>();
  private nextOperation = 1;

  constructor(private readonly native: CloudKitNative, { namespace = '', attempts = 5, backoff = (attempt) => Math.min(30, 2 ** attempt), onRetry }: CloudKitStoreOptions = {}) {
    this.namespace = namespace;
    this.indexZone = namespace + 'index';
    this.attempts = attempts;
    this.backoff = backoff;
    this.onRetry = onRetry;
  }

  /** Where a key lives: its zone and record name. */
  locate(key: string) {
    const match = /^books\/([^/]+)\/(.+)$/.exec(requireStoreKey(key));
    const zone = match && match[2] !== 'deleted.json' ? this.bookZone(match[1]) : undefined;
    const located = zone ? { zone, name: match![2] } : { zone: this.indexZone, name: key };
    // CloudKit's limits on record names.
    if (located.name.length > 255 || located.name.startsWith('_') || !/^[\x20-\x7e]+$/.test(located.name)) throw new Error('This key cannot be stored in iCloud: ' + key);
    return located;
  }
  /** The zone of a book's keys, or undefined for a book segment that cannot name one. */
  bookZone(book: string) {
    return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(book) && book !== 'index' ? this.namespace + book : undefined;
  }
  private keyOf(zone: string, name: string) {
    return zone === this.indexZone ? name : 'books/' + zone.slice(this.namespace.length) + '/' + name;
  }
  private entry(zone: string, record: CloudKitRecord): StoreEntry {
    return { key: this.keyOf(zone, record.name), size: record.size, lastModified: new Date(record.lastModified) };
  }

  /** What `status()` says, for Settings and the sync status. Never throws for a build without the entitlements. */
  status() { return this.native.status(); }
  /** The iCloud user this Mac is signed in as, in this container. Another Apple ID is another remote. */
  async userRecordId() {
    await this.open();
    return this.call(() => this.native.userRecordId());
  }
  /** Calls `listener` when CloudKit says the account changed; it also does when nothing did, so compare `userRecordId`. */
  async onAccountChange(listener: () => void) {
    await this.open();
    this.native.onAccountChange(listener);
  }

  private open() {
    const ready = this.ready ??= this.native.status().then((status) => {
      if (!status.entitled) throw cloudKitError('notEntitled');
    });
    // A failure is not kept: the next call asks again.
    ready.catch(() => { if (this.ready === ready) this.ready = undefined; });
    return ready;
  }

  /** Runs a call, retrying what CloudKit asks to be retried after the time it names, and translating its errors. */
  private async call<T>(run: (id?: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try { return await this.withSignal(run, signal); }
      catch (caught) {
        const error = translate(caught);
        if (error.code === 'operationCancelled' && signal?.aborted) throw signal.reason;
        if (!retryable.has(error.code) || attempt >= this.attempts) throw error;
        const seconds = error.retryAfter ?? this.backoff(attempt);
        this.onRetry?.(error, seconds);
        await pause(seconds, signal);
      }
    }
  }
  private withSignal<T>(run: (id?: number) => Promise<T>, signal?: AbortSignal) {
    if (!signal) return run(undefined);
    const id = this.nextOperation++;
    const abort = () => this.native.cancel(id);
    signal.addEventListener('abort', abort, { once: true });
    return run(id).finally(() => signal.removeEventListener('abort', abort));
  }

  private ensureZone(zone: string) {
    let saving = this.zones.get(zone);
    if (!saving) {
      saving = this.call(() => this.native.saveZone(zone));
      this.zones.set(zone, saving);
      saving.catch(() => { if (this.zones.get(zone) === saving) this.zones.delete(zone); });
    }
    return saving;
  }

  async putIfAbsent(key: string, source: StoreSource, { sha256, signal, onProgress }: PutOptions = {}) {
    const { zone, name } = this.locate(key);
    signal?.throwIfAborted();
    await this.open();
    let staging: string | undefined;
    try {
      // What is uploaded is a copy taken now, checked against the digest: a file changed afterwards never reaches
      // iCloud, and CloudKit never sees a file that changes while it uploads.
      let value: { data?: Uint8Array; file?: string; sha256: string };
      let size: number;
      if (source instanceof Uint8Array) {
        const bytes = new Uint8Array(source);
        size = bytes.length;
        value = { sha256: sha(bytes) };
        if (size <= CloudKitStore.inlineLimit) value.data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        else {
          staging = join(tmpdir(), 'imageflow-icloud-' + randomUUID());
          await writeFile(staging, bytes, { flag: 'wx', mode: 0o600, signal });
          value.file = staging;
        }
      } else {
        size = (await stat(source.file)).size;
        if (size <= CloudKitStore.inlineLimit) {
          const bytes = new Uint8Array(await readFile(source.file, { signal }));
          size = bytes.length;
          value = { data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), sha256: sha(bytes) };
        } else {
          // An object that is there is not uploaded again.
          if (await this.head(key)) return { existed: true };
          // A clone beside the source: on APFS it takes no space and no copying, also for a book on another volume
          // than the startup disk. The name is one a book ignores, and not the one the writer lock sweeps: originals
          // upload in the background, without the lock (`uploadOriginals` sweeps these after a crash). Where the
          // source's folder cannot be written, the clone goes to the temporary folder instead.
          staging = join(dirname(source.file), uploadClonePrefix + randomUUID() + '.tmp');
          try { await copyFile(source.file, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error;
            staging = join(tmpdir(), 'imageflow-icloud-' + randomUUID());
            await copyFile(source.file, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
          }
          signal?.throwIfAborted();
          size = (await stat(staging)).size;
          value = { file: staging, sha256: await fileSha(staging) };
        }
      }
      signal?.throwIfAborted();
      if (sha256 !== undefined && value.sha256 !== sha256) throw new Error('An object does not have the SHA-256 it was stored with: ' + key);
      let reported = 0;
      const progress = onProgress && ((fraction: number) => {
        const transferred = Math.min(size, Math.floor(fraction * size));
        if (transferred > reported) { reported = transferred; onProgress(transferred, size); }
      });
      const put = (id?: number) => this.native.putIfAbsent(zone, name, value, { id, onProgress: progress });
      await this.ensureZone(zone);
      let created: boolean;
      try { ({ created } = await this.call(put, signal)); }
      catch (error) {
        // A zone deleted since this store created it (another Mac deleting the book, the user emptying iCloud) is
        // made again for this write (`missingZone` says why that is safe).
        if (!missingZone(error)) throw error;
        this.zones.delete(zone);
        await this.ensureZone(zone);
        ({ created } = await this.call(put, signal));
      }
      onProgress?.(size, size);
      return { existed: !created };
    } catch (error) {
      // Reading or staging the source rejects with an AbortError of its own; the contract is the signal's reason.
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally {
      if (staging) await rm(staging, { force: true });
    }
  }

  async get(key: string, { signal, onProgress }: TransferOptions = {}) {
    const { zone, name } = this.locate(key);
    signal?.throwIfAborted();
    await this.open();
    const record = await this.call((id) => this.native.fetch(zone, name, { mode: 'bytes', id }), signal);
    signal?.throwIfAborted();
    if (!record?.bytes) return undefined;
    onProgress?.(record.bytes.length, record.bytes.length);
    return new Uint8Array(record.bytes);
  }

  async download(key: string, file: string, { signal, onProgress }: TransferOptions = {}) {
    const { zone, name } = this.locate(key);
    signal?.throwIfAborted();
    await this.open();
    // The addon writes a new file beside the destination, copying only the data: CloudKit's asset files carry a
    // quarantine flag that must not reach a book. The file then replaces the destination whole.
    const staging = join(dirname(file), '.sync-' + randomUUID() + '.tmp');
    try {
      // CloudKit reports a fraction and the size is known only at the end, so progress is reported once, when done.
      const record = await this.call((id) => this.native.fetch(zone, name, { mode: 'file', file: staging, id }), signal);
      if (!record) return false;
      signal?.throwIfAborted();
      await chmod(staging, 0o644);
      await rename(staging, file);
      onProgress?.(record.size, record.size);
      return true;
    } finally {
      await rm(staging, { force: true });
    }
  }

  async head(key: string) {
    const { zone, name } = this.locate(key);
    await this.open();
    const record = await this.call(() => this.native.fetch(zone, name, { mode: 'head' }));
    return record && { size: record.size, lastModified: new Date(record.lastModified) };
  }

  /** Every record of a zone, or none when it is not there. */
  private async records(zone: string) {
    try { return (await this.call(() => this.native.changes(zone))).changed; }
    catch (error) { if (missingZone(error)) return []; throw error; }
  }
  /** The book zones there are, from one listing of zones. */
  private async bookZones() {
    return (await this.call(() => this.native.listZones()))
      .filter((zone) => zone.startsWith(this.namespace) && zone !== this.indexZone && this.bookZone(zone.slice(this.namespace.length)) === zone);
  }
  /** The zones a listing of `prefix` has to read. */
  private async zonesFor(prefix: string) {
    const book = /^books\/([^/]+)\//.exec(prefix);
    if (book) {
      const zone = this.bookZone(book[1]);
      return zone ? [zone, this.indexZone] : [this.indexZone];
    }
    if (!'books/'.startsWith(prefix) && !prefix.startsWith('books/')) return [this.indexZone];
    const partial = prefix.slice('books/'.length);
    return [...(await this.bookZones()).filter((zone) => zone.slice(this.namespace.length).startsWith(partial)), this.indexZone];
  }

  async list(prefix: string) {
    requireStorePrefix(prefix);
    await this.open();
    const entries: StoreEntry[] = [];
    for (const zone of await this.zonesFor(prefix)) {
      for (const record of await this.records(zone)) {
        const entry = this.entry(zone, record);
        if (entry.key.startsWith(prefix)) entries.push(entry);
      }
    }
    return entries.sort(byKey);
  }

  async listPrefixes(prefix: string) {
    requireStorePrefix(prefix);
    await this.open();
    const children = new Set<string>();
    if (prefix === 'books/') {
      // Every book with a zone holds an object (a delete that empties a zone deletes it), and the index zone holds
      // the tombstones of books whose zone is gone.
      for (const zone of await this.bookZones()) children.add('books/' + zone.slice(this.namespace.length) + '/');
      for (const record of await this.records(this.indexZone)) {
        if (record.name.startsWith(prefix)) { const child = childPrefix(prefix, record.name); if (child) children.add(child); }
      }
    } else {
      for (const { key } of await this.list(prefix)) { const child = childPrefix(prefix, key); if (child) children.add(child); }
    }
    return [...children].sort();
  }

  async delete(keys: readonly string[]) {
    const byZone = new Map<string, string[]>();
    for (const key of keys) {
      const { zone, name } = this.locate(key);
      byZone.set(zone, [...(byZone.get(zone) ?? []), name]);
    }
    if (!byZone.size) return;
    await this.open();
    for (const [zone, names] of byZone) {
      try {
        for (let start = 0; start < names.length; start += 400) await this.call(() => this.native.deleteRecords(zone, names.slice(start, start + 400)));
      } catch (error) { if (missingZone(error)) continue; throw error; }
      // A book zone left empty goes, so listing books stays one listing of zones. Only deleting a whole book empties one.
      if (zone !== this.indexZone && await this.empty(zone)) {
        await this.call(() => this.native.deleteZones([zone])).catch((error) => { if (!missingZone(error)) throw error; });
        this.zones.delete(zone);
      }
    }
  }
  private async empty(zone: string) {
    try {
      const { changed, more } = await this.call(() => this.native.changes(zone, undefined, { limit: 1 }));
      return !changed.length && !more;
    } catch (error) { if (missingZone(error)) return false; throw error; }
  }

  async changes(bookId: string, token?: string): Promise<StoreChanges | undefined> {
    const zone = this.bookZone(bookId);
    if (!zone) throw new Error('This book cannot have a change feed in iCloud: ' + bookId);
    await this.open();
    let result;
    try { result = await this.call(() => this.native.changes(zone, token)); }
    catch (error) {
      if (missingZone(error)) return undefined;
      if (isCloudKitError(error) && error.code === 'changeTokenExpired') throw new ChangeTokenExpiredError();
      throw error;
    }
    if (!result.token) throw new CloudKitError('missingChangeToken', 'CloudKit returned no change token.');
    const changed = result.changed.map((record) => this.entry(zone, record)).sort(byKey);
    const deleted = result.deleted.map((name) => this.keyOf(zone, name)).sort();
    return { changed, deleted, token: result.token };
  }
}

/** The CloudKit error for whatever the addon rejected with. */
function translate(error: unknown): AnyCloudKitError {
  if (isCloudKitError(error)) return error;
  const { code, message, retryAfter } = (error ?? {}) as { code?: unknown; message?: unknown; retryAfter?: unknown };
  return cloudKitError(typeof code === 'string' ? code : 'unknown', typeof message === 'string' ? message : String(error),
    typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
}
