import type { SyncStatus, SyncView } from '../src/desktop';
import type { agentSyncStates } from '../src/mcp-results';
import { AuthoringError } from './authoring-service';

/**
 * A book's sync between Macs as agents see it (API-025), apart from Electron so it can be tested: the compact state
 * `list_projects` and `inspect_book` report, and what an agent's write does about a book that is behind.
 *
 * The states follow the app's own words (the status bar and the Sync window): `in-sync` "In sync", `to-fetch` "Changes
 * to fetch", `to-send` "Changes to send", `diverged` "Changed on two Macs", `arriving` "Still arriving", `interrupted`
 * "Sync stopped", `needs-update` "Needs an update", `unavailable` "Cannot sync now", `removed` "Removed on another Mac";
 * `syncing` while a sync runs, `unknown` before the status was first read.
 */
export type AgentSyncStateName = typeof agentSyncStates[number];
export type AgentSyncState = {
  state: AgentSyncStateName;
  /** Sync automatically is on: the book takes and sends changes by itself. */
  automatic: boolean;
  /** When the remote was last read for this status. */
  checked?: string;
  /** When this window last took changes from another Mac, and last sent its own. */
  lastPull?: string; lastPush?: string;
  /** Why the remote cannot be read, with `unavailable`. */
  detail?: string;
};

const names: Record<SyncStatus['state'], AgentSyncStateName> = {
  'in-sync': 'in-sync', ahead: 'to-send', behind: 'to-fetch', diverged: 'diverged', 'remote-syncing': 'arriving',
  abandoned: 'interrupted', newer: 'needs-update', unavailable: 'unavailable', removed: 'removed',
};

/** The state of a book that syncs on this Mac (a `SyncView`), or undefined for one that does not. */
export function agentSyncState(view: SyncView | undefined, { automatic, checked, lastPull, lastPush }:
  { automatic: boolean; checked?: number; lastPull?: string; lastPush?: string }): AgentSyncState | undefined {
  if (!view) return undefined;
  const state = view.syncing ? 'syncing' : view.status ? names[view.status.state] : 'unknown';
  return { state, automatic, ...(checked ? { checked: new Date(checked).toISOString() } : {}),
    ...(lastPull ? { lastPull } : {}), ...(lastPush ? { lastPush } : {}),
    ...(state === 'unavailable' && view.status?.detail ? { detail: view.status.detail } : {}) };
}

/**
 * What an agent's write does first about the book's sync (API-025): `pull` the changes another Mac sent, as a focus
 * would, when the book has changes to fetch and syncs by itself; otherwise nothing, or a `warning` for the reply. A
 * pull is not tried while the scheduler backs off from failures (the remote could not be reached).
 */
export function beforeAgentWrite(state: AgentSyncStateName | undefined, { automatic, allowed, backoff }:
  { automatic: boolean; allowed: boolean; backoff: boolean }): 'pull' | { warning: string } | undefined {
  if (state === 'diverged') return { warning: 'This book changed here and on another Mac, so it does not sync by itself. Ask the user to choose File → Sync → Sync Now, which keeps both versions.' };
  if (state !== 'to-fetch') return undefined;
  if (!automatic) return { warning: fetchWarning + ' Sync automatically is off, so ImageFlow did not take them. Saving now makes the book differ on two Macs; ask the user to sync first (File → Sync → Sync Now).' };
  if (!allowed) return { warning: fetchWarning + ' This book does not sync by itself now, so ImageFlow did not take them. Ask the user to sync first (File → Sync → Sync Now).' };
  if (backoff) return { warning: fetchWarning + ' The remote could not be reached just now; ImageFlow takes them once it can.' };
  return 'pull';
}
const fetchWarning = 'This book has changes to fetch from another Mac.';

/** What the pull before a write did, for its reply. */
export type AgentWriteSync = { pulled?: true; warning?: string };
/** A pull before a write that did not change the book, in words: why the changes are still to be fetched. */
export const notPulledWarning = (reason?: string) => fetchWarning + ' ImageFlow could not take them now' + (reason ? ' (' + reason.replace(/\.$/, '') + ')' : '') + '; it takes them once it can.';

/**
 * Runs an agent's write after the sync step before it (`prior`): a REVISION_CONFLICT after a pull says that the pull
 * moved the book, and the reply carries `sync` (the state now, `pulled`, `warning`) whenever the step did anything.
 */
export async function afterSyncStep<T>(prior: AgentWriteSync | undefined, state: () => AgentSyncState | undefined, write: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await write(); }
  catch (error) {
    if (prior?.pulled && error instanceof AuthoringError && error.code === 'REVISION_CONFLICT') {
      throw new AuthoringError('REVISION_CONFLICT', 'A sync pull just brought changes from another Mac, so the book is at a new revision. Inspect or check it again before editing; nothing was saved.',
        { ...error.details, syncPulled: true });
    }
    throw error;
  }
  if (!prior || (!prior.pulled && !prior.warning) || !result || typeof result !== 'object' || (result as { state?: unknown }).state === 'error') return result;
  return { ...result, sync: { ...state(), ...prior } };
}
