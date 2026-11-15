import assert from 'node:assert/strict';
import { test } from 'node:test';
import { impureMessage, installPurityGuards, renderingSpread } from '../src/purity';

const script = '/render/view/template/template.js';

function fakeWindow() {
  const log: string[] = [];
  class Canvas { getContext(kind: string) { log.push('context ' + kind); return { kind }; } }
  class Socket { constructor(readonly url: string) { log.push('socket ' + url); } }
  class Request { open(method: string, url: string) { log.push('xhr ' + method + ' ' + url); } }
  return {
    log,
    target: {
      fetch: (url: string) => { log.push('fetch ' + url); return 'response'; },
      setTimeout: (callback: () => void) => { log.push('timeout'); return 1; },
      WebSocket: Socket, HTMLCanvasElement: Canvas, XMLHttpRequest: Request,
    } as Record<string, unknown>,
  };
}

test('records impure calls from template code, located at the rendering spread, and still performs them', () => {
  const { log, target } = fakeWindow();
  let stack = 'at render (http://render/render/view/template/template.js:1:2)';
  const guards = installPurityGuards(target, script, () => stack);
  renderingSpread('s1');
  assert.equal((target.fetch as (url: string) => string)('https://tiles.example/1.pbf'), 'response');
  const socket = new (target.WebSocket as new (url: string) => { url: string })('wss://x');
  assert.equal(socket.url, 'wss://x');
  const canvas = new (target.HTMLCanvasElement as new () => { getContext(kind: string): unknown })();
  canvas.getContext('2d');
  canvas.getContext('webgl2');
  new (target.XMLHttpRequest as new () => { open(m: string, u: string): void })().open('GET', '/x');
  renderingSpread(undefined);
  (target.setTimeout as (callback: () => void) => number)(() => {});
  // Repeated calls on the same spread report once.
  renderingSpread('s1');
  (target.fetch as (url: string) => string)('again');
  renderingSpread(undefined);
  // The app's own calls are not template code.
  stack = 'at load (http://render/assets/render.js:3:4)';
  (target.fetch as (url: string) => string)('app');
  assert.deepEqual(guards.calls, [
    { api: 'fetch', spread: 's1' }, { api: 'WebSocket', spread: 's1' },
    { api: 'HTMLCanvasElement.getContext(\'webgl2\')', spread: 's1' }, { api: 'XMLHttpRequest', spread: 's1' },
    { api: 'setTimeout' },
  ]);
  assert.deepEqual(log, ['fetch https://tiles.example/1.pbf', 'socket wss://x', 'context 2d', 'context webgl2', 'xhr GET /x', 'timeout',
    'fetch again', 'fetch app']);
});

test('messages name what kind of impurity a call is', () => {
  assert.match(impureMessage('fetch'), /requests data/);
  assert.match(impureMessage('Worker'), /starts a worker/);
  assert.match(impureMessage('OffscreenCanvas.getContext(\'webgl\')'), /GPU/);
  assert.match(impureMessage('requestAnimationFrame'), /schedules work/);
});

test('declared asynchronous rendering may use timers, the GPU and the network while it runs', () => {
  const { log, target } = fakeWindow();
  let drawing = true;
  const guards = installPurityGuards(target, script, () => 'at draw (http://render/render/view/template/template.js:3:4)', () => drawing);
  (target.fetch as (url: string) => string)('https://tiles.example/2.pbf');
  new (target.HTMLCanvasElement as new () => { getContext(kind: string): unknown })().getContext('webgl2');
  assert.deepEqual(guards.calls, [], 'calls while a picture is drawn are not impure');
  drawing = false;
  (target.setTimeout as (callback: () => void) => number)(() => {});
  assert.deepEqual(guards.calls.map(({ api }) => api), ['setTimeout']);
  assert.deepEqual(log, ['fetch https://tiles.example/2.pbf', 'context webgl2', 'timeout']);
});

test('work a drawing starts stays declared after the drawing returns: its timers, frames and request continuations', async () => {
  const queue: (() => void)[] = [];
  const later = (callback: () => void) => { queue.push(callback); return queue.length; };
  const run = () => { while (queue.length) queue.shift()!(); };
  const microtasks = () => new Promise<void>((resolve) => setImmediate(resolve));
  let settle = () => {};
  const target: Record<string, unknown> = {
    setTimeout: later, requestAnimationFrame: later,
    fetch: () => new Promise<void>((resolve) => { settle = resolve; }),
  };
  let drawing = true;
  const guards = installPurityGuards(target, script, () => 'at draw (http://render/render/view/template/template.js:3:4)', () => drawing);
  const fetch = target.fetch as (url: string) => Promise<void>;
  const timeout = target.setTimeout as (callback: () => void) => number;
  const frame = target.requestAnimationFrame as (callback: () => void) => number;
  // A library starts a session request and a repaint loop while drawing; both continue after draw has resolved.
  void fetch('https://api.example/session').then(() => fetch('https://events.example/telemetry'));
  frame(() => frame(() => timeout(() => {})));
  drawing = false;
  queue.shift()!();
  queue.shift()!();
  settle();
  await microtasks();
  assert.deepEqual(guards.calls, [], 'background work started by a drawing is declared');
  // Once that work has settled, the exemption ends with it.
  run();
  settle();
  await microtasks();
  run();
  void fetch('https://elsewhere.example/');
  assert.deepEqual(guards.calls.map(({ api }) => api), ['fetch']);
});

test('calls outside any render are described as such', () => {
  assert.match(impureMessage('fetch', false), /outside any layout render and any <RenderedImage> drawing/);
  assert.doesNotMatch(impureMessage('fetch'), /outside/);
});
