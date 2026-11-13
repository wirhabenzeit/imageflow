import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Tooling only. Rendering already refuses relative imports through dot folders, and templateFiles leaves them
// out of hashes and copies. Opening a book never generates or updates this folder.
export const authoringSnapshotFolder = '.imageflow-sdk';

/** The installed SDK as deterministic, portable template-relative files; never reads a template's own snapshot. */
export async function authoringSnapshot(typesRoot: string, template?: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const walk = async (folder: string, prefix = '') => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('The installed authoring SDK contains a symbolic link.');
      if (entry.isDirectory()) await walk(join(folder, entry.name), path + '/');
      else if (entry.isFile()) entries.set(path, await readFile(join(folder, entry.name)));
    }
  };
  await walk(typesRoot);
  const hash = createHash('sha256');
  for (const [path, bytes] of entries) hash.update(path + '\0').update(bytes);
  entries.set('api.json', Buffer.from(JSON.stringify({ contract: 1, sdk: hash.digest('hex'), generated: true }, null, 2) + '\n'));
  const globals = template && await stat(join(template, 'vendor/types/globals.d.ts')).then((value) => value.isFile(), () => false);
  entries.set('tsconfig.json', Buffer.from(JSON.stringify({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx',
      strict: true, noEmit: true, skipLibCheck: false, types: [],
      paths: { imageflow: ['./imageflow.d.ts'], react: ['./react.d.ts'], 'react/jsx-runtime': ['./jsx-runtime.d.ts'],
        '*': ['./*', '../vendor/types/packages/*', '../vendor/types/packages/@types/*'] },
    },
    files: ['./assets.d.ts', ...(globals ? ['../vendor/types/globals.d.ts'] : [])],
    include: ['../**/*.ts', '../**/*.tsx'], exclude: ['../node_modules', '../vendor', './react-runtime', './csstype'],
  }, null, 2) + '\n'));
  return new Map([...entries].map(([path, bytes]) => [authoringSnapshotFolder + '/' + path, bytes]));
}

/** Writes only into a newly created book or a build fixture, never when opening a book. */
export async function writeAuthoringSnapshot(template: string, typesRoot: string) {
  const entries = await authoringSnapshot(typesRoot, template);
  await rm(join(template, authoringSnapshotFolder), { recursive: true, force: true });
  for (const [path, bytes] of entries) {
    await mkdir(dirname(join(template, path)), { recursive: true });
    await writeFile(join(template, path), bytes);
  }
}
