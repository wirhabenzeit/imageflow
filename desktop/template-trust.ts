// Lasting trust in a library template's network access (ADR 0006). The user allows the sites a template version
// declares once, when importing it or in Settings → Templates; books whose template still has exactly that hash then
// need not ask. Any change to the template's files changes its hash, so a changed template asks again.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Grant = { origins: string[]; id: string; version: string; allowedAt: string };
type Store = { schema: 1; templates: Record<string, Grant> };

const hashPattern = /^[a-f0-9]{64}$/;

export class TemplateTrust {
  private store?: Promise<Store>;
  private writes = Promise.resolve();

  constructor(private readonly file: string) {}

  private load() {
    this.store ??= readFile(this.file, 'utf8').then((text) => {
      const value = JSON.parse(text) as Store;
      if (value?.schema !== 1 || typeof value.templates !== 'object' || !value.templates) return { schema: 1 as const, templates: {} };
      const templates = Object.fromEntries(Object.entries(value.templates).filter(([hash, grant]) =>
        hashPattern.test(hash) && Array.isArray(grant?.origins) && grant.origins.every((origin) => typeof origin === 'string')));
      return { schema: 1 as const, templates };
    }).catch(() => ({ schema: 1 as const, templates: {} }));
    return this.store;
  }

  private update(change: (templates: Record<string, Grant>) => Record<string, Grant>) {
    const task = this.writes.then(async () => {
      const current = await this.load();
      const next: Store = { schema: 1, templates: change({ ...current.templates }) };
      await mkdir(dirname(this.file), { recursive: true });
      const staging = this.file + '.' + process.pid + '.tmp';
      await writeFile(staging, JSON.stringify(next, null, 2) + '\n');
      await rename(staging, this.file);
      this.store = Promise.resolve(next);
    });
    this.writes = task.catch(() => {});
    return task;
  }

  /** The sites the user allowed for the template with this hash, or none. */
  async allowed(hash: string): Promise<string[]> {
    return [...(await this.load()).templates[hash]?.origins ?? []];
  }

  /** Called only after the user allowed these sites for this exact template version. */
  async allow(hash: string, origins: readonly string[], template: { id: string; version: string }) {
    if (!hashPattern.test(hash)) throw new Error('Unknown template version.');
    await this.update((templates) => ({ ...templates,
      [hash]: { origins: [...new Set(origins)].sort(), id: template.id, version: template.version, allowedAt: new Date().toISOString() } }));
  }

  async revoke(hash: string) {
    await this.update((templates) => { delete templates[hash]; return templates; });
  }
}

/**
 * The declared sites a book's editors may reach without asking, from the hash of the book's template as it is now:
 * all of them for a built-in template the app ships, otherwise those the user allowed for that hash.
 */
export function trustedOrigins(declared: readonly string[], grant: { builtIn: boolean; allowed: readonly string[] }) {
  if (grant.builtIn) return [...declared];
  const allowed = new Set(grant.allowed);
  return declared.filter((origin) => allowed.has(origin));
}
