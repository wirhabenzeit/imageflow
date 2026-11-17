// Temporary pictures for the book view, its thumbnails and presentation, so render frames that come and go with every
// edit, and presentations opened again, never redraw the same map. Nothing is written to the book or disk; checks and
// exports never use this cache.
//
// One cache serves every book window, so all open books share a single memory budget. A picture is stored once,
// however many keys name it (the renderer saves the same picture as "this drawing", "this vector map at any
// resolution" and "the last picture at this place"), and is released when no key and no open book holds it.
import { createHash } from 'node:crypto';
import { totalmem } from 'node:os';

const MiB = 1024 * 1024;
/** An eighth of the computer's memory, between 1 and 4 GiB: room for the maps of a whole book, in every view. */
export function previewPictureBudget(memory = totalmem()) {
  return Math.min(4096 * MiB, Math.max(1024 * MiB, Math.floor(memory / 8)));
}

type Stored = { bytes: Uint8Array; type: string; keys: number };
type Entry = { stored: Stored; hash: string; owners: Set<string> };

export class PreviewPictureCache {
  // In least recently used order: the first key is the next to go.
  private entries = new Map<string, Entry>();
  private pictures = new Map<string, Stored>();
  private bytes = 0;
  constructor(private limit = previewPictureBudget(), private maxPicture = 64 * MiB, private maxEntries = 16384) {}

  /** The memory the stored pictures take now, each counted once. */
  get size() { return this.bytes; }

  /** The cache as one book window uses it; `clear` releases only what that window stored. */
  view(owner: string) {
    return {
      respond: (request: Request, scope: string, digest: string) => this.respond(request, scope, digest, owner),
      clear: () => this.release(owner),
    };
  }

  clear() { this.entries.clear(); this.pictures.clear(); this.bytes = 0; }

  private release(owner: string) {
    for (const [key, entry] of this.entries) {
      entry.owners.delete(owner);
      if (!entry.owners.size) this.remove(key);
    }
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (--entry.stored.keys > 0) return;
    this.pictures.delete(entry.hash);
    this.bytes -= entry.stored.bytes.byteLength;
  }

  async respond(request: Request, scope: string, digest: string, owner = '') {
    const key = JSON.stringify([scope, digest]);
    const headers = { 'Cache-Control': 'no-store' };
    if (request.method === 'GET') {
      const found = this.entries.get(key);
      if (!found) return new Response(null, { status: 404, headers });
      this.entries.delete(key); this.entries.set(key, found);
      found.owners.add(owner);
      return new Response(new Uint8Array(found.stored.bytes), { headers: { ...headers, 'Content-Type': found.stored.type } });
    }
    if (request.method !== 'PUT') return new Response(null, { status: 405 });
    const type = request.headers.get('Content-Type') ?? '';
    if (!/^image\/[a-z0-9.+-]+$/i.test(type)) return new Response(null, { status: 415 });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const maximum = Math.min(this.maxPicture, this.limit);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(value);
    }
    if (!size) return new Response(null, { status: 400 });
    const hashing = createHash('sha256').update(type + '\0');
    for (const chunk of chunks) hashing.update(chunk);
    const hash = hashing.digest('hex');
    const owners = new Set([...this.entries.get(key)?.owners ?? [], owner]);
    this.remove(key);
    let stored = this.pictures.get(hash);
    if (!stored) {
      // Make room first; a picture already stored under another key needs none.
      while (this.entries.size && (this.bytes + size > this.limit || this.entries.size >= this.maxEntries)) {
        this.remove(this.entries.keys().next().value!);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      stored = { bytes, type, keys: 1 };
      this.pictures.set(hash, stored);
      this.bytes += size;
    } else {
      // Held before evicting, so evicting its other keys cannot release it.
      stored.keys++;
      while (this.entries.size >= this.maxEntries) this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, { stored, hash, owners });
    return new Response(null, { status: 204 });
  }
}

/** The cache all book windows share. */
export const previewPictures = new PreviewPictureCache();
