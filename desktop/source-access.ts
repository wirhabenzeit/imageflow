import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import type { SourceEntry } from '../src/source-locations';

type Target = Pick<SourceEntry, 'kind' | 'path' | 'linked'> & { key?: string };
const grantsSchema = z.record(z.string(), z.object({ path: z.string(), accept: z.array(z.string()).optional(), hash: z.string().optional() }));
type Grants = z.infer<typeof grantsSchema>;
let root: string | undefined;
const books = new Map<string, Promise<{ grants: Grants; writes: Promise<void> }>>();
export function configureSourceAccess(directory: string) { root = directory; books.clear(); }
export class SourceAccessError extends Error { readonly code = 'SOURCE_NOT_APPROVED'; }
export async function sourceBookKey(folder: string) {
  const info = await stat(folder, { bigint: true });
  return `${info.dev}-${info.ino}-${info.birthtimeNs}`;
}
async function accessFor(folder: string) {
  const key = (root ?? 'memory') + '/' + await sourceBookKey(folder);
  if (!books.has(key)) books.set(key, (async () => {
    let grants: Grants = {};
    if (root) try { grants = grantsSchema.parse(JSON.parse(await readFile(key + '.json', 'utf8'))); } catch { /* An invalid registry grants nothing. */ }
    return { grants, writes: Promise.resolve() };
  })());
  return { key, book: await books.get(key)! };
}
async function saveGrants(key: string, grants: Grants) {
  if (!root) return;
  await mkdir(root, { recursive: true });
  const temporary = key + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(grants), { flag: 'wx', mode: 0o600 });
  await rename(temporary, key + '.json');
}
export async function approvedSource(folder: string, source: Target) {
  if (!source.linked) return true;
  if (!source.key) return false;
  const { book } = await accessFor(folder);
  const grant = book.grants[source.key];
  return grant?.path === source.path && (source.kind !== 'file' || !!grant.accept?.includes(extname(source.path).toLowerCase()));
}
export async function requireSourceAccess(folder: string, source: Target) {
  if (!await approvedSource(folder, source)) throw new SourceAccessError('Locate this original to approve access on this Mac.');
}
export async function approvedExtensions(folder: string, key: string) {
  return (await accessFor(folder)).book.grants[key]?.accept;
}
/** Called only after an explicit file/folder selection, never while loading a manifest. */
export async function approveSource(folder: string, source: Target, accept?: string[]) {
  if (!source.linked || !source.key) throw new Error('Choose an external source to link.');
  const path = await realpath(source.path);
  if (source.kind === 'file' && !accept?.includes(extname(path).toLowerCase())) throw new Error('Choose a file with an extension accepted by the parameter.');
  const { key, book } = await accessFor(folder);
  const task = book.writes.then(async () => {
    const grants = { ...book.grants, [source.key!]: { path, ...(source.kind === 'file' ? { accept } : {}) } };
    await saveGrants(key, grants);
    book.grants = grants;
  });
  book.writes = task.catch(() => {});
  await task;
}
/** An explicit Save a Copy may retain only this book's already approved links. */
export async function transferSourceAccess(from: string, to: string, entries: SourceEntry[]) {
  for (const entry of entries) if (entry.linked && await approvedSource(from, entry)) {
    const accept = await approvedExtensions(from, entry.key);
    const { key, book } = await accessFor(to);
    const task = book.writes.then(async () => {
      const grants = { ...book.grants, [entry.key]: { path: entry.path, ...(accept ? { accept } : {}) } };
      await saveGrants(key, grants);
      book.grants = grants;
    });
    book.writes = task.catch(() => {}); await task;
  }
}

// Network origins the user allowed this book's template to reach (ADR 0006), kept with the source grants: app-owned,
// outside the book, bound to the book's filesystem identity and to the template's hash when they were allowed. Any
// change to the template's files ends them, as it ends library trust.
const networkKey = (origin: string) => 'network:' + origin;
export async function approvedNetwork(folder: string, hash: string | undefined) {
  if (!hash) return [];
  const { book } = await accessFor(folder);
  return Object.entries(book.grants).filter(([key, grant]) => key.startsWith('network:') && grant.hash === hash)
    .map(([key]) => key.slice('network:'.length));
}
/** Called only after the user allowed these origins for the template with this hash. */
export async function approveNetwork(folder: string, origins: string[], hash: string) {
  const { key, book } = await accessFor(folder);
  const task = book.writes.then(async () => {
    const grants = { ...book.grants, ...Object.fromEntries(origins.map((origin) => [networkKey(origin), { path: origin, hash }])) };
    await saveGrants(key, grants);
    book.grants = grants;
  });
  book.writes = task.catch(() => {});
  await task;
}
