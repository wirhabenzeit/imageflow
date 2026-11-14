export type CaptureTime = { captured: string; capturedEstimated?: boolean };

// CIPA Exif DC-008: DateTimeOriginal (9003), DateTimeDigitized (9004), and their UTC offsets (9011/9012).
// Sharp already extracts the Exif block. Read just these ASCII tags, with bounded offsets and IFD counts.
// https://www.cipa.jp/std/documents/e/CIPA_DC-X008-Translation-2016-E.pdf
export function exifCaptureTime(exif?: Buffer): string | undefined {
  if (!exif) return;
  try {
    const base = exif.subarray(0, 6).toString('ascii') === 'Exif\0\0' ? 6 : 0;
    const data = exif.subarray(base);
    const order = data.subarray(0, 2).toString('ascii');
    if (order !== 'II' && order !== 'MM') return;
    const u16 = (at: number) => order === 'II' ? data.readUInt16LE(at) : data.readUInt16BE(at);
    const u32 = (at: number) => order === 'II' ? data.readUInt32LE(at) : data.readUInt32BE(at);
    if (u16(2) !== 42) return;
    const tags = new Map<number, string>();
    const visited = new Set<number>();
    function read(offset: number, nested = false) {
      if (visited.has(offset) || offset < 8 || offset + 2 > data.length) return;
      visited.add(offset);
      const count = u16(offset);
      if (count > 4096 || offset + 2 + count * 12 > data.length) return;
      let child: number | undefined;
      for (let i = 0; i < count; i++) {
        const at = offset + 2 + i * 12, tag = u16(at), type = u16(at + 2), size = u32(at + 4);
        if (!nested && tag === 0x8769 && type === 4 && size === 1) child = u32(at + 8);
        if (![0x9003, 0x9004, 0x9011, 0x9012].includes(tag) || type !== 2 || size < 1 || size > 64) continue;
        const start = size <= 4 ? at + 8 : u32(at + 8);
        if (start + size <= data.length) tags.set(tag, data.subarray(start, start + size).toString('ascii').replace(/\0.*$/, '').trim());
      }
      if (child !== undefined) read(child, true);
    }
    read(u32(4));
    for (const [date, zone] of [[0x9003, 0x9011], [0x9004, 0x9012]]) {
      const value = tags.get(date);
      const match = value && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
      if (!match) continue;
      const local = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
      const valid = new Date(local + 'Z');
      if (!Number.isFinite(valid.valueOf()) || valid.toISOString().slice(0, 19) !== local) continue;
      const offset = tags.get(zone);
      // A missing offset is unknown, not the computer's timezone. Keep the camera's wall time intact.
      return local + (offset && /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(offset) ? offset : '');
    }
  } catch { /* Broken optional metadata must not prevent importing an otherwise readable photo. */ }
}
export function captureTime(exif: Buffer | undefined, mtime: number): CaptureTime {
  const captured = exifCaptureTime(exif);
  return captured ? { captured } : { captured: new Date(mtime).toISOString(), capturedEstimated: true };
}
