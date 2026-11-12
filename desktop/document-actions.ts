import { lstat, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { containedPath } from './project';

export async function editableMarkdown(path: string) {
  const actual = await realpath(path);
  if (extname(path).toLowerCase() !== '.md' || extname(actual).toLowerCase() !== '.md' || !(await stat(actual)).isFile()) {
    throw new Error('Choose a regular Markdown (.md) file to edit.');
  }
  return actual;
}

export async function textSourcePath(folder: string, source: string) {
  return editableMarkdown(await containedPath(folder, source, 'texts'));
}

export async function templateFolder(folder: string) {
  const path = join(folder, 'template');
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('The template must be a real directory inside the book.');
  return path;
}
