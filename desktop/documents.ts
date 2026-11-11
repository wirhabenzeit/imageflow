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

export async function createDocument(destination: string, starter: string) {
  const folder = join(await realpath(dirname(destination)), basename(documentPath(destination)));
  const staging = join(dirname(folder), '.imageflow-create-' + randomUUID());
  let reserved = false;
  try {
    await cp(starter, staging, { recursive: true, filter: (path) => basename(path) !== '.imageflow' });
    const file = join(staging, 'project.json');
    const project = JSON.parse(await readFile(file, 'utf8'));
    project.title = basename(folder).slice(0, -documentExtension.length);
    await writeFile(file, JSON.stringify(project, null, 2) + '\n');
    // Reserve the destination exclusively. Never replace a user's existing book, even an empty package.
    await mkdir(folder);
    reserved = true;
    await rename(staging, folder);
    reserved = false;
    return folder;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (reserved) await rmdir(folder).catch(() => {});
  }
}

const recentSchema = z.array(z.object({
  id: z.string().uuid(), path: z.string(), identity: z.string(), title: z.string(), openedAt: z.string(),
  cover: z.string().max(300_000).optional(),
})).max(20);
type Entry = z.infer<typeof recentSchema>[number];

/** Recents and small derived cover images belong to the app, never to the document. */
export class RecentDocuments {
  private entries: Entry[] = [];
  private writes = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    try { this.entries = recentSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
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
    await this.update(() => {
      const previous = this.entries.find((entry) => entry.id === replacing || entry.identity === identity || entry.path === folder);
      const entry: Entry = { ...previous, id: previous?.id ?? randomUUID(), path: folder, identity, title, openedAt: new Date().toISOString() };
      this.entries = [entry, ...this.entries.filter((item) => item.id !== entry.id && item.identity !== identity && item.path !== folder)].slice(0, 20);
    });
  }
  async refresh(path: string, title: string, cover?: string) {
    await this.update(() => {
      const entry = this.entries.find((entry) => entry.path === path);
      if (entry) { entry.title = title; if (cover) entry.cover = cover; }
    });
  }
  remove(id: string) { return this.update(() => { this.entries = this.entries.filter((entry) => entry.id !== id); }); }
  async get(id: string) {
    await this.writes;
    const entry = this.entries.find((entry) => entry.id === id);
    if (!entry) throw new Error('This recent book is no longer listed.');
    return { ...entry };
  }
  async list(): Promise<RecentDocument[]> {
    await this.writes;
    return Promise.all(this.entries.map(async (entry) => {
      try {
        const current = await documentIdentity(entry.path);
        return { ...entry, available: current.identity === entry.identity };
      } catch { return { ...entry, available: false }; }
    }));
  }
  settled() { return this.writes; }
}
