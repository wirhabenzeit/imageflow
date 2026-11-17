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
