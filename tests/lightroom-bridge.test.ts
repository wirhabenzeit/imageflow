import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LightroomBridge, LightroomOffline, writeBridgeFile } from '../desktop/lightroom/bridge';
import { catalogId, FakeLightroom, otherCatalogId } from './lightroom-fake';

// The loopback bridge to the Lightroom plugin (ADR 0011, section 5), against a fake plugin that speaks its protocol
// over HTTP. The bridge file goes into a temporary folder, never into Application Support.

async function setup(t: { after: (fn: () => Promise<void>) => void }, options: Partial<ConstructorParameters<typeof LightroomBridge>[0]> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-lr-bridge-')));
  const file = join(root, 'ImageFlow', 'lightroom-bridge.json');
  const bridge = new LightroomBridge({ file, version: '1.0.0-test', hold: 300, grace: 1500, closeGrace: 200, ...options });
  await bridge.start();
  const plugins: FakeLightroom[] = [];
  const plugin = () => { const fake = new FakeLightroom(file); plugins.push(fake); return fake; };
  t.after(async () => { for (const fake of plugins) await fake.quit(true); await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, file, bridge, plugin };
}
type Raw = { status: number; body: string };
function raw(port: number, { method = 'GET', path = '/lightroom/jobs', headers = {}, body }: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }) {
  return new Promise<Raw>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
// Read through a function, so an assertion that it is undefined does not narrow later reads.
const connectionOf = (bridge: LightroomBridge) => bridge.connection;
const until = async (condition: () => boolean, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() > end) throw new Error('Timed out waiting.'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

test('the bridge listens on loopback only and writes its port and token into a file only this user can read', async (t) => {
  const { file, bridge } = await setup(t);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.port, bridge.address!.port);
  assert.equal(bridge.address!.host, '127.0.0.1');
  assert.match(written.token, /^[A-Za-z0-9_-]{43}$/, '256 bits, base64url');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // Another address of this Mac reaches nothing: the socket is bound to 127.0.0.1 alone.
  const external = Object.values(networkInterfaces()).flat().find((address) => address && address.family === 'IPv4' && !address.internal);
  if (external) {
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: external.address, port: written.port });
      socket.on('connect', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => resolve(true));
    });
    assert.equal(refused, true, 'not reachable on ' + external.address);
  }
  // A file left with other permissions is never accepted as written.
  await writeFile(file + '.other', '{}', { mode: 0o644 });
  await writeBridgeFile(file + '.other', { port: 1, token: 't', pid: 1, version: 'v' });
  assert.equal((await stat(file + '.other')).mode & 0o777, 0o600, 'rewritten files are 0600 too');
});

test('every request needs the token and the exact loopback host, and bodies are bounded', async (t) => {
  const { file, bridge } = await setup(t, { maximumBody: 1024 });
  const { port, token } = JSON.parse(await readFile(file, 'utf8'));
  const host = '127.0.0.1:' + port;
  const hello = JSON.stringify({ catalog: { id: catalogId }, plugin: { version: '1.0.0' } });
  assert.equal((await raw(port, { headers: { host } })).status, 401, 'no token');
  assert.equal((await raw(port, { headers: { host, authorization: 'Bearer wrong' } })).status, 401, 'wrong token');
  assert.equal((await raw(port, { headers: { host, authorization: token } })).status, 401, 'not a bearer token');
  const refused = await raw(port, { headers: { host, authorization: 'Bearer ' + token.slice(0, -1) } });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.includes(token.slice(0, 10)), false, 'the token is never echoed');
  // DNS rebinding: a page on evil.example resolved to 127.0.0.1 sends its own host name.
  for (const other of ['evil.example:' + port, 'localhost:' + port, '127.0.0.1', '127.0.0.1:1']) {
    assert.equal((await raw(port, { method: 'POST', path: '/lightroom/hello', headers: { host: other, authorization: 'Bearer ' + token }, body: hello })).status, 421, other);
  }
  // No CORS: a preflight is just an unknown route, and nothing carries an Access-Control header.
  const preflight = await new Promise<{ status: number; headers: Record<string, unknown> }>((resolve) => {
    httpRequest({ host: '127.0.0.1', port, method: 'OPTIONS', path: '/lightroom/hello', headers: { host, authorization: 'Bearer ' + token, origin: 'https://evil.example' } },
      (response) => { response.resume(); resolve({ status: response.statusCode!, headers: response.headers }); }).end();
  });
  assert.notEqual(preflight.status, 200);
  assert.equal(Object.keys(preflight.headers).some((name) => name.startsWith('access-control')), false);
  assert.equal((await raw(port, { headers: { host, authorization: 'Bearer ' + token } })).status, 409, 'jobs before hello');
  assert.equal((await raw(port, { method: 'POST', path: '/lightroom/hello', headers: { host, authorization: 'Bearer ' + token }, body: Buffer.alloc(2048, 32) })).status, 413);
  assert.equal((await raw(port, { method: 'POST', path: '/lightroom/hello', headers: { host, authorization: 'Bearer ' + token }, body: '{nope' })).status, 400);
  assert.equal((await raw(port, { method: 'POST', path: '/lightroom/hello', headers: { host, authorization: 'Bearer ' + token },
    body: JSON.stringify({ catalog: { id: '../../etc' }, plugin: { version: '1' } }) })).status, 400, 'a catalog identity is checked');
  assert.equal(bridge.connection, undefined);
  const accepted = await raw(port, { method: 'POST', path: '/lightroom/hello', headers: { host, authorization: 'Bearer ' + token }, body: hello });
  assert.equal(accepted.status, 200);
  assert.equal(connectionOf(bridge)?.catalog.id, catalogId);
});

test('jobs reach a long poll and results come back; a plugin that does not answer times out', async (t) => {
  const { bridge, plugin } = await setup(t);
  const fake = plugin();
  fake.add(1);
  const connected = new Promise<void>((resolve) => bridge.onConnection(() => resolve()));
  await fake.connect();
  await connected;
  assert.deepEqual(bridge.connection, { catalog: { id: catalogId, name: 'Photos.lrcat' }, plugin: { version: '1.0.0' }, lightroom: '16.0.1' });
  // Queued while the poll is held, delivered at once.
  const answer = await bridge.request<{ photos: { uuid: string }[] }>('metadata', { photos: [{ uuid: [...fake.photos.keys()][0] }] });
  assert.equal(answer.photos.length, 1);
  // Several polls without jobs keep the plugin connected.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(bridge.connection);
  // A job the plugin takes but never answers.
  fake.renderGate = new Promise(() => {});
  await assert.rejects(bridge.request('render', { uuids: [], size: 'preview', folder: '/tmp' }, { timeout: 200 }), /did not answer in time/);
  const aborted = new AbortController();
  const pending = bridge.request('render', { uuids: [], size: 'preview', folder: '/tmp' }, { signal: aborted.signal });
  aborted.abort();
  await assert.rejects(pending, /Cancelled/);
});

test('a plugin that quits or breaks off goes offline with its jobs, and reconnecting brings it back', async (t) => {
  const { bridge, plugin, file } = await setup(t);
  const fake = plugin();
  let changes = 0;
  bridge.onConnection(() => changes++);
  await fake.connect();
  await until(() => !!bridge.connection);
  fake.renderGate = new Promise(() => {});
  const pending = assert.rejects(bridge.request('render', { uuids: [], size: 'full', folder: '/tmp' }), LightroomOffline);
  await until(() => fake.jobs.some(({ type }) => type === 'render'));
  await fake.quit();
  await pending;
  assert.equal(bridge.connection, undefined);
  await assert.rejects(bridge.request('metadata', { photos: [] }), LightroomOffline, 'nothing is queued for a plugin that is not there');
  // Lightroom starts again, with another catalog.
  const again = plugin();
  again.catalog = { id: otherCatalogId, name: 'Travel.lrcat' };
  const waited = bridge.waitForConnection(2000);
  await again.connect();
  assert.equal(await waited, true);
  assert.equal(connectionOf(bridge)?.catalog.id, otherCatalogId);
  // A crash: the held poll's connection breaks and no request follows.
  await again.quit(true);
  await until(() => !bridge.connection, 2000);
  assert.equal(changes, 4, 'connected, quit, connected, gone');
  assert.equal(await bridge.waitForConnection(50), false);
  // An old session is refused and must say hello again.
  const stale = plugin();
  await stale.connect();
  const session = stale.session;
  await stale.connect();
  assert.notEqual(stale.session, session);
  await bridge.stop();
  await assert.rejects(readFile(file), { code: 'ENOENT' }, 'the file goes with the server');
});

test('tracked photos reach the plugin as a watch list, and its changes and sends come back validated', async (t) => {
  const { bridge, plugin } = await setup(t);
  const fake = plugin();
  const a = fake.add(1), b = fake.add(2);
  const owner = {};
  const stop = bridge.track(owner, [a, 'not a uuid!']);
  const hello = await fake.connect();
  assert.deepEqual(hello.watch, [a], 'the hello carries the list');
  const second = bridge.track({}, [b]);
  await until(() => fake.watched.length === 2);
  stop();
  await until(() => fake.watched.length === 1 && fake.watched[0] === b);
  second();
  await until(() => fake.watched.length === 0);
  const changed: string[][] = [];
  bridge.onChanges((uuids) => changed.push(uuids));
  await fake.changes([a, '../x']);
  assert.deepEqual(changed, [[a]]);
  const sent: unknown[] = [];
  bridge.onSend((value) => sent.push(value));
  assert.equal((await fake.send([a, b])).status, 202);
  assert.equal((await fake.send([a], otherCatalogId)).status, 400, 'only the open catalog');
  assert.deepEqual(sent, [{ catalog: catalogId, photos: [{ uuid: a, name: 'DSC_0001.ARW' }, { uuid: b, name: 'DSC_0002.ARW' }] }]);
});
