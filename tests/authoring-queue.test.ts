import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthoringQueue, isAuthoringCancellation } from '../desktop/authoring-queue';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('simultaneous agent calls execute in FIFO order with one running task', async (t) => {
  const queue = new AuthoringQueue({ ready: () => true });
  t.after(() => queue.close());
  const first = deferred();
  const events: string[] = [];
  let running = 0;
  const run = (id: number) => queue.run(async () => {
    assert.equal(running++, 0);
    events.push('start ' + id);
    if (id === 1) await first.promise;
    events.push('finish ' + id);
    running--;
    return id;
  });
  const calls = [run(1), run(2), run(3)];
  assert.deepEqual(events, ['start 1']);
  first.resolve();
  assert.deepEqual(await Promise.all(calls), [1, 2, 3]);
  assert.deepEqual(events, ['start 1', 'finish 1', 'start 2', 'finish 2', 'start 3', 'finish 3']);
  await queue.whenIdle();
  queue.close();
});

test('calls wait for UI work to finish and cancel while waiting without executing', async (t) => {
  let busy = true;
  const queue = new AuthoringQueue({ ready: () => !busy, pollMs: 2 });
  t.after(() => queue.close());
  const controller = new AbortController();
  const reason = new Error('Cancelled while waiting');
  const events: string[] = [];
  const cancelled = assert.rejects(queue.run(() => { events.push('cancelled'); }, controller.signal), (error) => error === reason);
  const next = queue.run(() => { events.push('next'); return 'ready'; });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  await delay(5);
  assert.deepEqual(events, []);
  controller.abort(reason);
  await cancelled;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  busy = false;
  assert.equal(await next, 'ready');
  assert.deepEqual(events, ['next']);
  queue.close();
});

test('cancelling a running task keeps its slot and preserves unrelated failures', async (t) => {
  const queue = new AuthoringQueue({ ready: () => true });
  t.after(() => queue.close());
  const controller = new AbortController();
  const blocked = deferred();
  const started = deferred<AbortSignal>();
  const original = Object.assign(new Error('Template failed'), { code: 'template-compile-error', diagnostics: [{ line: 3 }] });
  const events: string[] = [];
  const first = queue.run(async (signal) => {
    events.push('first');
    started.resolve(signal);
    await blocked.promise;
    throw original;
  }, controller.signal);
  const failure = assert.rejects(first, (error) => error === original);
  const next = queue.run(() => { events.push('next'); });
  const runSignal = await started.promise;
  const reason = new Error('Cancellation arrived');
  controller.abort(reason);
  assert.equal(runSignal.reason, reason);
  assert.equal(isAuthoringCancellation(original, runSignal), false);
  assert.deepEqual(events, ['first']);
  blocked.resolve();
  await failure;
  await next;
  assert.deepEqual(events, ['first', 'next']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  queue.close();
});

test('task rejection leaves later calls usable, and aborted submissions never run', async (t) => {
  const queue = new AuthoringQueue({ ready: () => true });
  t.after(() => queue.close());
  const error = new Error('One failed operation');
  const rejected = assert.rejects(queue.run(() => { throw error; }), (reason) => reason === error);
  let attempted = false;
  const controller = new AbortController();
  controller.abort(error);
  await assert.rejects(queue.run(() => { attempted = true; }, controller.signal), (reason) => reason === error);
  assert.equal(await queue.run(() => 7), 7);
  await rejected;
  assert.equal(attempted, false);
  queue.close();
});

test('revocation drops queued calls and waits for running work to settle before idle', async (t) => {
  const queue = new AuthoringQueue({ ready: () => true });
  t.after(() => queue.close());
  const blocked = deferred<string>();
  const controller = new AbortController();
  const reason = new Error('Connection revoked');
  let activeSignal: AbortSignal | undefined;
  let queuedRan = false;
  const active = queue.run((signal) => { activeSignal = signal; return blocked.promise; });
  const pending = assert.rejects(queue.run(() => { queuedRan = true; }, controller.signal), (error) => error === reason);
  let idle = false;
  const settled = queue.whenIdle().then(() => { idle = true; });
  queue.close(reason);
  queue.close(new Error('Second close'));
  await pending;
  assert.equal(activeSignal?.reason, reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(queuedRan, false);
  assert.equal(idle, false);
  await assert.rejects(queue.run(() => 'later'), (error) => error === reason);
  blocked.resolve('committed result');
  assert.equal(await active, 'committed result');
  await settled;
  assert.equal(idle, true);
});

test('a full waiting queue rejects overflow and a cancelled entry releases capacity', async (t) => {
  const queue = new AuthoringQueue({ ready: () => false, maxPending: 2 });
  t.after(() => queue.close());
  const controller = new AbortController();
  const first = assert.rejects(queue.run(() => {}, controller.signal));
  const second = assert.rejects(queue.run(() => {}), { code: 'AUTHORING_QUEUE_CLOSED' });
  await assert.rejects(queue.run(() => {}), { code: 'AUTHORING_QUEUE_FULL' });
  controller.abort();
  await first;
  const replacement = assert.rejects(queue.run(() => {}), { code: 'AUTHORING_QUEUE_CLOSED' });
  queue.close();
  await Promise.all([second, replacement, queue.whenIdle()]);
});

test('readiness failures reject the waiting operation and leave the queue usable', async (t) => {
  const error = new Error('Window lookup failed');
  let fail = true;
  const queue = new AuthoringQueue({ ready: () => { if (fail) throw error; return true; } });
  t.after(() => queue.close());
  await assert.rejects(queue.run(() => 'skipped'), (reason) => reason === error);
  fail = false;
  assert.equal(await queue.run(() => 'recovered'), 'recovered');
  await queue.whenIdle();
  queue.close();
});

test('cancellation mapping matches the abort reason or its Node AbortError wrapper only', () => {
  const controller = new AbortController();
  const cancellation = new Error('Stop this request');
  assert.equal(isAuthoringCancellation(cancellation, controller.signal), false);
  controller.abort(cancellation);
  assert.equal(isAuthoringCancellation(cancellation, controller.signal), true);
  const wrapped = new Error('The operation was aborted', { cause: cancellation });
  wrapped.name = 'AbortError';
  assert.equal(isAuthoringCancellation(wrapped, controller.signal), true);
  const unrelated = new Error('Different abort source');
  unrelated.name = 'AbortError';
  assert.equal(isAuthoringCancellation(unrelated, controller.signal), false);
  assert.equal(isAuthoringCancellation(new Error('Compile failed'), controller.signal), false);
});
