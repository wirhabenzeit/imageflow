import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { afterPullAttempt, afterSyncStep, agentSyncState, beforeAgentWrite, notPulledWarning } from '../desktop/agent-sync';
import type { AgentSyncState } from '../desktop/agent-sync';
import { AuthoringError, createAuthoringService } from '../desktop/authoring-service';
import { checkProject } from '../desktop/check';
import { loadProject } from '../desktop/project';
import { ProjectSession } from '../desktop/project-session';
import type { RenderStatus, SyncStatus, SyncView } from '../src/desktop';
import { mm } from '../src/format';
import { checkedOutput } from './mcp-output-check';
import './persistence-root';

// A book's sync between Macs as agents see it (API-025).

const view = (state: SyncStatus['state'], extra: Partial<SyncView> = {}): SyncView => ({ folder: 'iCloud', status: { state, pendingOriginals: 0 }, ...extra });

test('the sync state follows the app\'s own words, and is left out for a book that does not sync', () => {
  assert.equal(agentSyncState(undefined, { automatic: true }), undefined);
  const states = (['in-sync', 'behind', 'ahead', 'diverged', 'remote-syncing', 'abandoned', 'newer', 'unavailable', 'removed'] as const)
    .map((state) => agentSyncState(view(state), { automatic: true })!.state);
  assert.deepEqual(states, ['in-sync', 'to-fetch', 'to-send', 'diverged', 'arriving', 'interrupted', 'needs-update', 'unavailable', 'removed']);
  assert.equal(agentSyncState(view('behind', { syncing: true }), { automatic: true })!.state, 'syncing');
  assert.equal(agentSyncState({ folder: 'iCloud' }, { automatic: false })!.state, 'unknown');
  const checked = Date.UTC(2026, 10, 27, 9, 30);
  assert.deepEqual(agentSyncState(view('in-sync'), { automatic: false, checked, lastPull: '2026-11-27T09:00:00.000Z' }),
    { state: 'in-sync', automatic: false, checked: '2026-11-27T09:30:00.000Z', lastPull: '2026-11-27T09:00:00.000Z' });
  const offline = view('unavailable');
  offline.status!.detail = 'The Internet connection appears to be offline.';
  assert.equal(agentSyncState(offline, { automatic: true })!.detail, 'The Internet connection appears to be offline.');
});

test('a write to a book with changes to fetch pulls first only when the book syncs by itself; otherwise the reply warns', () => {
  const on = { automatic: true, allowed: true, backoff: false };
  assert.equal(beforeAgentWrite('to-fetch', on), 'pull');
  for (const state of ['in-sync', 'to-send', 'syncing', 'unknown', undefined] as const) assert.equal(beforeAgentWrite(state, on), undefined, state);
  const off = beforeAgentWrite('to-fetch', { automatic: false, allowed: false, backoff: false });
  assert.match((off as { warning: string }).warning, /changes to fetch.*Sync automatically is off/);
  assert.match((beforeAgentWrite('to-fetch', { ...on, allowed: false }) as { warning: string }).warning, /does not sync by itself/);
  assert.match((beforeAgentWrite('to-fetch', { ...on, backoff: true }) as { warning: string }).warning, /could not be reached/);
  assert.match((beforeAgentWrite('diverged', on) as { warning: string }).warning, /Sync Now/);
  assert.equal(notPulledWarning('The book is being edited.'), 'This book has changes to fetch from another Mac. ImageFlow could not take them now (The book is being edited); it takes them once it can.');
});

const state: AgentSyncState = { state: 'in-sync', automatic: true };
test('a pull before a write is judged by what the sync found, not by the status it acted on', () => {
  assert.deepEqual(afterPullAttempt({ action: 'fast-forward', pulled: 'c2', changed: true }), { pulled: true });
  // Taken meanwhile, or only its own changes to send: nothing is left to fetch, and the reply says nothing.
  assert.equal(afterPullAttempt({ action: 'in-sync', changed: false }), undefined);
  assert.equal(afterPullAttempt({ action: 'push', changed: false }), undefined);
  // Changed on both Macs since the status was read: never pulled by itself, so not "once it can".
  assert.match(afterPullAttempt({ action: 'diverged', changed: false })!.warning!, /File → Sync → Sync Now/);
  assert.doesNotMatch(afterPullAttempt({ action: 'diverged', changed: false })!.warning!, /once it can/);
  // Did not run, or deferred: the changes are still to fetch, with the reason where there is one.
  assert.equal(afterPullAttempt(undefined, 'The user is editing.')!.warning, notPulledWarning('The user is editing.'));
  assert.equal(afterPullAttempt({ action: 'deferred', changed: false })!.warning, notPulledWarning());
});

test('after a pull a write planned at the old revision fails with REVISION_CONFLICT that names the pull; a write that commits says what sync did', async () => {
  const conflict = () => Promise.reject(new AuthoringError('REVISION_CONFLICT', 'Inputs changed. Inspect or check the book again before editing.', { currentRevision: 'b'.repeat(64) }));
  await assert.rejects(afterSyncStep({ pulled: true }, () => state, conflict), (error: AuthoringError) =>
    error.code === 'REVISION_CONFLICT' && /sync pull just brought changes from another Mac/.test(error.message) &&
    error.details?.currentRevision === 'b'.repeat(64) && error.details?.syncPulled === true);
  // Without a pull the conflict is the usual one.
  await assert.rejects(afterSyncStep(undefined, () => state, conflict), (error: AuthoringError) => /^Inputs changed/.test(error.message));
  const committed = { state: 'ready', revision: null, committed: true };
  assert.deepEqual(await afterSyncStep({ pulled: true }, () => state, async () => committed), { ...committed, sync: { ...state, pulled: true } });
  assert.deepEqual(await afterSyncStep({ warning: 'Behind.' }, () => ({ ...state, state: 'to-fetch' }), async () => committed),
    { ...committed, sync: { state: 'to-fetch', automatic: true, warning: 'Behind.' } });
  assert.equal(await afterSyncStep(undefined, () => state, async () => committed), committed, 'nothing to say: the reply is unchanged');
  checkedOutput('apply_project_changes', await afterSyncStep({ pulled: true }, () => state, async () => committed));
});

const status: Extract<RenderStatus, { state: 'ready' }> = {
  state: 'ready', pages: 2, units: [], errors: [], warnings: [], flow: {}, anchors: [],
  template: {
    version: '1', parameters: {}, spreads: { main: { label: 'Main', span: 'spread', parameters: {}, boxes: {}, elements: {} } },
    formatId: 'default', formats: { default: 'Default' },
    format: {
      label: 'Sync test', trim: { width: mm(100), height: mm(100) },
      bleed: { top: mm(0), bottom: mm(0), outside: mm(0), binding: mm(0) },
      safe: { top: mm(5), bottom: mm(5), outside: mm(5), binding: mm(5) },
      structure: { delivery: 'pages', ends: 'inside-covers', pageCount: { min: 2, max: 40, step: 2 } },
      output: { container: 'pdf', colorSpace: 'sRGB', transparency: 'allow' },
    },
  },
};
async function open(t: TestContext, sync: () => AgentSyncState | undefined) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'imageflow-agent-sync-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const folder = join(work, 'Book.imageflow');
  const cache = join(work, 'cache');
  await mkdir(join(folder, 'template'), { recursive: true });
  await mkdir(cache);
  await writeFile(join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, title: 'Synced', template: { id: 'test', version: '1' }, spreads: [{ id: 'one', definition: 'main' }] }));
  await writeFile(join(folder, 'photos.json'), '{}');
  await writeFile(join(folder, 'template/index.tsx'), 'export default {};');
  const session = new ProjectSession(await loadProject(folder, cache));
  t.after(() => session.close());
  const service = createAuthoringService({
    session: () => session, cache, docs: resolve('docs'), syncState: sync,
    check: (book, request, signal, index, draft) => checkProject(book, cache, request, async () => ({ status }), signal, index, undefined, draft),
    changed: () => {}, recovery: () => {}, import: async () => assert.fail('No imports in this test.'),
  });
  return (name: string, args: Record<string, unknown> = {}) =>
    service(name, { project: session.handle, ...args }, new AbortController().signal).then((result) => checkedOutput(name, result));
}

test('list_projects and the inspect_book summary report the sync state of a book that syncs, and nothing for one that does not', async (t) => {
  let sync: AgentSyncState | undefined = { state: 'to-fetch', automatic: false, checked: '2026-11-27T09:30:00.000Z' };
  const call = await open(t, () => sync);
  const [listed] = (await call('list_projects')).projects as { sync?: AgentSyncState }[];
  assert.deepEqual(listed.sync, sync);
  assert.deepEqual((await call('inspect_book', { view: 'summary' })).sync, sync);
  assert.equal((await call('inspect_book', { view: 'spreads' })).sync, undefined, 'only the summary');
  sync = undefined;
  assert.equal(((await call('list_projects')).projects as { sync?: unknown }[])[0].sync, undefined);
  assert.equal((await call('inspect_book', { view: 'summary' })).sync, undefined);
});
