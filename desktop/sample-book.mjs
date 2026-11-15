import { copyFile, cp, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

// The built-in sample books share their photographs: the files live once in `sample/shared/photos/`, and each sample's
// `photos.json` lists only the photos that book uses, with its own titles and captions. Copying a sample into a
// new book, in the app and in every script and test, goes through this function, so the book receives its own
// copy of exactly the photos it lists.
const exists = (path) => stat(path).then(() => true, () => false);

/**
 * Copies a sample book folder to `destination` and fills in the photographs its `photos.json` lists that the folder
 * itself does not hold, from the `shared` folder (by default `shared/` next to the sample). A missing shared file is an error.
 */
export async function copySample(folder, destination, { shared = join(dirname(folder), 'shared') } = {}) {
  await cp(folder, destination, { recursive: true, filter: (path) => !['.imageflow', 'node_modules'].includes(basename(path)) });
  const index = JSON.parse(await readFile(join(destination, 'photos.json'), 'utf8').catch(() => '{}'));
  const root = resolve(destination);
  for (const { path } of Object.values(index)) {
    if (typeof path !== 'string') continue;
    const target = resolve(root, path);
    if (!target.startsWith(root + sep) || await exists(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(shared, path), target);
  }
}
