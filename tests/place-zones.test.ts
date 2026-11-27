import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetPlaceZones, offsetAtWallTime, withPlaceOffset } from '../desktop/place-zones';

test('the offset of a place at a camera time follows its summer time, also right after a change (API-020)', () => {
  assert.equal(offsetAtWallTime('Asia/Bishkek', '2026-08-26T06:38:32'), '+06:00');
  assert.equal(offsetAtWallTime('Europe/Zurich', '2026-08-26T06:38:32'), '+02:00');
  assert.equal(offsetAtWallTime('Europe/Zurich', '2026-12-26T06:38:32'), '+01:00');
  // Clocks went forward at 02:00 on 29 March: 03:30 that morning is summer time, 01:30 is not.
  assert.equal(offsetAtWallTime('Europe/Zurich', '2026-03-29T03:30:00'), '+02:00');
  assert.equal(offsetAtWallTime('Europe/Zurich', '2026-03-29T01:30:00'), '+01:00');
  assert.equal(offsetAtWallTime('America/St_Johns', '2026-01-10T12:00:00'), '-03:30');
  assert.equal(offsetAtWallTime('UTC', '2026-01-10T12:00:00'), '+00:00');
  // At sea the geocoder names the offset alone.
  assert.equal(offsetAtWallTime('GMT-0200', '2026-01-10T12:00:00'), '-02:00');
  assert.equal(offsetAtWallTime('Not/A_Zone', '2026-01-10T12:00:00'), undefined);
  assert.equal(offsetAtWallTime('Asia/Bishkek', 'yesterday'), undefined);
});

test('facts take the offset of their place only where they have none, and a place without a zone stays without', async () => {
  forgetPlaceZones();
  const facts = { width: 1, height: 1, captured: { dateTime: '2026-08-26T06:38:32', offset: null }, location: { latitude: 40.71, longitude: 75.86 } };
  assert.deepEqual((await withPlaceOffset(facts, async () => 'Asia/Bishkek')).captured, { dateTime: '2026-08-26T06:38:32', offset: '+06:00' });
  const own = { ...facts, captured: { dateTime: '2026-08-26T06:38:32', offset: '+02:00' } };
  assert.equal(await withPlaceOffset(own, async () => { throw new Error('not asked'); }), own);
  const sea = { ...facts, location: { latitude: 0, longitude: -30 } };
  assert.equal(await withPlaceOffset(sea, async () => null), sea);
  assert.equal(await withPlaceOffset(facts, undefined), facts, 'nothing to ask on another platform');
});
