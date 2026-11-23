import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import type { RecentDocument } from '../src/desktop';

export const documentExtension = '.imageflow';
export const isDocument = (path: string) => extname(path).toLowerCase() === documentExtension;
export const documentPath = (path: string) => isDocument(path) ? path : path + documentExtension;

/** Filesystem identity deduplicates aliases and moved packages, while Finder copies remain independent books. */
export async function documentIdentity(path: string) {
  const folder = await realpath(path);
  const info = await stat(folder, { bigint: true });
  if (!info.isDirectory()) throw new Error('Choose an ImageFlow document.');
  return { folder, identity: [info.dev, info.ino].join(':') };
}

export async function createDocument(destination: string, starter: string | ((stage: string) => Promise<void>),
  // A move keeps the book's lineage; every other new document starts its own.
  { keepLineage = false }: { keepLineage?: boolean } = {}) {
  const folder = join(await realpath(dirname(destination)), basename(documentPath(destination)));
  const staging = join(dirname(folder), '.imageflow-create-' + randomUUID());
  let reserved = false;
  try {
    if (typeof starter === 'string') await cp(starter, staging, { recursive: true, filter: (path) => basename(path) !== '.imageflow' && basename(path) !== 'node_modules' });
    else { await mkdir(staging); await starter(staging); }
    const file = join(staging, 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8'));
    // Every document made here (New Book, Duplicate, Save a Copy) starts a new lineage, so a copy never shares the
    // `bookId` of the book it was made from (ADR 0010). A Finder copy, which does not pass here, keeps it by design.
    const { schemaVersion, title: _title, bookId: inherited, ...rest } = project;
    const bookId = keepLineage && typeof inherited === 'string' ? inherited : randomUUID();
    await writeFile(file, JSON.stringify({ ...(schemaVersion === undefined ? {} : { schemaVersion }),
      title: basename(folder).slice(0, -documentExtension.length), bookId, ...rest }, null, 2) + '\n');
    // Reserve the destination exclusively. Never replace a user's existing book, even an empty package.
    try { await mkdir(folder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A book named “${basename(folder)}” already exists there. Choose another name.`, { cause: error });
      throw error;
    }
    reserved = true;
    await rename(staging, folder);
    reserved = false;
    return folder;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (reserved) await rmdir(folder).catch(() => {});
  }
}

const maximumCoverLength = 300_000;
/** Recent books that do not sync; books that sync on this Mac stay tracked beyond it (up to `maximumTracked`). */
export const maximumRecents = 20;
const maximumTracked = 500;
const recentEntrySchema = z.object({
  id: z.string().uuid(), path: z.string(), identity: z.string(), title: z.string(), openedAt: z.string(),
  cover: z.string().max(maximumCoverLength).optional(),
  // The book's lineage (`project.json` `bookId`), which the library matches books on the remote by (#283).
  bookId: z.string().uuid().optional(),
  // The book syncs on this Mac: it stays tracked beyond the cap, so the library never lists it as only on the remote.
  syncs: z.literal(true).optional(),
});
type Entry = z.infer<typeof recentEntrySchema>;

/** The lineage a book's project.json names, or undefined. Small and best effort: a book that cannot be read has none. */
async function lineageOf(folder: string) {
  try {
    const { bookId } = JSON.parse(await readFile(join(folder, 'project.json'), 'utf8')) as { bookId?: unknown };
    return typeof bookId === 'string' && z.string().uuid().safeParse(bookId).success ? bookId : undefined;
  } catch { return undefined; }
}

/** The 20 most recent books, and every book that syncs here besides (#283), most recent first. */
function capped(entries: Entry[]) {
  let recent = 0;
  return entries.filter((entry) => entry.syncs || recent++ < maximumRecents).slice(0, maximumTracked);
}

/**
 * Recents and small derived cover images belong to the app, never to the document. The list is also what the library
 * knows of the books on this Mac (#283): each entry records the book's lineage (`bookId`), and a book that syncs here
 * stays tracked beyond the 20 most recent, so it is never listed as a book only on the remote.
 */
export class RecentDocuments {
  private entries: Entry[] = [];
  private writes = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    try {
      const values = z.array(z.unknown()).parse(JSON.parse(await readFile(this.file, 'utf8')));
      this.entries = capped(values.flatMap((value) => {
        // Covers are disposable; a malformed cover must not discard the document or other recents.
        if (value && typeof value === 'object' && 'cover' in value && (typeof value.cover !== 'string' || value.cover.length > maximumCoverLength)) {
          value = { ...value, cover: undefined };
        }
        const parsed = recentEntrySchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('ImageFlow could not read recent books.', error);
    }
  }
  private update(change: () => void) {
    const task = this.writes.then(async () => {
      change();
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', JSON.stringify(this.entries, null, 2) + '\n');
      await rename(this.file + '.tmp', this.file);
    });
    this.writes = task.catch(() => {});
    return task;
  }
  async remember(path: string, title: string, replacing?: string) {
    const { folder, identity } = await documentIdentity(path);
    const bookId = await lineageOf(folder);
    await this.update(() => {
      const previous = this.entries.find((entry) => entry.id === replacing || entry.identity === identity || entry.path === folder);
      const entry: Entry = { ...previous, id: previous?.id ?? randomUUID(), path: folder, identity, title, openedAt: new Date().toISOString(), ...(bookId ? { bookId } : {}) };
      this.entries = capped([entry, ...this.entries.filter((item) => item.id !== entry.id && item.identity !== identity && item.path !== folder)]);
    });
  }
  /** The open book changed: its title, its cover when one was made, and its lineage (Sync Again gives it a new one). */
  async refresh(path: string, title: string, cover?: string, bookId?: string) {
    await this.update(() => {
      const entry = this.entries.find((entry) => entry.path === path);
      if (entry) {
        entry.title = title;
        if (cover && cover.length <= maximumCoverLength) entry.cover = cover;
        if (bookId) entry.bookId = bookId;
      }
    });
  }
  /**
   * Records whether the book at `path` syncs on this Mac: one that does stays tracked beyond the cap, and one that no
   * longer does counts toward it again. Writes only when it changed, and says whether it did.
   */
  async track(path: string, syncs: boolean) {
    const entry = this.entries.find((entry) => entry.path === path);
    if (!entry || !!entry.syncs === syncs) return false;
    await this.update(() => {
      const current = this.entries.find((item) => item.path === path);
      if (!current) return;
      if (syncs) current.syncs = true; else delete current.syncs;
      this.entries = capped(this.entries);
    });
    return true;
  }
  /** The cached cover of the book at `path`, as a JPEG data URL; undefined when none was made yet. */
  async coverOf(path: string) {
    await this.writes;
    return this.entries.find((entry) => entry.path === path)?.cover;
  }
  remove(id: string) { return this.update(() => { this.entries = this.entries.filter((entry) => entry.id !== id); }); }
  async get(id: string) {
    await this.writes;
    const entry = this.entries.find((entry) => entry.id === id);
    if (!entry) throw new Error('This recent book is no longer listed.');
    return { ...entry };
  }
  /**
   * Every tracked book, with whether it can be opened. An entry from before lineages were recorded gets its `bookId`
   * from the book's project.json while it can be read, and keeps it.
   */
  async list(): Promise<RecentDocument[]> {
    await this.writes;
    const listed = await Promise.all(this.entries.map(async (entry) => {
      try {
        if (!isDocument(entry.path)) return { ...entry, available: false };
        const current = await documentIdentity(entry.path);
        const manifest = await stat(join(current.folder, 'project.json'));
        if (!manifest.isFile()) return { ...entry, available: false };
        const bookId = entry.bookId ?? await lineageOf(current.folder);
        return { ...entry, ...(bookId ? { bookId } : {}), available: true };
      } catch { return { ...entry, available: false }; }
    }));
    const found = listed.filter((entry, index) => entry.bookId && !this.entries[index].bookId);
    if (found.length) {
      await this.update(() => {
        for (const { id, bookId } of found) { const entry = this.entries.find((item) => item.id === id); if (entry && !entry.bookId) entry.bookId = bookId; }
      }).catch((error) => console.warn('ImageFlow could not update recent books', error));
    }
    return listed;
  }
  settled() { return this.writes; }
}
