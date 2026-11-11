import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpConnection, McpAppClient } from '../desktop/mcp-connection';
import { mcpLimits, mcpTools, parseMcpArguments } from '../src/mcp-contract';

type ConnectionOptions = Parameters<typeof createMcpConnection>[0];
const hash = 'a'.repeat(64);

async function fixture(t: TestContext, onCall: ConnectionOptions['onCall'] = async (_name, args) => ({ state: 'ready', args })) {
  const work = await mkdtemp(join(tmpdir(), 'if-mcp-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  let clients: { name: string }[] = [];
  const descriptorPath = join(work, 'connection.json');
  const connection = await createMcpConnection({ descriptorPath, onCall, onClientsChanged: (next) => { clients = next; } });
  const app = new McpAppClient(descriptorPath, () => 'Transport test');
  t.after(async () => { app.close(); await connection.close(); });
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as { socket: string; token: string };
  return { work, app, connection, descriptorPath, descriptor, clients: () => clients };
}

async function eventually(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(10);
  }
  assert.ok(condition(), 'Expected the connection lifecycle event.');
}

function nextFrame(socket: Socket) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let data = '';
    const receive = (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      socket.off('data', receive);
      socket.off('error', reject);
      resolve(JSON.parse(data.slice(0, data.indexOf('\n'))));
    };
    socket.on('data', receive);
    socket.once('error', reject);
  });
}

async function rawClient(t: TestContext, descriptor: { socket: string; token: string }, token = descriptor.token) {
  const socket = createConnection(descriptor.socket);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const reply = nextFrame(socket);
  socket.write(JSON.stringify({ type: 'hello', name: 'Raw test', token }) + '\n');
  return { socket, ready: await reply };
}

test('local connection is private, tracks clients, multiplexes replies and removes its setup on close', async (t) => {
  const { app, clients, connection, descriptor, descriptorPath } = await fixture(t, async (_name, args) => {
    await delay(args.offset === 1 ? 20 : 1);
    return { state: 'ready', offset: args.offset };
  });
  assert.equal((await stat(dirname(descriptor.socket))).mode & 0o777, 0o700);
  assert.equal((await stat(descriptor.socket)).mode & 0o777, 0o600);
  assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
  const results = await Promise.all([
    app.call('inspect_book', { project: 'book', view: 'summary', offset: 1 }),
    app.call('inspect_book', { project: 'book', view: 'summary', offset: 2 }),
  ]);
  assert.deepEqual(results.map(({ offset }) => offset), [1, 2]);
  assert.deepEqual(clients(), [{ name: 'Transport test' }]);
  await assert.rejects(createMcpConnection({ descriptorPath, onCall: async () => ({}) }), { code: 'connection-already-enabled' });
  await connection.close();
  await connection.close();
  await eventually(() => clients().length === 0);
  await assert.rejects(readFile(descriptorPath), { code: 'ENOENT' });
  await assert.rejects(stat(dirname(descriptor.socket)), { code: 'ENOENT' });
});

test('authentication and argument validation reject requests before reaching the app', async (t) => {
  let calls = 0;
  const { descriptor, clients } = await fixture(t, async () => { calls++; return {}; });
  const rejected = await rawClient(t, descriptor, '0'.repeat(64));
  assert.equal((rejected.ready.error as { code: string }).code, 'connection-unauthorized');
  assert.deepEqual(clients(), []);
  const { socket, ready } = await rawClient(t, descriptor);
  assert.equal(ready.type, 'ready');
  const reply = nextFrame(socket);
  socket.write(JSON.stringify({ type: 'call', id: 'invalid', name: 'import_sources', args: {
    project: 'book', expectedRevision: hash, idempotencyKey: 'one', kind: 'photo', paths: ['inbox/../outside.jpg'],
  } }) + '\n');
  const invalid = await reply;
  assert.equal((invalid.error as { code: string }).code, 'invalid-tool-arguments');
  assert.equal(calls, 0);
});

test('oversized input and output are bounded and a rejected large result leaves the connection usable', async (t) => {
  const { descriptor, app } = await fixture(t, async (_name, args) => args.offset === 1
    ? { tooLarge: 'x'.repeat(mcpLimits.responseBytes) } : { state: 'ready' });
  await assert.rejects(app.call('inspect_book', { project: 'book', view: 'summary', offset: 1 }), { code: 'payload-too-large' });
  assert.equal((await app.call('list_projects', {})).state, 'ready');
  const { socket } = await rawClient(t, descriptor);
  const reply = nextFrame(socket);
  socket.write('x'.repeat(mcpLimits.requestBytes));
  const oversized = await reply;
  assert.equal((oversized.error as { code: string }).code, 'payload-too-large');
});

test('cancellation reaches the app and revocation invalidates pending calls and old credentials', async (t) => {
  let started = () => {};
  const starting = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = false;
  const { app, connection, descriptorPath, descriptor } = await fixture(t, async (_name, _args, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true }));
    return {};
  });
  const controller = new AbortController();
  const result = assert.rejects(app.call('list_projects', {}, controller.signal), /Stopped test/);
  await starting;
  controller.abort(new Error('Stopped test'));
  await result;
  await eventually(() => cancelled);
  const next = assert.rejects(app.call('list_projects', {}), { code: 'connection-closed' });
  await delay(10);
  await connection.close();
  await next;
  await assert.rejects(app.call('list_projects', {}), { code: 'connection-unavailable' });
  const replacement = await createMcpConnection({ descriptorPath, onCall: async () => ({ state: 'ready', reconnected: true }) });
  t.after(() => replacement.close());
  const current = JSON.parse(await readFile(descriptorPath, 'utf8'));
  assert.notEqual(current.token, descriptor.token);
  assert.equal((await app.call('list_projects', {})).reconnected, true);
});

test('tool contracts require revisions for page numbers and restrict source paths to explicit project folders', () => {
  assert.throws(() => parseMcpArguments('check_book', { project: 'book', preview: { target: { page: 2 } } }), /revision/);
  assert.throws(() => parseMcpArguments('get_authoring_context', { project: 'book', includeSource: ['project.json'] }), /project-relative/);
  assert.throws(() => parseMcpArguments('import_sources', {
    project: 'book', expectedRevision: hash, idempotencyKey: 'file', kind: 'file', paths: ['inbox/file.gpx'],
  }), /accept/);
  assert.equal(parseMcpArguments('check_book', {
    project: 'book', expectedRevision: hash, preview: { target: { page: 2 } },
  }).args.expectedRevision, hash);
});

test('official MCP client lists six tools and receives image content without duplicated image data', async (t) => {
  const { descriptorPath, work } = await fixture(t, async (name) => name === 'check_book'
    ? { state: 'ready', revision: hash, image: { data: 'aW1hZ2U=', mimeType: 'image/png', width: 10, height: 10 } }
    : { state: 'error', error: { code: 'TEST_FAILURE', message: 'Actionable failure.' } });
  const bridge = join(work, 'bridge.cjs');
  await build({ entryPoints: [resolve('desktop/mcp-bridge.ts')], outfile: bridge, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bridge, '--connection', descriptorPath], stderr: 'pipe' });
  let errors = '';
  transport.stderr?.on('data', (chunk) => { errors += String(chunk); });
  const client = new Client({ name: 'Official client test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), mcpTools.map(({ name }) => name).sort());
  assert.ok(tools.every(({ inputSchema }) => inputSchema.type === 'object'));
  const checked = await client.callTool({ name: 'check_book', arguments: { project: 'book', preview: { target: { spread: 'later' } } } });
  assert.equal(checked.isError, undefined, JSON.stringify(checked));
  assert.equal(checked.content[1].type, 'image');
  assert.deepEqual((checked.structuredContent as Record<string, unknown>)?.image, { mimeType: 'image/png', width: 10, height: 10 });
  assert.doesNotMatch((checked.content[0] as { text: string }).text, /aW1hZ2U=/);
  const failed = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.equal(failed.isError, true);
  assert.equal(((failed.structuredContent as Record<string, unknown>)?.error as { code: string }).code, 'TEST_FAILURE');
  assert.equal(errors, '');
});
