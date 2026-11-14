// Records the hashes of the built-in templates this version ships in sample/released-templates.json, so books made
// from them stay trusted for their network sites after a later update changes them (ADR 0006).
//
//   node scripts/released-templates.mjs           adds the current hashes (run when preparing a release)
//   node scripts/released-templates.mjs --check   fails when a current hash is missing (run by the release workflow)
//
// It hashes templates with desktop/template-hash.mjs, the same code the app uses.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashTemplateFiles, listTemplateFiles } from '../desktop/template-hash.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const releasedFile = join(root, 'sample', 'released-templates.json');

/** A template folder's hash, exactly as the app computes it. */
export async function templateHash(folder) {
  return hashTemplateFiles(folder, await listTemplateFiles(folder));
}

/** The built-in templates, as sample/starters.json lists them, with their current hashes. */
export async function builtInHashes(base = root) {
  const folders = JSON.parse(await readFile(join(base, 'sample', 'starters.json'), 'utf8')).map(({ folder }) => folder);
  if (!folders.length) throw new Error('sample/starters.json lists no built-in templates.');
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
