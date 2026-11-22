import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LightroomBridge } from '../desktop/lightroom/bridge';
import { captureTime, lightroomProvider } from '../desktop/providers/lightroom';
import { launchLightroom } from '../desktop/lightroom/launch';
import { registerProvider } from '../desktop/providers';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { configureProxyStore } from '../desktop/proxy-store';
import { AssetFacts, readAssetFacts } from '../desktop/asset-facts';
import { acquireProjectLock } from '../desktop/persistence';
import { loadProject, projectSummary, updateProject } from '../desktop/project';
import { providedChanges } from '../desktop/provided-photos';
import { copySample } from '../desktop/sample-book.mjs';
import type { Materialized, Observed, SourceRef } from '../desktop/source-provider';
import type { LightroomLocator } from '../src/source-locator';
import { lightroomLocator } from '../src/source-locator';
import { assetMenu } from '../src/asset-menu';
import { catalogId, FakeLightroom, otherCatalogId, uuid } from './lightroom-fake';
import './persistence-root';

// The Lightroom Classic provider (ADR 0011) over the real loopback bridge, against a fake plugin that speaks the
// bridge protocol over HTTP. No Lightroom runs and nothing is written outside temporary folders.

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-lr-provider-')));
  const bridge = new LightroomBridge({ file: join(root, 'bridge.json'), version: 'test', hold: 300, grace: 1500, closeGrace: 200 });
  await bridge.start();
  const provider = lightroomProvider(bridge);
  const fakes: FakeLightroom[] = [];
  const fake = () => { const plugin = new FakeLightroom(join(root, 'bridge.json')); fakes.push(plugin); return plugin; };
  const staging = join(root, 'staging');
  await mkdir(staging);
  t.after(async () => { for (const plugin of fakes) await plugin.quit(true); await bridge.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, bridge, provider, fake, staging };
}
const ref = (id: string, uuidValue: string, catalog = catalogId, known?: SourceRef<LightroomLocator>['known']): SourceRef<LightroomLocator> =>
  ({ id, locator: { provider: 'lightroom', catalog, uuid: uuidValue }, ...(known ? { known } : {}) });
const all = async (iterable: AsyncIterable<Materialized>) => { const results: Materialized[] = []; for await (const result of iterable) results.push(result); return results; };
const until = async (condition: () => boolean, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() > end) throw new Error('Timed out waiting.'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
const available = (result: Observed) => { assert.equal(result.state, 'available'); return result as Extract<Observed, { state: 'available' }>; };

test('Lightroom capture times become local wall clock with their offset', () => {
  assert.deepEqual(captureTime('2026-06-01T09:30:00.12+02:00'), { dateTime: '2026-06-01T09:30:00', offset: '+02:00' });
  assert.deepEqual(captureTime('2026-06-01T09:30'), { dateTime: '2026-06-01T09:30:00', offset: null });
  assert.deepEqual(captureTime('2026-06-01T09:30:05Z'), { dateTime: '2026-06-01T09:30:05', offset: '+00:00' });
  assert.deepEqual(captureTime('2026-06-01T09:30:05-0430'), { dateTime: '2026-06-01T09:30:05', offset: '-04:30' });
  assert.equal(captureTime('yesterday'), undefined);
  assert.equal(captureTime(undefined), undefined);
});

test('observe reports facts and both revisions, and is offline without Lightroom or in another catalog', async (t) => {
  const { provider, fake, bridge } = await setup(t);
  const refs = [ref('a', uuid(1)), ref('b', uuid(2)), ref('gone', uuid(9)), ref('elsewhere', uuid(1), otherCatalogId)];
  for (const result of await provider.observe('/book', refs)) assert.deepEqual(result.state, 'offline');
  assert.deepEqual(provider.repairs('offline'), ['launch']);
  assert.deepEqual(provider.repairs('missing'), []);
  const plugin = fake();
  plugin.add(1, { title: 'Harbour', caption: 'At dawn', copyright: '© Me' });
  plugin.add(2, { width: 4000, height: 6000 });
  await plugin.connect();
  await until(() => !!bridge.connection);
  const [a, b, gone, elsewhere] = await provider.observe('/book', refs);
  const first = available(a);
  assert.deepEqual(first.revisions, { revision: plugin.revision(uuid(1)), contentRevision: plugin.developHash(uuid(1)) });
  assert.deepEqual(first.facts, { width: 6000, height: 4000, captured: { dateTime: '2026-06-01T09:30:00', offset: '+02:00' }, camera: { make: 'SONY', model: 'ILCE-7M3' },
    provided: { title: 'Harbour', caption: 'At dawn', credit: '© Me' }, extra: { orientation: 'AB', fileName: 'DSC_0001.ARW' } });
  assert.equal(available(b).facts?.height, 6000);
  assert.deepEqual(gone, { state: 'missing', problem: 'No longer in the Lightroom catalog.' });
  assert.equal(elsewhere.state, 'offline');
  assert.match((elsewhere as { problem: string }).problem, /Another Lightroom catalog is open \(Photos\.lrcat\)/);
  // One metadata job for the open catalog's photos only; a UUID means nothing in another catalog.
  const jobs = plugin.jobs.filter(({ type }) => type === 'metadata');
  assert.equal(jobs.length, 1);
  assert.deepEqual((jobs[0].photos as { uuid: string }[]).map(({ uuid: id }) => id), [uuid(1), uuid(2), uuid(9)]);
});

test('the develop hash is read only when the revision moved, so a metadata edit keeps the content revision', async (t) => {
  const { provider, fake, bridge } = await setup(t);
  const plugin = fake();
  plugin.add(1);
  await plugin.connect();
  await until(() => !!bridge.connection);
  const known = available((await provider.observe('/book', [ref('a', uuid(1))]))[0]).revisions;
  // Unchanged: the plugin is told the stored revision and reads no hash; the stored content revision stands.
  const same = available((await provider.observe('/book', [ref('a', uuid(1), catalogId, { revision: known.revision, contentRevision: 'stored-hash' })]))[0]);
  assert.deepEqual(same.revisions, { revision: known.revision, contentRevision: 'stored-hash' });
  assert.equal((plugin.jobs.at(-1)!.photos as { known?: string }[])[0].known, known.revision);
  // A title changed in Lightroom: the revision moves, the develop hash does not.
  plugin.edit(uuid(1), { title: 'New title' });
  const metadata = available((await provider.observe('/book', [ref('a', uuid(1), catalogId, known)]))[0]);
  assert.notEqual(metadata.revisions.revision, known.revision);
  assert.equal(metadata.revisions.contentRevision, known.contentRevision);
  assert.equal(metadata.facts?.provided?.title, 'New title');
  // An exposure change moves both.
  plugin.edit(uuid(1), { develop: { Exposure2012: 1 } });
  const visual = available((await provider.observe('/book', [ref('a', uuid(1), catalogId, metadata.revisions)]))[0]);
  assert.notEqual(visual.revisions.contentRevision, known.contentRevision);
  // No stored hash, nothing to compare: the plugin reads it.
  assert.equal((await provider.observe('/book', [ref('a', uuid(1), catalogId, { revision: visual.revisions.revision })]))[0].state, 'available');
  assert.equal((plugin.jobs.at(-1)!.photos as { known?: string }[])[0].known, undefined);
});

test('previews and full renders run five photos to a session, each into the staging folder with its revisions', async (t) => {
  const { provider, fake, bridge, staging } = await setup(t);
  const plugin = fake();
  for (let n = 1; n <= 7; n++) plugin.add(n);
  await plugin.connect();
  await until(() => !!bridge.connection);
  const refs = [1, 2, 3, 4, 5, 6, 7].map((n) => ref('p' + n, uuid(n))).concat([ref('gone', uuid(99)), ref('elsewhere', uuid(1), otherCatalogId)]);
  const results = await all(provider.preview!('/book', refs, { staging, signal: new AbortController().signal }));
  assert.deepEqual(results.map(({ id }) => id), refs.map(({ id }) => id), 'one result per photo, in order');
  const renders = plugin.jobs.filter(({ type }) => type === 'render');
  assert.deepEqual(renders.map((job) => (job.uuids as string[]).length), [5, 3], 'sessions of five photos; the one of another catalog is never sent');
  assert.equal(renders[0].size, 'preview');
  for (const result of results.slice(0, 7)) {
    assert.ok('file' in result);
    assert.ok(result.file.startsWith(await realpath(staging) + '/lightroom-'), 'inside a folder of its own in staging');
    assert.deepEqual(result.before, result.after);
    assert.ok(result.before.contentRevision, 'the develop hash keys the preview');
    assert.ok((await readFile(result.file)).length > 0);
  }
  assert.deepEqual(results[7], { id: 'gone', state: 'missing', problem: 'No longer in the Lightroom catalog.' });
  assert.equal(results[8].id, 'elsewhere');
  assert.equal((results[8] as { state: string }).state, 'offline');
  const full = await all(provider.materialize('/book', refs.slice(0, 2), { staging, signal: new AbortController().signal }));
  assert.equal(plugin.jobs.at(-1)!.size, 'full');
  assert.equal(full.filter((result) => 'file' in result).length, 2);
});

test('an edit during a render shows in its revisions, and a file outside the named folder is refused', async (t) => {
  const { provider, fake, bridge, staging, root } = await setup(t);
  const plugin = fake();
  plugin.add(1); plugin.add(2);
  await plugin.connect();
  await until(() => !!bridge.connection);
  plugin.duringRender = (id) => { if (id === uuid(2)) plugin.edit(id, { develop: { Exposure2012: 2 } }); };
  const [first, second] = await all(provider.materialize('/book', [ref('a', uuid(1)), ref('b', uuid(2))], { staging, signal: new AbortController().signal }));
  assert.ok('file' in first && 'file' in second);
  assert.deepEqual(first.before, first.after);
  assert.notEqual(second.before.revision, second.after.revision, 'the host discards it and asks again');
  plugin.duringRender = undefined;
  plugin.renderOutside = join(root, 'escaped.jpg');
  const [outside] = await all(provider.preview!('/book', [ref('a', uuid(1))], { staging, signal: new AbortController().signal }));
  assert.equal((outside as { state: string }).state, 'unreadable');
  assert.match((outside as { problem: string }).problem, /outside the folder/);
});

test('an abort takes effect between sessions, and a plugin that goes away fails its session as offline', async (t) => {
  const { provider, fake, bridge, staging } = await setup(t);
  const plugin = fake();
  for (let n = 1; n <= 12; n++) plugin.add(n);
  await plugin.connect();
  await until(() => !!bridge.connection);
  const controller = new AbortController();
  const results: Materialized[] = [];
  for await (const result of provider.materialize('/book', Array.from({ length: 12 }, (_, i) => ref('p' + i, uuid(i + 1))), { staging, signal: controller.signal })) {
    results.push(result);
    controller.abort();
  }
  assert.equal(results.length, 5, 'the session that ran is reported; the next is never started');
  assert.equal(plugin.jobs.filter(({ type }) => type === 'render').length, 1);
  // The plugin takes the session and quits before answering.
  let release!: () => void;
  plugin.renderGate = new Promise((resolve) => { release = resolve; });
  const pending = all(provider.preview!('/book', [ref('a', uuid(1)), ref('b', uuid(2))], { staging, signal: new AbortController().signal }));
  await until(() => plugin.jobs.filter(({ type }) => type === 'render').length === 2);
  await plugin.quit();
  release();
  const offline = await pending;
  assert.deepEqual(offline.map((result) => (result as { state: string }).state), ['offline', 'offline']);
});

test('watch reports changed photos, and every photo when Lightroom goes away or comes back', async (t) => {
  const { provider, fake, bridge } = await setup(t);
  const reported: string[][] = [];
  const stop = provider.watch('/book', [ref('a', uuid(1)), ref('b', uuid(2)), ref('again', uuid(1))], (ids) => reported.push(ids));
  assert.deepEqual([...bridge.trackedPhotos], [uuid(1), uuid(2)]);
  const plugin = fake();
  plugin.add(1); plugin.add(2);
  const hello = await plugin.connect();
  assert.deepEqual(hello.watch, [uuid(1), uuid(2)], 'the plugin polls the watched photos from its hello on');
  await until(() => reported.length === 1);
  assert.deepEqual(reported.shift(), ['a', 'b', 'again'], 'connected: observed again, so offline photos come back');
  await plugin.changes([uuid(1)]);
  assert.deepEqual(reported.shift(), ['a', 'again']);
  await plugin.quit(true);
  await until(() => reported.length === 1, 2000);
  assert.deepEqual(reported.shift(), ['a', 'b', 'again']);
  stop();
  assert.deepEqual([...bridge.trackedPhotos], []);
  const again = fake();
  await again.connect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reported.length, 0, 'a stopped watch reports nothing');
});

test('Launch opens Lightroom Classic by name, without a shell, and says so when it is not installed', async () => {
  const calls: [string, readonly string[]][] = [];
  await launchLightroom(async (file, args) => { calls.push([file, args]); });
  assert.deepEqual(calls, [['/usr/bin/open', ['-a', 'Adobe Lightroom Classic']]]);
  await assert.rejects(launchLightroom(async () => { throw new Error('Unable to find application'); }), /not found on this Mac/);
});

// --- End to end: a book of Lightroom photos through the host -------------------------------------------------------

test('a book with Lightroom photos loads through the provider and the plugin, shows previews, and goes offline with Lightroom', async (t) => {
  const { root, provider, fake, bridge } = await setup(t);
  const folder = join(root, 'Book.imageflow');
  const cache = join(root, 'cache');
  await mkdir(cache);
  configureSourceStore(join(root, 'source-cache'));
  configureSourceAccess(join(root, 'source-access'));
  const proxies = await configureProxyStore(join(root, 'proxies'));
  const unregister = registerProvider(provider);
  await copySample(resolve('sample/starter'), folder);
  const release = await acquireProjectLock(folder);
  t.after(async () => { await SourceStore.drain(); await AssetFacts.release(folder); await release(); unregister(); configureProxyStore(undefined); });
  const plugin = fake();
  plugin.add(1, { title: 'Harbour', color: '#ff0000' });
  plugin.add(2, { width: 4000, height: 6000, color: '#0000ff' });
  await plugin.connect();
  await until(() => !!bridge.connection);
  const book = await loadProject(folder, cache);
  const files = structuredClone({ project: book.project, photoIndex: book.photoIndex });
  files.photoIndex.lr1 = lightroomLocator.write({ provider: 'lightroom', catalog: catalogId, uuid: uuid(1), name: 'DSC_0001.ARW' }) as never;
  files.photoIndex.lr2 = lightroomLocator.write({ provider: 'lightroom', catalog: catalogId, uuid: uuid(2) }) as never;
  const loaded = await updateProject(book, files, true);
  await (await AssetFacts.forBook(folder)).flush();
  const facts = await readAssetFacts(folder);
  assert.deepEqual(facts.lr1.revisions, { revision: plugin.revision(uuid(1)), contentRevision: plugin.developHash(uuid(1)) });
  assert.equal(facts.lr1.provided?.title, 'Harbour');
  assert.ok(await proxies.path(facts.lr1.digest), 'the 1400 px preview is in the proxy store');
  const photo = loaded.photos.get('lr1')!;
  assert.equal(photo.width, 6000);
  assert.equal(photo.title, 'Harbour');
  assert.equal(photo.problem, undefined);
  assert.equal(loaded.photos.get('lr2')!.height, 6000);
  assert.equal(loaded.sources!['photo:lr1'].previewOnly, true);
  assert.equal(plugin.jobs.filter(({ type }) => type === 'render').length, 1, 'both previews in one session');
  // A change in Lightroom refreshes the preview through the host's change path.
  plugin.edit(uuid(1), { develop: { Exposure2012: 1 }, color: '#00ff00' });
  const refs = ['lr1', 'lr2'].map((id) => ({ id, locator: lightroomLocator.read(loaded.photoIndex[id] as Record<string, unknown>)! }));
  const changes = await providedChanges(folder, provider, refs, await AssetFacts.forBook(folder), { staging: join(cache, 'provider-staging'), available: () => true });
  assert.deepEqual(changes, { reload: ['lr1'], revised: ['lr1'], reshaped: [] });
  // Lightroom quits: the photos are offline, drawn from their proxies, and offer Launch.
  await plugin.quit();
  const offline = await providedChanges(folder, provider, refs, await AssetFacts.forBook(folder), { staging: join(cache, 'provider-staging'), available: () => true });
  assert.deepEqual(offline.reload.sort(), ['lr1', 'lr2']);
  const reopened = await loadProject(folder, cache);
  const status = reopened.sources!['photo:lr1'];
  assert.equal(status.state, 'offline');
  assert.deepEqual(status.repairs, ['launch']);
  assert.equal(status.cached, true, 'its proxy stands in');
  assert.ok(reopened.photos.get('lr1'), 'still drawn');
  const commands = assetMenu(projectSummary(reopened, 'view'), ['photo:lr1']).map((item) => (item as { command?: string }).command ?? 'separator');
  assert.ok(commands.includes('asset-launch'), 'Launch Lightroom Classic is offered');
  assert.ok(commands.includes('asset-retry'));
  assert.equal(commands.includes('asset-locate'), false);
});
