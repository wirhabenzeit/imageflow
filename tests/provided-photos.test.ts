import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
import { compactPreview, providedChanges, refreshProvided, strippedPreview } from '../desktop/provided-photos';
import { materializePhotos, placedPhotos } from '../desktop/materialized-photos';
import { collectSources, saveDocumentCopy } from '../desktop/source-actions';
import type { Materialized, MaterializeOptions, Observed, Revisions, SourceProvider, SourceRef, Unavailable } from '../desktop/source-provider';
import { copySample } from '../desktop/sample-book.mjs';
import { bookFormatOf, photoIndexSchema, projectSchema } from '../src/project';
import { registerLocatorKind } from '../src/source-locator';
import type { LocatorKind } from '../src/source-locator';
import { photoName, printProblem, sourceEntries } from '../src/source-locations';
import type { PhotoSourceEntry } from '../src/source-locations';
import { assetMenu } from '../src/asset-menu';
import { assetFactSchema, assetsMetaSchema } from '../src/asset-facts';
import './persistence-root';

// Photos without a file (ADR 0011): the host's side, built against a provider that keeps its photos in memory and
// exists only here. Nothing in it is Lightroom's.

type MemoryLocator = { provider: 'memory'; asset: string; name?: string };
const memoryLocator: LocatorKind<MemoryLocator> = {
  provider: 'memory',
  // An app on this Mac, like Lightroom Classic.
  reach: 'mac',
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
  // Full-resolution originals: a render at the asset's own size, as Lightroom's export session makes one.
  materialized: string[][] = [];
  stagings: string[] = [];
  // Assets whose original cannot be made: a half-written file is left in the staging folder, as a failed export may.
  failOriginal = new Set<string>();
  // Changes an asset between the revision read before an original and the one after, this many times.
  editsDuringOriginal = new Map<string, number>();
  // Called before an original is reported, and after it was taken: a test aborts here.
  beforeOriginal?: (id: string) => void;
  afterOriginal?: (id: string) => void;
  async *materialize(_book: string, refs: readonly SourceRef<MemoryLocator>[], { staging, signal }: MaterializeOptions): AsyncGenerator<Materialized> {
    this.materialized.push(refs.map(({ id }) => id));
    this.stagings.push(staging);
    for (const { id, locator } of refs) {
      if (signal.aborted) return;
      const asset = this.assets.get(locator.asset);
      if (!asset || !this.online) { yield { id, state: (this.online ? 'missing' : 'offline') as Unavailable, problem: 'Not there.' }; continue; }
      if (this.failOriginal.has(locator.asset)) {
        await writeFile(join(staging, randomUUID() + '.part'), 'half an export');
        yield { id, state: 'unreadable', problem: 'The export failed in memory.' };
        continue;
      }
      const before = this.revisions(asset);
      const file = join(staging, randomUUID() + '.jpg');
      await writeFile(file, await render(asset.color, asset.width, asset.height));
      const edits = this.editsDuringOriginal.get(locator.asset) ?? 0;
      if (edits > 0) { this.editsDuringOriginal.set(locator.asset, edits - 1); asset.revision += '+'; }
      this.beforeOriginal?.(id);
      yield { id, file, before, after: this.revisions(asset) };
      this.afterOriginal?.(id);
    }
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
  // The editor does not call it a proof: an export materializes what its provider can produce.
  assert.equal(f.book.sources!['photo:mem1'].previewOnly, undefined);
  assert.equal(printProblem(f.book.sources!['photo:mem1']), undefined);
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

test('a preview is kept as a compact JPEG of at most 1400 px with its colour profile, equal pixels giving equal bytes', async () => {
  // Like Lightroom's: full chroma, high quality, a fresh metadata segment on each render, and larger than a preview.
  const noisy = await sharp({ create: { width: 2000, height: 1300, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).withIccProfile('srgb').toBuffer();
  const segment = Buffer.from('http://ns.adobe.com/xap/1.0/\0' + randomUUID());
  const head = Buffer.alloc(4); head.writeUInt16BE(0xffe1, 0); head.writeUInt16BE(segment.length + 2, 2);
  const rendered = () => Buffer.concat([noisy.subarray(0, 2), head, segment, noisy.subarray(2)]);
  const [one, two] = [await compactPreview(rendered()), await compactPreview(rendered())];
  assert.equal(sha256(one), sha256(two), 'two renders of the same pixels keep one digest');
  assert.ok(one.length < noisy.length / 2, 'much smaller than what arrived: ' + one.length + ' of ' + noisy.length);
  const metadata = await sharp(one).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height, metadata.chromaSubsampling], ['jpeg', 1400, 910, '4:2:0']);
  assert.ok(metadata.icc, 'the colour profile stays');
  assert.equal(metadata.exif, undefined);
  // A preview that is small already is never made larger.
  const small = await render('#336699', 40, 30);
  assert.ok((await compactPreview(small)).length <= strippedPreview(small).length);
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

test('an export load draws an unplaced photo without a file from its preview, and materializes nothing for it', async (t) => {
  const f = await fixture(t);
  await settle(f.book);
  const job = join(f.cache, 'job'); await mkdir(job);
  const pinned = await loadProject(f.folder, job, true, true);
  assert.deepEqual(f.provider.materialized, [], 'only placed photos are materialized');
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

// --- Full-resolution originals ------------------------------------------------------------------------------------

type Fixture = Awaited<ReturnType<typeof fixture>>;
const photoEntry = (book: OpenProject, id: string) => sourceEntries(book).find((entry) => entry.key === 'photo:' + id) as PhotoSourceEntry;
// What an export or a copy asks for: each photo with the revisions its provider reports now.
const requestsOf = async (f: Fixture, ids: string[]) => {
  const observed = await f.provider.observe(f.folder, refsOf(f.book, ids));
  return ids.map((id, index) => { const result = observed[index]; assert.equal(result.state, 'available'); return { source: photoEntry(f.book, id), revisions: (result as { revisions: Revisions }).revisions }; });
};
const storeOf = (f: Fixture) => SourceStore.forBook(f.folder, f.cache);
const materialize = async (f: Fixture, ids: string[], options?: Parameters<typeof materializePhotos>[3]) =>
  materializePhotos(f.folder, await storeOf(f), await requestsOf(f, ids), options);
// Every file left in the source cache's staging folders and among its content's temporary files.
const leftovers = async (f: Fixture) => {
  const root = join(f.root, 'source-cache');
  const staged = await readdir(join(root, 'staging'), { recursive: true }).catch(() => [] as string[]);
  const temporary = (await readdir(join(root, 'content'))).filter((name) => name.endsWith('.tmp'));
  return [...staged, ...temporary];
};
// Places photos in the hero boxes of the first spreads, as a user drags them onto pages.
async function place(f: Fixture, ids: string[]) {
  const files = structuredClone({ project: f.book.project, photoIndex: f.book.photoIndex });
  ids.forEach((id, index) => { files.project.spreads[index].boxes.hero = { params: {}, photo: id }; });
  f.book = await updateProject(f.book, files, true);
  await settle(f.book);
  return f.book;
}
const exportLoad = async (f: Fixture, name = 'job') => { const job = join(f.cache, name); await mkdir(job); return { job, book: await loadProject(f.folder, job, true, true) }; };

test('an original is materialized into the source cache once, and reused while its revision is the same', async (t) => {
  const f = await fixture(t);
  const first = (await materialize(f, ['mem1'])).get('mem1')!;
  assert.equal(first.state, 'available');
  assert.ok(first.state === 'available' && !first.reused);
  const { stored } = first as Extract<typeof first, { state: 'available' }>;
  assert.equal(stored.observation, 'r1', 'recorded against the revision');
  assert.equal(stored.snapshot, join(f.root, 'source-cache', 'content', stored.digest + '.jpg'), 'named by its content in the source cache');
  assert.equal(sha256(await readFile(stored.snapshot)), stored.digest);
  assert.deepEqual([stored.width, stored.height], [6000, 4000]);
  assert.deepEqual(f.provider.materialized, [['mem1']]);
  assert.deepEqual(await leftovers(f), [], 'the staging folder is removed');
  // The same revision: nothing is asked for.
  const again = (await materialize(f, ['mem1'])).get('mem1')!;
  assert.ok(again.state === 'available' && again.reused);
  assert.equal((again as { stored: { snapshot: string } }).stored.snapshot, stored.snapshot);
  assert.equal(f.provider.materialized.length, 1);
  // Recorded in the book's source index, so it survives the session.
  await (await storeOf(f)).settled();
  assert.equal(f.provider.materialized.length, 1);
});

test('an original is materialized again once its revision moved', async (t) => {
  const f = await fixture(t);
  const before = (await materialize(f, ['mem1'])).get('mem1') as { stored: { digest: string } };
  const asset = f.provider.assets.get('a1')!;
  asset.revision = 'r2'; asset.color = '#00ff00';
  const after = (await materialize(f, ['mem1'])).get('mem1')!;
  assert.ok(after.state === 'available' && !after.reused);
  assert.equal(f.provider.materialized.length, 2);
  assert.equal((after as { revision: string }).revision, 'r2');
  assert.notEqual((after as { stored: { digest: string } }).stored.digest, before.stored.digest);
  // A request for the revision the store holds now reuses it; the old one is not valid for it.
  assert.ok(((await materialize(f, ['mem1'])).get('mem1') as { reused: boolean }).reused);
  assert.equal(await (await storeOf(f)).materialization(photoEntry(f.book, 'mem1'), 'r1'), undefined);
});

test('an original made while its photo changed is discarded and asked for again, a bounded number of times', async (t) => {
  const f = await fixture(t);
  f.provider.editsDuringOriginal.set('a1', 1);
  const result = (await materialize(f, ['mem1', 'mem2'])).get('mem1')!;
  assert.equal(result.state, 'available');
  // Asked for again after observing it once more, with the revision it has now.
  assert.deepEqual(f.provider.materialized, [['mem1', 'mem2'], ['mem1']]);
  assert.equal((result as { revision: string }).revision, 'r1+');
  assert.equal((result as { stored: { observation: string } }).stored.observation, 'r1+');
  assert.deepEqual(await leftovers(f), [], 'the discarded file went with the staging folder');
  // A photo that keeps changing is given up on, and nothing is recorded for it.
  f.provider.materialized = [];
  f.provider.assets.get('a2')!.revision = 'r5';
  f.provider.editsDuringOriginal.set('a2', 10);
  const restless = (await materialize(f, ['mem2'])).get('mem2')!;
  assert.equal(restless.state, 'unreadable');
  assert.match((restless as { problem: string }).problem, /kept changing/);
  assert.equal(f.provider.materialized.length, 3);
  assert.equal(await (await storeOf(f)).materialization(photoEntry(f.book, 'mem2'), f.provider.assets.get('a2')!.revision), undefined);
  assert.deepEqual(await leftovers(f), []);
});

test('a photo whose original cannot be made fails alone, and its files are removed with the staging folder', async (t) => {
  const f = await fixture(t);
  f.provider.failOriginal.add('a1');
  const progress: string[] = [];
  const results = await materialize(f, ['mem1', 'mem2'], { progress: ({ done, total }) => progress.push(done + '/' + total) });
  assert.equal(results.get('mem1')!.state, 'unreadable');
  assert.match((results.get('mem1') as { problem: string }).problem, /failed in memory/);
  assert.equal(results.get('mem2')!.state, 'available');
  assert.deepEqual(f.provider.materialized, [['mem1', 'mem2']], 'one call for all of a provider\'s photos');
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
  assert.deepEqual(await leftovers(f), [], 'the half-written file of the failed photo is gone too');
});

test('a cancelled materialization stores nothing more, and leaves no staging files or partial entries', async (t) => {
  const f = await fixture(t);
  // Cancelled after the first original was taken: the second is never made.
  const job = new AbortController();
  f.provider.afterOriginal = () => job.abort();
  const results = await materialize(f, ['mem1', 'mem2'], { signal: job.signal });
  assert.equal(results.get('mem1')!.state, 'available', 'what was complete before the cancel is a whole original');
  assert.equal(results.get('mem2')!.state, 'unreadable');
  assert.match((results.get('mem2') as { problem: string }).problem, /Cancelled/);
  assert.equal(await (await storeOf(f)).materialization(photoEntry(f.book, 'mem2'), 'r1'), undefined);
  assert.deepEqual(await leftovers(f), []);
  // Cancelled while a provider was still writing one: its result arrives after the cancel and is not stored.
  f.provider.afterOriginal = undefined;
  const late = new AbortController();
  f.provider.beforeOriginal = () => late.abort();
  const after = await materialize(f, ['mem2'], { signal: late.signal });
  assert.equal(after.get('mem2')!.state, 'unreadable');
  assert.equal(await (await storeOf(f)).materialization(photoEntry(f.book, 'mem2'), 'r1'), undefined);
  assert.deepEqual(await leftovers(f), [], 'the file it wrote is removed');
  const content = (await readdir(join(f.root, 'source-cache', 'content'))).filter((name) => name.endsWith('.jpg'));
  assert.deepEqual(content, [(results.get('mem1') as { stored: { digest: string } }).stored.digest + '.jpg'], 'only the whole original is in the cache');
});

test('an export prints a placed photo without a file from its pinned original, not as a proof', async (t) => {
  const f = await fixture(t);
  await place(f, ['mem1']);
  assert.deepEqual([...placedPhotos(f.book)].filter((id) => id.startsWith('mem')), ['mem1']);
  const { job, book } = await exportLoad(f);
  // Only the placed photo was asked for.
  assert.deepEqual(f.provider.materialized, [['mem1']]);
  const status = book.sources!['photo:mem1'];
  assert.equal(status.state, 'available');
  assert.equal(status.previewOnly, undefined);
  assert.equal(printProblem(status), undefined, 'no ORIGINAL UNAVAILABLE, no source-unavailable');
  const photo = book.photos.get('mem1')!;
  assert.equal(photo.original.startsWith(join(job, 'pinned-sources')), true, 'read from a private copy in the job');
  const stored = await (await storeOf(f)).materialization(photoEntry(f.book, 'mem1'), 'r1');
  assert.equal(sha256(await readFile(photo.original)), stored!.digest);
  assert.deepEqual([photo.width, photo.height], [6000, 4000]);
  assert.equal(photo.title, 'Harbour at dawn', 'the provider\'s titles stay');
  assert.equal(photo.captured?.dateTime, '2026-06-01T10:00:00');
  assert.deepEqual(book.materialized, { mem1: 'r1' });
  // The unplaced photo stays a preview in the export.
  assert.equal(book.sources!['photo:mem2'].previewOnly, true);
  // A second export reuses the stored original.
  await exportLoad(f, 'job-2');
  assert.equal(f.provider.materialized.length, 1);
});

test('an export stays a proof for a placed photo whose provider is offline or cannot produce it', async (t) => {
  const f = await fixture(t);
  await place(f, ['mem1', 'mem2']);
  f.provider.failOriginal.add('a2');
  const { book } = await exportLoad(f);
  assert.equal(printProblem(book.sources!['photo:mem1']), undefined);
  assert.equal(book.sources!['photo:mem2'].previewOnly, true);
  assert.match(printProblem(book.sources!['photo:mem2'])!, /Only a preview/);
  assert.equal(book.photos.get('mem2')!.original, await f.proxies.path((await readAssetFacts(f.folder)).mem2.digest));
  // Offline: nothing is asked for, and the proxy stands in as before.
  f.provider.online = false;
  f.provider.materialized = [];
  const offline = (await exportLoad(f, 'job-2')).book;
  assert.deepEqual(f.provider.materialized, []);
  assert.equal(offline.sources!['photo:mem1'].state, 'offline');
  assert.match(printProblem(offline.sources!['photo:mem1'])!, /not running/);
  assert.equal(offline.materialized, undefined);
});

test('a cancelled export load leaves no staging files and no original of the photos it did not finish', async (t) => {
  const f = await fixture(t);
  await place(f, ['mem1', 'mem2']);
  const job = new AbortController();
  f.provider.beforeOriginal = () => job.abort();
  const folder = join(f.cache, 'job'); await mkdir(folder);
  const book = await loadProject(f.folder, folder, true, true, { signal: job.signal });
  assert.equal(book.materialized, undefined);
  assert.equal(book.sources!['photo:mem1'].previewOnly, true);
  assert.deepEqual(await leftovers(f), []);
  assert.deepEqual((await readdir(join(f.root, 'source-cache', 'content'))).filter((name) => name.endsWith('.jpg')), [], 'no original in the cache');
});

test('the export guard follows the revision token of a materialized photo', async (t) => {
  const f = await fixture(t);
  await place(f, ['mem1']);
  const before = await captureProjectInputs(f.folder);
  // Changed in its source before the open book heard of it: the export load sees another revision than the book.
  f.provider.assets.get('a1')!.revision = 'r2';
  const { book } = await exportLoad(f);
  assert.deepEqual(book.materialized, { mem1: 'r2' });
  assert.equal((await AssetFacts.forBook(f.folder)).get('mem1')!.revisions!.revision, 'r1', 'which the export tells from what the book has seen');
  // Once the watch reports it, the render inputs move: "Sources changed during export".
  await changesOf(f, ['mem1']);
  assert.notEqual((await captureProjectInputs(f.folder)).revision, before.revision);
});

test('Copy into Book materializes a photo without a file and makes it an owned photo', async (t) => {
  const f = await fixture(t);
  await settle(f.book);
  const progress: string[] = [];
  const failed: string[] = [];
  const copied = await collectSources(f.book, ['photo:mem1'], { progress: ({ done, total }) => progress.push(done + '/' + total), failed: (source) => failed.push(source.id) });
  assert.deepEqual(failed, []);
  assert.deepEqual(progress, ['0/1', '1/1']);
  const entry = copied.photoIndex.mem1 as Record<string, unknown>;
  assert.equal(entry.memory, undefined, 'the provider\'s fields are gone');
  assert.match(entry.path as string, /^photos\/mem1-[0-9a-f]{8}\/IMG_0001\.jpg$/);
  assert.equal(entry.title, 'Harbour at dawn', 'the provider\'s titles become the book\'s own');
  assert.equal(entry.caption, 'From Lightroom-like metadata');
  const stored = await (await storeOf(f)).materialization(photoEntry(f.book, 'mem1'), 'r1');
  assert.equal(sha256(await readFile(join(f.folder, entry.path as string))), stored!.digest);
  // It now loads as a file of the package, with no problem, and prints from its own bytes.
  const status = copied.sources!['photo:mem1'];
  assert.equal(status.state, 'available');
  assert.equal((status as PhotoSourceEntry).locator.provider, 'package');
  assert.equal(copied.photos.get('mem1')!.original, join(f.folder, entry.path as string));
  assert.equal(copied.photos.get('mem1')!.width, 6000);
  const { book: printed } = await exportLoad(f);
  assert.equal(printProblem(printed.sources!['photo:mem1']), undefined);
  // mem2 is still a photo without a file: the book stays format 4 until it is copied too.
  assert.equal(copied.project.schemaVersion, 4);
  const all = await collectSources(copied, ['photo:mem2']);
  assert.ok(all.project.schemaVersion < 4, 'no entry without a path remains');
  assert.equal(JSON.parse(await readFile(join(f.folder, 'project.json'), 'utf8')).schemaVersion, all.project.schemaVersion);
  assert.equal((all.photoIndex.mem2 as Record<string, unknown>).title, 'My own title', 'an override stays');
  // Facts follow the copied file once its digest is read, like any owned photo's.
  await (await storeOf(f)).digested();
  await settle(all);
  const fact = (await readAssetFacts(f.folder)).mem1;
  assert.equal(fact.digest, stored!.digest);
  assert.equal(fact.revisions, undefined);
});

test('Copy into Book keeps the entry of a photo its provider cannot produce, and a cancelled copy changes nothing', async (t) => {
  const f = await fixture(t);
  f.provider.failOriginal.add('a2');
  const failed: string[] = [];
  const copied = await collectSources(f.book, ['photo:mem1', 'photo:mem2'], { failed: (source) => failed.push(source.id) });
  assert.deepEqual(failed, ['mem2']);
  assert.ok((copied.photoIndex.mem1 as Record<string, unknown>).path);
  assert.deepEqual(copied.photoIndex.mem2, f.book.photoIndex.mem2);
  assert.deepEqual(await leftovers(f), []);
  // Cancelled: no entry changes and no file stays in the book.
  f.provider.failOriginal.clear();
  const job = new AbortController(); job.abort();
  const photos = await readdir(join(f.folder, 'photos'), { recursive: true });
  assert.equal(await collectSources(copied, ['photo:mem2'], { signal: job.signal }), copied);
  assert.deepEqual(await readdir(join(f.folder, 'photos'), { recursive: true }), photos);
  // An offline provider is refused like a missing file.
  f.provider.online = false;
  await assert.rejects(collectSources(copied, ['photo:mem2']), /Cannot include all assets/);
});

test('the Assets menu offers Copy into Book for a photo without a file', async (t) => {
  const f = await fixture(t);
  const menu = assetMenu(projectSummary(f.book, 'view'), ['photo:mem1', 'photo:mem2']);
  const copy = menu.find((item) => (item as { command?: string }).command === 'asset-copy') as { enabled: boolean; label?: string };
  assert.equal(copy.enabled, true);
  assert.equal(copy.label, 'Copy 2 into Book…');
});

test('Save a Copy with all files included copies photos without a file into the new book', async (t) => {
  const f = await fixture(t);
  await settle(f.book);
  const destination = await saveDocumentCopy(f.book, join(f.root, 'Portable.imageflow'), true);
  t.after(() => AssetFacts.release(destination));
  const photos = JSON.parse(await readFile(join(destination, 'photos.json'), 'utf8'));
  for (const id of ['mem1', 'mem2']) {
    assert.equal(photos[id].memory, undefined);
    assert.match(photos[id].path, new RegExp('^photos/' + id + '-'));
    const stored = await (await storeOf(f)).materialization(photoEntry(f.book, id), 'r1');
    assert.equal(sha256(await readFile(join(destination, photos[id].path))), stored!.digest);
  }
  assert.equal(photos.mem1.title, 'Harbour at dawn');
  assert.ok(JSON.parse(await readFile(join(destination, 'project.json'), 'utf8')).schemaVersion < 4, 'the copy opens in older builds');
  // The book itself is unchanged.
  assert.deepEqual(JSON.parse(await readFile(join(f.folder, 'photos.json'), 'utf8')).mem1.memory, { asset: 'a1', name: 'IMG_0001.dng' });
  // Without all files, the photos stay with their provider.
  const linked = await saveDocumentCopy(f.book, join(f.root, 'Linked.imageflow'), false);
  t.after(() => AssetFacts.release(linked));
  assert.deepEqual(JSON.parse(await readFile(join(linked, 'photos.json'), 'utf8')).mem1.memory, { asset: 'a1', name: 'IMG_0001.dng' });
  assert.equal(JSON.parse(await readFile(join(linked, 'project.json'), 'utf8')).schemaVersion, 4);
  assert.equal(f.provider.materialized.length, 1, 'both originals were made in one call');
});
