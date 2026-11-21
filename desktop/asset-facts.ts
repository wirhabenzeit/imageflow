import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assetFactSchema, assetsMetaFile, assetsMetaSchema } from '../src/asset-facts';
import type { AssetFact } from '../src/asset-facts';
import { canonicalJsonIndented } from '../src/canonical-json';
import { captureFields } from '../src/photo-metadata';
import { holdsProjectLock } from './persistence';

/**
 * Derived `assets-meta.json` of a book (ADR 0010). It is written here, independently: atomically by a
 * `.imageflow-write-<uuid>.tmp` rename in the book root, outside the two-manifest save journal and `ledger.jsonl`, so a
 * background digest never makes an undo step, a checkpoint or a "changed on disk" reload. Revision tracking and the
 * folder watcher only look at manifests and content folders, so they do not see this file. An unreadable or invalid file
 * counts as empty: it regenerates from the originals and never blocks opening.
 */
const maximumBytes = 16 * 1024 * 1024;
const flushDelay = 400;

/** Reads the facts of a book folder; `{}` for a missing, oversized or invalid file. */
export async function readAssetFacts(folder: string): Promise<Record<string, AssetFact>> {
  try {
    const handle = await open(join(folder, assetsMetaFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maximumBytes) return {};
      const parsed = assetsMetaSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
      return parsed.success ? parsed.data.assets : {};
    } finally { await handle.close(); }
  } catch { return {}; }
}

/** Writes a book's whole assets-meta.json atomically. */
async function writeAssetFacts(folder: string, facts: Record<string, AssetFact>) {
  const bytes = canonicalJsonIndented({ version: 1, assets: facts }) + '\n';
  const staging = join(folder, '.imageflow-write-' + randomUUID() + '.tmp');
  try {
    await writeFile(staging, bytes, { flag: 'wx', mode: 0o644 });
    await rename(staging, join(folder, assetsMetaFile));
  } finally { await rm(staging, { force: true }); }
}

const same = (a: AssetFact | undefined, b: AssetFact | undefined) => !!a && !!b &&
  canonicalJsonIndented({ ...a, verified: '' }) === canonicalJsonIndented({ ...b, verified: '' });

type Capture = Partial<Pick<AssetFact, typeof captureFields[number]>>;
type Note = { observation: string; width: number; height: number; capture: Capture };
const captureOf = (source: Capture): Capture => Object.fromEntries(captureFields.flatMap((field) => source[field] ? [[field, source[field]]] : []));

const registry = new Map<string, Promise<AssetFacts>>();

export class AssetFacts {
  private facts: Record<string, AssetFact> = {};
  // What a resolved photo looked like (the original's stamp, size and capture data), until its digest is known.
  private notes = new Map<string, Note>();
  private digests = new Map<string, { observation: string; digest: string }>();
  private dirty = new Set<string>();
  private removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private constructor(readonly folder: string) {}

  /** The facts of a book, loaded once per open session; `release` drops them. */
  static forBook(folder: string): Promise<AssetFacts> {
    if (!registry.has(folder)) registry.set(folder, (async () => {
      const facts = new AssetFacts(folder);
      facts.facts = await readAssetFacts(folder);
      return facts;
    })());
    return registry.get(folder)!;
  }
  /** The facts of a book that is only read (read-only, pinned or temporary loads): never registered, never written. */
  static async readOnly(folder: string): Promise<AssetFacts> {
    const facts = new AssetFacts(folder);
    facts.facts = await readAssetFacts(folder);
    return facts;
  }
  /** Writes what is pending and forgets the book's facts. */
  static async release(folder: string) {
    const loaded = registry.get(folder);
    registry.delete(folder);
    await (await loaded?.catch(() => undefined))?.flush();
  }

  /** Whether an open session registered the facts of this book. */
  static registered(folder: string) { return registry.has(folder); }
  /**
   * Replaces a book's facts with the ones a sync pull merged (ADR 0010, per-asset rule): written now, whether or not a
   * session holds them, and adopted by a session that does, after writing what it had pending.
   */
  static async adoptSynced(folder: string, facts: Record<string, AssetFact>) {
    const loaded = await registry.get(folder)?.catch(() => undefined);
    if (loaded) {
      await loaded.flush();
      loaded.facts = { ...facts };
    }
    await writeAssetFacts(folder, facts);
  }

  get(id: string): AssetFact | undefined { return this.facts[id]; }
  all(): Readonly<Record<string, AssetFact>> { return this.facts; }

  /** A photo was resolved from its original: remember it, and record it once its digest is known. */
  note(id: string, observation: string, details: { width: number; height: number } & Capture, digest?: string) {
    this.notes.set(id, { observation, width: details.width, height: details.height, capture: captureOf(details) });
    if (digest) this.digests.set(id, { observation, digest });
    this.commit(id);
  }
  /** A background digest finished for the original with this stamp. */
  digest(id: string, observation: string, digest: string) {
    this.digests.set(id, { observation, digest });
    this.commit(id);
  }
  private commit(id: string) {
    const note = this.notes.get(id);
    const digest = this.digests.get(id);
    if (!note || !digest || note.observation !== digest.observation) return;
    const fact = assetFactSchema.safeParse({ digest: digest.digest, width: note.width, height: note.height, ...note.capture, verified: new Date().toISOString() });
    if (!fact.success) return;
    // Nothing changed: keep the older `verified` and write nothing.
    if (same(this.facts[id], fact.data)) return;
    this.facts[id] = fact.data;
    this.removed.delete(id);
    this.dirty.add(id);
    this.schedule();
  }
  /** Drops facts of photos that left the book. Facts of photos with a missing original stay: they are the fallback. */
  prune(ids: Iterable<string>) {
    const keep = new Set(ids);
    for (const id of Object.keys(this.facts)) if (!keep.has(id)) {
      delete this.facts[id]; this.dirty.delete(id); this.removed.add(id);
      this.schedule();
    }
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, flushDelay);
    this.timer.unref?.();
  }

  /** Writes pending changes now, if this process holds the book's writer lock; otherwise they are dropped. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const task = this.writes.then(async () => {
      if (!this.dirty.size && !this.removed.size) return;
      const changed = [...this.dirty], removed = [...this.removed];
      this.dirty.clear(); this.removed.clear();
      // A failed write queues what it took again, without overriding what changed meanwhile.
      const requeue = () => {
        for (const id of changed) if (this.facts[id] && !this.removed.has(id)) this.dirty.add(id);
        for (const id of removed) if (!this.facts[id] && !this.dirty.has(id)) this.removed.add(id);
        if (this.dirty.size || this.removed.size) this.schedule();
      };
      // Read-only opens and books another process owns only read.
      if (!await holdsProjectLock(this.folder)) return;
      try {
      // Merge into what is on disk, so entries another replica or session added are kept.
      const current = await readAssetFacts(this.folder);
      for (const id of removed) delete current[id];
      for (const id of changed) if (this.facts[id]) current[id] = this.facts[id];
      await writeAssetFacts(this.folder, current);
      } catch (error) { requeue(); throw error; }
    }).catch((error) => console.warn('ImageFlow could not write assets-meta.json', error));
    this.writes = task;
    return task;
  }
}
