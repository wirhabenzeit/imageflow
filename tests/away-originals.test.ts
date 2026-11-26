import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notInPhotosHere, unreadableHelp, unreadableNotice, unreadablePhotos } from '../src/away-originals';
import type { SourceStatus } from '../src/source-locations';

// What Assets, the Inspector and the status bar say of photos of Apple Photos that this Mac's library does not have (UI-018).

const problems: Partial<Record<SourceStatus['state'], string>> = {
  missing: notInPhotosHere,
  offline: 'Photos can’t download this photo from iCloud now.',
  denied: 'ImageFlow may not read the Photos library. Allow it in System Settings → Privacy & Security → Photos.',
  unreadable: 'This build of ImageFlow cannot read the Photos library.',
};
const status = (id: string, state: SourceStatus['state'], extra: Partial<SourceStatus> = {}) => ({ kind: 'photo', id, key: 'photo:' + id,
  locator: { provider: 'photos', cloud: 'cloud-' + id }, state, problem: problems[state], cached: true, ...extra }) as unknown as SourceStatus;
const book = (...statuses: SourceStatus[]) => Object.fromEntries(statuses.map((one) => [one.key, one]));
const file = { kind: 'photo', id: 'f', key: 'photo:f', locator: { provider: 'linked', path: '/x.jpg' }, state: 'missing', problem: notInPhotosHere } as unknown as SourceStatus;

test('only a photo not in this Mac’s Photos library gets the help of another Mac', () => {
  // Not here, with or without a preview; not one deleted here, offline, denied, available, still loading, or a file.
  const sources = book(status('a', 'missing'), status('b', 'missing', { cached: false }), status('g', 'missing', { problem: 'No longer in the Photos library.' }),
    status('o', 'offline'), status('x', 'denied'), status('d', 'available'), status('e', 'missing', { pending: true }), status('u', 'unreadable'), file);
  assert.deepEqual(unreadablePhotos(sources), ['a', 'b']);
  assert.match(unreadableHelp(sources['photo:a'])!, /same iCloud Photos library.*Settings → Sources and iCloud reachable/);
  for (const id of ['g', 'o', 'x', 'd', 'e', 'u']) assert.equal(unreadableHelp(sources['photo:' + id]), undefined, id);
  assert.equal(unreadableHelp(file), undefined);
});

test('denied and offline photos say what to do in their problem alone', () => {
  // Their problem names the one place to act: no second place to grant access, no other Mac.
  for (const state of ['denied', 'offline'] as const) {
    const one = status('p', state);
    assert.equal(unreadableHelp(one), undefined);
    assert.equal([one.problem, unreadableHelp(one)].filter(Boolean).join(' '), problems[state]);
    assert.doesNotMatch(one.problem!, /another Mac|Settings → Sources/);
  }
});

test('photos not in this Mac’s Photos library are named once a session', () => {
  // The book opens: one notice for all of them.
  const sources = book(status('a', 'missing'), status('b', 'missing'), status('c', 'missing'), status('d', 'available'), status('o', 'offline'), status('x', 'denied'));
  const opened = unreadableNotice(sources, new Set());
  assert.equal(opened.notice, '3 photos from Photos aren’t in this Mac’s Photos library yet. Assets marks them and says why.');
  // A reload, an edit or a sync with the same photos says nothing.
  assert.deepEqual(unreadableNotice(sources, opened.noticed), { noticed: opened.noticed });
  // A sync brings one more: named alone.
  const synced = unreadableNotice(book(status('a', 'missing'), status('b', 'missing'), status('c', 'missing'), status('n', 'missing')), opened.noticed);
  assert.equal(synced.notice, '1 more photo from Photos isn’t in this Mac’s Photos library yet. Assets marks it and says why.');
  // One Photos delivered and that went again, or one whose preview is fetched again, is not named again.
  const delivered = unreadableNotice(book(status('a', 'missing', { pending: true }), status('b', 'available'), status('n', 'missing')), synced.noticed);
  assert.equal(delivered.notice, undefined);
  assert.equal(unreadableNotice(book(status('b', 'missing')), delivered.noticed).notice, undefined);
  assert.equal(unreadableNotice(book(status('d', 'available')), new Set()).notice, undefined);
});

test('access or iCloud dropping out says nothing in the status bar, however many photos it touches', () => {
  // A book of 1,000 photos whose access or iCloud flaps: the badge and the Book check report it, the notice doesn't.
  const ids = Array.from({ length: 1000 }, (_, at) => 'p' + at);
  let noticed: Set<string> = new Set();
  for (const state of ['offline', 'available', 'denied', 'available', 'offline'] as const) {
    const result = unreadableNotice(book(...ids.map((id) => status(id, state))), noticed);
    assert.equal(result.notice, undefined, state);
    noticed = result.noticed;
  }
  assert.equal(noticed.size, 0);
});
