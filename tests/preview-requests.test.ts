import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreviewFetches, PreviewRequests } from '../desktop/preview-requests';

const a = { id: 'a', key: 'k1' }, b = { id: 'b', key: 'k1' };

test('a preview is asked for once per content, and again once it was had', () => {
  const requests = new PreviewRequests();
  assert.equal(requests.want([a, b]), true);
  assert.deepEqual(requests.take(), ['a', 'b']);
  assert.equal(requests.want([a, b]), false, 'being fetched');
  requests.settled('a');
  requests.settled('b', { state: 'available', problem: 'Edited.' });
  assert.equal(requests.want([b]), false, 'its source has none of this content');
  assert.equal(requests.problem(b), 'Edited.');
  assert.equal(requests.problem({ id: 'b', key: 'k2' }), undefined);
  requests.want([a, { id: 'b', key: 'k2' }]);
  assert.deepEqual(requests.take(), ['a', 'b'], 'one whose preview was lost, and one of other content');
});

test('a request nothing is heard of never stays open: it fails with why, or is asked for again', () => {
  const requests = new PreviewRequests();
  const failures = new Map([['a', { state: 'unreadable' as const, problem: 'Lightroom did not answer in time.' }], ['b', { state: 'offline' as const, problem: 'Not running.' }]]);
  const gone = { id: 'gone', key: 'k1' };
  requests.want([a, b, gone]);
  requests.finish(requests.take(), (id) => failures.get(id));
  assert.equal(requests.problem(a), 'Lightroom did not answer in time.', 'says why instead of loading for ever');
  assert.equal(requests.want([a]), false);
  // Offline: whether it still is, the next load observes. No longer in the book (an import undone): a redo asks again.
  assert.equal(requests.problem(b), undefined);
  requests.want([b, gone]);
  assert.deepEqual(requests.take(), ['b', 'gone']);
  // What was settled keeps how it was settled.
  requests.settled('b', { state: 'missing', problem: 'Gone.' });
  requests.finish(['b'], () => ({ state: 'unreadable', problem: 'Another.' }));
  assert.equal(requests.problem(b), 'Gone.');
  requests.clear();
  assert.equal(requests.want([a, b]), true);
});

test('what comes for earlier content does not settle the request for newer content', () => {
  const requests = new PreviewRequests();
  requests.want([a]);
  requests.take();
  requests.want([{ id: 'a', key: 'k2' }]);
  requests.settled('a', { state: 'available', problem: 'Edited.' });
  assert.deepEqual(requests.take(), ['a']);
  assert.equal(requests.problem({ id: 'a', key: 'k2' }), undefined);
});

test('the previews being fetched are counted over all fetches, and the count goes once none are', () => {
  const seen: ({ done: number; total: number } | null)[] = [];
  const fetches = new PreviewFetches((progress) => seen.push(progress), 0);
  const first = fetches.start(10);
  first.progress(4, 10);
  // A report of changes does not know yet whether it asks for any preview.
  const second = fetches.start();
  second.progress(1, 2);
  first.end();
  second.end();
  assert.deepEqual(seen, [{ done: 0, total: 10 }, { done: 4, total: 10 }, { done: 5, total: 12 }, { done: 1, total: 2 }, null]);
  seen.length = 0;
  const quiet = fetches.start();
  quiet.end();
  assert.deepEqual(seen, [], 'one that asked for none says nothing');
});

test('a fetch reports now and then, but always its start and its end', () => {
  const seen: ({ done: number; total: number } | null)[] = [];
  const fetches = new PreviewFetches((progress) => seen.push(progress), 60_000);
  const fetch = fetches.start(3);
  for (const done of [1, 2, 3]) fetch.progress(done, 3);
  fetch.end();
  fetch.end();
  assert.deepEqual(seen, [{ done: 0, total: 3 }, null]);
});
