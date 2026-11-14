import { captureTime } from './capture-time';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { SourceEntry, SourceStatus } from '../src/source-locations';
import { sourceFolder } from '../src/source-locations';
import { requireSourceAccess, sourceBookKey, SourceAccessError } from './source-access';
import { photoDetails } from './photos';
import { isRenditionPath, renditionCacheFor } from './rendition-cache';

let persistentRoot: string | undefined;
const stores = new Map<string, Promise<SourceStore>>();
export function configureSourceStore(root: string) { persistentRoot = root; stores.clear(); }
export const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
export function within(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
export async function originalPath(folder: string, source: Pick<SourceEntry, 'kind' | 'path' | 'linked'> & { key?: string }) {
  if (source.linked) {
    await requireSourceAccess(folder, source);
    if (!isAbsolute(source.path)) throw new Error('Linked sources must name an absolute file path.');
    const actual = await realpath(source.path);
    if (actual !== source.path) throw new SourceAccessError('The linked target changed. Locate this original again.');
    if (within(folder, actual)) throw new Error('A linked source must be outside the book. Use Copy into Book for internal files.');
    return actual;
  }
  const root = join(folder, sourceFolder(source.kind));
  const path = resolve(folder, source.path);
  if (isAbsolute(source.path) || !within(root, path)) throw new Error('Source must be inside ' + sourceFolder(source.kind) + '/.');
  const actual = await realpath(path);
  if (!within(root, actual)) throw new Error('Source points outside ' + sourceFolder(source.kind) + '/.');
  return actual;
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  for await (const chunk of handle.createReadStream()) hash.update(chunk);
  return hash.digest('hex');
}
export type StoredSource = { digest?: string; snapshot: string; path: string; observation: string; snapshotObservation?: string;
  width?: number; height?: number; captured?: string; capturedEstimated?: boolean; direct?: boolean; key?: string; preview?: string; thumb?: string };
const storedIndexSchema = z.record(z.string(), z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(), snapshot: z.string(), path: z.string(), observation: z.string(),
  snapshotObservation: z.string().optional(), width: z.number().optional(), height: z.number().optional(),
  captured: z.string().optional(), capturedEstimated: z.boolean().optional(),
  direct: z.boolean().optional(), key: z.string().optional(), preview: z.string().optional(), thumb: z.string().optional(),
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
    const index = join(root, 'books', await sourceBookKey(folder) + '.json');
    if (!stores.has(index)) stores.set(index, (async () => {
      const store = new SourceStore(folder, root, index);
      try { store.saved = storedIndexSchema.parse(JSON.parse(await readFile(index, 'utf8'))); } catch { /* Rebuild derived state. */ }
      return store;
    })());
    return stores.get(index)!;
  }
  static async release(folder: string) {
    const identity = await sourceBookKey(folder).catch(() => undefined);
    for (const [key, promise] of stores) {
      const store = await promise;
      if (store.folder === folder || (identity && key.endsWith('/' + identity + '.json'))) {
        await store.settled().catch((error) => console.warn('ImageFlow could not retain source previews', error));
        stores.delete(key);
      }
    }
  }
  private remember(source: SourceEntry, stored: StoredSource) {
    this.saved[source.key] = stored; this.version++;
    if (within(join(this.root, 'content'), stored.snapshot)) this.pins.add(stored.snapshot);
  }
  async resolve(folder: string, source: SourceEntry, options: { pin?: boolean; cache?: string } = {}): Promise<ResolvedSource> {
    try {
      const actual = await originalPath(folder, source);
      const before = await stat(actual, { bigint: true });
      const privatePin = options.pin && !source.linked && source.kind === 'photo';
      if (source.kind === 'markdown' && extname(source.path).toLowerCase() !== '.md') throw new Error('Expected a Markdown (.md) file.');
      const maximum = source.kind === 'photo' ? source.linked ? 50 : undefined : source.kind === 'markdown' ? 5 : 20;
      if (!before.isFile() || (maximum && before.size > BigInt(maximum * 1024 * 1024))) throw new Error(`Expected a regular file${maximum ? ` up to ${maximum} MB` : ''}.`);
      // Metadata reads do not copy or decode every document-owned photo on first open.
      if (source.kind === 'photo' && !source.linked && !options.pin) {
        const details = await photoDetails(actual, null);
        if (stamp(await stat(actual, { bigint: true })) !== stamp(before)) throw new Error('Source changed while being read.');
        const cache = renditionCacheFor(options.cache ?? '');
        const extension = details.alpha ? '.png' : '.jpg';
        const stored = { path: source.path, snapshot: actual, observation: stamp(before), direct: true, key: details.key,
          width: details.width, height: details.height, captured: details.captured, capturedEstimated: details.capturedEstimated, preview: join(cache, details.key + '-preview' + extension), thumb: join(cache, details.key + '-thumb' + extension) };
        this.remember(source, stored);
        return { status: { ...source, state: 'available' }, stored };
      }
      const previous = this.saved[source.key];
      if (!privatePin && previous?.digest && !previous.direct && previous.path === source.path && previous.observation === stamp(before) &&
          await stat(previous.snapshot, { bigint: true }).then((info) => within(join(this.root, 'content'), previous.snapshot) && stamp(info) === previous.snapshotObservation, () => false)) {
        if (source.kind === 'photo' && !previous.captured) {
          const metadata = await sharp(previous.snapshot).metadata();
          Object.assign(previous, captureTime(metadata.exif, Number(before.mtimeMs))); this.remember(source, previous);
        }
        this.pins.add(previous.snapshot);
        return { status: { ...source, state: 'available', digest: previous.digest }, stored: previous };
      }
      const requestedDirectory = privatePin ? join(options.cache!, 'pinned-sources') : join(this.root, 'content');
      await mkdir(requestedDirectory, { recursive: true });
      const directory = await realpath(requestedDirectory);
      const temporary = join(directory, randomUUID() + '.tmp');
      try {
        // Clone/copy once, then validate the private bytes while the original's identity is guarded.
        await copyFile(actual, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        const digest = await hashFile(temporary);
        let dimensions: { width?: number; height?: number; captured?: string; capturedEstimated?: boolean } = {};
        if (source.kind === 'photo') {
          const metadata = await sharp(temporary, { failOn: 'warning' }).metadata();
          if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extname(source.path).toLowerCase()) || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error('Expected a still JPEG, PNG or WebP image.');
          const turned = (metadata.orientation ?? 1) >= 5;
          await sharp(temporary, { failOn: 'warning' }).resize({ width: 1, height: 1 }).toBuffer();
          dimensions = { ...captureTime(metadata.exif, Number(before.mtimeMs)), width: turned ? metadata.height : metadata.width, height: turned ? metadata.width : metadata.height };
        }
        if (await originalPath(folder, source) !== actual || stamp(await stat(actual, { bigint: true })) !== stamp(before)) throw new Error('Source changed while being read.');
        const snapshot = join(directory, digest + extname(source.path).toLowerCase());
        if (!privatePin) this.pins.add(snapshot);
        if (!await hashFile(snapshot).then((value) => value === digest, () => false)) await rename(temporary, snapshot);
        const stored = { digest, snapshot, path: source.path, observation: stamp(before), snapshotObservation: stamp(await stat(snapshot, { bigint: true })), ...dimensions };
        if (!privatePin) this.remember(source, stored);
        return { status: { ...source, state: 'available', digest }, stored };
      } finally { await rm(temporary, { force: true }); }
    } catch (error) {
      if (error instanceof SourceAccessError) return { status: { ...source, state: 'unapproved', problem: error.message, cached: false } };
      const code = (error as NodeJS.ErrnoException).code;
      const state = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unreadable';
      let stored: StoredSource | undefined = this.saved[source.key];
      if (stored?.direct) {
        const original = stored;
        stored = undefined;
        for (const path of [original.preview, original.thumb]) if (path && isRenditionPath(path, options.cache ?? '')) {
          try {
            if (!(await lstat(path)).isFile()) continue;
            const metadata = await sharp(path).metadata();
            if (metadata.width && metadata.height) { stored = { ...original, snapshot: path }; break; }
          } catch { /* A preview is optional. */ }
        }
      } else if (stored && (!stored.digest || !within(join(this.root, 'content'), stored.snapshot) || await hashFile(stored.snapshot).then((digest) => digest !== stored!.digest, () => true))) stored = undefined;
      if (stored && within(join(this.root, 'content'), stored.snapshot)) this.pins.add(stored.snapshot);
      const problem = state === 'missing' ? (source.linked ? 'Original missing: ' : 'Missing project file: ') + source.path : state === 'denied' ? 'Access denied' : 'Original unavailable: ' + (error instanceof Error ? error.message : String(error));
      return { status: { ...source, state, problem, cached: !!stored, digest: stored?.digest }, stored };
    }
  }
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
  const active = await Promise.all(stores.values());
  const pins = new Set(active.flatMap((store) => [...store.pins]));
  const recent = new Set((await Promise.all(recentFolders.map((folder) => sourceBookKey(folder).catch(() => undefined)))).filter(Boolean));
  const indexes = (await Promise.all((await readdir(join(root, 'books'))).filter((name) => name.endsWith('.json')).map(async (name) => ({ name, info: await stat(join(root, 'books', name)) })))).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const referenced = new Set<string>();
  for (const { name } of indexes) {
    const file = join(root, 'books', name);
    if (!stores.has(file) && !recent.has(name.slice(0, -5)) && !indexes.slice(0, 20).some((item) => item.name === name)) { await rm(file, { force: true }); continue; }
    try { for (const entry of Object.values(storedIndexSchema.parse(JSON.parse(await readFile(file, 'utf8'))))) if (!entry.direct) referenced.add(entry.snapshot); } catch { await rm(file, { force: true }); }
  }
  const files = (await Promise.all((await readdir(join(root, 'content'))).filter((name) => /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(name)).map(async (name) => {
    const path = join(root, 'content', name); const info = await lstat(path);
    return { path, info };
  }))).filter(({ info }) => info.isFile());
  let total = files.reduce((sum, file) => sum + file.info.size, 0);
  files.sort((a, b) => Number(referenced.has(a.path)) - Number(referenced.has(b.path)) || a.info.mtimeMs - b.info.mtimeMs);
  for (const { path, info } of files) if (!pins.has(path) && (!referenced.has(path) || total > maximumBytes)) { await rm(path, { force: true }); total -= info.size; }
}
