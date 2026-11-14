import type { MarkdownState } from '../src/desktop';

/** The native process owns pending text, including while the renderer or book is closing. */
export class MarkdownBuffer {
  private saved: string;
  private text: string;
  private version = 0;
  // The disk text revision is separate from the renderer’s input sequence.
  private basis = 0;
  private saving = false;
  private error?: string;
  private conflict?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private tail = Promise.resolve();
  private disposed = false;
  constructor(private identity: Pick<MarkdownState, 'id' | 'name' | 'path' | 'external'>, initial: string,
    private io: { read(): Promise<string>; write(expected: string, text: string): Promise<void> },
    private changed: (state: MarkdownState) => void, private delay = 650) {
    this.text = this.saved = initial;
  }
  get state(): MarkdownState {
    return { ...this.identity, text: this.text, version: this.version, basis: this.basis, dirty: this.text !== this.saved,
      saving: this.saving, error: this.error, conflict: this.conflict };
  }
  private publish() { if (!this.disposed) this.changed(this.state); }
  private serial(task: () => Promise<void>) {
    const next = this.tail.then(task);
    this.tail = next.catch(() => {});
    return next;
  }
  change(text: string, version: number, basis = this.basis) {
    if (this.disposed || version <= this.version) return;
    this.text = text; this.version = version;
    // A clean poll can adopt outside text while a keystroke based on the old text is still in flight.
    if (basis !== this.basis && text !== this.saved) this.conflict = this.saved;
    clearTimeout(this.timer);
    if (this.conflict === undefined) this.timer = setTimeout(() => void this.flush(), this.delay);
    this.publish();
  }
  refresh() {
    return this.serial(async () => {
      try {
        const disk = await this.io.read();
        if (disk !== this.saved) {
          if (this.text === this.saved || this.text === disk) {
            if (this.text !== disk) this.basis++;
            this.text = this.saved = disk; this.conflict = undefined; this.error = undefined;
          } else this.conflict = disk;
        } else if (this.text === this.saved) this.conflict = undefined;
        // An unavailable source can recover without discarding pending edits or retrying a failed write.
        if (this.text === this.saved) this.error = undefined;
      } catch (error) { this.error = message(error); }
      this.publish();
    });
  }
  flush() {
    clearTimeout(this.timer);
    return this.serial(async () => {
      if (this.disposed || this.text === this.saved) return;
      this.saving = true; this.error = undefined; this.publish();
      try {
        const disk = await this.io.read();
        if ((this.conflict !== undefined || disk !== this.saved) && disk !== this.text) { this.conflict = disk; return; }
        const text = this.text;
        if (disk !== text) await this.io.write(disk, text);
        this.saved = text; this.conflict = undefined;
      } catch (error) {
        this.error = message(error);
        // A source may have changed between the read and the final publication check.
        try { const disk = await this.io.read(); if (disk !== this.saved) this.conflict = disk; } catch { /* Keep the save error. */ }
      } finally { this.saving = false; this.publish(); }
    });
  }
  async resolve(action: 'reload' | 'keep', expected: string) {
    await this.serial(async () => {
      try {
        const disk = await this.io.read();
        if (disk !== expected) { this.conflict = disk; this.error = 'The file changed again. Review the latest outside text.'; return; }
        this.saved = disk;
        if (action === 'reload') { if (this.text !== disk) this.basis++; this.text = disk; }
        this.conflict = undefined; this.error = undefined;
      } catch (error) { this.error = message(error); }
      this.publish();
    });
    if (action === 'keep' && this.conflict === undefined && !this.error) await this.flush();
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); }
}
function message(error: unknown) { return error instanceof Error ? error.message : 'Could not save this Markdown source.'; }
