import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Machine-local runtime state (writer lock, pending-save journal, save ledger) lives in
// <userData>/persistence/<book key>/, not in the book (ADR 0010). The key ends in `-<inode>-<birthtimeNs>` of the book
// folder, which survives a same-volume move, so a book is found by those two numbers without recomputing the volume part.
export async function bookStateDir(userData, folder, { required = true } = {}) {
  const info = await stat(folder, { bigint: true });
  const base = join(await realpath(userData), 'persistence');
  const suffix = `-${info.ino}-${info.birthtimeNs}`;
  const found = (await readdir(base).catch(() => [])).filter((name) => name.endsWith(suffix));
  if (found.length > 1) throw new Error('More than one runtime state folder matches ' + folder + ': ' + found.join(', '));
  if (!found.length) {
    // Callers that assert something is absent require the folder, so a wrong lookup cannot pass vacuously.
    if (required) throw new Error('No runtime state folder for ' + folder + ' in ' + base + '. The book was never opened for editing there.');
    return undefined;
  }
  return join(base, found[0]);
}

/** The path of a state file such as `writer.lock` or `pending-save.json`; the file itself may or may not exist. */
export async function bookStateFile(userData, folder, name, options) {
  const directory = await bookStateDir(userData, folder, options);
  return directory && join(directory, name);
}

/** The writer lock record of an open book, from App Support or, for a release before ADR 0010, from the package. */
export async function readWriterLock(userData, folder) {
  const current = await bookStateFile(userData, folder, 'writer.lock', { required: false });
  for (const [location, path] of [['app-support', current], ['legacy', join(folder, '.imageflow/writer.lock')]]) {
    if (!path) continue;
    const text = await readFile(path, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (text !== undefined) return { location, path, owner: JSON.parse(text) };
  }
  throw new Error('No writer lock is recorded for ' + folder);
}
