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
  await approveSources(folder, [source], accept);
}
/** Approves the sources of one explicit selection together, so importing many files writes the registry once. */
export async function approveSources(folder: string, sources: readonly Target[], accept?: string[]) {
  const approved: Grants = {};
  for (const source of sources) {
    if (!source.linked || !source.key) throw new Error('Choose an external source to link.');
    const path = await realpath(source.path);
    if (source.kind === 'file' && !accept?.includes(extname(path).toLowerCase())) throw new Error('Choose a file with an extension accepted by the parameter.');
    approved[source.key] = { path, ...(source.kind === 'file' ? { accept } : {}) };
  }
  if (!sources.length) return;
  const { key, book } = await accessFor(folder);
  const task = book.writes.then(async () => {
    const grants = { ...book.grants, ...approved };
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
// outside the book and bound to the book's filesystem identity. They belong to the book, not to one version of its
// template: editing the template keeps them, and only an origin the template newly declares needs a question. The
// template hash recorded with older grants is informational only.
const networkKey = (origin: string) => 'network:' + origin;
export async function approvedNetwork(folder: string) {
  const { book } = await accessFor(folder);
  return Object.keys(book.grants).filter((key) => key.startsWith('network:')).map((key) => key.slice('network:'.length));
}
/** Called only after the user allowed these origins for this book, or the book's template was trusted for them. */
export async function approveNetwork(folder: string, origins: readonly string[], hash?: string) {
  const { key, book } = await accessFor(folder);
  const task = book.writes.then(async () => {
    const added = origins.filter((origin) => !book.grants[networkKey(origin)]);
    if (!added.length) return;
    const grants = { ...book.grants, ...Object.fromEntries(added.map((origin) => [networkKey(origin), { path: origin, ...(hash ? { hash } : {}) }])) };
    await saveGrants(key, grants);
    book.grants = grants;
  });
  book.writes = task.catch(() => {});
  await task;
}

// Whether this book is the user's own (ADR 0006): made with New Book on this Mac from a template whose sites were
// already trusted, saved as a copy of such a book, or trusted once when it came from elsewhere. Its template may then
// reach every site it declares without asking, including sites added later by the user or their agent. The mark is
// app-owned and bound to the book's filesystem identity, so a book received from someone else cannot claim it. A book
// that already had sites allowed before the mark existed counts as trusted: the user decided for it then.
const trustKey = 'trust:book';
export async function bookTrusted(folder: string) {
  const { book } = await accessFor(folder);
  return !!book.grants[trustKey] || Object.keys(book.grants).some((key) => key.startsWith('network:'));
}
async function changeGrants(folder: string, change: (grants: Grants) => Grants) {
  const { key, book } = await accessFor(folder);
  const task = book.writes.then(async () => {
    const grants = change({ ...book.grants });
    await saveGrants(key, grants);
    book.grants = grants;
  });
  book.writes = task.catch(() => {});
  await task;
}
/** Called when the user made this book here, or chose to trust it. */
export async function trustBook(folder: string) {
  if ((await accessFor(folder)).book.grants[trustKey]) return;
  await changeGrants(folder, (grants) => ({ ...grants, [trustKey]: { path: 'trusted' } }));
}
/** Withdraws the mark and every site allowed for the book; its template asks again. */
export async function distrustBook(folder: string) {
  await changeGrants(folder, (grants) => Object.fromEntries(Object.entries(grants).filter(([key]) => key !== trustKey && !key.startsWith('network:'))));
}
/** A saved copy of the user's own book is theirs too, with the sites already allowed for it. */
export async function transferBookTrust(from: string, to: string) {
  if (!await bookTrusted(from)) return;
  await approveNetwork(to, await approvedNetwork(from));
  await trustBook(to);
}
