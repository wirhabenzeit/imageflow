import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

const renditionName = /^[a-f0-9]{64}-(?:thumb|preview|export)(?:-\d+)?\.(?:jpg|png)$/;
let configured: { scratch: string; persistent: string } | undefined;

/** Only ordinary editor renditions persist; validation jobs keep their private scratch caches. */
export async function configureRenditionCache(scratch: string, persistent: string) {
  await mkdir(persistent, { recursive: true });
  configured = { scratch, persistent: await realpath(persistent) };
  return configured.persistent;
}
export function renditionCacheFor(scratch: string) { return configured?.scratch === scratch ? configured.persistent : scratch; }

/** Run between sessions. Leave unrelated files, staging directories and symlinks alone. */
export async function pruneRenditions(folder: string, maximumBytes = 512 * 1024 * 1024) {
  const names = await readdir(folder);
  const files = (await Promise.all(names.filter((name) => renditionName.test(name)).map(async (name) => {
    const path = join(folder, name);
    const info = await lstat(path).catch(() => undefined);
    return info?.isFile() ? { path, size: info.size, used: Math.max(info.atimeMs, info.mtimeMs) } : undefined;
  }))).filter((file) => file !== undefined).sort((a, b) => a.used - b.used);
  let bytes = files.reduce((total, file) => total + file.size, 0);
  for (const file of files) {
    if (bytes <= maximumBytes) break;
    await rm(file.path, { force: true });
    bytes -= file.size;
  }
}
