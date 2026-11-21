import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Sync proxies of photos (ADR 0010): preview-sized JPEG or PNG renditions keyed by the original's SHA-256 digest, kept in
 * App Support (`Cache/proxies/<digest>-preview-v1.(jpg|png)`), never in a book. A proxy only stands in on the canvas for
 * an original that is missing or not approved on this Mac (desktop/project.ts); it is never a print input. It is a
 * cache: anything `prune` evicts is fetched again by digest on the next sync.
 */
const digestPattern = /^[a-f0-9]{64}$/;
const proxyName = /^[a-f0-9]{64}-preview-v1\.(?:jpg|png)$/;
const extensions = ['.jpg', '.png'] as const;
// The size of a preview rendition is bounded (desktop/photos.ts), so anything far larger is not a proxy.
const maximumBytes = 16 * 1024 * 1024;

const tooLarge = 'A proxy must be at most 16 MB.';
/** A proxy file read whole, without following a symbolic link and only when it is small enough to be one. */
async function readBounded(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('A proxy must be a regular file.');
    if (info.size > maximumBytes) throw new Error(tooLarge);
    return await handle.readFile();
  } finally { await handle.close(); }
}
const fileName = (digest: string, extension: typeof extensions[number]) => digest + '-preview-v1' + extension;
function requireDigest(digest: string) {
  if (!digestPattern.test(digest)) throw new Error('A proxy needs the original’s SHA-256 digest.');
}

export class ProxyStore {
  private constructor(readonly root: string) {}

  /** The store in `folder`, created if needed. */
  static async at(folder: string) {
    await mkdir(folder, { recursive: true });
    return new ProxyStore(await realpath(folder));
  }

  /** Stores a proxy for the original with this digest, atomically, replacing an earlier one. Returns its path. */
  async put(digest: string, source: string | Uint8Array) {
    requireDigest(digest);
    const bytes = typeof source === 'string' ? await readBounded(source) : Buffer.from(source);
    if (bytes.length > maximumBytes) throw new Error(tooLarge);
    const metadata = await sharp(bytes).metadata();
    if ((metadata.format !== 'jpeg' && metadata.format !== 'png') || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
      throw new Error('A proxy must be a still JPEG or PNG image.');
    }
    // Its pixels too, so a truncated download never stands in for a photo.
    await sharp(bytes, { failOn: 'warning' }).resize({ width: 1, height: 1 }).toBuffer();
    const extension = metadata.format === 'png' ? '.png' : '.jpg';
    const path = join(this.root, fileName(digest, extension));
    const staging = join(this.root, '.proxy-' + randomUUID() + '.tmp');
    try {
      await writeFile(staging, bytes, { flag: 'wx', mode: 0o644 });
      await rename(staging, path);
    } finally { await rm(staging, { force: true }); }
    // One proxy per digest: a proxy of the other type goes.
    await rm(join(this.root, fileName(digest, extension === '.png' ? '.jpg' : '.png')), { force: true });
    return path;
  }

  /** The stored proxy of the original with this digest, or undefined. Never follows a symbolic link. */
  async path(digest: string) {
    if (!digestPattern.test(digest)) return undefined;
    for (const extension of extensions) {
      const path = join(this.root, fileName(digest, extension));
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      // Marks it as used, so `prune` evicts proxies nobody looked at first.
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return path;
    }
    return undefined;
  }

  /** Removes the least recently used proxies until at most `maxBytes` remain, and abandoned staging files. */
  async prune(maxBytes: number) {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const day = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of names) if (name.startsWith('.proxy-') && name.endsWith('.tmp')) {
      const path = join(this.root, name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs < day) await rm(path, { force: true });
    }
    const files = (await Promise.all(names.filter((name) => proxyName.test(name)).map(async (name) => {
      const path = join(this.root, name);
      const info = await lstat(path).catch(() => undefined);
      return info?.isFile() ? { path, size: info.size, used: Math.max(info.atimeMs, info.mtimeMs) } : undefined;
    }))).filter((file) => file !== undefined).sort((a, b) => a.used - b.used);
    let bytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of files) {
      if (bytes <= maxBytes) break;
      await rm(file.path, { force: true });
      bytes -= file.size;
    }
  }
}

let configured: Promise<ProxyStore> | undefined;
/** Set once at startup (desktop/main.ts). Without it, no proxy stands in for any photo. */
export function configureProxyStore(folder: string): Promise<ProxyStore>;
export function configureProxyStore(folder: undefined): undefined;
export function configureProxyStore(folder: string | undefined) {
  configured = folder === undefined ? undefined : ProxyStore.at(folder);
  return configured;
}
export function proxyStore(): Promise<ProxyStore | undefined> {
  return configured?.catch(() => undefined) ?? Promise.resolve(undefined);
}
