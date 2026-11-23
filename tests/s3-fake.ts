import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { canonicalRequest, sha256Hex, signingKey } from '../desktop/sync-s3-signer';
import type { S3Credentials } from '../desktop/sync-s3-signer';

// A stand-in for an S3-compatible service, over real HTTP on this Mac, as tests/lightroom-fake.ts is for Lightroom.
// It keeps buckets in memory, path style (`/<bucket>/<key>`), and is strict where S3 is: it checks every request's
// SigV4 signature and the SHA-256 the request was signed with, needs a length on every upload, and checks DeleteObjects
// for its Content-MD5 and its 1,000-key limit. Faults are queued with `fail` and taken by the next matching request.

export type FakeObject = { bytes: Uint8Array; lastModified: Date; etag: string };
export type Fault =
  /** An S3 error; `region` goes in `x-amz-bucket-region` and the body, `location` in a 3xx's `Location`. */
  | { status: number; code?: string; message?: string; region?: string; endpoint?: string; location?: string }
  /** The connection closes before any answer. */
  | 'drop'
  /** The connection closes when half of an upload has arrived; nothing is stored. */
  | 'drop-mid-upload'
  /** A listing says it is truncated but gives no token to go on. */
  | 'truncate-listing'
  /** A listing whose XML ends half-way. */
  | 'cut-listing'
  /** A download that ends half-way through the object. */
  | 'cut-body'
  /** No answer at all until the client gives up. */
  | 'hang';
type Queued = { fault: Fault; method?: string; match?: RegExp; times: number };
export type FakeRequest = { method: string; bucket: string; key: string; query: URLSearchParams; headers: IncomingMessage['headers']; status?: number };

export const fakeCredentials: S3Credentials = { accessKeyId: 'AKIAFAKEFAKEFAKE0001', secretAccessKey: 'fake/secret+KEY/never-in-output-0123456789' };

const seconds = () => new Date(Math.floor(Date.now() / 1000) * 1000);
const xml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const unxml = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]!);

export class FakeS3 {
  readonly buckets = new Map<string, Map<string, FakeObject>>();
  readonly requests: FakeRequest[] = [];
  /** `enforced`: `If-None-Match: *` refuses an existing key (412). `ignored`: the header is ignored, as by a service
   * without conditional writes that does not say so. `rejected`: the header is refused (501). */
  conditional: 'enforced' | 'ignored' | 'rejected' = 'enforced';
  /** Whether an upload whose bytes do not have the SHA-256 it was signed with is refused. */
  checksums: 'verified' | 'ignored' = 'verified';
  /** The most keys a listing page holds, whatever `max-keys` asks. */
  pageSize = 1000;
  credentials: S3Credentials = fakeCredentials;
  region = 'us-east-1';
  /** Milliseconds this server's clock is ahead of the Mac's, for a request that is too far off. */
  clockOffset = 0;
  private faults: Queued[] = [];
  private server?: Server;
  url = '';

  async start() {
    this.server = createServer((request, response) => void this.handle(request, response).catch((error) => {
      if (!response.headersSent) this.error(response, 500, 'InternalError', String(error));
      else response.destroy();
    }));
    this.server.keepAliveTimeout = 1000;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    return this;
  }
  async close() {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }
  /** Lets the process end while the server still runs (one server shared by many tests). */
  unref() { this.server?.unref(); return this; }

  bucket(name: string) {
    let bucket = this.buckets.get(name);
    if (!bucket) this.buckets.set(name, bucket = new Map());
    return bucket;
  }
  /** Queues a fault for the next `times` requests that match `method` and the path and query (`/<bucket>/<key>?…`). */
  fail(fault: Fault, { method, match, times = 1 }: { method?: string; match?: RegExp; times?: number } = {}) {
    this.faults.push({ fault, method, match, times });
  }
  private takeFault(method: string, target: string) {
    const index = this.faults.findIndex((queued) => (!queued.method || queued.method === method) && (!queued.match || queued.match.test(target)));
    if (index < 0) return undefined;
    const queued = this.faults[index];
    if (--queued.times <= 0) this.faults.splice(index, 1);
    return queued.fault;
  }

  private error(response: ServerResponse, status: number, code: string, message = '', { region, endpoint, location }: { region?: string; endpoint?: string; location?: string } = {}) {
    const body = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>' + code + '</Code><Message>' + xml(message) + '</Message>'
      + (region ? '<Region>' + region + '</Region>' : '') + (endpoint ? '<Endpoint>' + endpoint + '</Endpoint>' : '') + '</Error>';
    response.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body),
      ...(region ? { 'x-amz-bucket-region': region } : {}), ...(location ? { location } : {}) }).end(body);
  }

  /** Checks a request's SigV4 signature the way S3 does; undefined when it is right. */
  private verify(request: IncomingMessage, url: URL) {
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(request.headers.authorization ?? '');
    if (!match) return ['AccessDenied', 'No SigV4 authorization.'];
    const [, accessKeyId, day, region, signedHeaders, signature] = match;
    if (accessKeyId !== this.credentials.accessKeyId) return ['InvalidAccessKeyId', 'The access key does not exist.'];
    const date = String(request.headers['x-amz-date'] ?? '');
    if (!date.startsWith(day)) return ['AuthorizationHeaderMalformed', 'The credential scope is wrong.'];
    // As S3 answers a request signed for another region: 400, naming the right one.
    if (region !== this.region) return ['AuthorizationHeaderMalformed', "The authorization header is malformed; the region '" + region + "' is wrong; expecting '" + this.region + "'", 400];
    const names = signedHeaders.split(';');
    for (const required of ['host', 'x-amz-date', 'x-amz-content-sha256']) if (!names.includes(required)) return ['AccessDenied', 'Unsigned ' + required + '.'];
    const time = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15));
    if (Math.abs(Date.now() + this.clockOffset - time) > 15 * 60_000) return ['RequestTimeTooSkewed', 'The request time is too far off.'];
    const headers = Object.fromEntries(names.map((name) => [name, String(request.headers[name] ?? '')]));
    const canonical = canonicalRequest(request.method!, url, headers, String(request.headers['x-amz-content-sha256']));
    const scope = day + '/' + region + '/s3/aws4_request';
    const expected = createHmac('sha256', signingKey(this.credentials.secretAccessKey, day, region)).update(['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonical)].join('\n')).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) return ['SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.'];
    return undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, 'http://' + request.headers.host);
    const method = request.method!;
    const [, bucketName = '', ...rest] = url.pathname.split('/');
    const bucket = decodeURIComponent(bucketName);
    const key = rest.map(decodeURIComponent).join('/');
    const log: FakeRequest = { method, bucket, key, query: url.searchParams, headers: request.headers };
    this.requests.push(log);
    const end = (status: number) => { log.status = status; };
    const fault = this.takeFault(method, url.pathname + url.search);
    if (fault === 'drop') { request.socket.destroy(); return; }
    if (fault === 'hang') return;
    if (fault && typeof fault === 'object') {
      end(fault.status);
      await drain(request);
      return this.error(response, fault.status, fault.code ?? (fault.status === 403 ? 'AccessDenied' : fault.status === 503 ? 'SlowDown' : 'InternalError'), fault.message, fault);
    }

    const length = request.headers['content-length'];
    if ((method === 'PUT' || method === 'POST') && length === undefined && !request.headers['x-amz-copy-source']) {
      await drain(request); end(411); return this.error(response, 411, 'MissingContentLength', 'You must provide the Content-Length HTTP header.');
    }
    // The body is read before the signature is checked, as S3 does for the payload hash.
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
      received += (chunk as Buffer).length;
      if (fault === 'drop-mid-upload' && received >= Number(length) / 2) { request.socket.destroy(); return; }
    }
    const body = Buffer.concat(chunks);
    const denied = this.verify(request, url);
    if (denied) {
      const status = Number(denied[2] ?? 403);
      end(status);
      return this.error(response, status, String(denied[0]), String(denied[1]), denied[0] === 'AuthorizationHeaderMalformed' && status === 400 ? { region: this.region } : {});
    }
    const claimed = String(request.headers['x-amz-content-sha256']);
    if (this.checksums === 'verified' && claimed !== 'UNSIGNED-PAYLOAD' && claimed !== sha256Hex(body)) {
      end(400); return this.error(response, 400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed.');
    }
    const objects = this.buckets.get(bucket);
    if (!objects) { end(404); return this.error(response, 404, 'NoSuchBucket', 'The specified bucket does not exist.'); }

    if (!key) {
      if (method === 'GET' && url.searchParams.get('list-type') === '2') { end(200); return this.list(response, objects, url.searchParams, fault); }
      if (method === 'POST' && url.searchParams.has('delete')) return this.deleteObjects(response, objects, body, request, end);
      end(400); return this.error(response, 400, 'InvalidRequest', 'Not supported by the fake.');
    }
    const object = objects.get(key);
    if (method === 'HEAD' || method === 'GET') {
      if (!object) { end(404); if (method === 'HEAD') return response.writeHead(404).end(); return this.error(response, 404, 'NoSuchKey', 'The specified key does not exist.'); }
      end(200);
      response.writeHead(200, { 'content-length': object.bytes.length, 'last-modified': object.lastModified.toUTCString(), etag: object.etag, 'content-type': 'application/octet-stream' });
      if (method === 'HEAD') return response.end();
      if (fault === 'cut-body') { response.write(object.bytes.subarray(0, Math.floor(object.bytes.length / 2))); response.socket?.destroy(); return; }
      return response.end(object.bytes);
    }
    if (method === 'PUT') {
      const copySource = request.headers['x-amz-copy-source'];
      if (copySource) {
        const [, sourceBucket = '', ...sourceKey] = decodeURIComponent(String(copySource)).split('/');
        const source = this.buckets.get(sourceBucket)?.get(sourceKey.join('/'));
        if (!source) { end(404); return this.error(response, 404, 'NoSuchKey', 'The specified key does not exist.'); }
        const copy = { bytes: new Uint8Array(source.bytes), lastModified: seconds(), etag: source.etag };
        objects.set(key, copy);
        end(200);
        const result = '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><LastModified>' + copy.lastModified.toISOString() + '</LastModified><ETag>' + xml(copy.etag) + '</ETag></CopyObjectResult>';
        return response.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(result) }).end(result);
      }
      if (request.headers['if-none-match'] !== undefined) {
        if (this.conditional === 'rejected') { end(501); return this.error(response, 501, 'NotImplemented', 'A header you provided implies functionality that is not implemented.'); }
        if (this.conditional === 'enforced' && objects.has(key)) { end(412); return this.error(response, 412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.'); }
      }
      const etag = '"' + createHash('md5').update(body).digest('hex') + '"';
      objects.set(key, { bytes: new Uint8Array(body), lastModified: seconds(), etag });
      end(200);
      return response.writeHead(200, { etag, 'content-length': 0 }).end();
    }
    end(405);
    return this.error(response, 405, 'MethodNotAllowed', 'Not supported by the fake.');
  }

  private list(response: ServerResponse, objects: Map<string, FakeObject>, query: URLSearchParams, fault: Fault | undefined) {
    const prefix = query.get('prefix') ?? '';
    const delimiter = query.get('delimiter') ?? '';
    const limit = Math.min(Number(query.get('max-keys') ?? 1000), this.pageSize);
    const after = query.has('continuation-token') ? Buffer.from(query.get('continuation-token')!, 'base64url').toString('utf8') : '';
    // Objects and common prefixes in one order, as S3 pages them.
    const entries = new Map<string, { prefix?: string; object?: [string, FakeObject] }>();
    for (const entry of [...objects].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const end = delimiter ? entry[0].indexOf(delimiter, prefix.length) : -1;
      if (end >= 0) { const common = entry[0].slice(0, end + delimiter.length); if (!entries.has(common)) entries.set(common, { prefix: common }); }
      else entries.set(entry[0], { object: entry });
    }
    const all = [...entries].filter(([name]) => name > after);
    const page = all.slice(0, limit);
    const truncated = all.length > page.length;
    const token = truncated ? Buffer.from(page.at(-1)![0], 'utf8').toString('base64url') : '';
    let body = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Prefix>' + xml(prefix) + '</Prefix><KeyCount>' + page.length + '</KeyCount><MaxKeys>' + limit + '</MaxKeys>'
      + (delimiter ? '<Delimiter>' + xml(delimiter) + '</Delimiter>' : '') + '<IsTruncated>' + (truncated || fault === 'truncate-listing') + '</IsTruncated>'
      + (truncated && fault !== 'truncate-listing' ? '<NextContinuationToken>' + token + '</NextContinuationToken>' : '');
    for (const [, { prefix: common, object }] of page) {
      body += common ? '<CommonPrefixes><Prefix>' + xml(common) + '</Prefix></CommonPrefixes>'
        : '<Contents><Key>' + xml(object![0]) + '</Key><LastModified>' + object![1].lastModified.toISOString() + '</LastModified><ETag>' + xml(object![1].etag) + '</ETag><Size>' + object![1].bytes.length + '</Size><StorageClass>STANDARD</StorageClass></Contents>';
    }
    body += '</ListBucketResult>';
    if (fault === 'cut-listing') body = body.slice(0, Math.floor(body.length / 2));
    response.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) }).end(body);
  }

  private deleteObjects(response: ServerResponse, objects: Map<string, FakeObject>, body: Buffer, request: IncomingMessage, end: (status: number) => void) {
    const md5 = request.headers['content-md5'];
    if (!md5) { end(400); return this.error(response, 400, 'InvalidRequest', 'Missing required header for this request: Content-MD5.'); }
    if (md5 !== createHash('md5').update(body).digest('base64')) { end(400); return this.error(response, 400, 'BadDigest', 'The Content-MD5 you specified did not match what was received.'); }
    const text = body.toString('utf8');
    const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => unxml(match[1]));
    if (keys.length > 1000) { end(400); return this.error(response, 400, 'MalformedXML', 'More than 1,000 keys.'); }
    for (const key of keys) objects.delete(key);
    end(200);
    const quiet = /<Quiet>true<\/Quiet>/.test(text);
    const result = '<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' + (quiet ? '' : keys.map((key) => '<Deleted><Key>' + xml(key) + '</Key></Deleted>').join('')) + '</DeleteResult>';
    return response.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(result) }).end(result);
  }
}

async function drain(request: IncomingMessage) { for await (const _ of request) { /* discard */ } }
