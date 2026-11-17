import assert from 'node:assert/strict';
import test from 'node:test';
import { frameTimer } from '../src/rendered-image';

// Animation frames delivered by hand: `frames(...times)` runs the callbacks waiting at each time.
function animationFrames() {
  let waiting: ((now: number) => void)[] = [];
  const global = globalThis as unknown as { requestAnimationFrame: (callback: (now: number) => void) => number; cancelAnimationFrame: (id: number) => void };
  global.requestAnimationFrame = (callback) => waiting.push(callback);
  global.cancelAnimationFrame = () => { waiting = []; };
  return (...times: number[]) => {
    for (const now of times) { const run = waiting; waiting = []; for (const callback of run) callback(now); }
  };
}

test('a picture’s drawing time advances only while the window draws frames', () => {
  const frames = animationFrames();
  let expired = 0;
  const start = performance.now();
  frameTimer(() => expired++, 1000);
  // Frames every 100 ms for 0.7 s: not yet.
  frames(...Array.from({ length: 7 }, (_, i) => start + 100 * (i + 1)));
  assert.equal(expired, 0);
  // The window is hidden for ten minutes, so no frames come; when they resume, the gap counts as at most 250 ms.
  frames(start + 600_700);
  assert.equal(expired, 0, 'Time without frames, such as on another Space, is not held against the picture');
  frames(start + 600_800, start + 600_900);
  assert.equal(expired, 1, 'Drawing time that passed while visible expires the picture');
  frames(start + 601_000);
  assert.equal(expired, 1, 'It expires once');
});

test('a stopped drawing timer never expires', () => {
  const frames = animationFrames();
  let expired = false;
  const start = performance.now();
  const stop = frameTimer(() => { expired = true; }, 100);
  frames(start + 50);
  stop();
  frames(start + 200, start + 400);
  assert.equal(expired, false);
});
