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
