import { execFile } from 'node:child_process';
import { stat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const volumes = new Map<string, Promise<string>>();
async function volumeIdentity(folder: string, device: bigint) {
  if (process.platform !== 'darwin') return String(device);
  const key = String(device);
  if (!volumes.has(key)) {
    const task = (async () => {
      // diskutil accepts a device or mount point, not an arbitrary directory. df resolves APFS firmlinks too.
      const { stdout: usage } = await run('/bin/df', ['-P', folder], { timeout: 5000 });
      const devicePath = usage.trim().split('\n').at(-1)?.split(/\s+/)[0];
      if (!devicePath?.startsWith('/dev/')) return key;
      const { stdout } = await run('/usr/sbin/diskutil', ['info', '-plist', devicePath], { timeout: 5000 });
      const uuid = stdout.match(/<key>VolumeUUID<\/key>\s*<string>([A-Fa-f0-9-]+)<\/string>/)?.[1];
      return uuid ? 'volume-' + uuid.toLowerCase() : key;
    })().catch(() => key);
    volumes.set(key, task);
  }
  return volumes.get(key)!;
}

export async function sourceBookKey(folder: string) {
  const info = await stat(folder, { bigint: true });
  return `${await volumeIdentity(folder, info.dev)}-${info.ino}-${info.birthtimeNs}`;
}

/** Old releases recorded the transient device number. The inode AND nanosecond birth time must match;
 * never adopt records by book name or manifest contents. Copies and recreated books get new identities.
 * Keep legacy files intact for rollback. Conflicting legacy entries confer no access; a migrated registry is authoritative.
 */
export async function readSourceRegistry<T>(directory: string, folder: string, key: string,
  parse: (value: unknown) => Record<string, T>): Promise<{ entries: Record<string, T>; migrated?: boolean }> {
  // Once migrated, this registry is authoritative, including explicit revocations.
  try { return { entries: parse(JSON.parse(await readFile(join(directory, key + '.json'), 'utf8'))) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { entries: {} };
  }
  // Volumes without a UUID keep their original device-scoped records. A missing
  // birth time would leave no independent way to distinguish legacy inode reuse.
  if (!key.startsWith('volume-')) return { entries: {} };
  const info = await stat(folder, { bigint: true });
  if (info.ino === 0n || info.birthtimeNs <= 0n) return { entries: {} };
  const suffix = `-${info.ino}-${info.birthtimeNs}.json`;
  const names = await readdir(directory).catch(() => []);
  const legacy: Record<string, T> = {};
  const conflicts = new Set<string>();
  for (const name of names.filter((name) => /^\d+-\d+-\d+\.json$/.test(name) && name.endsWith(suffix) && name !== key + '.json').sort()) {
    let record: Record<string, T>;
    try { record = parse(JSON.parse(await readFile(join(directory, name), 'utf8'))); } catch { continue; }
    for (const [id, value] of Object.entries(record)) {
      if (Object.hasOwn(legacy, id) && JSON.stringify(legacy[id]) !== JSON.stringify(value)) conflicts.add(id);
      else legacy[id] = value;
    }
  }
  for (const id of conflicts) delete legacy[id];
  return { entries: legacy, migrated: Object.keys(legacy).length > 0 };
}
