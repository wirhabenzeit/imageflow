import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { configureSourceStore, SourceStore } from '../desktop/source-store';
import { configureSourceAccess } from '../desktop/source-access';
import { configureProxyStore } from '../desktop/proxy-store';
import { AssetFacts, readAssetFacts } from '../desktop/asset-facts';
import { acquireProjectLock, persistProjectManifests } from '../desktop/persistence';
import { loadProject, photoMetadata, projectSummary, updateProject, withProjectFiles } from '../desktop/project';
import type { OpenProject } from '../desktop/project';
import { captureProjectInputs } from '../desktop/revisions';
import { registerProvider } from '../desktop/providers';
import { providedChanges, refreshProvided, strippedPreview } from '../desktop/provided-photos';
import type { Materialized, MaterializeOptions, Observed, Revisions, SourceProvider, SourceRef, Unavailable } from '../desktop/source-provider';
import { copySample } from '../desktop/sample-book.mjs';
import { bookFormatOf, photoIndexSchema, projectSchema } from '../src/project';
import { registerLocatorKind } from '../src/source-locator';
import type { LocatorKind } from '../src/source-locator';
import { photoName, printProblem, sourceEntries } from '../src/source-locations';
import { assetMenu } from '../src/asset-menu';
import { assetFactSchema, assetsMetaSchema } from '../src/asset-facts';
import './persistence-root';

// Photos without a file (ADR 0011): the host's side, built against a provider that keeps its photos in memory and
// exists only here. Nothing in it is Lightroom's.

type MemoryLocator = { provider: 'memory'; asset: string; name?: string };
const memoryLocator: LocatorKind<MemoryLocator> = {
  provider: 'memory',
  fields: ['memory'],
  read: (entry) => {
    const value = entry.memory as Partial<MemoryLocator> | undefined;
    return typeof value?.asset === 'string' ? { provider: 'memory', asset: value.asset, ...(value.name ? { name: value.name } : {}) } : undefined;
  },
  write: ({ provider: _provider, ...memory }) => ({ memory }),
  portable: ({ asset }) => ({ memory: { asset } }),
  shared: (locator) => locator,
  adopt: (shared, here) => here ?? shared,
  key: ({ asset }) => asset,
  name: ({ name }) => name,
};

type Asset = { revision: string; content: string; width: number; height: number; color: string;
  provided?: { title?: string; caption?: string; credit?: string; altText?: string } };
// A JPEG of one colour, with an EXIF/XMP segment and a comment that differ on every render, as Lightroom's do.
async function render(color: string, width: number, height: number) {
  const plain = await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().withIccProfile('srgb').toBuffer();
  const segment = (marker: number, body: Buffer) => { const head = Buffer.alloc(4); head.writeUInt16BE(0xff00 | marker, 0); head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
  const xmp = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmpMM:DocumentID="' + randomUUID() + '"/>'));
  const comment = segment(0xfe, Buffer.from('rendered ' + randomUUID()));
  return Buffer.concat([plain.subarray(0, 2), xmp, comment, plain.subarray(2)]);
}

class MemoryProvider implements SourceProvider<MemoryLocator> {
  readonly provider = 'memory' as const;
  readonly assets = new Map<string, Asset>();
  online = true;
  observed: { id: string; known?: Revisions }[][] = [];
  previewed: string[][] = [];
  changed?: (ids: string[]) => void;
  watched: string[] = [];
  // Changes an asset between the revision read before a preview and the one after, once.
  editDuringPreview?: string;
  duringPreview?: () => void;
  revisions = (asset: Asset): Revisions => ({ revision: asset.revision, contentRevision: asset.content });
  async observe(_book: string, refs: readonly SourceRef<MemoryLocator>[]): Promise<Observed[]> {
    this.observed.push(refs.map(({ id, known }) => ({ id, ...(known ? { known } : {}) })));
    return refs.map(({ locator }) => {
      if (!this.online) return { state: 'offline', problem: 'The memory app is not running.' };
      const asset = this.assets.get(locator.asset);
      if (!asset) return { state: 'missing', problem: 'Deleted from memory.' };
      return { state: 'available', revisions: this.revisions(asset), facts: { width: asset.width, height: asset.height,
        captured: { dateTime: '2026-06-01T10:00:00', offset: '+02:00' }, ...(asset.provided ? { provided: asset.provided } : {}), extra: { color: asset.color } } };
    });
  }
  async *preview(_book: string, refs: readonly SourceRef<MemoryLocator>[], { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
    this.previewed.push(refs.map(({ id }) => id));
    for (const { id, locator } of refs) {
      if (signal.aborted) return;
      const asset = this.assets.get(locator.asset);
      if (!asset || !this.online) { yield { id, state: (this.online ? 'missing' : 'offline') as Unavailable, problem: 'Not there.' }; continue; }
      const before = this.revisions(asset);
      const scale = Math.min(1, 140 / Math.max(asset.width, asset.height));
      const file = join(staging, randomUUID() + '.jpg');
      await writeFile(file, await render(asset.color, Math.round(asset.width * scale), Math.round(asset.height * scale)));
      if (this.editDuringPreview === locator.asset) { this.editDuringPreview = undefined; asset.revision += '+'; this.duringPreview?.(); }
      yield { id, file, before, after: this.revisions(asset) };
    }
  }
  async *materialize(_book: string, refs: readonly SourceRef<MemoryLocator>[]): AsyncGenerator<Materialized> {
    for (const { id } of refs) yield { id, state: 'unreadable', problem: 'Memory has no originals.' };
  }
  watch(_book: string, refs: readonly SourceRef<MemoryLocator>[], changed: (ids: string[]) => void) {
    this.watched = refs.map(({ id }) => id);
    this.changed = changed;
    return () => { this.changed = undefined; this.watched = []; };
  }
  repairs(state: Unavailable) { return state === 'offline' ? ['launch'] as const : []; }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-provided-')));
  const folder = join(root, 'Book.imageflow');
  const cache = join(root, 'cache');
  await mkdir(cache);
  configureSourceStore(join(root, 'source-cache'));
  configureSourceAccess(join(root, 'source-access'));
  const proxies = await configureProxyStore(join(root, 'proxies'));
  const provider = new MemoryProvider();
  const unregister = [registerLocatorKind(memoryLocator), registerProvider(provider)];
  await copySample(resolve('sample/starter'), folder);
  const release = await acquireProjectLock(folder);
  t.after(async () => {
    await SourceStore.drain();
    await AssetFacts.release(folder);
    await release();
    for (const remove of unregister) remove();
    configureProxyStore(undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  provider.assets.set('a1', { revision: 'r1', content: 'c1', width: 6000, height: 4000, color: '#ff0000', provided: { title: 'Harbour at dawn', caption: 'From Lightroom-like metadata' } });
  provider.assets.set('a2', { revision: 'r1', content: 'c1', width: 4000, height: 6000, color: '#0000ff' });
  const book = await loadProject(folder, cache);
  // Two photos from memory, added as an import of that provider would add them: without a title of their own.
  const files = structuredClone({ project: book.project, photoIndex: book.photoIndex });
  files.photoIndex.mem1 = { memory: { asset: 'a1', name: 'IMG_0001.dng' } } as never;
  files.photoIndex.mem2 = { memory: { asset: 'a2' }, title: 'My own title' } as never;
  const added = await updateProject(book, files, true);
  return { root, folder, cache, proxies, provider, book: added };
}
const settle = async (book: OpenProject) => (await AssetFacts.forBook(book.folder)).flush();

// --- Compatibility -----------------------------------------------------------------------------------------------

test('a photos.json entry without a path is read only through a registered locator kind, and makes a book format 4', () => {
  const entry = { memory: { asset: 'a1' } };
  assert.equal(photoIndexSchema.safeParse({ p: entry }).success, false, 'no kind of this version reads it');
  assert.match(photoIndexSchema.safeParse({ p: entry }).error!.issues[0].message, /update ImageFlow/);
  const unregister = registerLocatorKind(memoryLocator);
  try {
    const photos = photoIndexSchema.parse({ p: entry, q: { path: 'photos/q.jpg' } });
    assert.deepEqual(photos.p, entry, 'the locator is kept as the entry holds it');
    const project = projectSchema.parse({ schemaVersion: 1, title: 'Book', template: { id: 't', version: '1' }, spreads: [] });
    assert.equal(bookFormatOf(project), 1);
    assert.equal(bookFormatOf(project, { q: { path: 'photos/q.jpg' } }), 1);
    assert.equal(bookFormatOf(project, photos), 4);
    assert.equal(bookFormatOf({ ...project, cover: {} }, photos), 4);
  } finally { unregister(); }
});

test('assets-meta.json keeps fields this version does not know, and is never written over in a newer version', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'if-meta-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'Book.imageflow');
  await copySample(resolve('sample/starter'), folder);
  const release = await acquireProjectLock(folder);
  t.after(async () => { await AssetFacts.release(folder); await release(); });
  const digest = 'a'.repeat(64);
  const fact = { digest, width: 10, height: 5, verified: '2026-01-01T00:00:00.000Z', lightroom: { revision: 'x', developHash: 'y' }, future: 1 };
  assert.deepEqual(assetFactSchema.parse(fact), fact, 'a fact keeps unknown keys');
  await writeFile(join(folder, 'assets-meta.json'), JSON.stringify({ version: 1, assets: { p: fact, gone: { ...fact, digest: 'b'.repeat(64) } }, written: 'by a newer build' }));
  const facts = await AssetFacts.forBook(folder);
  assert.deepEqual(facts.get('p'), fact);
  // Noting the same original again keeps the unknown keys; another original drops them, as they described the old one.
  facts.note('p', 'stamp', { width: 10, height: 5 }, digest);
  facts.prune(['p']);
  await facts.flush();
  const written = JSON.parse(await readFile(join(folder, 'assets-meta.json'), 'utf8'));
  assert.equal(written.written, 'by a newer build', 'unknown top-level keys stay');
  assert.deepEqual(written.assets.p.lightroom, fact.lightroom);
  assert.equal(written.assets.p.future, 1);
  assert.equal(written.assets.gone, undefined);
  facts.note('p', 'stamp-2', { width: 10, height: 5 }, 'c'.repeat(64));
  await facts.flush();
  assert.equal(JSON.parse(await readFile(join(folder, 'assets-meta.json'), 'utf8')).assets.p.lightroom, undefined);
  // A newer version of the file reads as empty, and stays as it is when this build would write it.
  const newer = JSON.stringify({ version: 2, assets: { p: { anything: true } } });
  await writeFile(join(folder, 'assets-meta.json'), newer);
  assert.deepEqual(await readAssetFacts(folder), {});
  facts.note('p', 'stamp-3', { width: 12, height: 5 }, 'd'.repeat(64));
  await facts.flush();
  assert.equal(await readFile(join(folder, 'assets-meta.json'), 'utf8'), newer);
  assert.equal(assetsMetaSchema.safeParse(JSON.parse(newer)).success, false);
});

// --- Loading ------------------------------------------------------------------------------------------------------

test('a book asks each provider once for all its photos, and records facts, revisions, provided titles and previews', async (t) => {
  const f = await fixture(t);
  await settle(f.book);
  // One observe for the memory provider, with both photos, at each load.
  const memory = f.provider.observed.at(-1)!;
  assert.deepEqual(memory.map(({ id }) => id).sort(), ['mem1', 'mem2']);
  const facts = await readAssetFacts(f.folder);
  for (const id of ['mem1', 'mem2']) {
    const fact = facts[id];
    assert.deepEqual(fact.revisions, { revision: 'r1', contentRevision: 'c1' });
    const proxy = await f.proxies.path(fact.digest);
    assert.ok(proxy, 'the preview is in the proxy store under its digest');
    assert.equal(sha256(await readFile(proxy!)), fact.digest, 'the digest is of the stored bytes');
    assert.equal(strippedPreview(await readFile(proxy!)).length, (await readFile(proxy!)).length, 'stored without metadata segments');
  }
  assert.deepEqual(facts.mem1.provided, { title: 'Harbour at dawn', caption: 'From Lightroom-like metadata' });
  assert.deepEqual(facts.mem1.extra, { color: '#ff0000' });
  assert.equal(facts.mem1.width, 6000);
  // Drawn from fact and proxy, without a problem: laid out at the original's size.
  const photo = f.book.photos.get('mem1')!;
  assert.equal(photo.problem, undefined);
  assert.equal(photo.width, 6000);
  assert.equal(photo.height, 4000);
  assert.equal(photo.captured?.dateTime, '2026-06-01T10:00:00');
  assert.equal(f.book.sources!['photo:mem1'].state, 'available');
  assert.equal(f.book.sources!['photo:mem1'].previewOnly, true);
  assert.equal(f.book.problems.some((problem) => problem.includes('mem1')), false);
  // The book is format 4 on disk, so older builds ask for an update.
  assert.equal(JSON.parse(await readFile(join(f.folder, 'project.json'), 'utf8')).schemaVersion, 4);
  // A second load reuses the stored previews: the content revision has not moved.
  const previews = f.provider.previewed.length;
  const again = await loadProject(f.folder, f.cache);
  assert.equal(f.provider.previewed.length, previews);
  assert.deepEqual(f.provider.observed.at(-1)!.find(({ id }) => id === 'mem1')!.known, { revision: 'r1', contentRevision: 'c1' }, 'the stored revisions are handed back');
  assert.equal(again.photos.get('mem1')!.key, photo.key);
});

test('two renders of the same pixels have one digest once their metadata segments are removed', async () => {
  const [one, two] = [await render('#336699', 40, 30), await render('#336699', 40, 30)];
  assert.notEqual(sha256(one), sha256(two));
  assert.equal(sha256(strippedPreview(one)), sha256(strippedPreview(two)));
  const metadata = await sharp(strippedPreview(one)).metadata();
  assert.ok(metadata.icc, 'the ICC profile stays');
  assert.equal(metadata.exif, undefined);
  assert.throws(() => strippedPreview(Buffer.from('GIF89a')), /JPEG or PNG/);
  // A segment length counts its own two bytes: 0 or 1 is no JPEG.
  for (const length of [0, 1]) assert.throws(() => strippedPreview(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, length, 0xff, 0xd9])), /not a whole JPEG/);
});

test('titles come from the provider unless photos.json overrides them; an empty override blanks', async (t) => {
  const f = await fixture(t);
  assert.equal(f.book.photos.get('mem1')!.title, 'Harbour at dawn');
  assert.equal(f.book.photos.get('mem1')!.caption, 'From Lightroom-like metadata');
  assert.equal(f.book.photos.get('mem2')!.title, 'My own title');
  const summary = projectSummary(f.book, 'view');
  assert.equal(photoName(summary, 'mem1'), 'Harbour at dawn');
  assert.deepEqual(summary.photoProvided?.mem1, { title: 'Harbour at dawn', caption: 'From Lightroom-like metadata' });
  // Without a title of either kind, the locator's name; without one, the ID.
  assert.equal(sourceEntries(f.book).find(({ id }) => id === 'mem1')!.name, 'IMG_0001.dng');
  assert.equal(sourceEntries(f.book).find(({ id }) => id === 'mem2')!.name, 'mem2');
  const files = structuredClone({ project: f.book.project, photoIndex: f.book.photoIndex });
  files.photoIndex.mem1.title = 'Book title';
  files.photoIndex.mem1.caption = '';
  const edited = withProjectFiles(f.book, files);
  assert.equal(edited.photos.get('mem1')!.title, 'Book title');
  assert.equal(edited.photos.get('mem1')!.caption, '', 'a present empty string is an override');
  // Revert removes the key: the provider's value comes back.
  delete files.photoIndex.mem1.title;
  assert.equal(withProjectFiles(f.book, files).photos.get('mem1')!.title, 'Harbour at dawn');
  assert.deepEqual(photoMetadata({ path: 'photos/x.jpg' }, { title: 'T' }), { title: 'T' });
});

// --- Changes ------------------------------------------------------------------------------------------------------

const refsOf = (book: OpenProject, ids: string[]) => ids.map((id) => ({ id, locator: memoryLocator.read(book.photoIndex[id] as Record<string, unknown>)! }));
const changesOf = async (f: Awaited<ReturnType<typeof fixture>>, ids: string[], available = (id: string) => f.book.sources?.['photo:' + id]?.state === 'available') =>
  providedChanges(f.folder, f.provider, refsOf(f.book, ids), await AssetFacts.forBook(f.folder), { staging: join(f.cache, 'provider-staging'), available });

test('a metadata edit records new revisions without a preview, and reloads only for what the book shows', async (t) => {
  const f = await fixture(t);
  const asset = f.provider.assets.get('a1')!;
  const previews = f.provider.previewed.length;
  // A rating, say: the revision moves, nothing the book shows does. No preview, no reload.
  const initial = await captureProjectInputs(f.folder);
  asset.revision = 'r1b';
  assert.deepEqual(await changesOf(f, ['mem1']), { reload: [], revised: ['mem1'], reshaped: [] });
  assert.notEqual((await captureProjectInputs(f.folder)).revision, initial.revision, 'the render inputs follow the revision token');
  // A new title is shown at once: templates print inherited titles and the Inspector shows them.
  const before = await captureProjectInputs(f.folder);
  asset.revision = 'r2';
  asset.provided = { title: 'Renamed in the source' };
  const changes = await changesOf(f, ['mem1']);
  assert.deepEqual(changes, { reload: ['mem1'], revised: ['mem1'], reshaped: [] });
  assert.equal(f.provider.previewed.length, previews, 'no preview for a metadata edit');
  const fact = (await AssetFacts.forBook(f.folder)).get('mem1')!;
  assert.deepEqual(fact.revisions, { revision: 'r2', contentRevision: 'c1' });
  assert.equal(fact.provided?.title, 'Renamed in the source');
  // The render inputs follow the revision token, with no bytes to hash.
  const after = await captureProjectInputs(f.folder);
  assert.notEqual(after.revision, before.revision);
  // Nothing new: nothing at all.
  assert.deepEqual(await changesOf(f, ['mem1']), { reload: [], revised: [], reshaped: [] });
  assert.equal((await captureProjectInputs(f.folder)).revision, after.revision);
});

test('a visual edit re-renders the preview, and reloads only if its digest changed', async (t) => {
  const f = await fixture(t);
  const asset = f.provider.assets.get('a1')!;
  const digest = (await AssetFacts.forBook(f.folder)).get('mem1')!.digest;
  // Rendered again, the same pixels: a new preview, the same digest, no reload.
  asset.revision = 'r2'; asset.content = 'c2';
  const same = await changesOf(f, ['mem1']);
  assert.deepEqual(same, { reload: [], revised: ['mem1'], reshaped: [] });
  assert.equal(f.provider.previewed.at(-1)!.join(), 'mem1');
  assert.equal((await AssetFacts.forBook(f.folder)).get('mem1')!.digest, digest);
  // Another picture: a new digest, a reload.
  asset.revision = 'r3'; asset.content = 'c3'; asset.color = '#00ff00';
  const changed = await changesOf(f, ['mem1']);
  assert.deepEqual(changed, { reload: ['mem1'], revised: ['mem1'], reshaped: [] });
  const fact = (await AssetFacts.forBook(f.folder)).get('mem1')!;
  assert.notEqual(fact.digest, digest);
  assert.ok(await f.proxies.path(fact.digest));
  const reloaded = await loadProject(f.folder, f.cache);
  assert.ok(reloaded.photos.get('mem1')!.original.includes(fact.digest));
});

test('a crop in the source that changes the aspect ratio is reported for the photo', async (t) => {
  const f = await fixture(t);
  const asset = f.provider.assets.get('a1')!;
  asset.revision = 'r2'; asset.content = 'c2'; asset.width = 4000; asset.height = 4000; asset.color = '#ffff00';
  const changes = await changesOf(f, ['mem1']);
  assert.deepEqual(changes.reshaped, ['mem1']);
  assert.equal((await AssetFacts.forBook(f.folder)).get('mem1')!.width, 4000);
});

test('a preview made while the photo changed is discarded and asked for again', async (t) => {
  const f = await fixture(t);
  const asset = f.provider.assets.get('a1')!;
  asset.revision = 'r2'; asset.content = 'c2'; asset.color = '#00ffff';
  f.provider.editDuringPreview = 'a1';
  const previews = f.provider.previewed.length;
  // The edit made during the first preview also changes the photo's size: the facts recorded are the new ones.
  f.provider.duringPreview = () => { asset.width = 3000; asset.provided = { title: 'Edited meanwhile' }; };
  await changesOf(f, ['mem1']);
  assert.equal(f.provider.previewed.length, previews + 2);
  const fact = (await AssetFacts.forBook(f.folder)).get('mem1')!;
  assert.equal(fact.revisions?.revision, 'r2+');
  assert.equal(fact.width, 3000);
  assert.equal(fact.provided?.title, 'Edited meanwhile');
});

test('facts a provider reports that are not valid leave the photo unreadable, not laid out from them', async (t) => {
  const f = await fixture(t);
  f.provider.assets.set('a3', { revision: 'r1', content: 'c1', width: 0, height: 10, color: '#ffffff' });
  const files = structuredClone({ project: f.book.project, photoIndex: f.book.photoIndex });
  files.photoIndex.mem3 = { memory: { asset: 'a3' } } as never;
  const book = await updateProject(f.book, files, true);
  assert.equal(book.sources!['photo:mem3'].state, 'unreadable');
  assert.match(book.sources!['photo:mem3'].problem!, /cannot use/);
  assert.equal(book.photos.has('mem3'), false);
  assert.equal((await AssetFacts.forBook(f.folder)).get('mem3'), undefined);
  // The same for a photo that had a valid fact: it is not reported as available with its old one.
  f.provider.assets.get('a1')!.revision = 'r2';
  f.provider.assets.get('a1')!.width = 0;
  const outcome = (await refreshProvided(f.folder, f.provider as never, refsOf(f.book, ['mem1']), await f.provider.observe(f.folder, refsOf(f.book, ['mem1'])),
    await AssetFacts.forBook(f.folder), { staging: join(f.cache, 'staging') })).get('mem1')!;
  assert.equal(outcome.state, 'unreadable');
});

test('an offline provider shows its photos from their proxies, offers its own repairs, and prints them as proofs', async (t) => {
  const f = await fixture(t);
  await settle(f.book);
  f.provider.online = false;
  const changes = await changesOf(f, ['mem1', 'mem2']);
  assert.deepEqual(changes.reload.sort(), ['mem1', 'mem2'], 'going offline is shown');
  const offline = await loadProject(f.folder, f.cache);
  const status = offline.sources!['photo:mem1'];
  assert.equal(status.state, 'offline');
  assert.equal(status.cached, true, 'the proxy stands in');
  assert.deepEqual(status.repairs, ['launch']);
  assert.equal(offline.photos.get('mem1')!.width, 6000);
  assert.match(offline.photos.get('mem1')!.problem!, /not running/);
  assert.match(printProblem(status)!, /not running/);
  // The Assets menu asks the provider: Retry, and no Locate for a photo that is not a file.
  const menu = assetMenu(projectSummary(offline, 'view'), ['photo:mem1']).map((item) => (item as { command?: string }).command ?? 'separator');
  assert.ok(menu.includes('asset-retry'));
  assert.equal(menu.includes('asset-locate'), false);
  assert.equal(menu.includes('asset-locate-folder'), false);
  // Back online: reported as available again, and reloaded.
  f.provider.online = true;
  assert.deepEqual((await changesOf(f, ['mem1'], () => false)).reload, ['mem1']);
});

// --- Export -------------------------------------------------------------------------------------------------------

test('an export load draws a photo without a file from its preview and marks it for a proof only', async (t) => {
  const f = await fixture(t);
  await settle(f.book);
  const job = join(f.cache, 'job'); await mkdir(job);
  const pinned = await loadProject(f.folder, job, true, true);
  const status = pinned.sources!['photo:mem1'];
  assert.equal(status.state, 'available');
  assert.equal(status.previewOnly, true);
  assert.match(printProblem(status)!, /Only a preview/);
  assert.equal(pinned.photos.get('mem1')!.width, 6000);
  // Nothing was materialized for it: its pixels are its proxy's.
  assert.equal(pinned.photos.get('mem1')!.original, await f.proxies.path((await readAssetFacts(f.folder)).mem1.digest));
});

// --- Saving -------------------------------------------------------------------------------------------------------

test('saving writes the format the photo index needs, and a save that would not is refused', async (t) => {
  const f = await fixture(t);
  assert.equal(f.book.project.schemaVersion, 4);
  const files = structuredClone({ project: f.book.project, photoIndex: f.book.photoIndex });
  delete files.photoIndex.mem1; delete files.photoIndex.mem2;
  const without = await updateProject(f.book, files, true);
  assert.equal(JSON.parse(await readFile(join(f.folder, 'project.json'), 'utf8')).schemaVersion, bookFormatOf(without.project));
  assert.ok(without.project.schemaVersion < 4, 'a book without such photos goes back to the lowest format, so older apps open it');
  const before = { 'project.json': await readFile(join(f.folder, 'project.json')), 'photos.json': await readFile(join(f.folder, 'photos.json')) };
  const photos = JSON.parse(before['photos.json'].toString('utf8'));
  photos.mem3 = { memory: { asset: 'a1' } };
  await assert.rejects(persistProjectManifests(f.folder, before, { ...before, 'photos.json': Buffer.from(JSON.stringify(photos)) }), /book format 4/);
});

test('refreshing a provider without previews leaves its photos unreadable with their last fact', async (t) => {
  const f = await fixture(t);
  const facts = await AssetFacts.forBook(f.folder);
  const { preview: _preview, ...rest } = f.provider;
  const without = Object.assign(Object.create(Object.getPrototypeOf(f.provider)), rest, { preview: undefined }) as SourceProvider<MemoryLocator>;
  f.provider.assets.get('a1')!.content = 'c9';
  const refs = refsOf(f.book, ['mem1']);
  const outcomes = await refreshProvided(f.folder, without as never, refs, await f.provider.observe(f.folder, refs), facts, { staging: join(f.cache, 'staging') });
  const outcome = outcomes.get('mem1')!;
  assert.equal(outcome.state, 'unreadable');
  assert.ok('fact' in outcome && outcome.fact?.digest, 'the last fact still lays it out');
});
