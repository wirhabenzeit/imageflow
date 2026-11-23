import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoSync, autoSyncTiming, cloudKitPush } from '../desktop/sync-auto';
import type { AutoFailure, AutoLook, AutoSyncHost, AutoSyncTiming } from '../desktop/sync-auto';

// The scheduler of automatic sync (#284) with a host that records what it is asked, and times in milliseconds.
const timing: AutoSyncTiming = { idle: 30, gate: 10, notified: 5, backoff: (failures) => 40 * failures };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Host implements AutoSyncHost {
  calls: string[] = [];
  isAllowed = true;
  blocking: string | undefined;
  looks: (AutoLook | Error)[] = [];
  isEdited = true;
  results: ('deferred' | 'stop' | Error | void)[] = [];
  starts: (Error | void)[] = [];
  uploads: (Error | void)[] = [];
  async allowed() { return this.isAllowed; }
  blocked() { return this.blocking; }
  async start() {
    this.calls.push('start');
    const next = this.starts.shift();
    if (next instanceof Error) throw next;
  }
  async look() {
    this.calls.push('look');
    const next = this.looks.shift() ?? 'none';
    if (next instanceof Error) throw next;
    return next;
  }
  async edited() { return this.isEdited; }
  async sync({ pushOnly, signal }: { pushOnly: boolean; signal: AbortSignal }) {
    this.calls.push(pushOnly ? 'push-only' : 'sync');
    this.signal = signal;
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next;
  }
  signal?: AbortSignal;
  failure(error: unknown): AutoFailure {
    const kind = (error as { kind?: AutoFailure }).kind;
    return kind ?? 'retry';
  }
  async upload() {
    this.calls.push('upload');
    const next = this.uploads.shift();
    if (next instanceof Error) throw next;
  }
}
const failing = (kind?: AutoFailure) => Object.assign(new Error('offline'), kind ? { kind } : {});

test('a focus that finds nothing to do reads the status once and does not sync; one that finds a fast-forward pulls', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  auto.focused();
  await auto.settled();
  assert.deepEqual(host.calls, ['look']);
  host.looks.push('pull');
  auto.focused();
  await auto.settled();
  assert.deepEqual(host.calls, ['look', 'look', 'sync']);
  // A book that may not sync by itself (stopped, untrusted, excluded, the preference off) is not even looked at.
  host.isAllowed = false;
  auto.focused();
  await auto.settled();
  assert.deepEqual(host.calls, ['look', 'look', 'sync']);
});

test('a pull waits while the book is being edited, without a request, and runs once nothing blocks it; a push goes ahead without changing the book', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  host.blocking = 'A text of the book is open in its editor.';
  host.looks.push('pull');
  auto.focused();
  await auto.settled();
  assert.deepEqual(host.calls, ['look']);
  assert.equal(auto.state.waitingForGate, true);
  await wait(50);
  assert.deepEqual(host.calls, ['look'], 'still blocked: nothing is asked of the remote');
  // Changes of this Mac go up meanwhile, without a pull.
  host.looks.push('push');
  auto.focused();
  await auto.settled();
  assert.deepEqual(host.calls, ['look', 'look', 'push-only']);
  host.blocking = undefined;
  await wait(30);
  await auto.settled();
  assert.deepEqual(host.calls, ['look', 'look', 'push-only', 'sync'], 'the pull runs once the editor closed, with no second look');
  assert.equal(auto.state.waitingForGate, false);
  // A sync that found it would have to change the book after all waits again.
  host.results.push('deferred');
  host.looks.push('push');
  host.blocking = 'The book is being edited.';
  auto.focused();
  await auto.settled();
  assert.equal(auto.state.waitingForGate, true);
});

test('a save pushes once the book was idle, only when it changed since its last sync, and each save starts the wait again', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  auto.saved();
  await wait(15);
  auto.saved();
  await wait(20);
  assert.deepEqual(host.calls, [], 'not yet idle');
  await wait(30);
  await auto.settled();
  assert.deepEqual(host.calls, ['sync'], 'one push for both saves, without a look');
  host.isEdited = false;
  auto.saved();
  await wait(50);
  await auto.settled();
  assert.deepEqual(host.calls, ['sync'], 'a revision a pull brought is no edit: no request');
});

test('failures back off from 30 s up to 15 min; every trigger waits, and a network change or Sync Now ends the wait', async (t) => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(autoSyncTiming.backoff), [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  host.looks.push(failing(), failing());
  auto.focused();
  await auto.settled();
  assert.equal(auto.state.failures, 1);
  // A focus during the backoff waits for it: nothing is sent to a remote that cannot be reached.
  auto.focused();
  await auto.settled();
  assert.deepEqual(host.calls, ['look']);
  await wait(60);
  await auto.settled();
  assert.deepEqual(host.calls, ['look', 'look'], 'tried again once the backoff ended');
  assert.equal(auto.state.failures, 2);
  // The network changed: what waits runs now.
  host.looks.push('pull');
  auto.networkChanged();
  await auto.settled();
  assert.deepEqual(host.calls, ['look', 'look', 'look', 'sync']);
  assert.equal(auto.state.failures, 0);
  // Sync Now ends a backoff too.
  host.looks.push(failing());
  auto.focused();
  await auto.settled();
  assert.ok(auto.state.backoffUntil > Date.now());
  auto.reset();
  assert.equal(auto.state.backoffUntil, 0);
});

test('a full remote is no failure to back off from and is not tried again by itself; a busy book is tried again soon', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  host.results.push(failing('full'));
  auto.saved();
  await wait(50);
  await auto.settled();
  await wait(100);
  assert.deepEqual(host.calls, ['sync']);
  assert.equal(auto.state.failures, 0);
  assert.equal(auto.state.wanted, undefined);
  host.results.push(failing('later'));
  auto.saved();
  await wait(70);
  await auto.settled();
  assert.deepEqual(host.calls, ['sync', 'sync', 'sync'], 'the busy book was tried again after a moment, without backoff');
  assert.equal(auto.state.failures, 0);
});

test('a book deleted from sync stops the scheduler until Sync Now, and is no repeating failure', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  // The status looked normal (a bucket does not see a tombstone over commits pushed after the deletion); the sync refuses.
  host.looks.push('push');
  host.results.push(failing('stop'));
  auto.focused();
  await auto.settled();
  assert.equal(auto.state.stopped, 'removed');
  assert.equal(auto.state.failures, 0);
  auto.focused(); auto.saved(); auto.notified();
  await wait(60);
  await auto.settled();
  assert.deepEqual(host.calls, ['look', 'sync'], 'nothing more is asked or pushed');
  // A status that says so stops it as well.
  auto.reset();
  host.looks.push('stop');
  auto.focused();
  await auto.settled();
  assert.equal(auto.state.stopped, 'removed');
});

test('the first sync at open is tried again with the backoff when the remote cannot be reached', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  host.starts.push(failing());
  auto.opened();
  await auto.settled();
  assert.deepEqual(host.calls, ['start']);
  await wait(60);
  await auto.settled();
  assert.deepEqual(host.calls, ['start', 'start', 'look'], 'the first sync again, then a look at the remote');
});

test('a failed upload of originals is tried again with a backoff of its own, and closing aborts a sync that runs', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  host.uploads.push(failing());
  auto.uploadFailed();
  await wait(50);
  assert.deepEqual(host.calls, ['upload']);
  assert.equal(auto.state.uploadFailures, 2, 'it failed again and waits longer');
  auto.networkChanged();
  await wait(10);
  assert.deepEqual(host.calls, ['upload', 'upload']);
  assert.equal(auto.state.uploadFailures, 0);
  // A sync that waits for the remote is aborted when the book closes.
  let release = () => {};
  host.sync = async ({ signal }) => { host.calls.push('sync'); host.signal = signal; await new Promise<void>((resolve) => { release = resolve; }); };
  host.looks.push('pull');
  auto.focused();
  await wait(5);
  const closed = auto.close();
  assert.equal(host.signal?.aborted, true);
  release();
  await closed;
  assert.equal(auto.state.stopped, 'closed');
  auto.reset();
  assert.equal(auto.state.stopped, 'closed', 'a closed scheduler stays closed');
  t.after(() => auto.close());
});

test('several pushes from iCloud at once make one look, and only CloudKit’s pushes count', async (t) => {
  const host = new Host();
  const auto = new AutoSync(host, timing);
  t.after(() => auto.close());
  auto.notified(); auto.notified(); auto.notified();
  await wait(20);
  await auto.settled();
  assert.deepEqual(host.calls, ['look']);
  assert.equal(cloudKitPush({ ck: { ce: 2, cid: 'iCloud.ch.wirhabenzeit.imageflow', met: { dbs: 1, sid: 'books' } }, aps: { 'content-available': 1 } }), true);
  assert.equal(cloudKitPush({ aps: { alert: 'Hello' } }), false);
  assert.equal(cloudKitPush(undefined), false);
});

test('Sync automatically is an ordinary preference a window may change, beside the guard that keeps the backend to Settings → Sync', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SettingsStore } = await import('../desktop/settings');
  const { syncPatchError } = await import('../desktop/sync-settings');
  const folder = await mkdtemp(join(tmpdir(), 'if-auto-settings-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const store = new SettingsStore(join(folder, 'settings.json'));
  assert.equal(store.value.syncAutomatically, undefined, 'on unless turned off');
  assert.equal(syncPatchError({ syncAutomatically: false }), undefined);
  assert.equal((await store.update({ syncAutomatically: false })).syncAutomatically, false);
  assert.equal((await store.update({ syncAutomatically: true })).syncAutomatically, undefined);
  await assert.rejects(store.update({ syncAutomatically: 'yes' } as never), /automatic sync/);
  // The guard is unchanged: a window still cannot set a backend, the books to choose or the downloads folder with it.
  assert.match(syncPatchError({ syncAutomatically: true, sync: { kind: 'icloud' } })!, /Settings → Sync/);
  assert.match(syncPatchError({ syncAutomatically: true, syncBooksUnchosen: true })!, /Settings → Sync/);
  assert.match(syncPatchError({ syncAutomatically: true, booksFolder: '/tmp' })!, /Settings → Sync/);
});
