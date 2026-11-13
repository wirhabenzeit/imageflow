// A book window's temporary thumbnail pictures. Render frames can come and go without redrawing the same map.
// Nothing is written to the book or disk; checks and exports never use this cache.
export class PreviewPictureCache {
  private entries = new Map<string, { bytes: Uint8Array; type: string }>();
  private bytes = 0;
  constructor(private limit = 16 * 1024 * 1024, private maxPicture = 4 * 1024 * 1024, private maxEntries = 128) {}

  clear() { this.entries.clear(); this.bytes = 0; }

  async respond(request: Request, scope: string, digest: string) {
    const key = JSON.stringify([scope, digest]);
    const headers = { 'Cache-Control': 'no-store' };
    if (request.method === 'GET') {
      const found = this.entries.get(key);
      if (!found) return new Response(null, { status: 404, headers });
      this.entries.delete(key); this.entries.set(key, found);
      return new Response(new Uint8Array(found.bytes), { headers: { ...headers, 'Content-Type': found.type } });
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
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes.byteLength; this.entries.delete(key); }
    while (this.bytes + size > this.limit || this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes.byteLength;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { bytes, type }); this.bytes += size;
    return new Response(null, { status: 204 });
  }
}
