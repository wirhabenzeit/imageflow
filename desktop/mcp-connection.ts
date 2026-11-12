import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { mcpCallSchema, mcpCancelSchema, mcpDescriptorSchema, mcpHelloSchema, mcpLimits, mcpReplySchema, parseMcpArguments } from '../src/mcp-contract';
import type { McpDescriptor, McpToolName } from '../src/mcp-contract';

type WireError = { code: string; message: string };
type Client = { name: string };
type PendingCall = { controller: AbortController; timer: ReturnType<typeof setTimeout> };

export class McpConnectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

function wireError(error: unknown): WireError {
  if (error instanceof McpConnectionError) return { code: error.code, message: error.message };
  return { code: 'app-call-failed', message: error instanceof Error ? error.message : 'ImageFlow could not complete the request.' };
}

function send(socket: Socket, message: unknown, limit: number) {
  if (socket.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(message) + '\n');
  if (bytes.length > limit || socket.writableLength + bytes.length > limit) {
    throw new McpConnectionError('payload-too-large', 'The ImageFlow message exceeds the connection payload limit. Request fewer results or a smaller image.');
  }
  socket.write(bytes);
}

function receive(socket: Socket, limit: number, frame: (value: unknown) => void, fail: (error: McpConnectionError) => void) {
  let buffered = Buffer.alloc(0);
  let failed = false;
  const reject = (error: McpConnectionError) => { failed = true; buffered = Buffer.alloc(0); fail(error); };
  socket.on('data', (chunk: Buffer) => {
    if (failed || socket.destroyed || socket.writableEnded) return;
    buffered = Buffer.concat([buffered, chunk]);
    let newline: number;
    while ((newline = buffered.indexOf(10)) >= 0) {
      if (newline + 1 > limit) {
        reject(new McpConnectionError('payload-too-large', 'The ImageFlow message exceeds the connection payload limit.'));
        return;
      }
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      let value: unknown;
      try { value = JSON.parse(line.toString('utf8')); }
      catch {
        reject(new McpConnectionError('invalid-message', 'The ImageFlow connection received invalid JSON.'));
        return;
      }
      frame(value);
      if (socket.destroyed || socket.writableEnded) return;
    }
    if (buffered.length >= limit) reject(new McpConnectionError('payload-too-large', 'The ImageFlow message exceeds the connection payload limit.'));
  });
}

async function readDescriptor(path: string): Promise<McpDescriptor> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) {
      throw new McpConnectionError('connection-descriptor-invalid', 'The ImageFlow connection file must be a private regular file. In ImageFlow, turn agent access off and on again.');
    }
    const parsed = mcpDescriptorSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    if (!parsed.success || !isAbsolute(parsed.data.socket)) throw new Error('Invalid connection descriptor.');
    return parsed.data;
  } catch (error) {
    if (error instanceof McpConnectionError) throw error;
    throw new McpConnectionError('connection-unavailable', 'ImageFlow is not accepting agents. Open a book in ImageFlow, choose Connect an agent… and turn on agent access.');
  } finally {
    await file?.close();
  }
}

function socketIsActive(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    const finish = (active: boolean) => { socket.destroy(); resolve(active); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(mcpLimits.handshakeMs, () => finish(true));
  });
}

export async function createMcpConnection(options: {
  descriptorPath: string;
  onCall: (name: McpToolName, args: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
  onClientsChanged?: (clients: Client[]) => void;
}) {
  if (process.platform === 'win32') throw new McpConnectionError('connection-unsupported', 'The local ImageFlow bridge currently requires a Unix socket.');
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'if-mcp-')));
  const descriptor = { socket: join(directory, 's'), token: randomBytes(32).toString('hex') };
  const sockets = new Set<Socket>();
  const clients = new Map<Socket, Client>();
  const changed = () => options.onClientsChanged?.([...clients.values()].map((client) => ({ ...client })));
  const server = createServer((socket) => {
    if (sockets.size >= mcpLimits.clients) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setNoDelay(true);
    const pending = new Map<string, PendingCall>();
    const handshake = setTimeout(() => socket.destroy(), mcpLimits.handshakeMs);
    const replyError = (error: WireError, id?: string) => {
      try { send(socket, { type: 'error', ...(id ? { id } : {}), error }, mcpLimits.responseBytes); }
      catch { socket.destroy(); }
    };
    const finishCall = (id: string) => {
      const call = pending.get(id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(id);
      return call;
    };
    receive(socket, mcpLimits.requestBytes, (message) => {
      if (!clients.has(socket)) {
        const hello = mcpHelloSchema.safeParse(message);
        const token = hello.success ? Buffer.from(hello.data.token) : Buffer.alloc(0);
        const expected = Buffer.from(descriptor.token);
        if (!hello.success || token.length !== expected.length || !timingSafeEqual(token, expected)) {
          replyError({ code: 'connection-unauthorized', message: 'This ImageFlow connection is no longer authorized. In ImageFlow, turn agent access off and on again.' });
          socket.end();
          return;
        }
        clearTimeout(handshake);
        clients.set(socket, { name: hello.data.name });
        changed();
        send(socket, { type: 'ready' }, mcpLimits.responseBytes);
        return;
      }
      const cancelled = mcpCancelSchema.safeParse(message);
      if (cancelled.success) {
        const call = finishCall(cancelled.data.id);
        if (call) {
          call.controller.abort(new McpConnectionError('request-cancelled', 'The ImageFlow request was cancelled.'));
          replyError({ code: 'request-cancelled', message: 'The ImageFlow request was cancelled.' }, cancelled.data.id);
        }
        return;
      }
      const call = mcpCallSchema.safeParse(message);
      if (!call.success) { replyError({ code: 'invalid-message', message: 'The ImageFlow connection received an invalid request.' }); socket.end(); return; }
      const { id } = call.data;
      if (pending.has(id)) { replyError({ code: 'duplicate-request', message: 'This request is already running.' }, id); return; }
      if (pending.size >= mcpLimits.callsPerClient) { replyError({ code: 'connection-busy', message: 'Too many ImageFlow requests are running. Wait for an earlier request to finish.' }, id); return; }
      let parsed;
      try { parsed = parseMcpArguments(call.data.name, call.data.args); }
      catch (error) { replyError({ code: 'invalid-tool-arguments', message: error instanceof Error ? error.message : 'Invalid tool arguments.' }, id); return; }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        const running = finishCall(id);
        if (running) {
          running.controller.abort(new McpConnectionError('request-timeout', 'The ImageFlow request timed out.'));
          replyError({ code: 'request-timeout', message: 'The ImageFlow request timed out.' }, id);
        }
      }, mcpLimits.callMs);
      pending.set(id, { controller, timer });
      void Promise.resolve().then(() => options.onCall(parsed.name, parsed.args, controller.signal)).then((result) => {
        if (!finishCall(id)) return;
        try { send(socket, { type: 'result', id, result }, mcpLimits.responseBytes); }
        catch (error) { replyError(wireError(error), id); }
      }, (error: unknown) => {
        if (finishCall(id)) replyError(wireError(error), id);
      });
    }, (error) => { replyError(wireError(error)); socket.end(); });
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(handshake);
      sockets.delete(socket);
      const wasClient = clients.delete(socket);
      for (const { controller, timer } of pending.values()) {
        clearTimeout(timer);
        controller.abort(new McpConnectionError('connection-closed', 'The ImageFlow connection closed.'));
      }
      pending.clear();
      if (wasClient) changed();
    });
  });
  let published = false;
  try {
    await chmod(directory, 0o700);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(descriptor.socket, resolve); });
    await chmod(descriptor.socket, 0o600);
    await mkdir(dirname(options.descriptorPath), { recursive: true });
    try {
      const previous = await readDescriptor(options.descriptorPath);
      if (await socketIsActive(previous.socket)) throw new McpConnectionError('connection-already-enabled', 'An ImageFlow connection is already enabled for this setup path.');
    } catch (error) {
      if (!(error instanceof McpConnectionError) || error.code !== 'connection-unavailable') throw error;
    }
    const staging = options.descriptorPath + '.' + randomUUID();
    try {
      await writeFile(staging, JSON.stringify(descriptor) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(staging, options.descriptorPath);
    } finally {
      await rm(staging, { force: true });
    }
    published = true;
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    descriptorPath: options.descriptorPath,
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (published) {
          const current = await readFile(options.descriptorPath, 'utf8').catch(() => '');
          if (current.trim() === JSON.stringify(descriptor)) await rm(options.descriptorPath, { force: true });
        }
        await rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

type Awaiting = { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void };

/** One stdio client's persistent attachment to the app. Read the descriptor again on every call so revocation
 * and a newly enabled connection take effect without restarting the MCP client. */
export class McpAppClient {
  private socket?: Socket;
  private descriptor?: McpDescriptor;
  private connecting?: Promise<void>;
  private pending = new Map<string, Awaiting>();

  constructor(private readonly descriptorPath: string, private readonly clientName: () => string) {}

  async connect() {
    const descriptor = await readDescriptor(this.descriptorPath);
    if (this.socket && !this.socket.destroyed && this.descriptor?.token === descriptor.token && this.descriptor.socket === descriptor.socket) {
      await this.connecting;
      return;
    }
    this.close();
    this.descriptor = descriptor;
    const socket = createConnection(descriptor.socket);
    socket.setNoDelay(true);
    this.socket = socket;
    const connecting = new Promise<void>((resolve, reject) => {
      const fail = (error: McpConnectionError) => { reject(error); socket.destroy(); };
      const timer = setTimeout(() => fail(new McpConnectionError('connection-timeout', 'ImageFlow did not accept the local connection.')), mcpLimits.handshakeMs);
      socket.once('connect', () => {
        send(socket, { type: 'hello', token: descriptor.token, name: this.clientName().slice(0, 120) || 'MCP client' }, mcpLimits.requestBytes);
      });
      receive(socket, mcpLimits.responseBytes, (message) => {
        const parsed = mcpReplySchema.safeParse(message);
        if (!parsed.success) { fail(new McpConnectionError('invalid-response', 'ImageFlow returned an invalid connection message.')); return; }
        const frame = parsed.data;
        if (frame.type === 'ready') { clearTimeout(timer); resolve(); return; }
        if (frame.type === 'error' && !frame.id) {
          fail(new McpConnectionError(frame.error?.code ?? 'connection-closed', frame.error?.message ?? 'The ImageFlow connection closed.'));
          return;
        }
        const call = frame.id && this.pending.get(frame.id);
        if (!call || !frame.id) return;
        this.pending.delete(frame.id);
        if (frame.type === 'result') call.resolve(frame.result);
        else call.reject(new McpConnectionError(frame.error.code, frame.error.message));
      }, fail);
      socket.on('error', () => fail(new McpConnectionError('connection-unavailable', 'ImageFlow’s agent connection closed. Open ImageFlow and turn on agent access again.')));
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new McpConnectionError('connection-closed', 'The ImageFlow connection closed.'));
        if (this.socket === socket) {
          this.socket = undefined;
          this.descriptor = undefined;
          for (const call of this.pending.values()) call.reject(new McpConnectionError('connection-closed', 'The ImageFlow connection closed.'));
          this.pending.clear();
        }
      });
    });
    this.connecting = connecting;
    await connecting;
  }

  async call(name: McpToolName, args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.connect();
    signal?.throwIfAborted();
    const socket = this.socket!;
    const id = randomUUID();
    let abort = () => {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new McpConnectionError('request-timeout', 'The ImageFlow request timed out.')), mcpLimits.callMs);
    const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        abort = () => {
          this.pending.delete(id);
          try { send(socket, { type: 'cancel', id }, mcpLimits.requestBytes); } catch { socket.destroy(); }
          reject(runSignal.reason);
        };
        runSignal.addEventListener('abort', abort, { once: true });
        try { send(socket, { type: 'call', id, name, args }, mcpLimits.requestBytes); }
        catch (error) { this.pending.delete(id); reject(error); }
      });
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener('abort', abort);
    }
  }

  close() {
    for (const call of this.pending.values()) call.reject(new McpConnectionError('connection-closed', 'The ImageFlow connection closed.'));
    this.pending.clear();
    this.socket?.destroy();
    this.socket = undefined;
    this.descriptor = undefined;
    this.connecting = undefined;
  }
}
