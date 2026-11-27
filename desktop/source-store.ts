import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { fileSourceOf } from '../src/source-locations';
import type { PhotoSourceEntry, SourceEntry, SourceRepair, SourceState, SourceStatus } from '../src/source-locations';
import { locatorKindOf } from '../src/source-locator';
import type { Locator } from '../src/source-locator';
import { sourceBookKey } from './source-access';
import { providerOf } from './providers';
import { cloneFile, fileFailure, observeFile, within } from './providers/files';
import type { ClonedFile, ObservedFile } from './providers/files';
import type { Observed, SourceRef } from './source-provider';
import { readSourceRegistry } from './source-identity';
import { checkPixels, photoDetails } from './photos';
import { isRenditionPath, renditionCacheFor } from './rendition-cache';

let persistentRoot: string | undefined;
const stores = new Map<string, Promise<SourceStore>>();
export function configureSourceStore(root: string) { persistentRoot = root; stores.clear(); }
export const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export { fileStamp as stamp } from './file-stamp';
import { fileStamp as stamp } from './file-stamp';
export { originalPath, within } from './providers/files';

// A photo is read through its provider (ADR 0011); a text or a file is a file and nothing else. This store keeps files
// only: a photo whose provider reports facts is the host's other path (desktop/provided-photos.ts), and is answered
// here as available without anything stored.
const photoRef = (source: PhotoSourceEntry): SourceRef<Locator> => ({ id: source.id, locator: source.locator });
// A photo's full-resolution materialization is recorded beside its other entries, under its own key, so neither the
// editor's reads nor a stand-in for an unavailable photo ever take it for a snapshot of a file. Its `path` is the
// locator it was made for: another locator (the photo relocated) is another original.
const materializedKey = (source: PhotoSourceEntry) => 'full:' + source.key;
const locatorKey = (locator: Locator) => locator.provider + ':' + locatorKindOf(locator).key(locator);
type ObservedSource = ObservedFile | { state: 'available'; facts: true } | { state: 'offline' | 'needs-sign-in'; problem: string };
const asObservedSource = (observed: Observed): ObservedSource => observed.state !== 'available' ? observed
  : observed.file !== undefined ? { state: 'available', revisions: observed.revisions, modified: observed.modified ?? new Date(0).toISOString(), file: observed.file }
  : { state: 'available', facts: true };
async function observeSource(folder: string, source: SourceEntry): Promise<ObservedSource> {
  if (source.kind !== 'photo') return observeFile(folder, source);
  const ref = photoRef(source);
  const [observed] = await providerOf(ref.locator).observe(folder, [ref]);
  return asObservedSource(observed);
}
async function cloneSource(folder: string, source: SourceEntry, staging: string): Promise<ClonedFile | { state: 'offline' | 'needs-sign-in'; problem: string }> {
  if (source.kind !== 'photo') return cloneFile(folder, source, staging);
  const ref = photoRef(source);
  for await (const copy of providerOf(ref.locator).materialize(folder, [ref], { staging, signal: new AbortController().signal })) {
    if ('file' in copy) return copy;
    return { state: copy.state, problem: copy.problem };
  }
  return { state: 'unreadable', problem: 'Original unavailable: The provider produced no file.' };
}
// The file a source is, for the messages and checks of a file; a photo that is not a file has none.
const fileOf = (source: SourceEntry) => fileSourceOf(source) ?? { kind: source.kind, path: source.name, linked: true };
type Failure = { state: Exclude<SourceState, 'available'>; problem: string };
async function hashFile(path: string) {
  const hash = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  for await (const chunk of handle.createReadStream()) hash.update(chunk);
  return hash.digest('hex');
}
// `observation` is the revision the source's provider reported; for a file, its stamp. `modified` is the original's
// modification time: a snapshot's own is its copy time, so photo views estimate an undated photo's capture time from
// this instead (see desktop/capture-time.ts).
export type StoredSource = { digest?: string; snapshot: string; path: string; observation: string; snapshotObservation?: string;
  width?: number; height?: number; modified?: string; direct?: boolean; key?: string; preview?: string; thumb?: string;
  // Renditions of the version before, for a photo read in place: they stand in while the current version has none.
  earlier?: string[] };
const storedIndexSchema = z.record(z.string(), z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(), snapshot: z.string(), path: z.string(), observation: z.string(),
  snapshotObservation: z.string().optional(), width: z.number().optional(), height: z.number().optional(),
  modified: z.string().optional(),
  direct: z.boolean().optional(), key: z.string().optional(), preview: z.string().optional(), thumb: z.string().optional(),
  earlier: z.array(z.string()).max(4).optional(),
}));
export type ResolvedSource = { status: SourceStatus; stored?: StoredSource };

/** Approved linked inputs are immutable. Owned photos stay in the package except for private job snapshots. */
export class SourceStore {
  private saved: Record<string, StoredSource> = {};
  private version = 0;
  private written = 0;
  private writes = Promise.resolve();
  readonly pins = new Set<string>();
  private constructor(readonly folder: string, private root: string, private index: string) {}
  static async forBook(folder: string, fallback: string) {
    const requestedRoot = persistentRoot ?? join(fallback, 'sources');
    await mkdir(join(requestedRoot, 'content'), { recursive: true });
    await mkdir(join(requestedRoot, 'books'), { recursive: true });
    const root = await realpath(requestedRoot);
    const identity = await sourceBookKey(folder);
    const index = join(root, 'books', identity + '.json');
    if (!stores.has(index)) stores.set(index, (async () => {
      const store = new SourceStore(folder, root, index);
      const registry = await readSourceRegistry(join(root, 'books'), folder, identity, (value) => storedIndexSchema.parse(value));
      store.saved = registry.entries;
      if (registry.migrated) store.version++;
      return store;
    })());
    return stores.get(index)!;
  }
  /** Waits for the background digests and registry writes of every open store (tests, before removing their folders). */
  static async drain() {
    for (const store of await Promise.all([...stores.values()].map((promise) => promise.catch(() => undefined)))) await store?.digested().catch(() => {});
  }
  static async release(folder: string) {
    const identity = await sourceBookKey(folder).catch(() => undefined);
    for (const [key, promise] of stores) {
      const ownKey = !!identity && key.endsWith('/' + identity + '.json');
      // A registry that failed to load is dropped for its book, so the next open reads it again.
      const store = await promise.catch(() => undefined);
      if (!store) { if (ownKey) stores.delete(key); continue; }
      if (store.folder === folder || ownKey) {
        await store.settled().catch((error) => console.warn('ImageFlow could not retain source previews', error));
        stores.delete(key);
      }
    }
  }
  private remember(source: SourceEntry, stored: StoredSource) {
    this.saved[source.key] = stored; this.version++;
    if (within(join(this.root, 'content'), stored.snapshot)) this.pins.add(stored.snapshot);
  }
  /**
   * Reads a source as the editor (in place) or an export (a private copy) needs it. `observed` is the state its provider
   * already reported for it in a batch (`readContent`), so a book's photos are observed once per provider.
   */
  async resolve(folder: string, source: SourceEntry, options: { pin?: boolean; cache?: string; observed?: Observed } = {}): Promise<ResolvedSource> {
    const file = fileOf(source);
    try {
      const observed = options.observed ? asObservedSource(options.observed) : await observeSource(folder, source);
      if (observed.state !== 'available') return await this.unavailable(source, observed, options);
      // A provider without a file: its facts and preview are recorded elsewhere, and nothing is stored here.
      if ('facts' in observed) return { status: { ...source, state: 'available' } };
      const { file: actual, revisions: { revision } } = observed;
      // Exports read every photo, owned or linked, from a private copy that lives as long as the job. Checks don't pin.
      const privatePin = options.pin && source.kind === 'photo';
      // The editor reads photos where they are, owned or linked, from their metadata: opening neither copies, hashes nor
      // decodes them. A linked photo re-exported in place (from Lightroom, say) has another revision, so it gets new
      // renditions (rendition keys name the file's stamp) and the book reloads with it (its provider watches it).
      if (source.kind === 'photo' && !options.pin) {
        const details = await photoDetails(actual, null);
        const current = await observeSource(folder, source);
        if (current.state !== 'available') return await this.unavailable(source, current, options);
        if (!('revisions' in current) || current.revisions.revision !== revision) {
          // Changed since the book's batch looked at it: read as it is now.
          if (options.observed) return await this.resolve(folder, source, { ...options, observed: undefined });
          throw new Error('Source changed while being read.');
        }
        const cache = renditionCacheFor(options.cache ?? '');
        const extension = details.alpha ? '.png' : '.jpg';
        // Locate Folder finds a moved linked original by its content, so its digest is kept: from the last record while
        // the file is unchanged, and otherwise computed in the background, not while the book opens.
        const previous = this.saved[source.key];
        const digest = previous?.digest && previous.path === file.path && previous.observation === revision ? previous.digest : undefined;
        // A re-exported photo keeps the renditions of the version before as a fallback, until its own exist: a file
        // caught half-written by the next export then still shows a picture.
        const earlier = previous?.direct && previous.key !== details.key ? [previous.preview, previous.thumb].filter((path): path is string => !!path)
          : previous?.direct ? previous.earlier : undefined;
        const stored = { path: file.path, snapshot: actual, observation: revision, direct: true, key: details.key, ...(digest ? { digest } : {}), ...(earlier?.length ? { earlier } : {}),
          width: details.width, height: details.height, modified: observed.modified, preview: join(cache, details.key + '-preview' + extension), thumb: join(cache, details.key + '-thumb' + extension) };
        this.remember(source, stored);
        if (!digest) this.recordDigest(source.key, actual, revision, async () => { const now = await observeSource(folder, source); return now.state === 'available' && 'revisions' in now ? now.revisions.revision : undefined; });
        return { status: { ...source, state: 'available', ...(digest ? { digest } : {}) }, stored };
      }
      const previous = this.saved[source.key];
      if (!privatePin && previous?.digest && !previous.direct && previous.path === file.path && previous.observation === revision &&
          await stat(previous.snapshot, { bigint: true }).then((info) => within(join(this.root, 'content'), previous.snapshot) && stamp(info) === previous.snapshotObservation, () => false)) {
        if (source.kind === 'photo' && !previous.modified) { previous.modified = observed.modified; this.remember(source, previous); }
        this.pins.add(previous.snapshot);
        return { status: { ...source, state: 'available', digest: previous.digest }, stored: previous };
      }
      const requestedDirectory = privatePin ? join(options.cache!, 'pinned-sources') : join(this.root, 'content');
      await mkdir(requestedDirectory, { recursive: true });
      const directory = await realpath(requestedDirectory);
      // Copied once (a clone where the volume makes them), then the private bytes are checked.
      const copy = await cloneSource(folder, source, directory);
      if ('state' in copy) return await this.unavailable(source, copy, options);
      const temporary = copy.file;
      try {
        if (copy.before.revision !== revision || copy.after.revision !== revision) {
          if (options.observed && copy.before.revision === copy.after.revision) return await this.resolve(folder, source, { ...options, observed: undefined });
          throw new Error('Source changed while being read.');
        }
        const digest = await hashFile(temporary);
        let dimensions: { width?: number; height?: number; modified?: string } = {};
        if (source.kind === 'photo') {
          // The copy is named by the original's extension, as the snapshot will be: a HEIC is checked by what decodes it.
          const named = temporary + extname(file.path).toLowerCase();
          await rename(temporary, named);
          try {
            const { width, height } = await photoDetails(named, null);
            await checkPixels(named);
            dimensions = { modified: observed.modified, width, height };
          } finally { await rename(named, temporary); }
        }
        const snapshot = join(directory, digest + extname(file.path).toLowerCase());
        if (!privatePin) this.pins.add(snapshot);
        if (!await hashFile(snapshot).then((value) => value === digest, () => false)) await rename(temporary, snapshot);
        const stored = { digest, snapshot, path: file.path, observation: revision, snapshotObservation: stamp(await stat(snapshot, { bigint: true })), ...dimensions };
        if (!privatePin) this.remember(source, stored);
        return { status: { ...source, state: 'available', digest }, stored };
      } finally { await rm(temporary, { force: true }); }
    } catch (error) {
      return this.unavailable(source, fileFailure(error, file), options);
    }
  }
  /** The status of a source that cannot be read now, with what was last read from it when that can stand in. */
  private async unavailable(source: SourceEntry, { state, problem }: Failure, options: { cache?: string }): Promise<ResolvedSource> {
    // An unapproved location stays unread, also what was cached from it.
    if (state === 'unapproved') return { status: { ...source, state, problem, cached: false, ...this.repairs(source, state) } };
    let stored: StoredSource | undefined = this.saved[source.key];
    if (stored?.direct) {
      const original = stored;
      stored = undefined;
      for (const path of [original.preview, original.thumb, ...(original.earlier ?? [])]) if (path && isRenditionPath(path, options.cache ?? '')) {
        try {
          if (!(await lstat(path)).isFile()) continue;
          const metadata = await sharp(path).metadata();
          if (metadata.width && metadata.height) { stored = { ...original, snapshot: path }; break; }
        } catch { /* A preview is optional. */ }
      }
    } else if (stored && (!stored.digest || !within(join(this.root, 'content'), stored.snapshot) || await hashFile(stored.snapshot).then((digest) => digest !== stored!.digest, () => true))) stored = undefined;
    if (stored && within(join(this.root, 'content'), stored.snapshot)) this.pins.add(stored.snapshot);
    // The last known content of the original, for Locate Folder, also when nothing cached can stand in for it.
    const digest = stored?.digest ?? this.saved[source.key]?.digest;
    return { status: { ...source, state, problem, cached: !!stored, ...(digest ? { digest } : {}), ...this.repairs(source, state) }, stored };
  }
  // What a photo's provider offers for its state; a text or a file is located like a file.
  private repairs(source: SourceEntry, state: Failure['state']): { repairs?: SourceRepair[] } {
    const repairs = source.kind === 'photo' ? providerOf(source.locator).repairs(state) : ['locate', 'locate-folder'] as const;
    return repairs.length ? { repairs: [...repairs] } : {};
  }
  /**
   * The full-resolution original of a photo without a file that is still valid for `revision` (ADR 0011, Where renders
   * are stored): recorded against that revision for the photo's current locator, and still the file that was stored.
   * Undefined when there is none, or when the revision moved since: the photo is then materialized again.
   */
  async materialization(source: PhotoSourceEntry, revision: string): Promise<StoredSource | undefined> {
    const stored = this.saved[materializedKey(source)];
    if (!stored?.digest || stored.path !== locatorKey(source.locator) || stored.observation !== revision) return undefined;
    const intact = await stat(stored.snapshot, { bigint: true }).then((info) => within(join(this.root, 'content'), stored.snapshot) && stamp(info) === stored.snapshotObservation, () => false);
    if (!intact) return undefined;
    this.pins.add(stored.snapshot);
    return stored;
  }
  /**
   * A new folder for a provider to write originals into, inside the source cache so a checked file moves into
   * `content/` by a rename. Its caller removes it, with whatever is left in it.
   */
  async staging() {
    const directory = join(this.root, 'staging');
    await mkdir(directory, { recursive: true });
    return mkdtemp(join(directory, 'materialize-'));
  }
  /**
   * Takes a file a provider materialized for `revision` into the source cache: hashed, checked to be one still JPEG,
   * PNG or WebP whose pixels decode, moved to `content/<sha256>.<ext>` and recorded against the revision. The file is
   * the host's from then on; one that fails a check is left where it is for the caller to remove.
   */
  async keepMaterialized(source: PhotoSourceEntry, revision: string, file: string): Promise<StoredSource> {
    const digest = await hashFile(file);
    const metadata = await sharp(file, { failOn: 'warning' }).metadata();
    const extension = ({ jpeg: '.jpg', png: '.png', webp: '.webp' } as Record<string, string>)[metadata.format ?? ''];
    if (!extension || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error('Expected a still JPEG, PNG or WebP image.');
    await sharp(file, { failOn: 'warning' }).resize({ width: 1, height: 1 }).toBuffer();
    const turned = (metadata.orientation ?? 1) >= 5;
    const directory = join(this.root, 'content');
    const snapshot = join(directory, digest + extension);
    this.pins.add(snapshot);
    if (!await hashFile(snapshot).then((value) => value === digest, () => false)) await rename(file, snapshot);
    const stored: StoredSource = { digest, snapshot, path: locatorKey(source.locator), observation: revision, snapshotObservation: stamp(await stat(snapshot, { bigint: true })),
      width: turned ? metadata.height : metadata.width, height: turned ? metadata.width : metadata.height };
    this.saved[materializedKey(source)] = stored; this.version++;
    return stored;
  }
  /**
   * A private copy of a materialized original in an export job's `pinned-sources`, as every file photo of an export is
   * read (ADR 0005): the job keeps printing these bytes whatever happens to the cache meanwhile. Checked against the
   * digest it was recorded with.
   */
  async pinMaterialized(stored: StoredSource, cache: string) {
    const requested = join(cache, 'pinned-sources');
    await mkdir(requested, { recursive: true });
    const pinned = join(await realpath(requested), stored.digest + extname(stored.snapshot));
    if (await hashFile(pinned).then((value) => value === stored.digest, () => false)) return pinned;
    const temporary = pinned + '.' + randomUUID() + '.tmp';
    try {
      await copyFile(stored.snapshot, temporary, constants.COPYFILE_FICLONE);
      if (await hashFile(temporary) !== stored.digest) throw new Error('The stored original changed.');
      await rename(temporary, pinned);
    } finally { await rm(temporary, { force: true }); }
    return pinned;
  }
  /** The revision a source had when it was last read; what its provider's watch compares the source with. */
  observed(key: string) { return this.saved[key]?.observation; }
  private digests = Promise.resolve();
  /** Told when a background digest of a photo read in place is known (assets-meta.json records it, ADR 0010). */
  onDigest?: (key: string, observation: string, digest: string) => void;
  /** Records a photo's digest after it was read in place, one file at a time, if it is still the same file. */
  private recordDigest(key: string, path: string, observation: string, current: () => Promise<string | undefined>) {
    this.digests = this.digests.then(async () => {
      if (this.saved[key]?.observation !== observation || this.saved[key]?.digest) return;
      const digest = await hashFile(path);
      if (await current() !== observation || this.saved[key]?.observation !== observation) return;
      this.saved[key] = { ...this.saved[key], digest }; this.version++;
      this.onDigest?.(key, observation, digest);
      await this.settled();
    }).catch(() => {});
  }
  /** Waits for digests being recorded in the background (tests). */
  async digested() { await this.digests; await this.settled(); }
  async settled() {
    const task = this.writes.then(async () => {
      while (this.written !== this.version) {
        const version = this.version;
        const temporary = this.index + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(this.saved));
        await rename(temporary, this.index);
        this.written = version;
      }
    });
    this.writes = task.catch(() => {});
    await task;
  }
}

/** Keep current and recent last-good inputs preferentially; open frames/jobs cannot be evicted. */
let cleanup = Promise.resolve();
export function pruneSourceCache(recentFolders: string[], maximumBytes = 2 * 1024 * 1024 * 1024) {
  const task = cleanup.then(() => prune(recentFolders, maximumBytes));
  cleanup = task.catch(() => {});
  return task;
}
async function prune(recentFolders: string[], maximumBytes: number) {
  if (!persistentRoot) return;
  const root = await realpath(persistentRoot).catch(() => undefined);
  if (!root) return;
  // Jobs are bounded well below a day. Reclaim abandoned staging files after crashes, never active writes.
  for (const directory of [join(root, 'content'), join(root, 'books')]) for (const name of await readdir(directory)) if (name.endsWith('.tmp')) {
    const path = join(directory, name);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) await rm(path, { force: true });
  }
  // Materialization staging folders a crash left behind (SourceStore.staging); a running one is younger than a day.
  for (const name of await readdir(join(root, 'staging')).catch(() => [] as string[])) {
    const path = join(root, 'staging', name);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isDirectory() && info.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) await rm(path, { recursive: true, force: true });
  }
  const active = await Promise.all(stores.values());
  const pins = new Set(active.flatMap((store) => [...store.pins]));
  const recent = new Set((await Promise.all(recentFolders.map((folder) => sourceBookKey(folder).catch(() => undefined)))).filter(Boolean));
  const indexes = (await Promise.all((await readdir(join(root, 'books'))).filter((name) => name.endsWith('.json')).map(async (name) => ({ name, info: await stat(join(root, 'books', name)) })))).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const referenced = new Set<string>();
  // The most recently opened book keeps every snapshot it references, whatever the limit. Its next open needs them
  // all: a book with more linked photos than the limit lost some at every close and copied, hashed and checked them
  // again at the next start, 2 s for a 2.8 GB book. While a book is open it holds all its snapshots anyway (pins).
  const latest = recentFolders[0] && await sourceBookKey(recentFolders[0]).catch(() => undefined);
  const kept = new Set<string>();
  for (const { name } of indexes) {
    const file = join(root, 'books', name);
    if (!stores.has(file) && !recent.has(name.slice(0, -5)) && !indexes.slice(0, 20).some((item) => item.name === name)) { await rm(file, { force: true }); continue; }
    try {
      for (const entry of Object.values(storedIndexSchema.parse(JSON.parse(await readFile(file, 'utf8'))))) if (!entry.direct) {
        referenced.add(entry.snapshot);
        if (latest && name === latest + '.json') kept.add(entry.snapshot);
      }
    } catch { await rm(file, { force: true }); }
  }
  const files = (await Promise.all((await readdir(join(root, 'content'))).filter((name) => /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(name)).map(async (name) => {
    const path = join(root, 'content', name); const info = await lstat(path);
    return { path, info };
  }))).filter(({ info }) => info.isFile());
  let total = files.reduce((sum, file) => sum + file.info.size, 0);
  files.sort((a, b) => Number(referenced.has(a.path)) - Number(referenced.has(b.path)) || a.info.mtimeMs - b.info.mtimeMs);
  for (const { path, info } of files) if (!pins.has(path) && !kept.has(path) && (!referenced.has(path) || total > maximumBytes)) { await rm(path, { force: true }); total -= info.size; }
}
