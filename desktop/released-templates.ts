// The built-in templates earlier releases shipped (ADR 0006). Books copy their template, so after an update changes a
// built-in, books made from an earlier release keep its old hash. `sample/released-templates.json` lists the hash of
// every built-in template each release shipped, so those books stay trusted for the sites their template declares.
// `node scripts/released-templates.mjs` adds the current hashes when preparing a release; the release workflow checks
// them. Removing a hash from the list withdraws that trust in the next update.
import { readFile } from 'node:fs/promises';

const hashPattern = /^[a-f0-9]{64}$/;

/** The hashes in a released-templates file; a missing or damaged file trusts none. */
export async function readReleasedTemplates(file: string): Promise<Set<string>> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { schema?: unknown; templates?: unknown };
    if (value?.schema !== 1 || !value.templates || typeof value.templates !== 'object') return new Set();
    return new Set(Object.keys(value.templates).filter((hash) => hashPattern.test(hash)));
  } catch { return new Set(); }
}
