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
import { loadedPhoto } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import { saveDocumentCopy } from '../desktop/source-actions';
import { loadProject, projectSummary, updateProject } from '../desktop/project';
import { backgroundPreviews, providedChanges } from '../desktop/provided-photos';
import { copySample } from '../desktop/sample-book.mjs';
import type { Materialized, Observed, Previewed, SourceRef } from '../desktop/source-provider';
import type { LightroomLocator } from '../src/source-locator';
import { lightroomLocator } from '../src/source-locator';
import { sourceWarnings } from '../src/away-originals';
import { assetMenu } from '../src/asset-menu';
import { catalogId, FakeLightroom, otherCatalogId, uuid } from './lightroom-fake';
import './persistence-root';

// The Lightroom Classic provider (ADR 0011) over the real loopback bridge, against a fake plugin that speaks the
// bridge protocol over HTTP. No Lightroom runs and nothing is written outside temporary folders.

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-lr-provider-')));
  const bridge = new LightroomBridge({ file: join(root, 'bridge.json'), version: 'test', hold: 300, grace: 5000, closeGrace: 200 });
  await bridge.start();
  const provider = lightroomProvider(bridge);
  const fakes: FakeLightroom[] = [];
  const fake = (version?: string) => { const plugin = new FakeLightroom(join(root, 'bridge.json'), version); fakes.push(plugin); return plugin; };
  const staging = join(root, 'staging');
  await mkdir(staging);
  t.after(async () => { for (const plugin of fakes) await plugin.quit(true); await bridge.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { root, bridge, provider, fake, staging };
}
const ref = (id: string, uuidValue: string, catalog = catalogId, known?: SourceRef<LightroomLocator>['known']): SourceRef<LightroomLocator> =>
  ({ id, locator: { provider: 'lightroom', catalog, uuid: uuidValue }, ...(known ? { known } : {}) });
const all = async <T extends Previewed>(iterable: AsyncIterable<T>) => { const results: T[] = []; for await (const result of iterable) results.push(result); return results; };
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
  // No stored hash: the one read of this revision is remembered, so a load that still lacks the preview asks for none.
  const again = available((await provider.observe('/book', [ref('a', uuid(1), catalogId, { revision: visual.revisions.revision })]))[0]);
  assert.equal((plugin.jobs.at(-1)!.photos as { known?: string }[])[0].known, visual.revisions.revision);
  assert.deepEqual(again.revisions, visual.revisions);
});

test('an older plugin renders previews twenty photos to a session, and full renders run five, each into the staging folder with its revisions', async (t) => {
  const { provider, fake, bridge, staging } = await setup(t);
  const plugin = fake();
  for (let n = 1; n <= 7; n++) plugin.add(n);
  await plugin.connect();
  await until(() => !!bridge.connection);
  const refs = [1, 2, 3, 4, 5, 6, 7].map((n) => ref('p' + n, uuid(n))).concat([ref('gone', uuid(99)), ref('elsewhere', uuid(1), otherCatalogId)]);
  const results = await all(provider.preview!('/book', refs, { staging, signal: new AbortController().signal }));
  assert.deepEqual(results.map(({ id }) => id), refs.map(({ id }) => id), 'one result per photo, in order');
  const renders = plugin.jobs.filter(({ type }) => type === 'render');
  assert.deepEqual(renders.map((job) => (job.uuids as string[]).length), [8], 'one session of previews; the one of another catalog is never sent');
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
  const full = await all(provider.materialize('/book', refs.slice(0, 7), { staging, signal: new AbortController().signal }));
  assert.equal(plugin.jobs.at(-1)!.size, 'full');
  assert.deepEqual(plugin.jobs.filter(({ size }) => size === 'full').map((job) => (job.uuids as string[]).length), [5, 2]);
  assert.equal(full.filter((result) => 'file' in result).length, 7);
});

const renderJobs = (plugin: FakeLightroom) => plugin.jobs.filter(({ type }) => type === 'render');
const thumbnailJobs = (plugin: FakeLightroom) => plugin.jobs.filter(({ type }) => type === 'thumbnails');

test('previews are the thumbnails Lightroom keeps, asked for in chunks, and nothing is rendered', async (t) => {
  const { provider, fake, bridge, staging } = await setup(t);
  const plugin = fake('1.1.0');
  for (let n = 1; n <= 30; n++) plugin.add(n);
  await plugin.connect();
  await until(() => !!bridge.connection);
  const bare = Array.from({ length: 30 }, (_, i) => ref('p' + i, uuid(i + 1)));
  const observed = await provider.observe('/book', bare);
  const refs = bare.map((entry, i) => ({ ...entry, known: available(observed[i]).revisions })).concat([ref('gone', uuid(99)) as never, ref('elsewhere', uuid(1), otherCatalogId) as never]);
  const previews = await all(provider.preview!('/book', refs, { staging, signal: new AbortController().signal }));
  assert.deepEqual(previews.map(({ id }) => id), refs.map(({ id }) => id));
  assert.equal(renderJobs(plugin).length, 0);
  assert.deepEqual(thumbnailJobs(plugin).map((job) => (job.photos as unknown[]).length), [24, 7]);
  for (const [index, result] of previews.slice(0, 30).entries()) {
    assert.ok('file' in result && result.kept);
    // The plugin reads no develop hash of the revision it was told; the one observed with it stands.
    assert.deepEqual(result.before, refs[index].known);
    assert.deepEqual(result.after, refs[index].known);
  }
  assert.equal((previews[30] as { state: string }).state, 'missing');
  assert.equal((previews[31] as { state: string }).state, 'offline');
});

test('a photo Lightroom has no preview of is rendered, deferred, or rendered at once, as the host asks', async (t) => {
  const { provider, fake, bridge, staging } = await setup(t);
  const plugin = fake('1.1.0');
  plugin.add(1); plugin.add(2);
  plugin.refused.add(uuid(2));
  await plugin.connect();
  await until(() => !!bridge.connection);
  const refs = [ref('a', uuid(1)), ref('b', uuid(2))];
  const options = { staging, signal: new AbortController().signal };
  const fallback = await all(provider.preview!('/book', refs, { ...options, rendering: 'fallback' }));
  assert.deepEqual(fallback.map((result) => 'file' in result && !!result.kept), [true, false]);
  assert.deepEqual(renderJobs(plugin).map((job) => job.uuids), [[uuid(2)]], 'only the refused photo is rendered');
  const never = await all(provider.preview!('/book', refs, { ...options, rendering: 'never' }));
  assert.deepEqual(never.find(({ id }) => id === 'b'), { id: 'b', deferred: true });
  assert.equal(renderJobs(plugin).length, 1);
  const before = thumbnailJobs(plugin).length;
  const always = await all(provider.preview!('/book', refs, { ...options, rendering: 'always' }));
  assert.deepEqual(always.map((result) => 'file' in result && !('kept' in result)), [true, true]);
  assert.equal(thumbnailJobs(plugin).length, before);
  // A job that fails while Lightroom is there is no reason to show nothing.
  plugin.thumbnailsFail = true;
  const failed = await all(provider.preview!('/book', refs, options));
  assert.ok(failed.every((result) => 'file' in result));
});

test('an edit while a thumbnail was fetched shows in its revisions', async (t) => {
  const { provider, fake, bridge, staging } = await setup(t);
  const plugin = fake('1.1.0');
  plugin.add(1);
  await plugin.connect();
  await until(() => !!bridge.connection);
  const known = available((await provider.observe('/book', [ref('a', uuid(1))]))[0]).revisions;
  plugin.duringRender = (id) => plugin.edit(id, { develop: { Exposure2012: 2 } });
  const [result] = await all(provider.preview!('/book', [ref('a', uuid(1), catalogId, known)], { staging, signal: new AbortController().signal }));
  assert.ok('file' in result);
  assert.deepEqual(result.before, known);
  assert.equal(result.after.revision, plugin.revision(uuid(1)));
  assert.equal(result.after.contentRevision, plugin.developHash(uuid(1)));
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
  // A crash breaks the held poll; between polls the bridge's grace would apply instead.
  await until(() => bridge.holding);
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

test('a watch that starts after Lightroom connected still brings back photos the book last saw offline', async (t) => {
  const { provider, fake, bridge } = await setup(t);
  const refs = [ref('a', uuid(1)), ref('b', uuid(2))];
  // The book loads before the plugin reconnects (the app was restarted): its photos are offline.
  for (const result of await provider.observe('/book', refs)) assert.equal(result.state, 'offline');
  const plugin = fake();
  plugin.add(1); plugin.add(2);
  await plugin.connect();
  await until(() => !!bridge.connection);
  // Its watch starts only now; no connection event is coming, so the watch itself reports every photo once.
  const reported: string[][] = [];
  const stop = provider.watch('/book', refs, (ids) => reported.push(ids));
  await until(() => reported.length === 1);
  assert.deepEqual(reported[0], ['a', 'b']);
  for (const result of await provider.observe('/book', refs)) assert.equal(result.state, 'available');
  stop();
  // A watch that starts with the book's last look matching the connection reports nothing.
  const quiet: string[][] = [];
  const again = provider.watch('/book', refs, (ids) => quiet.push(ids));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(quiet, []);
  again();
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
  // Only an export load marks a photo it could not get the original of; the editor shows the preview without it.
  assert.equal(loaded.sources!['photo:lr1'].previewOnly, undefined);
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

async function bookWithLightroom(t: Parameters<typeof setup>[0]) {
  const context = await setup(t);
  const { root, provider, fake, bridge } = context;
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
  const plugin = fake('1.1.0');
  plugin.add(1, { title: 'Harbour', color: '#ff0000' });
  plugin.add(2, { color: '#0000ff' });
  await plugin.connect();
  await until(() => !!bridge.connection);
  const book = await loadProject(folder, cache);
  const files = structuredClone({ project: book.project, photoIndex: book.photoIndex });
  for (const n of [1, 2]) files.photoIndex['lr' + n] = lightroomLocator.write({ provider: 'lightroom', catalog: catalogId, uuid: uuid(n) }) as never;
  const loaded = await updateProject(book, files, true);
  const refs = ['lr1', 'lr2'].map((id) => ({ id, locator: lightroomLocator.read(loaded.photoIndex[id] as Record<string, unknown>)! }));
  const facts = await AssetFacts.forBook(folder);
  const changes = async (shown: Awaited<ReturnType<typeof loadProject>>, again = false) => providedChanges(folder, provider, refs, facts, { staging: join(cache, 'provider-staging'), again,
    available: () => true, shown: (id) => ({ available: shown.sources!['photo:' + id].state === 'available', outOfDate: !!shown.sources!['photo:' + id].outOfDate, pending: !!shown.sources!['photo:' + id].pending }) });
  return { ...context, folder, cache, proxies, plugin, loaded, facts, changes, load: () => loadProject(folder, cache) };
}

test('a photo edited in Develop keeps its picture, marked out of date, until Lightroom has a preview of it again', async (t) => {
  const f = await bookWithLightroom(t);
  const { plugin } = f;
  assert.equal(renderJobs(plugin).length, 0, 'the import rendered nothing');
  const before = f.facts.get('lr1')!;
  // An edit with a crop, in Develop: no preview of it exists.
  plugin.refused.add(uuid(1));
  plugin.edit(uuid(1), { develop: { Exposure2012: 1 }, crop: { width: 4000, height: 4000 }, title: 'Harbour at dusk', color: '#00ff00' });
  const edited = await f.changes(f.loaded);
  assert.deepEqual([edited.reload, edited.revised, edited.reshaped], [['lr1'], ['lr1'], []]);
  assert.equal(renderJobs(plugin).length, 0, 'an edited photo is not rendered');
  const stale = f.facts.get('lr1')!;
  assert.equal(stale.digest, before.digest);
  assert.deepEqual([stale.width, stale.height], [6000, 4000], 'the size the picture goes with');
  assert.equal(stale.provided?.title, 'Harbour at dusk');
  assert.deepEqual(stale.revisions, { revision: plugin.revision(uuid(1)) }, 'prints follow the revision; no content is claimed');
  assert.equal(stale.verified, before.verified, 'no newer an observation than its preview');
  const shown = await f.load();
  assert.equal(shown.sources!['photo:lr1'].outOfDate, true);
  assert.equal(shown.sources!['photo:lr1'].state, 'available');
  assert.equal(shown.photos.get('lr1')!.problem, undefined);
  assert.equal(shown.sources!['photo:lr2'].outOfDate, undefined);
  // Asked again while there is none: nothing to show differently.
  const same = await f.changes(shown);
  assert.deepEqual([same.reload, same.revised], [[], []]);
  // Edited once more, still in Develop: only what prints moves.
  plugin.edit(uuid(1), { develop: { Exposure2012: 2 } });
  const more = await f.changes(shown);
  assert.deepEqual([more.reload, more.revised], [[], ['lr1']]);
  // Back in Library Lightroom has one, and the plugin reports the photo.
  plugin.refused.delete(uuid(1));
  const back = await f.changes(shown);
  assert.deepEqual([back.reload, back.revised, back.reshaped], [['lr1'], ['lr1'], ['lr1']]);
  const fresh = f.facts.get('lr1')!;
  assert.notEqual(fresh.digest, before.digest);
  assert.deepEqual([fresh.width, fresh.height], [4000, 4000]);
  assert.deepEqual(fresh.revisions, { revision: plugin.revision(uuid(1)), contentRevision: plugin.developHash(uuid(1)) });
  assert.equal((await f.load()).sources!['photo:lr1'].outOfDate, undefined);
  assert.equal(renderJobs(plugin).length, 0);
});

test('a metadata edit asks for no preview, and an undone edit clears the mark', async (t) => {
  const f = await bookWithLightroom(t);
  const asked = thumbnailJobs(f.plugin).length;
  f.plugin.edit(uuid(1), { title: 'Renamed' });
  assert.deepEqual((await f.changes(f.loaded)).reload, ['lr1'], 'the new title');
  assert.equal(thumbnailJobs(f.plugin).length, asked);
  f.plugin.refused.add(uuid(1));
  f.plugin.edit(uuid(1), { develop: { Exposure2012: 1 } });
  await f.changes(f.loaded);
  const shown = await f.load();
  assert.equal(shown.sources!['photo:lr1'].outOfDate, true);
  f.plugin.edit(uuid(1), { develop: { Exposure2012: 0 } });
  f.plugin.refused.delete(uuid(1));
  assert.deepEqual((await f.changes(shown)).reload, ['lr1']);
  assert.equal((await f.load()).sources!['photo:lr1'].outOfDate, undefined);
});

test('a thumbnail that still shows the photo before its edit is not taken for the new one: the photo is rendered', async (t) => {
  const f = await bookWithLightroom(t);
  const before = f.facts.get('lr1')!;
  f.plugin.keptColor.set(uuid(1), '#ff0000');
  f.plugin.edit(uuid(1), { develop: { Exposure2012: 1 }, color: '#00ff00' });
  assert.deepEqual((await f.changes(f.loaded)).reload, ['lr1']);
  assert.deepEqual(renderJobs(f.plugin).map((job) => [job.uuids, job.size]), [[[uuid(1)], 'preview']]);
  const fact = f.facts.get('lr1')!;
  assert.notEqual(fact.digest, before.digest);
  assert.equal(fact.revisions?.contentRevision, f.plugin.developHash(uuid(1)));
});

test('Refresh from Lightroom renders anew, and a failed one keeps the picture and says why', async (t) => {
  const f = await bookWithLightroom(t);
  f.plugin.refused.add(uuid(1));
  f.plugin.edit(uuid(1), { develop: { Exposure2012: 1 }, color: '#00ff00' });
  await f.changes(f.loaded);
  const shown = await f.load();
  assert.ok(assetMenu(projectSummary(shown, 'view'), ['photo:lr1']).some((item) => (item as { command?: string }).command === 'asset-refresh'));
  const asked = thumbnailJobs(f.plugin).length;
  const refreshed = await f.changes(shown, true);
  assert.deepEqual(refreshed.reload.sort(), ['lr1', 'lr2']);
  assert.equal(refreshed.problems, undefined);
  assert.deepEqual(renderJobs(f.plugin).map((job) => job.uuids), [[uuid(1), uuid(2)]]);
  assert.equal(thumbnailJobs(f.plugin).length, asked, 'no thumbnail is asked for');
  const now = await f.load();
  assert.equal(now.sources!['photo:lr1'].outOfDate, undefined);
  f.plugin.renderOutside = join(f.root, 'escaped.jpg');
  const failed = await f.changes(now, true);
  assert.deepEqual(failed.reload, []);
  assert.equal(failed.problems!.get('lr1')!.state, 'available');
  assert.match(failed.problems!.get('lr1')!.problem, /outside the folder/);
  assert.equal((await f.load()).sources!['photo:lr1'].state, 'available');
});

test('a thumbnail too small to lay out by is replaced by a render', async (t) => {
  const f = await bookWithLightroom(t);
  f.plugin.keptEdge.set(uuid(1), 360);
  f.plugin.edit(uuid(1), { develop: { Exposure2012: 1 }, color: '#00ff00' });
  assert.deepEqual((await f.changes(f.loaded)).reload, ['lr1']);
  assert.equal(renderJobs(f.plugin).length, 1);
});

test('a small thumbnail of a panorama is too small by the panorama’s long edge, and its new shape is still reported', async (t) => {
  const f = await bookWithLightroom(t);
  f.plugin.keptEdge.set(uuid(1), 800);
  f.plugin.edit(uuid(1), { develop: { CropTop: 0.4 }, crop: { width: 6000, height: 800 }, color: '#00ff00' });
  const changes = await f.changes(f.loaded);
  assert.equal(renderJobs(f.plugin).length, 1, '800 px of a 6000 px photo, though its short edge is 800 px');
  // The small preview already recorded the new shape when the render replaced it.
  assert.deepEqual([changes.reload, changes.reshaped], [['lr1'], ['lr1']]);
  assert.equal(f.facts.get('lr1')!.height, 800);
});

test('a photo that cannot be observed has its problem reported, with its state', async (t) => {
  const f = await bookWithLightroom(t);
  await f.plugin.quit();
  const changes = await f.changes(f.loaded);
  assert.deepEqual([...changes.problems!.values()].map(({ state }) => state), ['offline', 'offline']);
});

test('an export of an out-of-date photo asks for no preview and prints the photo as it is now', async (t) => {
  const f = await bookWithLightroom(t);
  f.plugin.refused.add(uuid(1));
  f.plugin.edit(uuid(1), { develop: { Exposure2012: 1 }, color: '#00ff00' });
  await f.changes(f.loaded);
  const files = structuredClone({ project: f.loaded.project, photoIndex: f.loaded.photoIndex });
  const spread = files.project.spreads.find(({ boxes }) => Object.values(boxes).some(({ photo }) => photo))!;
  const box = Object.values(spread.boxes).find(({ photo }) => photo)!;
  box.photo = 'lr1';
  await updateProject(f.loaded, files, true);
  await f.facts.flush();
  const job = join(f.cache, 'job'); await mkdir(job);
  const asked = thumbnailJobs(f.plugin).length;
  const pinned = await loadProject(f.folder, job, true, true);
  assert.equal(thumbnailJobs(f.plugin).length, asked);
  assert.deepEqual(renderJobs(f.plugin).map((job_) => [job_.uuids, job_.size]), [[[uuid(1)], 'full']]);
  assert.equal(pinned.materialized!.lr1, f.plugin.revision(uuid(1)));
  // The export guard compares with the fact, which follows the revision while its picture does not.
  assert.equal(pinned.materialized!.lr1, f.facts.get('lr1')!.revisions!.revision);
  assert.equal(pinned.sources!['photo:lr1'].outOfDate, undefined);
  assert.equal(pinned.sources!['photo:lr1'].previewOnly, undefined);
});

test('a book open in a session loads without waiting for previews: it names those it wants and shows them as they come', async (t) => {
  const f = await bookWithLightroom(t);
  for (let n = 3; n <= 4; n++) f.plugin.add(n, { title: 'Photo ' + n });
  const wanted: { id: string; key: string }[] = [], problems = new Map<string, string>();
  const stop = backgroundPreviews(f.folder, { wanted: (previews) => wanted.push(...previews), problem: ({ id }) => problems.get(id) });
  t.after(async () => stop());
  const asked = thumbnailJobs(f.plugin).length;
  let open!: () => void;
  f.plugin.thumbnailGate = new Promise((resolve) => { open = resolve; });
  const files = structuredClone({ project: f.loaded.project, photoIndex: f.loaded.photoIndex });
  for (const n of [3, 4]) files.photoIndex['lr' + n] = lightroomLocator.write({ provider: 'lightroom', catalog: catalogId, uuid: uuid(n) }) as never;
  const loaded = await updateProject(f.loaded, files, true);
  assert.equal(thumbnailJobs(f.plugin).length, asked, 'the load asked Lightroom for no preview');
  assert.deepEqual(wanted, [3, 4].map((n) => ({ id: 'lr' + n, key: f.plugin.developHash(uuid(n)) })));
  const status = loaded.sources!['photo:lr3'];
  assert.equal(status.state, 'unreadable');
  assert.equal(status.pending, true);
  assert.equal(loaded.unavailablePhotos!.lr3.width, 6000, 'laid out at its size');
  assert.equal(f.facts.get('lr3'), undefined, 'nothing is recorded of it yet');
  assert.ok(!sourceWarnings(loaded.sources).some(({ source }) => source === 'lr3'), 'a preview that is loading is no finding');
  // Fetched in the background; a load meanwhile waits for none of it and shows what has come.
  const refs = [3, 4].map((n) => ({ id: 'lr' + n, locator: lightroomLocator.read(loaded.photoIndex['lr' + n] as Record<string, unknown>)! }));
  const seen: string[] = [];
  const fetching = providedChanges(f.folder, f.provider, refs, f.facts, { staging: join(f.cache, 'provider-staging'), available: () => false,
    shown: () => ({ available: false, pending: true }), progress: (id, _changes, done, total) => seen.push(id + ' ' + done + '/' + total) });
  await until(() => thumbnailJobs(f.plugin).length > asked);
  assert.equal((await f.load()).sources!['photo:lr3'].pending, true);
  open();
  assert.deepEqual((await fetching).reload.sort(), ['lr3', 'lr4']);
  assert.deepEqual(seen.map((entry) => entry.slice(4)), ['1/2', '2/2']);
  const shown = await f.load();
  assert.equal(shown.sources!['photo:lr3'].state, 'available');
  assert.equal(shown.photos.get('lr4')!.title, 'Photo 4');
  // An edited photo is wanted too, and drawn from before until it comes.
  wanted.length = 0;
  f.plugin.edit(uuid(3), { develop: { Exposure2012: 1 } });
  assert.equal((await f.load()).sources!['photo:lr3'].outOfDate, true);
  assert.deepEqual(wanted, [{ id: 'lr3', key: f.plugin.developHash(uuid(3)) }]);
  // One that failed before shows why instead of loading for ever.
  f.plugin.add(5);
  problems.set('lr5', 'No preview of it.');
  const more = structuredClone({ project: shown.project, photoIndex: shown.photoIndex });
  more.photoIndex.lr5 = lightroomLocator.write({ provider: 'lightroom', catalog: catalogId, uuid: uuid(5) }) as never;
  const last = await updateProject(shown, more, true);
  assert.equal(last.sources!['photo:lr5'].pending, undefined);
  assert.equal(last.sources!['photo:lr5'].problem, 'No preview of it.');
});

// The book of `bookWithLightroom` with more photos, whose previews an open session is fetching; `open` lets them come.
async function bookFetchingPreviews(t: Parameters<typeof setup>[0], count: number) {
  const f = await bookWithLightroom(t);
  const ids = Array.from({ length: count }, (_, index) => index + 3);
  for (const n of ids) f.plugin.add(n);
  const wanted: string[] = [];
  const stop = backgroundPreviews(f.folder, { wanted: (previews) => wanted.push(...previews.map(({ id }) => id)), problem: () => undefined });
  t.after(async () => stop());
  let open!: () => void;
  f.plugin.thumbnailGate = new Promise((resolve) => { open = resolve; });
  const files = structuredClone({ project: f.loaded.project, photoIndex: f.loaded.photoIndex });
  for (const n of ids) files.photoIndex['lr' + n] = lightroomLocator.write({ provider: 'lightroom', catalog: catalogId, uuid: uuid(n) }) as never;
  const box = Object.values(files.project.spreads).flatMap((spread) => Object.values(spread.boxes)).find(({ photo }) => photo)!;
  box.photo = 'lr3';
  const book = await updateProject(f.loaded, files, true);
  const before = thumbnailJobs(f.plugin).length;
  const refs = ids.map((n) => ({ id: 'lr' + n, locator: lightroomLocator.read(book.photoIndex['lr' + n] as Record<string, unknown>)! }));
  const fetching = providedChanges(f.folder, f.provider, refs, f.facts, { staging: join(f.cache, 'provider-staging'), available: () => false, shown: () => ({ available: false, pending: true }) });
  await until(() => thumbnailJobs(f.plugin).length > before);
  const asked = () => thumbnailJobs(f.plugin).slice(before).reduce((sum, { photos }) => sum + (photos as unknown[]).length, 0);
  const check = (signal = new AbortController().signal) => checkProject(book, f.cache, {}, async () => ({
    status: { state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {}, anchors: [], template: {} } as never }), signal);
  return { ...f, book, wanted, fetching, open, asked, check };
}

test('a check of a book whose previews are being fetched waits for none and asks for none (API-009, UI-008)', async (t) => {
  const f = await bookFetchingPreviews(t, 30);
  f.wanted.length = 0;
  // Held until `open`: a check that waited for the previews would never end.
  const during = await f.check();
  assert.equal(during.state, 'ready');
  assert.deepEqual(during.diagnostics.filter(({ code }) => code === 'photo-preview-loading').map(({ severity, details }) => ({ severity, details })),
    [{ severity: 'warning', details: { photos: 1 } }], 'the placed photo drawn without its picture is named');
  // Previews that come while it renders move the revision, and the check stands (API-007).
  const revised = await checkProject(f.book, f.cache, {}, async () => {
    f.open();
    await f.fetching;
    return { status: { state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {}, anchors: [], template: {} } as never };
  }, new AbortController().signal);
  assert.equal(revised.state, 'ready', JSON.stringify(revised.diagnostics));
  assert.ok(revised.superseded && revised.superseded.revision !== revised.revision);
  // The facts of the previews that came are not in the file yet: the check reads them from the open book.
  const after = await f.check();
  assert.deepEqual(after.diagnostics.filter(({ code }) => code === 'photo-preview-loading'), []);
  assert.equal(f.asked(), 30, 'each preview was asked for once');
  assert.deepEqual(f.wanted, [], 'a check wants no previews');
});

test('a check that is given up ends while Lightroom has not answered yet', async (t) => {
  const f = await bookFetchingPreviews(t, 1);
  t.after(async () => f.open());
  const observe = f.provider.observe;
  let asked!: () => void;
  const waiting = new Promise<void>((resolve) => { asked = resolve; });
  f.provider.observe = (folder, refs, options) => {
    asked();
    return options?.signal ? new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })) : observe(folder, refs, options);
  };
  const job = new AbortController();
  const check = f.check(job.signal);
  await waiting;
  job.abort(new Error('Timed out.'));
  await assert.rejects(check, /Timed out/);
});

test('an observation that is given up ends its request to the plugin', async (t) => {
  const { provider, fake, bridge } = await setup(t);
  const plugin = fake('1.1.0');
  plugin.add(1);
  await plugin.connect();
  await until(() => !!bridge.connection);
  const job = new AbortController();
  job.abort();
  const [result] = await provider.observe('/book', [ref('a', uuid(1))], { signal: job.signal });
  assert.equal(result.state, 'unreadable');
  assert.equal(plugin.jobs.filter(({ type }) => type === 'metadata').length, 0);
});

test('a photo is known to commands by its size and its source’s caption, also while its preview loads', async (t) => {
  const f = await bookFetchingPreviews(t, 1);
  t.after(async () => f.open());
  f.plugin.photos.get(uuid(3))!.caption = 'From Lightroom';
  f.plugin.edit(uuid(3), { title: 'Edited' });
  const pending = await f.load();
  assert.equal(pending.sources!['photo:lr3'].pending, true);
  const known = loadedPhoto(pending)('lr3')!;
  assert.deepEqual([known.width, known.height, known.caption], [6000, 4000, 'From Lightroom']);
  // A caption saved in the book is the registry's to tell, which a batch may have changed: not what was loaded.
  const files = structuredClone({ project: pending.project, photoIndex: pending.photoIndex });
  files.photoIndex.lr1.caption = 'Saved';
  assert.equal(loadedPhoto(await updateProject(pending, files, true))('lr1')!.caption, undefined);
  assert.equal(loadedPhoto(pending)('none'), undefined);
});

test('Save a Copy waits for no previews, and previews that come meanwhile do not fail it', async (t) => {
  const f = await bookFetchingPreviews(t, 20);
  const asked = f.asked();
  // Held until the copy is done: one that waited for the previews would never end.
  await saveDocumentCopy(f.book, join(f.root, 'Copy.imageflow'), false);
  assert.equal(f.asked(), asked, 'and asks for none');
  f.open();
  await f.fetching;
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.root, 'Copy.imageflow/photos.json'), 'utf8'))), Object.keys(f.book.photoIndex));
});
