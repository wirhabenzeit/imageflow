import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { SourceEntry, SourceStatus } from '../src/source-locations';
import { sourceFolder } from '../src/source-locations';

let persistentRoot: string | undefined;
export function configureSourceStore(root: string) { persistentRoot = root; }
export const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
export function within(root: string, path: string) {
  const rel = relative(root, path);
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
export async function originalPath(folder: string, source: SourceEntry) {
  if (source.linked) {
    if (!isAbsolute(source.path)) throw new Error('Linked sources must name an absolute file path.');
    const actual = await realpath(source.path);
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
export type StoredSource = { digest: string; snapshot: string; path: string; observation: string; snapshotObservation?: string; width?: number; height?: number };
const storedIndexSchema = z.record(z.string(), z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/), snapshot: z.string(), path: z.string(), observation: z.string(),
  snapshotObservation: z.string().optional(), width: z.number().optional(), height: z.number().optional(),
}));
export type ResolvedSource = { status: SourceStatus; stored?: StoredSource };

/** Validated immutable bytes, plus a last-good record. Availability always comes from the original, never the cache. */
export class SourceStore {
  private saved: Record<string, StoredSource> = {};
  private changed = false;
  private constructor(private root: string, private index: string) {}
  static async forBook(folder: string, fallback: string) {
    const info = await stat(folder, { bigint: true });
    const requestedRoot = persistentRoot ?? join(fallback, 'sources');
    await mkdir(join(requestedRoot, 'content'), { recursive: true });
    await mkdir(join(requestedRoot, 'books'), { recursive: true });
    const root = await realpath(requestedRoot);
    const store = new SourceStore(root, join(root, 'books', `${info.dev}-${info.ino}-${info.birthtimeNs}.json`));
    try { store.saved = storedIndexSchema.parse(JSON.parse(await readFile(store.index, 'utf8'))); } catch { /* Derived cache may be rebuilt. */ }
    return store;
  }
  async resolve(folder: string, source: SourceEntry): Promise<ResolvedSource> {
    try {
      const actual = await originalPath(folder, source);
      const before = await stat(actual, { bigint: true });
      if (source.kind === 'markdown' && extname(source.path).toLowerCase() !== '.md') throw new Error('Expected a Markdown (.md) file.');
      const maximum = source.kind === 'photo' ? 50 : source.kind === 'markdown' ? 5 : 20;
      if (!before.isFile() || before.size > BigInt(maximum * 1024 * 1024)) throw new Error(`Expected a file up to ${maximum} MB.`);
      const previous = this.saved[source.key];
      if (previous?.path === source.path && previous.observation === stamp(before) && await stat(previous.snapshot, { bigint: true }).then((info) => within(join(this.root, 'content'), previous.snapshot) && stamp(info) === previous.snapshotObservation, () => false)) {
        return { status: { ...source, state: 'available', digest: previous.digest }, stored: previous };
      }
      const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new Error('Source is changing. Retry when the write has finished.');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== Number(before.size)) throw new Error('Source changed while being read.');
        bytes = buffer.subarray(0, offset);
        if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) throw new Error('Source is changing. Retry when the write has finished.');
      } finally { await handle.close(); }
      if (await originalPath(folder, source) !== actual || stamp(await stat(actual, { bigint: true })) !== stamp(before)) throw new Error('Source changed while being read.');
      let dimensions: { width?: number; height?: number } = {};
      if (source.kind === 'photo') {
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extname(source.path).toLowerCase())) throw new Error('Use JPEG, PNG or WebP images.');
        const image = sharp(bytes, { failOn: 'warning' });
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw new Error('Expected a still image.');
        await image.resize({ width: 1, height: 1 }).toBuffer();
        const turned = (metadata.orientation ?? 1) >= 5;
        dimensions = { width: turned ? metadata.height : metadata.width, height: turned ? metadata.width : metadata.height };
      }
      const digest = digestBytes(bytes);
      const snapshot = join(this.root, 'content', digest + extname(source.path).toLowerCase());
      if (!await readFile(snapshot).then((cached) => digestBytes(cached) === digest, () => false)) {
        const temporary = snapshot + '.' + randomUUID() + '.tmp';
        // APFS can clone immutable inputs without duplicating their disk blocks. Always verify the clone's bytes.
        await copyFile(actual, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL).catch(async () => { await rm(temporary, { force: true }); await writeFile(temporary, bytes, { flag: 'wx' }); });
        if (digestBytes(await readFile(temporary)) !== digest) await writeFile(temporary, bytes);
        await rename(temporary, snapshot);
      }
      const stored = { digest, snapshot, path: source.path, observation: stamp(before), snapshotObservation: stamp(await stat(snapshot, { bigint: true })), ...dimensions };
      this.saved[source.key] = stored;
      this.changed = true;
      return { status: { ...source, state: 'available', digest }, stored };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const state = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unreadable';
      let stored: StoredSource | undefined = this.saved[source.key];
      // An app-owned cached snapshot is a preview only when the selected original is unavailable.
      if (stored && (!within(join(this.root, 'content'), stored.snapshot) || await readFile(stored.snapshot).then((bytes) => digestBytes(bytes) !== stored!.digest, () => true))) stored = undefined;
      const problem = state === 'missing' ? (source.linked ? 'Original missing: ' : 'Missing project file: ') + source.path : state === 'denied' ? 'Access denied' : 'Original unavailable: ' + (error instanceof Error ? error.message : String(error));
      return { status: { ...source, state, problem, cached: !!stored, digest: stored?.digest }, stored };
    }
  }
  async settled() {
    if (!this.changed) return;
    const temporary = this.index + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(this.saved));
    await rename(temporary, this.index);
  }
}
