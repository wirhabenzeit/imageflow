// The built-in templates earlier releases shipped (ADR 0006). Books copy their template, so after an update changes a
// built-in, books made from an earlier release keep its old hash. `sample/released-templates.json` lists the hash of
// every built-in template each release shipped, so those books stay trusted for the sites their template declares,
// like the current built-ins: always, with no switch in Manage Templates. `node scripts/released-templates.mjs` adds the
// current hashes when preparing a release; the release workflow checks them. Removing a hash from the list withdraws
// that trust in the next update.
import { readFile } from 'node:fs/promises';

const hashPattern = /^[a-f0-9]{64}$/;

export class ReleasedTemplates {
  // The sites each released template declared when its book rendered. The hash fixes the template's files, so this is
  // what it declares every time; it lets a refresh before the next render keep them (see bookNetworkTrust).
  private declared = new Map<string, string[]>();

  constructor(private readonly hashes: ReadonlySet<string> = new Set()) {}

  /** Reads the shipped list; a missing or damaged file trusts none. */
  static async read(file: string) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as { schema?: unknown; templates?: unknown };
      if (value?.schema !== 1 || !value.templates || typeof value.templates !== 'object') return new ReleasedTemplates();
      return new ReleasedTemplates(new Set(Object.keys(value.templates).filter((hash) => hashPattern.test(hash))));
    } catch { return new ReleasedTemplates(); }
  }

  has(hash: string) { return this.hashes.has(hash); }

  /**
   * The sites a released template may reach: all it declares. Without `declared`, before the book has rendered in
   * this session, the sites it declared the last time; none when it has not rendered yet.
   */
  trusted(hash: string, declared?: readonly string[]) {
    if (!this.has(hash)) return undefined;
    if (!declared) return [...this.declared.get(hash) ?? []];
    this.declared.set(hash, [...declared]);
    return [...declared];
  }
}
