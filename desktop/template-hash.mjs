// A template's files and their hash, shared by the app (desktop/template-library.ts) and the release script
// (scripts/released-templates.mjs), which runs without a build. Plain JavaScript for that reason.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Why a folder's files cannot be listed as a template; the app turns it into a TemplateImportError. */
export class TemplateFilesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateFilesError';
  }
}

const skipped = new Set(['node_modules']);
/**
 * The files in a template folder, as sorted relative paths with forward slashes. Dotfiles and folders (including
 * `.imageflow/`) and `node_modules/` are left out. Symbolic links are refused, so a template never carries files from
 * outside its folder.
 */
export async function listTemplateFiles(folder) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TemplateFilesError(relative(folder, path) + ' is a symbolic link. Templates must contain their files.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(folder, path).split(sep).join('/'));
    }
  };
  const root = await lstat(folder).catch(() => undefined);
  if (!root?.isDirectory()) throw new TemplateFilesError('The template folder could not be read.');
  await walk(folder);
  return files.sort();
}

/** A hash of these template files and their paths, so the same template has the same hash wherever it is copied. */
export async function hashTemplateFiles(folder, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = await readFile(join(folder, ...file.split('/')));
    hash.update(file + '\0' + bytes.length + '\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}
