// Keep receipts across repeated filesystem notifications, but never for an entire editing session.
export class ImportReceipts {
  private readonly entries = new Map<string, { fingerprint: string; expires: number }>();
  constructor(private readonly limit = 2048, private readonly lifetimeMs = 60_000, private readonly now = Date.now) {}

  private prune() {
    const now = this.now();
    for (const [path, receipt] of this.entries) {
      if (receipt.expires > now) break;
      this.entries.delete(path);
    }
  }

  set(path: string, fingerprint: string) {
    this.prune();
    this.entries.delete(path);
    this.entries.set(path, { fingerprint, expires: this.now() + this.lifetimeMs });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  get(path: string) { this.prune(); return this.entries.get(path)?.fingerprint; }
  delete(path: string) { this.entries.delete(path); }
  clear() { this.entries.clear(); }
  get size() { this.prune(); return this.entries.size; }
}
