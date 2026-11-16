import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSentinel, makeSentinel, parseSentinel, sentinelMatches, sentinelSamples } from '../src/capture-sentinel';
import type { Rgb } from '../src/capture-sentinel';

test('a sentinel round-trips through the render URL and is far apart on every channel', () => {
  for (let i = 0; i < 200; i++) {
    const sentinel = makeSentinel();
    assert.deepEqual(parseSentinel(formatSentinel(sentinel)), sentinel);
    sentinel.first.forEach((value, c) => assert.ok(Math.abs(value - sentinel.second[c]) >= 55));
  }
  assert.equal(parseSentinel('nope'), undefined);
  assert.equal(parseSentinel(null), undefined);
});

test('only the painted strip matches; stale white, grey or page pixels do not', () => {
  const sentinel = makeSentinel(() => 0.1);
  const { first, second } = sentinel;
  assert.ok(sentinelMatches([first, second, first], sentinel));
  // Small colour-management shifts still match.
  const shift = (rgb: Rgb, by: number) => rgb.map((value) => Math.max(0, Math.min(255, value + by))) as unknown as Rgb;
  assert.ok(sentinelMatches([shift(first, 12), shift(second, -10), shift(first, 14)], sentinel));
  const white: Rgb = [255, 255, 255], paper: Rgb = [244, 240, 233], grey: Rgb = [233, 233, 233];
  assert.ok(!sentinelMatches([white, white, white], sentinel));
  assert.ok(!sentinelMatches([paper, paper, paper], sentinel));
  assert.ok(!sentinelMatches([grey, first, grey], sentinel));
  assert.ok(!sentinelMatches([second, first, second], sentinel), 'a swapped pattern is not this capture');
  assert.deepEqual(sentinelSamples(100).map(({ y }) => y), [102, 102, 102]);
});
