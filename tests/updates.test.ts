import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppUpdater } from '../desktop/updates';
import { updateLocationHint, updateUnavailable, moveToApplications } from '../desktop/update-environment';
import type { UpdateState } from '../src/updates';

function fixture(t: { after(callback: () => void): void }, extra: { unavailable?: string; interval?: number; pending?: boolean } = {}) {
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

test('translocated and Downloads launches explain how to move the app; external drives are allowed', () => {
  for (const path of ['/private/var/folders/a/AppTranslocation/a/d/ImageFlow.app', '/Users/me/Downloads/ImageFlow.app']) {
    assert.equal(updateLocationHint(path, '/Users/me/Downloads'), moveToApplications);
  }
  assert.equal(updateLocationHint('/Volumes/My Drive/Apps/ImageFlow.app', '/Users/me/Downloads'), undefined);
  assert.equal(updateLocationHint('/Applications/ImageFlow.app', '/Users/me/Downloads'), undefined);
  assert.equal(updateLocationHint('/Users/me/Downloads-backup/ImageFlow.app', '/Users/me/Downloads'), undefined);
});

test('pending eligibility defers launch/manual checks and honours the latest automatic preference', (t) => {
  const { updater, calls } = fixture(t, { pending: true });
  updater.setAutomatic(true);
  updater.setAutomatic(false);
  assert.equal(updater.state.status, 'initializing');
  assert.deepEqual(calls, []);
  updater.setEligibility();
  assert.deepEqual(calls, []);
  updater.check();
  assert.deepEqual(calls, ['initialize']);
});

test('a manual check during eligibility waits and unavailable builds never start a check', (t) => {
  const good = fixture(t, { pending: true });
  good.updater.check();
  good.updater.setEligibility();
  assert.deepEqual(good.calls, ['initialize']);
  const bad = fixture(t, { pending: true });
  bad.updater.setAutomatic(true);
  bad.updater.check();
  bad.updater.setEligibility('No signed build');
  assert.deepEqual(bad.calls, []);
  assert.equal(bad.updater.state.status, 'unavailable');
});

test('Later dismisses notices for the whole app while preserving the restart action', (t) => {
  const { updater, calls } = fixture(t);
  updater.downloaded('1.0.1');
  updater.dismissNotice();
  assert.equal(updater.state.dismissed, true);
  assert.equal(updater.state.status, 'ready');
  updater.restart();
  assert.deepEqual(calls, ['quit']);
  updater.cancelRestart();
  updater.downloaded('1.0.2');
  assert.equal(updater.state.dismissed, undefined);
});


test('asynchronous feed failures leave checking state and allow a manual retry', async (t) => {
  let calls = 0;
  const updater = new AppUpdater({ driver: { initialize: async () => { throw new Error('offline feed'); },
    check: async () => { calls++; updater.current(); }, install: () => {} }, quit: () => {}, changed: () => {} });
  t.after(() => updater.dispose());
  updater.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.state.status, 'error');
  updater.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(updater.state.status, 'current');
});
