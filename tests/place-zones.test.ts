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

test('after a failed lookup none is asked for a while, so a slow network stalls a load once; an aborted one asks nothing', async () => {
  forgetPlaceZones();
  let clock = 0, asked = 0, online = false;
  const now = () => clock;
  const lookup = async () => { asked++; return online ? 'Asia/Bishkek' : undefined; };
  const facts = (latitude: number) => ({ width: 1, height: 1, captured: { dateTime: '2026-08-26T06:38:32', offset: null }, location: { latitude, longitude: 75.86 } });
  for (const latitude of [40.7, 41.7, 42.7]) assert.equal((await withPlaceOffset(facts(latitude), lookup, { now })).captured?.offset, null);
  assert.equal(asked, 1, 'one failure, then a pause');
  online = true;
  clock += 4 * 60_000;
  assert.equal((await withPlaceOffset(facts(40.7), lookup, { now })).captured?.offset, null);
  assert.equal(asked, 1, 'still paused');
  clock += 2 * 60_000;
  assert.equal((await withPlaceOffset(facts(40.7), lookup, { now })).captured?.offset, '+06:00');
  assert.equal(asked, 2);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await withPlaceOffset(facts(43.7), lookup, { now, signal: aborted.signal })).captured?.offset, null);
  assert.equal(asked, 2, 'nothing asked once aborted');
});
