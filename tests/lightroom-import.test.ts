import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LightroomBridge } from '../desktop/lightroom/bridge';
import { lightroomProvider } from '../desktop/providers/lightroom';
import { registerProvider } from '../desktop/providers';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { configureProxyStore } from '../desktop/proxy-store';
import { AssetFacts, readAssetFacts } from '../desktop/asset-facts';
import { acquireProjectLock } from '../desktop/persistence';
import { importProvidedPhotos, loadProject } from '../desktop/project';
import { copySample } from '../desktop/sample-book.mjs';
import type { LightroomLocator } from '../src/source-locator';
import { catalogId, FakeLightroom, otherCatalogId, uuid } from './lightroom-fake';
import './persistence-root';

// Importing Lightroom Classic photos (ADR 0011): Send to ImageFlow and Import from Lightroom Classic… both end in the
// same host step as a file import. The plugin is a fake that speaks the bridge protocol over HTTP.

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-lr-import-')));
  const folder = join(root, 'Book.imageflow');
  const cache = join(root, 'cache');
  await mkdir(cache);
  configureSourceStore(join(root, 'source-cache'));
  configureSourceAccess(join(root, 'source-access'));
  const proxies = await configureProxyStore(join(root, 'proxies'));
  const bridge = new LightroomBridge({ file: join(root, 'bridge.json'), version: 'test', hold: 300, grace: 5000, closeGrace: 200 });
  await bridge.start();
  const unregister = registerProvider(lightroomProvider(bridge));
  await copySample(resolve('sample/starter'), folder);
  const release = await acquireProjectLock(folder);
  const plugin = new FakeLightroom(join(root, 'bridge.json'));
  t.after(async () => {
    await plugin.quit(true);
    await SourceStore.drain();
    await AssetFacts.release(folder);
    await release();
    unregister();
    await bridge.stop();
    configureProxyStore(undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  for (let n = 1; n <= 4; n++) plugin.add(n, { title: n === 1 ? 'Harbour' : undefined });
  await plugin.connect();
  const end = Date.now() + 3000;
  while (!bridge.connection && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  return { root, folder, cache, proxies, plugin, book: await loadProject(folder, cache) };
}
const locator = (n: number, name?: string, catalog = catalogId): LightroomLocator => ({ provider: 'lightroom', catalog, uuid: uuid(n), ...(name ? { name } : {}) });
const lightroomEntries = (photoIndex: Record<string, unknown>) => Object.entries(photoIndex).filter(([, entry]) => !!(entry as { lightroom?: unknown }).lightroom);

test('new Lightroom photos get an ID and an entry without a title, and load with facts and previews', async (t) => {
  const f = await fixture(t);
  const { book, imported, counts } = await importProvidedPhotos(f.book, [locator(1, 'DSC_0001.ARW'), locator(2, 'DSC_0002.ARW')]);
  assert.deepEqual(counts, { photos: 2, texts: 0, files: 0, skipped: 0, failed: 0 });
  assert.equal(imported.length, 2);
  for (const id of imported) assert.match(id, /^ph-[0-9a-f-]{12}$/);
  const written = JSON.parse(await readFile(join(f.folder, 'photos.json'), 'utf8'));
  assert.deepEqual(written[imported[0]], { lightroom: { catalog: catalogId, uuid: uuid(1), name: 'DSC_0001.ARW' } }, 'no title: it inherits Lightroom’s');
  assert.equal(JSON.parse(await readFile(join(f.folder, 'project.json'), 'utf8')).schemaVersion, 4);
  // The same load as any import: facts recorded, previews fetched in one session.
  await (await AssetFacts.forBook(f.folder)).flush();
  const facts = await readAssetFacts(f.folder);
  assert.ok(await f.proxies.path(facts[imported[0]].digest));
  assert.equal(book.photos.get(imported[0])!.title, 'Harbour');
  assert.equal(book.sources!['photo:' + imported[1]].previewOnly, true);
  assert.equal(f.plugin.jobs.filter(({ type }) => type === 'render').length, 1);
});

test('a photo the book holds already, by catalog and UUID, is reported and never added again', async (t) => {
  const f = await fixture(t);
  const first = await importProvidedPhotos(f.book, [locator(1), locator(2)]);
  const renders = f.plugin.jobs.filter(({ type }) => type === 'render').length;
  // All held: the book is unchanged and nothing is written or rendered.
  const again = await importProvidedPhotos(first.book, [locator(2), { ...locator(1), uuid: uuid(1).toLowerCase() }]);
  assert.equal(again.book, first.book);
  assert.deepEqual(again.counts, { photos: 0, texts: 0, files: 0, skipped: 0, failed: 0, existing: 2 });
  assert.deepEqual(again.imported, [first.imported[1], first.imported[0]], 'one ID per photo asked for, in order');
  assert.equal(f.plugin.jobs.filter(({ type }) => type === 'render').length, renders);
  // Mixed: one held, one new twice, one of another catalog (a different photo), and a file locator, which this
  // import does not take.
  const mixed = await importProvidedPhotos(first.book, [locator(1), locator(3), locator(3), locator(1, undefined, otherCatalogId), { provider: 'package', path: 'photos/x.jpg' } as never]);
  assert.deepEqual(mixed.counts, { photos: 2, texts: 0, files: 0, skipped: 1, failed: 0, existing: 2 });
  assert.equal(mixed.imported[0], first.imported[0]);
  assert.equal(mixed.imported[1], mixed.imported[2], 'a photo sent twice is one photo');
  assert.equal(lightroomEntries(mixed.book.photoIndex).length, 4);
  // The photo of the other catalog is offline: that catalog is not open.
  assert.equal(mixed.book.sources!['photo:' + mixed.imported[3]].state, 'offline');
});

test('photos sent while Lightroom has gone are added and wait offline for it', async (t) => {
  const f = await fixture(t);
  await f.plugin.quit();
  const { book, imported, counts } = await importProvidedPhotos(f.book, [locator(4)]);
  assert.equal(counts.photos, 1);
  const status = book.sources!['photo:' + imported[0]];
  assert.equal(status.state, 'offline');
  assert.deepEqual(status.repairs, ['launch']);
  assert.equal(book.photos.has(imported[0]), false, 'nothing to draw before a first preview');
});
