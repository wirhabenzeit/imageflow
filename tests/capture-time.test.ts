import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureTime, exifCaptureTime } from '../desktop/capture-time';

function exif(tags: Record<number, string>, little = true) {
  const data = Buffer.alloc(512);
  const u16 = (value: number, at: number) => little ? data.writeUInt16LE(value, at) : data.writeUInt16BE(value, at);
  const u32 = (value: number, at: number) => little ? data.writeUInt32LE(value, at) : data.writeUInt32BE(value, at);
  data.write(little ? 'II' : 'MM'); u16(42, 2); u32(8, 4); u16(1, 8);
  u16(0x8769, 10); u16(4, 12); u32(1, 14); u32(26, 18);
  u16(Object.keys(tags).length, 26);
  let valueAt = 100;
  Object.entries(tags).forEach(([tag, value], i) => {
    const at = 28 + 12 * i; u16(Number(tag), at); u16(2, at + 2); u32(value.length + 1, at + 4); u32(valueAt, at + 8);
    data.write(value + '\0', valueAt, 'ascii'); valueAt += value.length + 1;
  });
  return Buffer.concat([Buffer.from('Exif\0\0'), data]);
}
test('Exif original capture time and offset survive both TIFF byte orders', () => {
  for (const endian of [true, false]) assert.equal(exifCaptureTime(exif({ 0x9003: '2026:11:02 14:39:50', 0x9011: '+02:00' }, endian)), '2026-11-02T14:39:50+02:00');
});
test('digitized time is the fallback, unknown offsets remain unknown, and invalid dates do not normalize silently', () => {
  assert.equal(exifCaptureTime(exif({ 0x9004: '2026:11:03 01:02:03', 0x9012: '-05:00' })), '2026-11-03T01:02:03-05:00');
  assert.equal(exifCaptureTime(exif({ 0x9003: '2026:11:02 14:39:50' })), '2026-11-02T14:39:50');
  assert.equal(exifCaptureTime(exif({ 0x9003: '2026:02:31 14:39:50' })), undefined);
  assert.deepEqual(captureTime(undefined, Date.UTC(2026, 10, 2)), { captured: '2026-11-02T00:00:00.000Z', capturedEstimated: true });
});
test('malformed metadata cannot read outside its buffer or loop over IFD pointers', () => {
  for (let size = 0; size < 80; size++) assert.doesNotThrow(() => exifCaptureTime(Buffer.alloc(size, 0xff)));
  const damaged = exif({ 0x9003: '2026:11:02 14:39:50' });
  damaged.writeUInt32LE(0xfffffff0, 6 + 28 + 8);
  assert.equal(exifCaptureTime(damaged), undefined);
});
