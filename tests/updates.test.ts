import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppUpdater } from '../desktop/updates';
import { updateLocationHint, updateUnavailable, moveToApplications } from '../desktop/update-environment';
import type { UpdateState } from '../src/updates';

function fixture(t: { after(callback: () => void): void }, extra: { unavailable?: string; eligibility?: Promise<string | undefined>; interval?: number } = {}) {
  const calls: string[] = [], states: UpdateState[] = [];
  const updater = new AppUpdater({ driver: { initialize: () => { calls.push('initialize'); },
    check: () => { calls.push('check'); }, install: () => { calls.push('install'); } },
    quit: () => { calls.push('quit'); }, changed: (state) => states.push(state), ...extra });
  t.after(() => updater.dispose());
  return { updater, calls, states };
}

test('automatic checks start once, do not overlap a download, and can be disabled without losing manual checks', (t) => {
  const { updater, calls } = fixture(t);
  updater.setAutomatic(false);
  assert.deepEqual(calls, []);
  updater.setAutomatic(true);
  updater.setAutomatic(true);
  updater.check();
  assert.deepEqual(calls, ['initialize']);
  updater.available();
  updater.check();
  assert.equal(updater.state.status, 'downloading');
  assert.deepEqual(calls, ['initialize']);
  updater.current();
  updater.setAutomatic(false);
  updater.check();
  assert.deepEqual(calls, ['initialize', 'check']);
  updater.current();
  updater.setAutomatic(true);
  assert.deepEqual(calls, ['initialize', 'check', 'check']);
});

test('periodic checks stop when the preference is disabled', async (t) => {
  const { updater, calls } = fixture(t, { interval: 10 });
  updater.setAutomatic(true);
  updater.current();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(calls, ['initialize', 'check']); // no overlapping check
  updater.setAutomatic(false);
  updater.current();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(calls, ['initialize', 'check']);
});

test('restart requests ordinary quit; installation waits for cleanup and a cancelled quit can be retried', (t) => {
  const { updater, calls } = fixture(t);
  updater.restart();
  assert.deepEqual(calls, []);
  updater.downloaded('1.0.1');
  updater.restart();
  updater.restart();
  assert.deepEqual(calls, ['quit']);
  updater.cancelRestart();
  assert.equal(updater.finishQuit(), false);
  assert.equal(updater.state.status, 'ready');
  updater.restart();
  assert.deepEqual(calls, ['quit', 'quit']);
  assert.equal(updater.finishQuit(), true);
  assert.deepEqual(calls, ['quit', 'quit', 'install']);
  assert.equal(updater.finishQuit(), false);
});

test('manual errors are recoverable and a downloaded update is retained', (t) => {
  const { updater, calls } = fixture(t);
  updater.check();
  updater.failed(new Error('offline'));
  assert.equal(updater.state.status, 'error');
  assert.match(updater.state.message!, /internet connection/);
  updater.check();
  assert.deepEqual(calls, ['initialize', 'check']);
  updater.current();
  assert.equal(updater.state.status, 'current');
  updater.downloaded('1.0.1');
  updater.failed(new Error('late error'));
  updater.current();
  updater.check();
  assert.deepEqual(updater.state, { status: 'ready', release: '1.0.1' });
  assert.deepEqual(calls, ['initialize', 'check']);
});

test('an ineligible build never initializes or checks a feed', async (t) => {
  const unavailable = await updateUnavailable({ packaged: false, platform: 'darwin', executable: '/unused', downloads: '/unused' });
  const { updater, calls } = fixture(t, { unavailable });
  updater.setAutomatic(true);
  updater.check();
  updater.restart();
  assert.deepEqual(calls, []);
  assert.equal(updater.state.status, 'unavailable');
  assert.equal(await updateUnavailable({ packaged: true, platform: 'linux', executable: '/unused', downloads: '/unused' }), unavailable);
});

test('translocated, disk image and Downloads launches explain how to move the app', () => {
  for (const path of ['/private/var/folders/a/AppTranslocation/a/d/ImageFlow.app', '/Volumes/ImageFlow/ImageFlow.app', '/Users/me/Downloads/ImageFlow.app']) {
    assert.equal(updateLocationHint(path, '/Users/me/Downloads'), moveToApplications);
  }
  assert.equal(updateLocationHint('/Applications/ImageFlow.app', '/Users/me/Downloads'), undefined);
  assert.equal(updateLocationHint('/Users/me/Downloads-backup/ImageFlow.app', '/Users/me/Downloads'), undefined);
  // An Applications folder on an external drive is a real install, not a mounted disk image.
  assert.equal(updateLocationHint('/Volumes/Work/Applications/ImageFlow.app', '/Users/me/Downloads'), undefined);
});

test('eligibility is checked in the background: checks wait for it and never run when it fails', async (t) => {
  let resolve!: (message: string | undefined) => void;
  const { updater, calls, states } = fixture(t, { eligibility: new Promise((done) => { resolve = done; }) });
  updater.setAutomatic(true);
  assert.deepEqual(calls, []);
  assert.equal(updater.state.status, 'idle');
  updater.check();
  assert.equal(updater.state.status, 'checking');
  assert.deepEqual(calls, []);
  resolve(undefined);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls, ['initialize']);
  assert.equal(states.at(-1)?.status, 'checking');

  let reject!: (message: string | undefined) => void;
  const blocked = fixture(t, { eligibility: new Promise((done) => { reject = done; }) });
  blocked.updater.check();
  reject('Move it');
  await new Promise((done) => setImmediate(done));
  blocked.updater.setAutomatic(true);
  blocked.updater.check();
  assert.deepEqual(blocked.calls, []);
  assert.deepEqual(blocked.updater.state, { status: 'unavailable', message: 'Move it' });
});

test('a pending manual check runs once eligibility is known, even with automatic checks off', async (t) => {
  let resolve!: (message: string | undefined) => void;
  const { updater, calls } = fixture(t, { eligibility: new Promise((done) => { resolve = done; }) });
  updater.check();
  resolve(undefined);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(calls, ['initialize']);
});

test('Later dismisses the ready notice everywhere but keeps the restart available', (t) => {
  const { updater, calls } = fixture(t);
  updater.dismiss();
  assert.equal(updater.state.dismissed, undefined);
  updater.downloaded('1.0.1');
  updater.dismiss();
  assert.deepEqual(updater.state, { status: 'ready', release: '1.0.1', dismissed: true });
  updater.restart();
  assert.deepEqual(calls, ['quit']);
});
