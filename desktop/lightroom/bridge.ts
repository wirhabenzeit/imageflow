import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isLightroomIdentifier } from '../../src/source-locator';

/**
 * The loopback bridge to the ImageFlow plugin in Lightroom Classic (ADR 0011, section 5). Lightroom's `LrHttp` can only
 * make requests, so ImageFlow is the server and the plugin the client: it says hello with the catalog it has open,
 * long-polls for jobs, posts each job's result, and posts the photos whose revision moved and the photos the user sends.
 *
 * What keeps other software out:
 * - The server listens on 127.0.0.1 only, on a port the system picks, so nothing off this Mac reaches it.
 * - Every request carries a bearer token that ImageFlow makes at start and writes, with the port, into a file only this
 *   user can read (mode 0600). Local web pages cannot read it, nor can other accounts. The comparison takes the same time
 *   whatever the token sent, and the token is never logged or put into an error.
 * - The `Host` header must name exactly 127.0.0.1 and the port: a web page that rebinds a DNS name to 127.0.0.1 sends its
 *   own name there. There is no CORS: no request is answered with an `Access-Control-*` header.
 * - Bodies are bounded, and every identifier and path the plugin sends is checked where it is used.
 */

/** Where the plugin finds the bridge: the port and token of this run of ImageFlow. */
export type BridgeFile = { port: number; token: string; pid: number; version: string };
export type LightroomConnection = {
  /** The open catalog's identity, which the plugin keeps in the catalog itself (never its path). */
  catalog: { id: string; name?: string };
  plugin: { version: string };
  lightroom?: string;
};
/** The photos the user sent from Lightroom with File → Plug-in Extras → Send to ImageFlow. */
export type SentPhotos = { catalog: string; photos: { uuid: string; name?: string }[] };

/** The plugin is not connected, or stopped answering: the photos it serves are offline. */
export class LightroomOffline extends Error {
  constructor(message = 'Lightroom Classic is not running, or the ImageFlow plugin is not connected.') { super(message); this.name = 'LightroomOffline'; }
}

export type BridgeOptions = {
  /** The file the plugin reads the port and token from (mode 0600). */
  file: string;
  /** This app's version, for the plugin to show. */
  version: string;
  /** How long a poll is held when there is no job, in ms. */
  hold?: number;
  /** How long the plugin may go without a request, between polls, before it counts as gone, in ms. */
  grace?: number;
  /** How long after a poll's connection broke before the plugin counts as gone, in ms (it may just poll again). */
  closeGrace?: number;
  /** The largest request body accepted, in bytes. */
  maximumBody?: number;
};

type Job = { id: string; type: string; payload: Record<string, unknown>; session?: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
type Poll = { session: string; response: ServerResponse; timer: NodeJS.Timeout };

const json = (response: ServerResponse, status: number, body: unknown) => {
  if (response.writableEnded || response.destroyed) return;
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  response.end(text);
};
// Both sides hashed first, so the comparison takes the same time for a token of any length.
const sameToken = (sent: string, token: string) => timingSafeEqual(createHash('sha256').update(sent).digest(), createHash('sha256').update(token).digest());
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shortText = (value: unknown, length = 200) => typeof value === 'string' && value.length <= length && !/[\x00-\x1f]/.test(value) ? value : undefined;

/** Writes the bridge file so that it is never readable by anyone else, not even for a moment, and never half written. */
export async function writeBridgeFile(file: string, contents: BridgeFile) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    // The mode given to open is reduced by the umask, never widened; set it once more in case the file system ignores it.
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(contents) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  if (((await stat(file)).mode & 0o077) !== 0) throw new Error('The Lightroom bridge file is readable by others.');
}

export class LightroomBridge {
  private server?: Server;
  private token = '';
  private port = 0;
  private session?: string;
  private current?: LightroomConnection;
  private poll?: Poll;
  // Until when the plugin counts as connected without another request; Infinity while a poll is held.
  private deadline = 0;
  private checker?: NodeJS.Timeout;
  private queue: Job[] = [];
  private taken = new Map<string, Job>();
  private tracked = new Map<object, string[]>();
  private trackedSet: string[] = [];
  private connectionListeners = new Set<() => void>();
  private changeListeners = new Set<(uuids: string[]) => void>();
  private sendListeners = new Set<(sent: SentPhotos) => void>();
  private readonly hold: number;
  private readonly grace: number;
  private readonly closeGrace: number;
  private readonly maximumBody: number;

  constructor(private readonly options: BridgeOptions) {
    this.hold = options.hold ?? 25_000;
    this.grace = options.grace ?? 10_000;
    this.closeGrace = options.closeGrace ?? 3_000;
    this.maximumBody = options.maximumBody ?? 4 * 1024 * 1024;
  }

  /** The address the plugin reaches, once started. */
  get address() { return this.server ? { host: '127.0.0.1', port: this.port } : undefined; }
  /** The connected plugin and the catalog it has open, or undefined while none is connected. */
  get connection(): LightroomConnection | undefined { return this.current; }

  /** Starts listening on an ephemeral loopback port and writes the bridge file with a new token. */
  async start() {
    if (this.server) return;
    this.token = randomBytes(32).toString('base64url');
    const server = createServer((request, response) => void this.handle(request, response).catch(() => json(response, 500, { error: 'The request failed.' })));
    // A request that stalls is cut off; a poll is held for less than this.
    server.requestTimeout = this.hold + 30_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 50;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Only the loopback address: never 0.0.0.0, never an IPv6 wildcard.
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    try { await writeBridgeFile(this.options.file, { port: this.port, token: this.token, pid: process.pid, version: this.options.version }); }
    catch (error) { await this.stop(); throw error; }
    this.checker = setInterval(() => this.checkAlive(), 1000);
    this.checker.unref();
  }

  /** Stops the server, ends the connection and removes the bridge file if it is still this run's. */
  async stop() {
    clearInterval(this.checker);
    this.checker = undefined;
    this.disconnect(new LightroomOffline('ImageFlow is closing.'));
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    // Another run of ImageFlow may have written its own file meanwhile; only this run's is removed.
    const written = await readFile(this.options.file, 'utf8').then((text) => JSON.parse(text) as Partial<BridgeFile>, () => undefined);
    if (written?.token === this.token) await rm(this.options.file, { force: true });
    this.token = '';
  }

  onConnection(listener: () => void) { this.connectionListeners.add(listener); return () => { this.connectionListeners.delete(listener); }; }
  onChanges(listener: (uuids: string[]) => void) { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; }
  onSend(listener: (sent: SentPhotos) => void) { this.sendListeners.add(listener); return () => { this.sendListeners.delete(listener); }; }

  /** Resolves true once a plugin is connected, or false after `timeout` ms. */
  waitForConnection(timeout: number): Promise<boolean> {
    if (this.current) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { stop(); resolve(false); }, timeout);
      timer.unref();
      const stop = this.onConnection(() => { if (!this.current) return; clearTimeout(timer); stop(); resolve(true); });
    });
  }

  /**
   * Asks the plugin to run a job and resolves with its result. Rejects with `LightroomOffline` when no plugin is connected
   * or it goes away before answering, and with an error after `timeout` ms or when `signal` aborts.
   */
  request<T>(type: string, payload: Record<string, unknown>, { timeout = 60_000, signal }: { timeout?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (!this.current) return Promise.reject(new LightroomOffline());
    if (signal?.aborted) return Promise.reject(new Error('Cancelled.'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { id: randomUUID(), type, payload, resolve: resolve as (value: unknown) => void, reject };
      const settle = () => { clearTimeout(job.timer); this.taken.delete(job.id); this.queue = this.queue.filter((queued) => queued !== job); signal?.removeEventListener('abort', aborted); };
      const aborted = () => { settle(); reject(new Error('Cancelled.')); };
      job.resolve = (value) => { settle(); resolve(value as T); };
      job.reject = (error) => { settle(); reject(error); };
      job.timer = setTimeout(() => job.reject(new Error('Lightroom Classic did not answer in time.')), timeout);
      job.timer.unref();
      signal?.addEventListener('abort', aborted, { once: true });
      this.queue.push(job);
      this.deliver();
    });
  }

  /**
   * The photos an owner (one open book) wants the plugin to poll for changes; returns a function that stops. The plugin
   * polls the union of all owners' photos, and nothing while there are none (ADR 0011, §3.6).
   */
  track(owner: object, uuids: readonly string[]): () => void {
    this.tracked.set(owner, uuids.filter(isLightroomIdentifier));
    this.retrack();
    return () => { if (this.tracked.delete(owner)) this.retrack(); };
  }
  /** The photos the plugin is asked to poll. */
  get trackedPhotos(): readonly string[] { return this.trackedSet; }

  private retrack() {
    const next = [...new Set([...this.tracked.values()].flat())].sort();
    if (next.join() === this.trackedSet.join()) return;
    this.trackedSet = next;
    // Only the latest list matters: one not yet taken is replaced.
    for (const job of this.queue.filter(({ type }) => type === 'watch')) job.resolve(undefined);
    if (this.current) void this.request('watch', { uuids: next }, { timeout: 30_000 }).catch(() => {});
  }

  private emitConnection() { for (const listener of [...this.connectionListeners]) listener(); }

  private disconnect(error: Error) {
    const was = this.current;
    this.current = undefined;
    this.session = undefined;
    if (this.poll) { clearTimeout(this.poll.timer); json(this.poll.response, 200, { jobs: [] }); this.poll = undefined; }
    for (const job of [...this.queue, ...this.taken.values()]) job.reject(error);
    if (was) this.emitConnection();
  }

  private checkAlive() {
    if (this.current && Date.now() > this.deadline) this.disconnect(new LightroomOffline('Lightroom Classic stopped responding.'));
  }

  // Hands queued jobs to the poll that is held, if any.
  private deliver() {
    const poll = this.poll;
    if (!poll || !this.queue.length || poll.session !== this.session) return;
    this.poll = undefined;
    clearTimeout(poll.timer);
    const jobs = this.queue.splice(0);
    for (const job of jobs) { job.session = poll.session; this.taken.set(job.id, job); }
    this.deadline = Date.now() + this.grace;
    json(poll.response, 200, { jobs: jobs.map(({ id, type, payload }) => ({ ...payload, id, type })) });
  }

  private async body(request: IncomingMessage): Promise<unknown> {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared > this.maximumBody) throw Object.assign(new Error('Too large.'), { status: 413 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > this.maximumBody) throw Object.assign(new Error('Too large.'), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    // DNS rebinding: a page that resolves its own name to 127.0.0.1 still sends that name here.
    if (request.headers.host !== '127.0.0.1:' + this.port) { request.resume(); return json(response, 421, { error: 'Wrong host.' }); }
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !this.token || !sameToken(authorization.slice(7), this.token)) {
      request.resume();
      return json(response, 401, { error: 'Unauthorized.' });
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = request.method + ' ' + url.pathname;
    let body: unknown;
    try { body = request.method === 'POST' ? await this.body(request) : (request.resume(), {}); }
    catch (error) { return json(response, (error as { status?: number }).status ?? 400, { error: (error as Error).message }); }
    if (!isRecord(body)) return json(response, 400, { error: 'Expected an object.' });
    if (route === 'POST /lightroom/hello') return this.hello(body, response);
    // Everything else belongs to the session a hello started; an unknown one says hello again.
    const session = request.method === 'GET' ? url.searchParams.get('session') : body.session;
    if (!this.session || session !== this.session) return json(response, 409, { error: 'Say hello first.' });
    this.deadline = Math.max(this.deadline, Date.now() + this.grace);
    if (route === 'GET /lightroom/jobs') return this.jobs(response);
    if (route === 'POST /lightroom/results') return this.result(body, response);
    if (route === 'POST /lightroom/changes') return this.changes(body, response);
    if (route === 'POST /lightroom/send') return this.send(body, response);
    if (route === 'POST /lightroom/bye') { this.disconnect(new LightroomOffline('Lightroom Classic quit.')); return json(response, 200, {}); }
    return json(response, 404, { error: 'Not found.' });
  }

  private hello(body: Record<string, unknown>, response: ServerResponse) {
    const catalog = isRecord(body.catalog) ? body.catalog : undefined;
    const plugin = isRecord(body.plugin) ? body.plugin : undefined;
    const version = shortText(plugin?.version, 40);
    if (!catalog || !isLightroomIdentifier(catalog.id) || !version) return json(response, 400, { error: 'A hello names the catalog and the plugin version.' });
    const name = shortText(catalog.name, 255);
    const lightroom = shortText(body.lightroom, 80);
    const before = this.current;
    // A new hello is a plugin that started again: whatever it had taken is lost with the old session.
    for (const job of this.taken.values()) job.reject(new LightroomOffline('Lightroom Classic restarted the ImageFlow plugin.'));
    if (this.poll) { clearTimeout(this.poll.timer); json(this.poll.response, 200, { jobs: [] }); this.poll = undefined; }
    this.session = randomUUID();
    this.current = { catalog: { id: catalog.id, ...(name ? { name } : {}) }, plugin: { version }, ...(lightroom ? { lightroom } : {}) };
    this.deadline = Date.now() + this.grace;
    json(response, 200, { session: this.session, hold: Math.round(this.hold / 1000), watch: this.trackedSet, imageflow: this.options.version });
    if (!before || before.catalog.id !== catalog.id || before.plugin.version !== version) this.emitConnection();
  }

  private jobs(response: ServerResponse) {
    const session = this.session!;
    // One poll at a time: an older one is answered empty.
    if (this.poll) { clearTimeout(this.poll.timer); json(this.poll.response, 200, { jobs: [] }); }
    const timer = setTimeout(() => {
      if (this.poll?.response !== response) return;
      this.poll = undefined;
      this.deadline = Date.now() + this.grace;
      json(response, 200, { jobs: [] });
    }, this.hold);
    timer.unref();
    this.poll = { session, response, timer };
    this.deadline = Infinity;
    // A poll whose connection breaks before it is answered: Lightroom quit or the plugin stopped. It may just be
    // polling again, so it counts as gone only if nothing follows soon.
    response.on('close', () => {
      if (this.poll?.response !== response) return;
      clearTimeout(timer);
      this.poll = undefined;
      if (!response.writableEnded) this.deadline = Date.now() + this.closeGrace;
    });
    this.deliver();
  }

  private result(body: Record<string, unknown>, response: ServerResponse) {
    const job = typeof body.job === 'string' ? this.taken.get(body.job) : undefined;
    // A result for a job that timed out or was cancelled is not an error of the plugin's.
    if (!job || job.session !== this.session) return json(response, 200, { ignored: true });
    if (body.ok === true) job.resolve(body.result);
    else job.reject(new Error('Lightroom Classic: ' + (shortText(body.error, 500) ?? 'the job failed.')));
    json(response, 200, {});
  }

  private changes(body: Record<string, unknown>, response: ServerResponse) {
    const uuids = Array.isArray(body.uuids) ? body.uuids.filter(isLightroomIdentifier).slice(0, 10_000) : [];
    json(response, 200, {});
    if (uuids.length) for (const listener of [...this.changeListeners]) listener(uuids);
  }

  private send(body: Record<string, unknown>, response: ServerResponse) {
    const catalog = body.catalog;
    const photos = Array.isArray(body.photos) ? body.photos.flatMap((photo) => {
      if (!isRecord(photo) || !isLightroomIdentifier(photo.uuid)) return [];
      const name = shortText(photo.name, 255);
      return [{ uuid: photo.uuid, ...(name ? { name } : {}) }];
    }).slice(0, 5000) : [];
    if (!isLightroomIdentifier(catalog) || catalog !== this.current?.catalog.id || !photos.length) return json(response, 400, { error: 'Send names the open catalog and its photos.' });
    // Answered at once: the import, and any question it asks, happens in ImageFlow's own windows.
    json(response, 202, { accepted: photos.length });
    for (const listener of [...this.sendListeners]) listener({ catalog, photos });
  }
}
