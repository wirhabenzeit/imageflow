import { constants } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * The object store a sync remote is built on (ADR 0012, section 2). `StoreRemote` (desktop/sync-remote.ts) implements
 * everything sync needs over these few operations, so a transport implements only this: a folder and memory here, an
 * S3-compatible bucket and ImageFlow Cloud later.
 *
 * Keys are `/`-separated paths (`requireStoreKey`); a prefix is the start of a key, as in S3, and not a folder. The
 * conformance suite (tests/sync-store-conformance.ts) is the contract in executable form: every store runs it.
 */
export type StoreSource = Uint8Array | { file: string };
export type StoreObject = { size: number; lastModified: Date };
/** `etag`, where the store has one, changes whenever the object under the key is replaced (S3's ETag). */
export type StoreEntry = StoreObject & { key: string; etag?: string };
export type TransferOptions = {
  /** Stops the transfer, also one that is running; it then rejects with the signal's reason and leaves nothing behind:
   * no object, no file, no temporary file. A transfer that had finished by then stays. */
  signal?: AbortSignal;
  /** Bytes transferred so far and, when known, the object's size. Called at least once, when the transfer is done. */
  onProgress?: (transferred: number, total?: number) => void;
};
export type PutOptions = TransferOptions & {
  /** The SHA-256 of the object (lower-case hex) when the caller knows it, so a store that sends or checks one need not
   * read the source twice. A store that checks it rejects a source with other bytes and stores nothing. */
  sha256?: string;
};

export interface SyncStore {
  /** Stores an object unless the key exists; never replaces one. `existed` says whether it was there already. */
  putIfAbsent(key: string, source: StoreSource, options?: PutOptions): Promise<{ existed: boolean }>;
  /** A whole object in memory, or undefined when the store does not have it. For small objects. */
  get(key: string, options?: TransferOptions): Promise<Uint8Array | undefined>;
  /** Writes an object to `file`, replacing it whole (never a partial file there); false when the store does not have it. */
  download(key: string, file: string, options?: TransferOptions): Promise<boolean>;
  /** An object's size and time of its last change, or undefined when the store does not have it. */
  head(key: string): Promise<StoreObject | undefined>;
  /** Every object whose key starts with `prefix`, sorted by key. */
  list(prefix: string): Promise<StoreEntry[]>;
  /**
   * The immediate child prefixes of `prefix` that hold an object, sorted: `listPrefixes('books/')` gives
   * `books/<bookId>/` for every book without listing its objects (S3's `Delimiter=/`).
   */
  listPrefixes(prefix: string): Promise<string[]>;
  /** Deletes objects. Keys the store does not have are ignored. */
  delete(keys: readonly string[]): Promise<void>;
  /**
   * Copies an object inside the store without transferring it, replacing `to`; false when `from` is not there.
   * Optional: a store without a server-side copy leaves it out, and a caller then uploads instead.
   */
  copy?(from: string, to: string): Promise<boolean>;
}

/**
 * A store that cannot be used now, as opposed to one that answered: offline or timed out (`unavailable`), one that
 * refuses this Mac's credentials (`sign-in`), one whose settings name no bucket there (`settings`: a missing bucket, a
 * wrong region or endpoint), or a Mac whose clock is too far off for signed requests (`clock`). Settings → Sync fixes
 * `sign-in` and `settings`. The message says so in words for the status bar, and never carries a credential.
 */
export type StoreAccessReason = 'unavailable' | 'sign-in' | 'settings' | 'clock';
export class StoreAccessError extends Error {
  constructor(readonly reason: StoreAccessReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreAccessError';
  }
}

const segmentOk = (part: string) => !!part && !part.startsWith('.') && !/[\\\0]/.test(part);
/** Whether a string is a store key: `/`-separated parts that are not empty, not hidden (`.`, `..`, `.name`), without `\`. */
export const isStoreKey = (key: string) => typeof key === 'string' && key.length <= 1024 && key.split('/').every(segmentOk);
export function requireStoreKey(key: string) {
  if (!isStoreKey(key)) throw new Error('Not a sync store key: ' + key);
  return key;
}
/** A prefix is the start of a key: empty, or a key that may end in `/`. */
export function requireStorePrefix(prefix: string) {
  if (prefix !== '' && !isStoreKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)) throw new Error('Not a sync store prefix: ' + prefix);
  return prefix;
}
/** The child prefix of `prefix` that `key` lies under, or undefined when it is an object directly at `prefix`. */
export function childPrefix(prefix: string, key: string) {
  const end = key.indexOf('/', prefix.length);
  return end < 0 ? undefined : key.slice(0, end + 1);
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A store held in memory: tests, and the reference for what a store has to do. */
export class MemoryStore implements SyncStore {
  readonly objects = new Map<string, { bytes: Uint8Array; lastModified: Date }>();

  async putIfAbsent(key: string, source: StoreSource, { sha256, signal, onProgress }: PutOptions = {}) {
    requireStoreKey(key);
    signal?.throwIfAborted();
    if (this.objects.has(key)) return { existed: true };
    const bytes = source instanceof Uint8Array ? new Uint8Array(source)
      : new Uint8Array(await readFile(source.file, { signal }).catch((error) => { signal?.throwIfAborted(); throw error; }));
    // Aborted while the file was read: nothing is stored.
    signal?.throwIfAborted();
    if (sha256 !== undefined && sha(bytes) !== sha256) throw new Error('An object does not have the SHA-256 it was stored with: ' + key);
    // Another put may have finished while the file was read.
    if (this.objects.has(key)) return { existed: true };
    this.objects.set(key, { bytes, lastModified: new Date() });
    onProgress?.(bytes.length, bytes.length);
    return { existed: false };
  }
  async get(key: string, { signal, onProgress }: TransferOptions = {}) {
    requireStoreKey(key);
    signal?.throwIfAborted();
    const bytes = this.objects.get(key)?.bytes;
    if (bytes) onProgress?.(bytes.length, bytes.length);
    return bytes && new Uint8Array(bytes);
  }
  async download(key: string, file: string, options: TransferOptions = {}) {
    const bytes = await this.get(key, options);
    if (!bytes) return false;
    options.signal?.throwIfAborted();
    await writeAtomically(file, bytes);
    return true;
  }
  async head(key: string) {
    const object = this.objects.get(requireStoreKey(key));
    return object && { size: object.bytes.length, lastModified: new Date(object.lastModified) };
  }
  async list(prefix: string) {
    requireStorePrefix(prefix);
    return [...this.objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, { bytes, lastModified }]) => ({ key, size: bytes.length, lastModified: new Date(lastModified) }));
  }
  async listPrefixes(prefix: string) {
    requireStorePrefix(prefix);
    const children = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => childPrefix(prefix, key));
    return [...new Set(children.filter((child) => child !== undefined))].sort();
  }
  async copy(from: string, to: string) {
    requireStoreKey(to);
    const object = this.objects.get(requireStoreKey(from));
    if (!object) return false;
    this.objects.set(to, { bytes: new Uint8Array(object.bytes), lastModified: new Date() });
    return true;
  }
  async delete(keys: readonly string[]) {
    for (const key of keys) this.objects.delete(requireStoreKey(key));
  }
}

/** Writes a file whole, replacing one that is there, by a rename from a staging file beside it. */
export async function writeAtomically(destination: string, source: StoreSource) {
  const staging = join(dirname(destination), '.sync-' + randomUUID() + '.tmp');
  try {
    if (source instanceof Uint8Array) await writeFile(staging, source, { flag: 'wx', mode: 0o644 });
    else await copyFile(source.file, staging, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    await rename(staging, destination);
  } finally { await rm(staging, { force: true }); }
}
