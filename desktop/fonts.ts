import { brotliDecompressSync, inflateSync } from 'node:zlib';

// WOFF2 numbers the common tables; their order in the format's known-tag list.
const woff2Tags: Record<string, number> = { cmap: 0, name: 5 };

function woff2Table(font: Buffer, wanted: string) {
  if (font.toString('ascii', 4, 8) === 'ttcf') return;
  let cursor = 48;
  let offset = 0;
  let table: { offset: number; length: number } | undefined;
  function length() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = font.readUInt8(cursor++);
      value = value * 128 + (byte & 127);
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid WOFF2 table length.');
  }
  for (let i = 0; i < font.readUInt16BE(12); i++) {
    const flags = font.readUInt8(cursor++);
    const tag = flags & 63;
    const version = flags >> 6;
    const custom = tag === 63 ? font.toString('ascii', cursor, cursor += 4) : '';
    const original = length();
    const size = (tag === 10 || tag === 11 ? version !== 3 : version !== 0) ? length() : original;
    if (tag === woff2Tags[wanted] || custom === wanted) table = { offset, length: size };
    offset += size;
  }
  if (!table) return;
  const data = brotliDecompressSync(font.subarray(cursor, cursor + font.readUInt32BE(20)), { maxOutputLength: 32 << 20 });
  return data.subarray(table.offset, table.offset + table.length);
}

function fontTable(font: Buffer, wanted: string) {
  const signature = font.toString('ascii', 0, 4);
  if (signature === 'wOF2') return woff2Table(font, wanted);
  const woff = signature === 'wOFF';
  const count = font.readUInt16BE(woff ? 12 : 4);
  for (let i = 0; i < count; i++) {
    const record = woff ? 44 + i * 20 : 12 + i * 16;
    if (font.toString('ascii', record, record + 4) !== wanted) continue;
    const offset = font.readUInt32BE(record + (woff ? 4 : 8));
    const length = font.readUInt32BE(record + (woff ? 8 : 12));
    const bytes = font.subarray(offset, offset + length);
    return woff && length < font.readUInt32BE(record + 12) ? inflateSync(bytes, { maxOutputLength: 32 << 20 }) : bytes;
  }
}

/** The code points a font has glyphs for, as sorted, merged [first, last] ranges, from its Unicode cmap subtable. */
export function fontCoverage(bytes: Uint8Array): [number, number][] | undefined {
  const cmap = fontTable(Buffer.from(bytes), 'cmap');
  if (!cmap) return;
  const records = Array.from({ length: cmap.readUInt16BE(2) }, (_, i) => ({
    platform: cmap.readUInt16BE(4 + i * 8), encoding: cmap.readUInt16BE(6 + i * 8), offset: cmap.readUInt32BE(8 + i * 8) }));
  const unicode = ({ platform, encoding }: { platform: number; encoding: number }) => platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
  // Full-repertoire format 12 first, then the BMP format 4.
  const subtables = records.filter(unicode).map((record) => ({ ...record, format: cmap.readUInt16BE(record.offset) }))
    .filter(({ format }) => format === 12 || format === 4).sort((a, b) => (b.format === 12 ? 1 : 0) - (a.format === 12 ? 1 : 0));
  const table = subtables[0];
  if (!table) return;
  const ranges: [number, number][] = [];
  const add = (first: number, last: number) => {
    const previous = ranges[ranges.length - 1];
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else ranges.push([first, last]);
  };
  const at = table.offset;
  if (table.format === 12) {
    const groups = cmap.readUInt32BE(at + 12);
    for (let i = 0; i < groups; i++) {
      const group = at + 16 + i * 12;
      add(cmap.readUInt32BE(group), cmap.readUInt32BE(group + 4));
    }
  } else {
    const segments = cmap.readUInt16BE(at + 6) / 2;
    const ends = at + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, rangeOffsets = deltas + segments * 2;
    for (let i = 0; i < segments; i++) {
      const end = cmap.readUInt16BE(ends + i * 2), start = cmap.readUInt16BE(starts + i * 2);
      const delta = cmap.readInt16BE(deltas + i * 2), rangeOffset = cmap.readUInt16BE(rangeOffsets + i * 2);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        const glyph = rangeOffset === 0 ? (code + delta) & 0xffff
          : cmap.readUInt16BE(rangeOffsets + i * 2 + rangeOffset + (code - start) * 2);
        if (glyph !== 0) add(code, code);
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

const coverages = new WeakMap<Map<string, Uint8Array>, Record<string, [number, number][]>>();
/** Each bundled font file's coverage, by its file name in the template's assets. Unreadable fonts are left out. */
export function bundledFontCoverage(files: Map<string, Uint8Array>) {
  let found = coverages.get(files);
  if (found) return found;
  found = {};
  for (const [file, bytes] of files) {
    if (!/\.(woff2?|otf|ttf)$/i.test(file)) continue;
    try {
      const coverage = fontCoverage(bytes);
      if (coverage) found[file] = coverage;
    } catch { /* A font whose cmap cannot be read reports no coverage. */ }
  }
  coverages.set(files, found);
  return found;
}

const nameTable = (font: Buffer) => fontTable(font, 'name');

export function bundledFontNames(files: Map<string, Uint8Array>) {
  const names = new Set<string>();
  for (const [file, bytes] of files) {
    if (!/\.(woff2?|otf|ttf)$/i.test(file)) continue;
    try {
      const table = nameTable(Buffer.from(bytes));
      if (!table) continue;
      const base = table.readUInt16BE(4);
      for (let i = 0; i < table.readUInt16BE(2); i++) {
        const entry = 6 + i * 12;
        if (table.readUInt16BE(entry + 6) !== 6) continue; // PostScript name
        const platform = table.readUInt16BE(entry);
        const size = table.readUInt16BE(entry + 8);
        const start = base + table.readUInt16BE(entry + 10);
        const name = table.subarray(start, start + size);
        const text = platform === 0 || platform === 3 ? Buffer.from(name).swap16().toString('utf16le') : name.toString('latin1');
        if (/^[!-~]+$/.test(text)) names.add(text);
      }
    } catch {
      // Unreadable or unsupported font tables cannot authorize a PDF font.
    }
  }
  return [...names];
}
