import { brotliDecompressSync, inflateSync } from 'node:zlib';

function woff2NameTable(font: Buffer) {
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
    if (tag === 5 || custom === 'name') table = { offset, length: size };
    offset += size;
  }
  if (!table) return;
  const data = brotliDecompressSync(font.subarray(cursor, cursor + font.readUInt32BE(20)), { maxOutputLength: 32 << 20 });
  return data.subarray(table.offset, table.offset + table.length);
}

function nameTable(font: Buffer) {
  const signature = font.toString('ascii', 0, 4);
  if (signature === 'wOF2') return woff2NameTable(font);
  const woff = signature === 'wOFF';
  const count = font.readUInt16BE(woff ? 12 : 4);
  for (let i = 0; i < count; i++) {
    const record = woff ? 44 + i * 20 : 12 + i * 16;
    if (font.toString('ascii', record, record + 4) !== 'name') continue;
    const offset = font.readUInt32BE(record + (woff ? 4 : 8));
    const length = font.readUInt32BE(record + (woff ? 8 : 12));
    const bytes = font.subarray(offset, offset + length);
    return woff && length < font.readUInt32BE(record + 12) ? inflateSync(bytes, { maxOutputLength: 32 << 20 }) : bytes;
  }
}

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
