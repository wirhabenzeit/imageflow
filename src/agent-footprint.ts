import { coverInstance } from './project';
import type { ActiveBookEditor } from './desktop';
import type { PageSide } from './project';

// What an agent's save changes, as far as an open editor is concerned: the layouts it edits (a spread, one page of
// a split sheet, or the cover), or the whole book. Anything book-wide, structural, or not understood counts as the
// whole book, so the editor keeps the book to itself as before (beta finding F-023, #231).
export type AgentUnit = { spread: string; page?: PageSide };
export type AgentFootprint = { book: true } | { units: AgentUnit[] };

const whole = { book: true } as const;
const sides = new Set(['left', 'right']);

// The layout an operation addresses: `{ spread, page }` or `{ cover: true }`. A `$ref` names a spread the batch
// inserts, which is structural anyway.
function unitOf(target: unknown): AgentUnit | undefined {
  if (!target || typeof target !== 'object') return;
  const { spread, page, cover } = target as Record<string, unknown>;
  if (cover === true && spread === undefined && page === undefined) return { spread: coverInstance };
  if (typeof spread !== 'string' || !spread || spread.startsWith('$')) return;
  if (page !== undefined && (typeof page !== 'string' || !sides.has(page))) return;
  return { spread, ...(page ? { page: page as PageSide } : {}) };
}

// Operations that change one layout's own state, by the field that addresses it.
const local = new Set(['clear_page', 'swap_pages', 'switch_layout', 'assign_source', 'clear_box', 'set_crop']);
const parameters = new Set(['set_parameter', 'reset_parameter', 'insert_list_item', 'update_list_item', 'remove_list_item', 'move_list_item']);

/** The footprint of an MCP mutation, from its raw (not yet validated) arguments. */
export function agentFootprint(tool: string, args: Record<string, unknown>): AgentFootprint {
  if (tool !== 'apply_project_changes' || !Array.isArray(args.operations) || !args.operations.length) return whole;
  const units: AgentUnit[] = [];
  for (const operation of args.operations as unknown[]) {
    if (!operation || typeof operation !== 'object') return whole;
    const op = (operation as { op?: unknown }).op;
    if (typeof op !== 'string') return whole;
    if (op === 'swap_content') {
      const { from, to } = operation as { from?: unknown; to?: unknown };
      const a = unitOf(from), b = unitOf(to);
      if (!a || !b) return whole;
      units.push(a, b);
    } else if (local.has(op) || (parameters.has(op) && (operation as { scope?: unknown }).scope !== 'document')) {
      const unit = unitOf(operation);
      if (!unit) return whole;
      units.push(unit);
    } else return whole; // Title, format, document settings, photo metadata, and inserting, moving or removing spreads.
  }
  return { units };
}

/**
 * Whether a save with this footprint leaves the open editor's layout alone, so it may go through while the editor
 * stays open. An editor without a spread (a focused field, a document editor) shares nothing.
 */
export function leavesEditorAlone(footprint: AgentFootprint | undefined, editor: ActiveBookEditor) {
  if (!footprint || 'book' in footprint || !editor.spread) return false;
  return footprint.units.every(({ spread, page }) => spread !== editor.spread || (!!page && !!editor.page && page !== editor.page));
}
