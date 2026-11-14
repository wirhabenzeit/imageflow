import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, open, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const maximumMarkdownBytes = 5 * 1024 * 1024;
export async function readMarkdownFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumMarkdownBytes) throw new Error('Choose a regular Markdown file smaller than 5 MB.');
    const bytes = await file.readFile();
    // A lossless round trip is required before enabling an editor that writes UTF-8.
    if (bytes.length > maximumMarkdownBytes) throw new Error('Markdown files must be smaller than 5 MB.');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('This Markdown file must use UTF-8 encoding to edit it here.');
    return text;
  } finally { await file.close(); }
}

/** Publish complete UTF-8 text, retaining file permissions and checking outside changes before replacement. */
const pendingWrites = new Map<string, Promise<void>>();
export async function writeMarkdownFile(path: string, expected: string, text: string, validate: () => Promise<string>, external = false) {
  // Different books or source IDs can refer to the same original. Serialize them before the disk comparison.
  const info = await stat(path, { bigint: true });
  const key = info.dev + ':' + info.ino;
  const task = (pendingWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(() => publishMarkdownFile(path, expected, text, validate, external));
  pendingWrites.set(key, task);
  try { await task; }
  finally { if (pendingWrites.get(key) === task) pendingWrites.delete(key); }
}
async function publishMarkdownFile(path: string, expected: string, text: string, validate: () => Promise<string>, external: boolean) {
  if (Buffer.byteLength(text) > maximumMarkdownBytes) throw new Error('Markdown files must be smaller than 5 MB.');
  if (await validate() !== path) throw new Error('The source location changed. Reopen its editor.');
  await access(path, constants.W_OK);
  const before = await stat(path, { bigint: true });
  if (external) return writeExternalMarkdown(path, expected, text, validate, before);
  const temporary = join(dirname(path), '.imageflow-text-' + randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', Number(before.mode & 0o777n));
    try { await file.chmod(Number(before.mode & 0o777n)); await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
    if (await validate() !== path || await readMarkdownFile(path) !== expected) throw new Error('This source changed outside the editor. Review the outside text before saving.');
    const current = await stat(path, { bigint: true });
    if (current.ino !== before.ino || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) throw new Error('This source changed outside the editor. Review the outside text before saving.');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function writeAll(file: FileHandle, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
    if (!bytesWritten) throw new Error('The file stopped accepting text.');
    offset += bytesWritten;
  }
}

/** External originals retain their inode, ACLs, extended attributes, creation date, ownership and hard links.
 * This deliberately trades atomic replacement for metadata preservation. Restore the old bytes if a write fails. */
async function writeExternalMarkdown(path: string, expected: string, text: string, validate: () => Promise<string>, before: BigIntStats) {
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximumMarkdownBytes ||
        !(await file.readFile()).equals(Buffer.from(expected)) || await validate() !== path) throw new Error('This source changed outside the editor. Review the outside text before saving.');
    const current = await stat(path, { bigint: true });
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) throw new Error('This source changed outside the editor. Review the outside text before saving.');
    try {
      const bytes = Buffer.from(text);
      await writeAll(file, bytes); await file.truncate(bytes.length); await file.sync();
    } catch (error) {
      try {
        const original = Buffer.from(expected);
        await writeAll(file, original); await file.truncate(original.length); await file.sync();
      } catch { throw new Error('Saving failed and the original could not be restored. Your text is preserved in this editor; check the external file before retrying.', { cause: error }); }
      throw error;
    }
  } finally { await file.close(); }
}
