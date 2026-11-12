import { lstat, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { SourceReference } from '../src/source-locations';
import { sourceLinked, sourcePath } from '../src/source-locations';
import { originalPath } from './source-store';

export async function editableMarkdown(path: string) {
  const actual = await realpath(path);
  if (extname(path).toLowerCase() !== '.md' || extname(actual).toLowerCase() !== '.md' || !(await stat(actual)).isFile()) {
    throw new Error('Choose a regular Markdown (.md) file to edit.');
  }
  return actual;
}

export async function textSourcePath(folder: string, source: SourceReference, id = 'editor') {
  return editableMarkdown(await originalPath(folder, { key: 'markdown:' + id, kind: 'markdown', path: sourcePath(source), linked: sourceLinked(source) }));
}

export async function templateFolder(folder: string) {
  const path = join(folder, 'template');
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('The template must be a real directory inside the book.');
  return path;
}
