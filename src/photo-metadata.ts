// Capture metadata read from a photo's EXIF block: when it was taken, where, and with which camera. Every field is
// optional and normalized; anything missing, stripped or malformed is left out rather than guessed, and a photo always
// imports and renders without it. The raw EXIF block never reaches templates.

/**
 * `dateTime` is the camera's local wall-clock time, `YYYY-MM-DDTHH:mm:ss`. `offset` is its UTC offset, such as
 * `+02:00`, or null when the photo does not record one: the time zone is then unknown, not UTC.
 */
export type CaptureTime = { dateTime: string; offset: string | null };
/** WGS 84 degrees: latitude −90 (south) to 90 (north), longitude −180 (west) to 180 (east). */
export type CaptureLocation = { latitude: number; longitude: number };
export type CaptureCamera = { make?: string; model?: string };
export type CaptureMetadata = { captured?: CaptureTime; location?: CaptureLocation; camera?: CaptureCamera };
export const captureFields = ['captured', 'location', 'camera'] as const;

type Entry = { type: number; count: number; at: number };
const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// Reads one IFD of a TIFF structure as tag → entry, with every offset checked against the buffer.
function readIfd(view: DataView, little: boolean, tiff: number, offset: number): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  const start = tiff + offset;
  if (offset <= 0 || start + 2 > view.byteLength) return entries;
  const count = view.getUint16(start, little);
  if (count > 1000 || start + 2 + count * 12 > view.byteLength) return entries;
  for (let i = 0; i < count; i++) {
    const at = start + 2 + i * 12;
    const tag = view.getUint16(at, little);
    const type = view.getUint16(at + 2, little);
    const items = view.getUint32(at + 4, little);
    const size = sizes[type];
    if (!size || items > 65536) continue;
    const bytes = size * items;
    const value = bytes <= 4 ? at + 8 : tiff + view.getUint32(at + 8, little);
    if (value + bytes > view.byteLength) continue;
    entries.set(tag, { type, count: items, at: value });
  }
  return entries;
}

const ascii = (view: DataView, entry: Entry | undefined) => {
  if (!entry || (entry.type !== 2 && entry.type !== 7)) return undefined;
  let text = '';
  for (let i = 0; i < entry.count; i++) {
    const code = view.getUint8(entry.at + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
};
const rationals = (view: DataView, little: boolean, entry: Entry | undefined) => {
  if (!entry || entry.type !== 5) return undefined;
  return Array.from({ length: entry.count }, (_, i) => {
    const denominator = view.getUint32(entry.at + i * 8 + 4, little);
    return denominator ? view.getUint32(entry.at + i * 8, little) / denominator : NaN;
  });
};
const pointer = (view: DataView, little: boolean, entry: Entry | undefined) =>
  entry && (entry.type === 4 || entry.type === 13) && entry.count === 1 ? view.getUint32(entry.at, little) : 0;

const pad = (value: number) => String(value).padStart(2, '0');
// `YYYY:MM:DD HH:MM:SS`, the EXIF form, to `YYYY-MM-DDTHH:mm:ss`. Placeholder values such as `0000:00:00 00:00:00`,
// blanks and impossible dates are rejected.
export function exifDateTime(text: string | undefined) {
  const match = text?.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1800 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return undefined;
  return year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hour) + ':' + pad(minute) + ':' + pad(second);
}
// `+HH:MM` or `-HH:MM`, from −12:00 to +14:00.
export function exifOffset(text: string | undefined) {
  const match = text?.trim().match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (Number(match[3]) > 59 || (match[1] === '+' ? minutes > 14 * 60 : minutes > 12 * 60)) return null;
  return match[1] === '-' && minutes === 0 ? '+00:00' : match[0];
}
function coordinate(values: number[] | undefined, reference: string | undefined, positive: string, negative: string, limit: number) {
  const ref = reference?.trim().toUpperCase();
  if (!values || values.length !== 3 || (ref !== positive && ref !== negative)) return undefined;
  const [degrees, minutes, seconds] = values;
  if (![degrees, minutes, seconds].every(Number.isFinite) || minutes >= 60 || seconds >= 60) return undefined;
  const value = (degrees + minutes / 60 + seconds / 3600) * (ref === negative ? -1 : 1);
  return Math.abs(value) <= limit ? Math.round(value * 1e7) / 1e7 : undefined;
}
const label = (text: string | undefined) => {
  const trimmed = text?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return trimmed ? trimmed.slice(0, 100) : undefined;
};

/** Capture metadata from an EXIF block, as sharp's `metadata().exif` returns it (with or without the `Exif\0\0` header). */
export function captureMetadata(exif: Uint8Array | undefined): CaptureMetadata {
  if (!exif || exif.byteLength < 8) return {};
  try {
    const start = exif[0] === 0x45 && exif[1] === 0x78 && exif[2] === 0x69 && exif[3] === 0x66 ? 6 : 0;
    const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
    const order = view.getUint16(start);
    if (order !== 0x4949 && order !== 0x4d4d) return {};
    const little = order === 0x4949;
    if (view.getUint16(start + 2, little) !== 42) return {};
    const ifd0 = readIfd(view, little, start, view.getUint32(start + 4, little));
    const exifIfd = readIfd(view, little, start, pointer(view, little, ifd0.get(0x8769)));
    const gps = readIfd(view, little, start, pointer(view, little, ifd0.get(0x8825)));
    const result: CaptureMetadata = {};
    // The time the photo was taken, else when it was digitized; never the file's modification time (IFD0 DateTime).
    const original = exifDateTime(ascii(view, exifIfd.get(0x9003)));
    const digitized = original ? undefined : exifDateTime(ascii(view, exifIfd.get(0x9004)));
    if (original) result.captured = { dateTime: original, offset: exifOffset(ascii(view, exifIfd.get(0x9011))) };
    else if (digitized) result.captured = { dateTime: digitized, offset: exifOffset(ascii(view, exifIfd.get(0x9012))) };
    // A receiver that reports a void fix (GPSStatus V) has no position.
    if (ascii(view, gps.get(0x0009))?.trim().toUpperCase() !== 'V') {
      const latitude = coordinate(rationals(view, little, gps.get(0x0002)), ascii(view, gps.get(0x0001)), 'N', 'S', 90);
      const longitude = coordinate(rationals(view, little, gps.get(0x0004)), ascii(view, gps.get(0x0003)), 'E', 'W', 180);
      if (latitude !== undefined && longitude !== undefined) result.location = { latitude, longitude };
    }
    const make = label(ascii(view, ifd0.get(0x010f)));
    const model = label(ascii(view, ifd0.get(0x0110)));
    if (make || model) result.camera = { ...(make ? { make } : {}), ...(model ? { model } : {}) };
    return result;
  } catch {
    return {};
  }
}
