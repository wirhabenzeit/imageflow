import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { emptySha256, sha256Hex, signRequest, uriEncode } from './sync-s3-signer';
import type { S3Credentials } from './sync-s3-signer';
import { isStoreKey, requireStoreKey, requireStorePrefix, StoreAccessError } from './sync-store';
import type { PutOptions, StoreEntry, StoreObject, StoreSource, SyncStore, TransferOptions } from './sync-store';
import type { S3SyncBackend } from '../src/settings';

/**
 * The object store over an S3-compatible bucket (#281, ADR 0012 section 2): S3, R2, B2, MinIO, Wasabi. The main process
 * alone uses it; it holds the credentials in a private field and never puts them in an error.
 *
 * - Requests are signed with SigV4 (desktop/sync-s3-signer.ts) and sent with `fetch`; the few calls are written here.
 * - `putIfAbsent` looks first (a large original that is there is not uploaded again), then writes with
 *   `If-None-Match: *`. The look is left out for small objects in memory (previews, content) once the service proved that
 *   it refuses to replace an object (`enforced`). A service that rejects the header gets plain puts from then on: blobs are content-addressed and
 *   commit IDs are UUIDs, so a race of two writers can only put the same bytes under a key, and the remote's identity is
 *   always read back (ADR 0012, Remote identity).
 * - Uploads are single PUTs streamed from the file with the SHA-256 the caller has (`x-amz-content-sha256`), so a
 *   service that checks it refuses other bytes. The bytes are hashed again as they are sent and the last chunk is held
 *   back until they match, so a source that changed is never stored, also by a service that does not check.
 * - No multipart upload: one PUT holds at most 5 GiB (`maxObjectSize`), far above any photo, and a larger file is
 *   refused before a byte is sent. A single PUT keeps the service's whole-object SHA-256 check.
 * - Downloads go to a temporary file beside the destination and are renamed into place when whole.
 * - Network errors, timeouts and 5xx answers are retried with backoff; 4xx answers and redirects are not. A redirect is
 *   never followed (it would carry the signed request elsewhere): it names the bucket's region or endpoint instead.
 * - Errors say what to fix by the S3 error code: the access key ID, the secret, the key's permissions for the operation,
 *   a missing bucket, the region or endpoint, or this Mac's clock.
 */

/** The most a single PUT may hold (S3's limit; R2, B2 and MinIO allow at least this). */
export const maxObjectSize = 5 * 1024 ** 3;
/** What a request does, for an error that says which permission the access key lacks. */
type Operation = 'read' | 'write' | 'list' | 'delete';
const operationWords: Record<Operation, string> = { read: 'read objects in', write: 'write objects to', list: 'list the objects of', delete: 'delete objects from' };
const redirectStatuses = [301, 302, 303, 307, 308];
export type S3StoreOptions = Omit<S3SyncBackend, 'kind'> & {
  credentials: S3Credentials;
  /** Attempts after the first, for errors worth retrying. */
  retries?: number;
  /** The first wait before a retry in milliseconds; it doubles each time. */
  retryDelay?: number;
  /** Milliseconds a request may go without sending or receiving anything before it counts as timed out. */
  timeout?: number;
  /** `max-keys` of a listing page (the service may give fewer). */
  pageSize?: number;
};

/** What the connection test found (Settings → Sync). */
export type ConnectionReport = {
  /** `enforced`: a second conditional put was refused. `ignored`: the service replaced the object anyway. `unsupported`:
   * it refused the header, and puts look first instead. */
  conditionalWrites: 'enforced' | 'ignored' | 'unsupported';
  /** Whether the service refused an upload whose bytes do not have the SHA-256 it was signed with. */
  checksums: 'verified' | 'not-verified';
  addressing: 'path' | 'virtual';
};

/** An answer of the service that is not a success, with its S3 error code. */
export class S3ResponseError extends Error {
  /** Where the service says the bucket is, from a redirect or a region error. */
  region?: string;
  endpoint?: string;
  constructor(readonly status: number, readonly code: string, detail: string) {
    super('The bucket refused the request (' + status + (code ? ' ' + code : '') + ')' + (detail ? ': ' + detail : '.'));
    this.name = 'S3ResponseError';
  }
}
/** A response that ended early or a listing that does not hold together: retried, as a network error is. */
class IncompleteResponseError extends Error {}
class StalledError extends Error { constructor() { super('The request to the bucket timed out.'); } }
class ChecksumMismatchError extends Error {}

const virtualByDefault = (host: string) => /(^|\.)amazonaws\.com$/.test(host);
/** Whether `endpoint` may carry credentials: https, or plain http to this Mac (a MinIO in development, the tests). */
export function endpointError(endpoint: string) {
  let url: URL;
  try { url = new URL(endpoint); } catch { return 'The endpoint is not a URL.'; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return 'The endpoint is only a server address, like https://s3.example.com.';
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined;
  return 'The endpoint must use https.';
}

const xmlDecode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (entity[0] !== '#') return named[entity.toLowerCase()];
  return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
});
const xmlEncode = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const tag = (xml: string, name: string) => { const match = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml); return match ? xmlDecode(match[1]) : undefined; };
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'g'))].map((match) => match[1]);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function fileSha256(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Progress that never goes backwards, also across a retry that starts the transfer again. */
function monotonic(report?: (transferred: number, total?: number) => void) {
  let last = -1;
  return (transferred: number, total?: number) => { if (transferred >= last) { last = transferred; report?.(transferred, total); } };
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current && chain.length < 8; current = (current as { cause?: unknown }).cause) chain.push(current);
  return chain;
}
const networkCodes = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|UND_ERR_\w+)$/;
/** A failure on the way to the service or back: no connection, a dropped one, a timeout, an answer cut short. */
const networkError = (error: unknown) => error instanceof StalledError || error instanceof IncompleteResponseError
  || (error instanceof TypeError && /^(fetch failed|terminated)$/.test(error.message))
  || causes(error).some((item) => !!item && typeof item === 'object' && networkCodes.test(String((item as { code?: unknown }).code)));
const retryable = (error: unknown) => {
  if (causes(error).some((item) => item instanceof ChecksumMismatchError)) return false;
  if (error instanceof S3ResponseError) return error.status >= 500 || error.status === 429 || error.code === 'ConditionalRequestConflict';
  return networkError(error);
};

export class S3Store implements SyncStore {
  readonly #credentials: S3Credentials;
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly addressing: 'path' | 'virtual';
  /** False once the service refused `If-None-Match: *`: puts then look first and write plainly. */
  conditionalWrites = true;
  /**
   * Whether the service answered a conditional put with 412, which proves that it enforces the condition. One that
   * ignores the header answers every put alike, and there only the look keeps a put from replacing an object (a preview
   * another Mac stored, which its snapshot records by its SHA-256). Until it is proven, every put looks first.
   */
  private enforced = false;
  /** Small puts that stored something before the service was asked for that proof; a sync of a few never asks. */
  private smallPuts = 0;
  static readonly proveAfter = 8;
  /** Objects in memory up to this size are sent without a look: a refused one wastes little. */
  static readonly smallObject = 2 * 1024 * 1024;
  /** Whether the bucket answered once: until then a 404 without a body (HEAD) is checked to be a key, not the bucket. */
  private bucketConfirmed = false;
  private readonly retries: number;
  private readonly retryDelay: number;
  private readonly timeout: number;
  private readonly pageSize: number;

  constructor({ endpoint, region, bucket, prefix = '', addressing, credentials, retries = 4, retryDelay = 250, timeout = 60_000, pageSize = 1000 }: S3StoreOptions) {
    const problem = endpointError(endpoint);
    if (problem) throw new Error(problem);
    this.endpoint = new URL(endpoint);
    this.region = region || 'us-east-1';
    this.bucket = bucket;
    this.prefix = requireStorePrefix(prefix && !prefix.endsWith('/') ? prefix + '/' : prefix);
    this.addressing = addressing ?? (virtualByDefault(this.endpoint.hostname) ? 'virtual' : 'path');
    this.#credentials = { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey };
    this.retries = retries;
    this.retryDelay = retryDelay;
    this.timeout = timeout;
    this.pageSize = pageSize;
  }

  /** The URL of an object (or of the bucket, without a key). Keys keep their `/` and have everything else encoded. */
  url(key?: string, query = '') {
    const url = new URL(this.endpoint.origin);
    const path = key === undefined ? '' : '/' + uriEncode(key, true);
    if (this.addressing === 'virtual') { url.hostname = this.bucket + '.' + url.hostname; url.pathname = path || '/'; }
    else url.pathname = '/' + uriEncode(this.bucket) + path;
    url.search = query;
    return url;
  }
  private full(key: string) { return this.prefix + requireStoreKey(key); }

  /** Sends one signed request. `body` is bytes, or a stream of `length` bytes whose hash is `payloadSha256`. */
  private async send(method: string, url: URL, { headers = {}, body, payloadSha256 = emptySha256, signal }: {
    headers?: Record<string, string>; body?: Uint8Array | ReadableStream<Uint8Array>; payloadSha256?: string; signal: AbortSignal }) {
    const signed = signRequest({ method, url, headers, payloadSha256, region: this.region, credentials: this.#credentials });
    // `identity`: a body arrives as stored, so its length can be checked against `content-length`. Not signed: fetch
    // sets it itself on a request with a `range` (and then adds to one given), so a signed value would not hold.
    if (!('range' in headers)) signed['accept-encoding'] = 'identity';
    // A redirect is never followed: the signed request (and a body) would go elsewhere. It says where the bucket is.
    const response = await fetch(url, { method, headers: signed, signal, redirect: 'manual', ...(body === undefined ? {} : { body, duplex: 'half' }) } as RequestInit);
    if (redirectStatuses.includes(response.status)) await S3Store.fail(response);
    if (response.ok) this.bucketConfirmed = true;
    return response;
  }

  /**
   * Runs one request, reading of its answer included, with retries. `run` is given a signal that also fires when the
   * request goes `timeout` without progress, and `poke` to call on progress.
   */
  private async call<T>(operation: Operation, run: (signal: AbortSignal, poke: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const stall = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poke = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(new StalledError()), this.timeout); };
      poke();
      try { return await run(signal ? AbortSignal.any([signal, stall.signal]) : stall.signal, poke); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        const cause = stall.signal.aborted ? stall.signal.reason : error;
        if (!retryable(cause) || attempt >= this.retries) throw this.describe(cause, operation);
        await wait(this.retryDelay * 2 ** attempt * (0.75 + Math.random() / 2), signal);
      } finally { clearTimeout(timer); }
    }
  }

  /** The error to report for a request that failed for good, in words, without credentials. */
  private describe(error: unknown, operation: Operation) {
    const mismatch = causes(error).find((item) => item instanceof ChecksumMismatchError);
    if (mismatch) return mismatch as Error;
    if (error instanceof S3ResponseError) {
      const bucket = '“' + this.bucket + '”';
      const code = ' (' + (error.code || error.status) + ')';
      const fail = (reason: ConstructorParameters<typeof StoreAccessError>[0], text: string) => new StoreAccessError(reason, text, { cause: error });
      if (error.code === 'ConditionalRequestConflict') return fail('unavailable', 'The bucket ' + bucket + ' is busy with another write of the same object. Sync again.');
      if (error.code === 'RequestTimeTooSkewed') {
        return fail('clock', 'This Mac’s clock is too far off for the bucket to accept its requests' + code + '. Turn on “Set time and date automatically” in System Settings → General → Date & Time.');
      }
      if (redirectStatuses.includes(error.status) || ['PermanentRedirect', 'TemporaryRedirect', 'AuthorizationHeaderMalformed', 'IllegalLocationConstraintException'].includes(error.code)) {
        if (error.region && error.region !== this.region) return fail('settings', 'The bucket ' + bucket + ' is in the region “' + error.region + '”, not “' + this.region + '”' + code + '. Set Region to ' + error.region + ' in Settings → Sync.');
        if (error.endpoint) return fail('settings', 'The bucket ' + bucket + ' is served at ' + error.endpoint + ', not at ' + this.endpoint.host + code + '. Check the endpoint and region in Settings → Sync.');
        return fail('settings', 'The bucket ' + bucket + ' is in another region or at another endpoint' + code + '. Check the endpoint and region in Settings → Sync.');
      }
      if (error.code === 'NoSuchBucket') return fail('settings', 'There is no bucket ' + bucket + ' at ' + this.endpoint.host + code + '. Check its name and the endpoint in Settings → Sync.');
      if (error.code === 'InvalidAccessKeyId') return fail('sign-in', 'Sign-in needed: ' + this.endpoint.host + ' does not know this access key ID' + code + '. Check it in Settings → Sync.');
      if (error.code === 'SignatureDoesNotMatch') return fail('sign-in', 'Sign-in needed: the secret access key does not match the access key ID' + code + '. Enter it again in Settings → Sync.');
      if (error.status === 401 || error.status === 403) {
        return fail('sign-in', 'Sign-in needed: the access key may not ' + operationWords[operation] + ' the bucket ' + bucket + code
          + '. It needs permission to read, write, list and delete objects in the bucket; give it those, or enter another key in Settings → Sync.');
      }
      if (error.status >= 500 || error.status === 429) return fail('unavailable', 'The bucket ' + bucket + ' is not available right now (' + error.status + (error.code ? ' ' + error.code : '') + '). Sync again later.');
      return error;
    }
    if (!networkError(error)) return error;
    const text = error instanceof StalledError ? 'timed out' : error instanceof IncompleteResponseError ? 'sent an incomplete answer' : 'cannot be reached';
    return new StoreAccessError('unavailable', 'The sync bucket at ' + this.endpoint.host + ' ' + text + '. Check the network connection, then sync again.', { cause: error });
  }

  /** Throws the S3 error of a response that is not a success. */
  private static async fail(response: Response): Promise<never> {
    throw await S3Store.failure(response);
  }
  /** The S3 error of a response that is not a success, with the region or endpoint it names, if any. */
  private static async failure(response: Response) {
    const text = await response.text().catch(() => '');
    const message = (tag(text, 'Message') ?? '').slice(0, 300);
    const error = new S3ResponseError(response.status, tag(text, 'Code') ?? '', message);
    const region = response.headers.get('x-amz-bucket-region') ?? tag(text, 'Region') ?? /expecting '([a-z0-9-]+)'/.exec(message)?.[1];
    if (region && /^[a-z0-9-]{1,64}$/.test(region)) error.region = region;
    const endpoint = tag(text, 'Endpoint');
    if (endpoint && /^[A-Za-z0-9.-]{1,255}$/.test(endpoint)) error.endpoint = endpoint;
    return error;
  }
  /**
   * The S3 error code behind an answer without a body (HEAD): the same object read with a body (one byte of it). Also
   * tells a missing key from a missing bucket. Undefined when that read succeeds; then `object` is what it found.
   */
  private async explain(url: URL, signal: AbortSignal) {
    const probe = await this.send('GET', url, { signal, headers: { range: 'bytes=0-0' } });
    if (!probe.ok) return { error: await S3Store.failure(probe) };
    await probe.body?.cancel();
    const total = /\/(\d+)$/.exec(probe.headers.get('content-range') ?? '')?.[1] ?? probe.headers.get('content-length') ?? '0';
    const modified = probe.headers.get('last-modified');
    return { object: { size: Number(total), lastModified: modified ? new Date(modified) : new Date() } };
  }
  /** A 404 of a GET: undefined for a missing key, an error for a missing bucket. */
  private async missing(response: Response) {
    const error = await S3Store.failure(response);
    if (error.code === 'NoSuchBucket') throw error;
    this.bucketConfirmed = true;
    return undefined;
  }

  /** Reads a body to the end, reporting progress; throws when it ends before its `content-length`. */
  private static async readBody(response: Response, poke: () => void, each: (chunk: Uint8Array, received: number, total?: number) => Promise<void> | void) {
    const length = response.headers.get('content-length');
    const total = length === null ? undefined : Number(length);
    let received = 0;
    if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      poke();
      await each(chunk, received, total);
    }
    if (total !== undefined && received !== total) throw new IncompleteResponseError('The object ended before its length.');
    return received;
  }

  async head(key: string, signal?: AbortSignal): Promise<StoreObject | undefined> {
    const url = this.url(this.full(key));
    return this.call('read', async (live) => {
      const response = await this.send('HEAD', url, { signal: live });
      // HEAD has no body to say why: on a store's first 404, and for every refusal, the same read with a body tells.
      if (response.status === 404 && this.bucketConfirmed) return undefined;
      if (response.status >= 500 || response.status === 429) await S3Store.fail(response);
      if (!response.ok) {
        const answer = await this.explain(url, live);
        if (answer.object) return answer.object;
        if (answer.error.status === 404 && answer.error.code !== 'NoSuchBucket') { this.bucketConfirmed = true; return undefined; }
        throw answer.error;
      }
      const modified = response.headers.get('last-modified');
      return { size: Number(response.headers.get('content-length') ?? 0), lastModified: modified ? new Date(modified) : new Date() };
    }, signal);
  }

  async putIfAbsent(key: string, source: StoreSource, { sha256, signal, onProgress }: PutOptions = {}) {
    const full = this.full(key);
    signal?.throwIfAborted();
    const bytes = source instanceof Uint8Array ? new Uint8Array(source) : undefined;
    const file = bytes ? undefined : (source as { file: string }).file;
    const size = bytes ? bytes.length : (await stat(file!)).size;
    // One PUT holds at most 5 GiB, and there is no multipart upload: refused before anything is sent.
    if (size > maxObjectSize) {
      throw new Error('“' + (file ? basename(file) : key) + '” is ' + (size / 1024 ** 3).toFixed(1) + ' GiB, more than the 5 GiB one upload to a bucket can hold, so it is not synced.');
    }
    // Looked at first, so a large original that is there already is not uploaded to find that out, and so nothing is
    // replaced at a service not known to refuse it.
    const small = !!bytes && size <= S3Store.smallObject;
    const looked = !(small && this.conditionalWrites && this.enforced);
    if (looked && await this.head(key, signal)) return { existed: true };
    let digest: string;
    if (bytes) {
      digest = sha256Hex(bytes);
      if (sha256 !== undefined && sha256 !== digest) throw new Error('An object does not have the SHA-256 it was stored with: ' + key);
    } else {
      digest = sha256 ?? await fileSha256(file!, signal).catch((error) => { signal?.throwIfAborted(); throw error; });
    }
    signal?.throwIfAborted();
    const report = monotonic(onProgress);
    const existed = await this.put(full, { bytes, file, size, digest, signal, report, key, looked });
    // The same bytes again, once: a service that enforces the condition refuses them (`enforced`), and one that ignores it
    // puts what is there already. The object is stored whatever comes of it.
    if (small && !existed && this.conditionalWrites && !this.enforced && ++this.smallPuts === S3Store.proveAfter) {
      await this.put(full, { bytes, size, digest, signal, key }).catch(() => {});
    }
    if (!existed) report(size, size);
    return { existed };
  }

  /** One conditional PUT (a plain one where the service refused the condition); true when the object was there. */
  private async put(full: string, { bytes, file, size, digest, claimed = digest, signal, report = () => {}, key = full, conditional = this.conditionalWrites, looked = true }: {
    bytes?: Uint8Array; file?: string; size: number; digest: string; claimed?: string; signal?: AbortSignal; report?: (n: number, total?: number) => void; key?: string; conditional?: boolean; looked?: boolean;
  }): Promise<boolean> {
    const url = this.url(full);
    const attempt = (withCondition: boolean) => this.call('write', async (live, poke): Promise<'stored' | 'existed' | S3ResponseError> => {
      const body = bytes ?? (size === 0 ? new Uint8Array() : verifiedFile(file!, size, digest, key, (sent) => { poke(); report(sent, size); }));
      const response = await this.send('PUT', url, { signal: live, body, payloadSha256: claimed,
        headers: { 'content-length': String(size), ...(withCondition ? { 'if-none-match': '*' } : {}) } });
      if (response.ok) { await response.body?.cancel(); return 'stored' as const; }
      if (response.status === 412) { this.enforced ||= withCondition; await response.body?.cancel(); return 'existed' as const; }
      const error = await S3Store.fail(response).catch((failure: S3ResponseError) => failure);
      // Perhaps the condition is refused: tried again without it, by the caller.
      if (withCondition && (response.status === 501 || (response.status === 400 && ['NotImplemented', 'InvalidArgument', 'InvalidRequest'].includes(error.code)))) return error;
      if (response.status === 400 && ['XAmzContentSHA256Mismatch', 'BadDigest', 'InvalidDigest'].includes(error.code)) throw new ChecksumMismatchError('An object does not have the SHA-256 it was stored with: ' + key, { cause: error });
      throw error;
    }, signal);
    const outcome = await attempt(conditional);
    if (!(outcome instanceof S3ResponseError)) return outcome === 'existed';
    // A put sent without a look looks now: nothing is replaced by a plain one.
    if (!looked && await this.head(key, signal)) return true;
    // The look before found nothing, so the put is tried plainly. Conditional writes go off for this store only when
    // that works, or when the refusal named the condition: a 400 for another reason leaves them on.
    const named = outcome.status === 501 || /if-none-match|conditional/i.test(outcome.message);
    let plain: 'stored' | 'existed' | S3ResponseError;
    try { plain = await attempt(false); }
    catch (error) { if (named) this.conditionalWrites = false; throw error; }
    if (plain instanceof S3ResponseError) throw plain;
    this.conditionalWrites = false;
    return plain === 'existed';
  }

  async get(key: string, { signal, onProgress }: TransferOptions = {}) {
    const url = this.url(this.full(key));
    const report = monotonic(onProgress);
    const bytes = await this.call('read', async (live, poke) => {
      const response = await this.send('GET', url, { signal: live });
      if (response.status === 404) return this.missing(response);
      if (!response.ok) await S3Store.fail(response);
      const chunks: Uint8Array[] = [];
      const received = await S3Store.readBody(response, poke, (chunk, done, total) => { chunks.push(chunk); report(done, total); });
      const whole = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { whole.set(chunk, offset); offset += chunk.length; }
      return whole;
    }, signal);
    if (bytes) report(bytes.length, bytes.length);
    return bytes;
  }

  async download(key: string, file: string, { signal, onProgress }: TransferOptions = {}) {
    const url = this.url(this.full(key));
    const report = monotonic(onProgress);
    const size = await this.call('read', async (live, poke) => {
      const response = await this.send('GET', url, { signal: live });
      if (response.status === 404) return this.missing(response);
      if (!response.ok) await S3Store.fail(response);
      const staging = join(dirname(file), '.sync-' + randomUUID() + '.tmp');
      try {
        const handle = await open(staging, 'wx', 0o644);
        let received: number;
        try { received = await S3Store.readBody(response, poke, async (chunk, done, total) => { await handle.write(chunk); report(done, total); }); }
        finally { await handle.close(); }
        live.throwIfAborted();
        await rename(staging, file);
        return received;
      } finally { await rm(staging, { force: true }); }
    }, signal);
    if (size === undefined) return false;
    report(size, size);
    return true;
  }

  /** One listing of `prefix` (a full key prefix), every page; with `delimiter`, the common prefixes instead of the objects. */
  private async listAll(prefix: string, delimiter: boolean) {
    const objects: StoreEntry[] = [];
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const query = 'list-type=2&max-keys=' + this.pageSize + '&prefix=' + uriEncode(prefix) + (delimiter ? '&delimiter=%2F' : '') + (token ? '&continuation-token=' + uriEncode(token) : '');
      const page = await this.call('list', async (live) => {
        const response = await this.send('GET', this.url(undefined, query), { signal: live });
        if (!response.ok) await S3Store.fail(response);
        const xml = await response.text();
        if (!/<ListBucketResult[\s>]/.test(xml) || !xml.includes('</ListBucketResult>')) throw new IncompleteResponseError('The bucket sent an incomplete listing.');
        const truncated = tag(xml, 'IsTruncated') === 'true';
        const next = tag(xml, 'NextContinuationToken');
        if (truncated && !next) throw new IncompleteResponseError('The bucket sent a listing that is cut short.');
        return { xml, next: truncated ? next : undefined };
      });
      for (const item of tags(page.xml, 'Contents')) {
        const key = tag(item, 'Key');
        if (key === undefined || !key.startsWith(this.prefix)) continue;
        const etag = tag(item, 'ETag');
        objects.push({ key: key.slice(this.prefix.length), size: Number(tag(item, 'Size') ?? 0), lastModified: new Date(tag(item, 'LastModified') ?? 0), ...(etag ? { etag } : {}) });
      }
      for (const item of tags(page.xml, 'CommonPrefixes')) {
        const child = tag(item, 'Prefix');
        if (child?.startsWith(this.prefix)) prefixes.push(child.slice(this.prefix.length));
      }
      token = page.next;
    } while (token);
    return { objects, prefixes };
  }

  async list(prefix: string) {
    const { objects } = await this.listAll(this.prefix + requireStorePrefix(prefix), false);
    // Objects that are no store keys (a folder marker `name/`, a file a person put there) are not listed.
    return objects.filter(({ key }) => isStoreKey(key)).sort((a, b) => order(a.key, b.key));
  }

  async listPrefixes(prefix: string) {
    const { prefixes } = await this.listAll(this.prefix + requireStorePrefix(prefix), true);
    return [...new Set(prefixes.filter((child) => child.endsWith('/') && isStoreKey(child.slice(0, -1))))].sort(order);
  }

  async copy(from: string, to: string) {
    const source = '/' + uriEncode(this.bucket) + '/' + uriEncode(this.full(from), true);
    const url = this.url(this.full(to));
    return this.call('write', async (live) => {
      const response = await this.send('PUT', url, { signal: live, headers: { 'x-amz-copy-source': source } });
      if (response.status === 404) return this.missing(response).then(() => false);
      if (!response.ok) await S3Store.fail(response);
      const text = await response.text();
      // A copy can fail after the service answered 200: the error is then the body.
      if (/<Error[\s>]/.test(text)) {
        const code = tag(text, 'Code') ?? '';
        if (code === 'NoSuchKey') return false;
        throw new S3ResponseError(code === 'InternalError' || code === 'SlowDown' ? 500 : 400, code, (tag(text, 'Message') ?? '').slice(0, 300));
      }
      return true;
    });
  }

  async delete(keys: readonly string[]) {
    const full = [...new Set(keys.map((key) => this.full(key)))];
    // DeleteObjects takes at most 1,000 keys a request.
    for (let index = 0; index < full.length; index += 1000) {
      const body = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>' +
        full.slice(index, index + 1000).map((key) => '<Object><Key>' + xmlEncode(key) + '</Key></Object>').join('') + '</Delete>');
      const headers = { 'content-type': 'application/xml', 'content-length': String(body.length), 'content-md5': createHash('md5').update(body).digest('base64') };
      await this.call('delete', async (live) => {
        const response = await this.send('POST', this.url(undefined, 'delete='), { signal: live, body, headers, payloadSha256: sha256Hex(body) });
        if (!response.ok) await S3Store.fail(response);
        const text = await response.text();
        const errors = tags(text, 'Error').filter((item) => tag(item, 'Code') !== 'NoSuchKey');
        if (errors.length) throw new S3ResponseError(400, tag(errors[0], 'Code') ?? '', 'Could not delete ' + errors.length + (errors.length === 1 ? ' object.' : ' objects.'));
      });
    }
  }

  /**
   * The connection test of Settings → Sync: puts, reads, lists and deletes a probe object under the prefix, then asks
   * whether the service enforces `If-None-Match: *` and checks the SHA-256 of an upload. Leaves nothing behind.
   */
  async testConnection(): Promise<ConnectionReport> {
    const base = 'imageflow-connection-test/' + randomUUID();
    const probe = base + '/probe';
    const unchecked = base + '/checksum';
    const bytes = new TextEncoder().encode('ImageFlow connection test ' + new Date().toISOString());
    try {
      if ((await this.putIfAbsent(probe, bytes, { sha256: sha256Hex(bytes) })).existed) throw new Error('The connection test found its own probe object before writing it.');
      if ((await this.head(probe))?.size !== bytes.length) throw new Error('The bucket does not show the object that was just stored.');
      if (!(await this.list(base + '/')).some(({ key }) => key === probe)) throw new Error('The bucket does not list the object that was just stored.');
      const got = await this.get(probe);
      if (!got || sha256Hex(got) !== sha256Hex(bytes)) throw new Error('The bucket returned other bytes than were stored.');
      let conditionalWrites: ConnectionReport['conditionalWrites'] = 'unsupported';
      if (this.conditionalWrites) {
        const other = new TextEncoder().encode('replaced');
        const existed = await this.put(this.full(probe), { bytes: other, size: other.length, digest: sha256Hex(other), conditional: true, key: probe });
        conditionalWrites = existed ? 'enforced' : this.conditionalWrites ? 'ignored' : 'unsupported';
      }
      // Signed with the SHA-256 of other bytes: a service that checks refuses it.
      const claimed = sha256Hex(new TextEncoder().encode('not these bytes'));
      let checksums: ConnectionReport['checksums'] = 'not-verified';
      try { await this.put(this.full(unchecked), { bytes, size: bytes.length, digest: sha256Hex(bytes), claimed, conditional: false, key: unchecked }); }
      catch (error) {
        if (!(error instanceof ChecksumMismatchError) && !(error instanceof S3ResponseError && error.status === 400)) throw error;
        checksums = 'verified';
      }
      return { conditionalWrites, checksums, addressing: this.addressing };
    } finally {
      await this.delete([probe, unchecked]).catch(() => {});
    }
  }
}

/**
 * A file as a request body of `size` bytes that are checked against `digest` as they are sent. The last chunk is held
 * back until the whole file matched, so a file that changed since it was hashed never reaches the service whole and
 * nothing is stored.
 */
function verifiedFile(file: string, size: number, digest: string, key: string, sent: (bytes: number) => void): ReadableStream<Uint8Array> {
  const hash = createHash('sha256');
  let read = 0, passed = 0;
  let held: Uint8Array | undefined;
  const mismatch = () => new ChecksumMismatchError('An object does not have the SHA-256 it was stored with: ' + key);
  return (Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      read += chunk.length;
      if (read > size) throw mismatch();
      if (held) { controller.enqueue(held); passed += held.length; sent(passed); }
      held = chunk;
    },
    flush(controller) {
      if (read !== size || hash.digest('hex') !== digest) throw mismatch();
      if (held) { controller.enqueue(held); sent(passed + held.length); }
    },
  }));
}
