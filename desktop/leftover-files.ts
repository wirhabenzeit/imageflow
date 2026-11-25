import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { LeftoverFile } from '../src/desktop';
import { ignoredName } from './revisions';

/**
 * Files in a book's package that the book no longer uses (UI-010). An import that is undone and an asset that is removed
 * leave their copied files for Undo, and nothing removed them once Undo was gone. They are only listed here: what becomes
 * of one is the user's choice.
 *
 * A file is in use if any string of `project.json` or `photos.json` is its path, whatever the string is for, so a field
 * this version does not know keeps its file, or any string of `states`: what this session's Undo, Redo and Revert to Last
 * Opened can bring back. Paths are compared without case and in one Unicode form, as the volume may. Manifests that cannot
 * be read leave nothing to tell unused files by, so none are listed.
 */
export async function leftoverFiles(folder: string, states: readonly unknown[], open: readonly string[] = []): Promise<LeftoverFile[]> {
  const root = await realpath(folder);
  const used = new Set<string>();
  const key = (path: string) => path.normalize('NFC').toLowerCase();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') used.add(key(value));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  try { for (const name of ['project.json', 'photos.json']) collect(JSON.parse(await readFile(join(root, name), 'utf8'))); }
  catch { return []; }
  states.forEach(collect);
  // Texts whose editor window is open would be written again.
  for (const path of open) used.add(key(path));
  const found: LeftoverFile[] = [];
  for (const folderName of ['photos', 'texts', 'files']) {
    const directory = join(root, folderName);
    // A link leaves the package: what is behind it is not the book's.
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = folderName + '/' + entry.name;
      if (!entry.isFile() || entry.name.startsWith('.') || ignoredName(entry.name) || used.has(key(path)) || used.has(key(join(directory, entry.name)))) continue;
      const file = await lstat(join(directory, entry.name)).catch(() => undefined);
      if (file?.isFile()) found.push({ path, size: file.size, modified: file.mtimeMs });
    }
  }
  return found.sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
}
