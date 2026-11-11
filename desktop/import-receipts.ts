// Pending writes survive a queued filesystem event. The duplicate-event grace begins only when it is consumed.
export class ImportReceipts {
  private readonly entries = new Map<string, { fingerprint: string; pendingUntil: number; expires?: number; observed: boolean }>();
  constructor(private readonly limit = 2048, private readonly lifetimeMs = 60_000, private readonly now = Date.now,
    private readonly pendingLifetimeMs = 5 * 60_000) {}

  private prune() {
    const now = this.now();
    for (const [path, receipt] of this.entries) {
      if (!receipt.observed && (receipt.expires ?? receipt.pendingUntil) <= now) this.entries.delete(path);
    }
  }

  set(path: string, fingerprint: string, observed = false) {
    this.prune();
    this.entries.delete(path);
    this.entries.set(path, { fingerprint, pendingUntil: this.now() + this.pendingLifetimeMs, observed });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  get(path: string) { this.prune(); return this.entries.get(path)?.fingerprint; }
  observe(path: string) {
    this.prune();
    const receipt = this.entries.get(path);
    if (receipt) receipt.observed = true;
  }
  consume(path: string, fingerprint: string) {
    this.prune();
    const receipt = this.entries.get(path);
    if (!receipt || receipt.fingerprint !== fingerprint) return false;
    receipt.observed = false;
    receipt.expires ??= this.now() + this.lifetimeMs;
    this.prune();
    return true;
  }
  delete(path: string) { this.entries.delete(path); }
  clear() { this.entries.clear(); }
  get size() { this.prune(); return this.entries.size; }
}
