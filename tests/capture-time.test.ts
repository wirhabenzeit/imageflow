import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedCapture, photoDate } from '../desktop/capture-time';

test('the editor photo date is the EXIF capture time as shot, keeping a known offset and leaving an unknown one off', () => {
  assert.deepEqual(photoDate({ captured: { dateTime: '2026-11-02T14:39:50', offset: '+02:00' } }), { captured: '2026-11-02T14:39:50+02:00' });
  assert.deepEqual(photoDate({ captured: { dateTime: '2026-11-02T14:39:50', offset: null } }), { captured: '2026-11-02T14:39:50' });
  // An EXIF capture time wins over a file-time estimate.
  assert.deepEqual(photoDate({ captured: { dateTime: '2026-11-02T14:39:50', offset: null }, estimatedCapture: '2020-01-01T00:00:00.000Z' }),
    { captured: '2026-11-02T14:39:50' });
});
test('photos without an EXIF capture time fall back to an estimate from the file time, marked as estimated', () => {
  const estimate = estimatedCapture(undefined, Date.UTC(2026, 10, 2));
  assert.equal(estimate, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(photoDate({ estimatedCapture: estimate }), { captured: '2026-11-02T00:00:00.000Z', capturedEstimated: true });
  assert.equal(estimatedCapture({ dateTime: '2026-11-02T14:39:50', offset: null }, Date.UTC(2026, 10, 2)), undefined);
  assert.equal(estimatedCapture(undefined, Number.NaN), undefined);
  assert.equal(photoDate({}), undefined);
});
