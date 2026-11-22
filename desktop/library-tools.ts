import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { templateFiles } from './template-library';
import type { ImportPlan, TemplateLibrary } from './template-library';
import { AuthoringError } from './authoring-service';
import type { LibraryEntry } from '../src/library';

// The app-level MCP tools for the template library (#141): agents list the library and save an open book's template
// into it. They answer with results instead of the dialogs Manage Templates shows, and never grant network trust.

/** A library entry as agents see it: identity, what it declares and what it brings, without local paths or pictures. */
export function agentLibraryEntry(entry: LibraryEntry) {
  return {
    id: entry.id, version: entry.version, label: entry.label, ...(entry.description ? { description: entry.description } : {}),
    source: entry.source, ...(entry.replacesBuiltIn ? { replacesBuiltIn: true } : {}), hash: entry.hash,
    ...(entry.importedAt ? { importedAt: entry.importedAt } : {}),
    formats: entry.formats, layouts: entry.layouts, openingSpreads: entry.openingSpreads, ...(entry.shape ? { shape: entry.shape } : {}),
    ...(entry.packages?.length ? { packages: entry.packages } : {}),
    ...(entry.network?.length ? { network: entry.network } : {}), ...(entry.networkTrust ? { networkTrust: entry.networkTrust } : {}),
    ...(entry.unavailable ? { unavailable: entry.unavailable } : {}),
  };
}

const identity = ({ id, version, hash, source }: LibraryEntry) => ({ id, version, hash, source });

type Conflict = { reason: 'changed' | 'older' | 'built-in' | 'replaced-meanwhile'; current: LibraryEntry };

/**
 * Why saving `plan` needs the agent to name the entry it replaces, or undefined when it may save at once: a newer
 * version of an imported entry, or a new ID. Replacing a built-in template, the same version with other files or a
 * later version needs `replaceHash` to match the current entry. When supplied, it must also match for an upgrade.
 */
function conflict(plan: ImportPlan, replaceHash: string | undefined): Conflict | undefined {
  const current = plan.current;
  if (!current || plan.kind === 'same') return undefined;
  if (replaceHash && replaceHash !== current.hash) return { reason: 'replaced-meanwhile', current };
  const reason = current.source === 'built-in' ? 'built-in' : plan.kind === 'changed' || plan.kind === 'older' ? plan.kind : undefined;
  if (!reason) return undefined;
  if (replaceHash === current.hash) return undefined;
  return { reason, current };
}

const conflictMessages: Record<Conflict['reason'], string> = {
  'changed': 'The library has other files under this ID and version. Raise version in the template declaration and save again, or pass replaceHash to replace the entry.',
  'older': 'The library has a later version of this template. Raise version, or pass replaceHash to replace the later version.',
  'built-in': 'This ID belongs to a template that ships with ImageFlow. Give the template its own id, or pass replaceHash to hide the built-in template behind this one.',
  'replaced-meanwhile': 'replaceHash does not match the library entry with this ID, which may have changed. Call list_templates and decide again.',
};

/**
 * Saves the template folder of an open book into the library through the same validation, staging and Trash rules as
 * an import. Network sites the template declares are not allowed by saving it: each book made from it asks, until the
 * user allows them in Manage Templates.
 */
export async function saveTemplateToLibrary(library: TemplateLibrary, folder: string, replaceHash: string | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  let decided: { plan: ImportPlan; conflict?: Conflict } | undefined;
  const result = await library.import(folder, async () => true, async (plan) => {
    // The library repeats this decision if the entry changes before the queued commit.
    decided = { plan, conflict: conflict(plan, replaceHash) };
    return !decided.conflict && !signal.aborted;
  });
  if (result.status === 'failed') {
    // Without an ID the template failed to load; with one, writing the library failed.
    const code = result.id ? 'LIBRARY_SAVE_FAILED' : 'TEMPLATE_INVALID';
    throw new AuthoringError(code, result.message ?? 'The template could not be saved to the library.', result.details?.length ? { details: result.details } : undefined);
  }
  signal.throwIfAborted();
  const saved = { id: result.id!, version: result.version!, label: result.label ?? result.id!, ...(decided ? { hash: decided.plan.hash } : {}) };
  if (result.status === 'cancelled') {
    const found = decided?.conflict;
    if (!found) throw new AuthoringError('LIBRARY_SAVE_FAILED', 'The template was not saved to the library.');
    return { status: 'conflict' as const, template: saved, reason: found.reason, current: identity(found.current), message: conflictMessages[found.reason] };
  }
  if (result.status === 'unchanged') {
    const current = (await library.list()).find((entry) => entry.id === result.id);
    return { status: 'unchanged' as const, template: { ...saved, ...(current ? { hash: current.hash } : {}) },
      message: 'The library already has this template with these files.' };
  }
  const network = decided?.plan.info.network ?? [];
  return {
    status: decided?.plan.current ? 'replaced' as const : 'saved' as const, template: saved,
    ...(decided?.plan.current ? { replaced: identity(decided.plan.current) } : {}),
    ...(network.length ? { notice: 'Saving does not allow the sites this template declares: books made from it ask once, until the user allows them in Templates → Manage Templates….' } : {}),
  };
}

// Generated folders are compared and listed as one entry each: nobody ports them file by file.
const generatedFolders = ['vendor/', 'fonts/'];
const readableExtensions = new Set(['.ts', '.tsx', '.css', '.json', '.md', '.js', '.mjs', '.txt', '.svg']);
const sourceLimit = 32_000;

const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
async function fileDigests(folder: string) {
  const files = await templateFiles(folder);
  return new Map(await Promise.all(files.map(async (path) => [path, await digest(join(folder, ...path.split('/')))] as const)));
}
const grouped = (path: string) => generatedFolders.find((prefix) => path.startsWith(prefix)) ?? path;

/**
 * Reads a library template's files for agents (API-002): its file list, or one text file, and with a book's template
 * folder, which files differ from it, so a fork can bring over a newer starter's changes without the app's install path.
 */
export async function readLibraryTemplate(library: TemplateLibrary, args: { template: string; path?: string }, book?: string) {
  const entries = await library.list();
  const listed = entries.find(({ id }) => id === args.template);
  if (!listed) throw new AuthoringError('TEMPLATE_NOT_FOUND', 'The library has no template ' + args.template + '. Templates: ' + entries.map(({ id }) => id).join(', ') + '.');
  if (listed.unavailable) throw new AuthoringError('TEMPLATE_UNAVAILABLE', listed.unavailable);
  return library.withTemplate(args.template, async ({ entry, folder }) => {
    const template = { id: entry.id, version: entry.version, hash: entry.hash, source: entry.source };
    if (args.path) {
      const path = args.path;
      if (path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
        throw new AuthoringError('PATH_NOT_ALLOWED', 'Use a path from the file list, relative to the template folder, such as index.tsx.');
      }
      if (!readableExtensions.has(extname(path).toLowerCase())) {
        throw new AuthoringError('SOURCE_TYPE_NOT_SUPPORTED', 'Only text files can be read: ' + [...readableExtensions].join(', ') + '.');
      }
      const files = await templateFiles(folder);
      if (!files.includes(path)) throw new AuthoringError('SOURCE_NOT_FOUND', 'The template has no file ' + path + '. Call without path for its files.');
      const bytes = await readFile(join(folder, ...path.split('/')));
      const text = bytes.toString('utf8');
      return { template, path, text: text.slice(0, sourceLimit), truncated: text.length > sourceLimit,
        sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const shipped = await fileDigests(folder);
    const own = book ? await fileDigests(join(book, 'template')) : undefined;
    const entries = new Map<string, { status?: 'same' | 'changed' | 'library-only' | 'book-only'; files: number }>();
    for (const [path, hash] of shipped) {
      const key = grouped(path);
      const status = !own ? undefined : !own.has(path) ? 'library-only' as const : own.get(path) === hash ? 'same' as const : 'changed' as const;
      const listed = entries.get(key);
      entries.set(key, { files: (listed?.files ?? 0) + 1,
        ...(status ? { status: !listed?.status || listed.status === status ? status : 'changed' } : {}) });
    }
    for (const path of own?.keys() ?? []) {
      if (shipped.has(path)) continue;
      const key = grouped(path);
      const listed = entries.get(key);
      entries.set(key, { files: listed?.files ?? 0, status: listed ? 'changed' : 'book-only' });
    }
    const files = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([path, { status, files: count }]) => ({
      path, ...(path.endsWith('/') ? { files: count } : {}), ...(status ? { status } : {}) }));
    return { template, files, ...(own ? { compared: 'template/ of the book' } : {}),
      ...(shipped.has('CHANGELOG.md') ? { changelog: 'CHANGELOG.md' } : {}) };
  });
}
