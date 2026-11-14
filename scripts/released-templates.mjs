// Records the hashes of the built-in templates this version ships in sample/released-templates.json, so books made
// from them stay trusted for their network sites after a later update changes them (ADR 0006).
//
//   node scripts/released-templates.mjs           adds the current hashes (run when preparing a release)
//   node scripts/released-templates.mjs --check   fails when a current hash is missing (run by the release workflow)
//
// The hash must match templateHash in desktop/template-library.ts; tests/released-templates.test.ts checks that.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const releasedFile = join(root, 'sample', 'released-templates.json');

async function templateFiles(folder) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(relative(folder, path) + ' is a symbolic link.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(folder, path).split(sep).join('/'));
    }
  };
  if (!(await lstat(folder)).isDirectory()) throw new Error(folder + ' is not a folder.');
  await walk(folder);
  return files.sort();
}

export async function templateHash(folder) {
  const hash = createHash('sha256');
  for (const file of await templateFiles(folder)) {
    const bytes = await readFile(join(folder, ...file.split('/')));
    hash.update(file + '\0' + bytes.length + '\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** The built-in templates, as src/starters.ts lists them, with their current hashes. */
export async function builtInHashes(base = root) {
  const starters = await readFile(join(base, 'src', 'starters.ts'), 'utf8');
  const folders = [...starters.matchAll(/folder:\s*'([^']+)'/g)].map((match) => match[1]);
  if (!folders.length) throw new Error('src/starters.ts lists no built-in templates.');
  return Promise.all(folders.map(async (folder) => ({ folder, hash: await templateHash(join(base, 'sample', folder, 'template')) })));
}

async function readReleased(file) {
  const value = JSON.parse(await readFile(file, 'utf8').catch(() => '{"schema":1,"templates":{}}'));
  if (value?.schema !== 1 || !value.templates || typeof value.templates !== 'object') throw new Error(file + ' is invalid.');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const released = await readReleased(releasedFile);
  const current = await builtInHashes();
  const missing = current.filter(({ hash }) => !released.templates[hash]);
  if (process.argv.includes('--check')) {
    if (missing.length) {
      console.error('Built-in templates changed since they were last recorded: ' + missing.map(({ folder }) => folder).join(', ') +
        '. Run node scripts/released-templates.mjs on the release-preparation branch and commit sample/released-templates.json.');
      process.exit(1);
    }
    console.log('Every built-in template hash is recorded.');
  } else {
    for (const { folder, hash } of missing) released.templates[hash] = { template: folder, app: version };
    await writeFile(releasedFile, JSON.stringify(released, null, 2) + '\n');
    console.log(missing.length ? 'Recorded ' + missing.map(({ folder }) => folder).join(', ') + '.' : 'Nothing to record.');
  }
}
