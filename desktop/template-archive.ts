import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { TemplateImportError, templateFiles } from './template-library';
import { authoringSnapshot, authoringSnapshotFolder } from './authoring-sdk';

// `.imageflow-template` files: authored templateFiles plus an optional installed SDK snapshot. The archive is
// deterministic (sorted names, fixed timestamps), so exporting the same template twice gives the same bytes, and
// importing it gives the same hash as the folder it came from.

export const templateArchiveExtension = '.imageflow-template';
export const isTemplateArchive = (path: string) => extname(path).toLowerCase() === templateArchiveExtension;

// Templates are source and fonts; these bounds only keep a damaged or hostile archive from exhausting the disk.
const maxEntries = 10000;
const maxBytes = 512 * 1024 * 1024;
// 1980-01-01 00:00 in MS-DOS format, the earliest time a zip can hold.
const dosDate = (0 << 9) | (1 << 5) | 1;
const utf8Names = 0x0800;

// Zip names without the UTF-8 flag are CP437 by the format, but macOS's own archiver (ditto, Finder's Compress)
// writes UTF-8 without setting it. A name that is valid UTF-8 is read as UTF-8; anything else as CP437.
const cp437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';
const utf8 = new TextDecoder('utf-8', { fatal: true });
function entryName(bytes: Buffer, flags: number) {
  if (flags & utf8Names) return bytes.toString('utf8');
  try { return utf8.decode(bytes); }
  catch { return [...bytes].map((byte) => byte < 0x80 ? String.fromCharCode(byte) : cp437[byte - 0x80]).join(''); }
}

/** Why a path cannot be unpacked inside a template folder, if it cannot. */
function pathProblem(name: string) {
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')) return name + ' has a path outside the template.';
  return undefined;
}

/** Writes the template in `folder` to an `.imageflow-template` file. The file is replaced only once it is complete. */
export async function writeTemplateArchive(folder: string, file: string, typesRoot?: string) {
  const generated = typesRoot ? await authoringSnapshot(typesRoot, folder) : new Map<string, Buffer>();
  const files = [...await templateFiles(folder), ...generated.keys()].sort();
  // The export must be a file this app can import again, so the import's limits apply here first.
  if (files.length > maxEntries) throw new Error('The template has ' + files.length + ' files; a template file holds at most ' + maxEntries + '.');
  for (const path of files) {
    const problem = pathProblem(path);
    if (problem) throw new Error(problem + ' Rename it before exporting.');
  }
  let total = 0;
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const path of files) {
    const data = generated.get(path) ?? await readFile(join(folder, ...path.split('/')));
    total += data.length;
    if (total > maxBytes) throw new Error('The template is too large to export: a template file holds at most 512 MB.');
    const deflated = deflateRawSync(data, { level: 9 });
    const compressed = deflated.length < data.length;
    const body = compressed ? deflated : data;
    const name = Buffer.from(path, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Names, 6);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so the mode below is read as one
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(utf8Names, 8);
    entry.writeUInt16LE(compressed ? 8 : 0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + directory.length + end.length > maxBytes) throw new Error('The template is too large to export: a template file holds at most 512 MB.');
  const partial = join(dirname(file), '.' + basename(file) + '-' + randomUUID());
  try {
    await writeFile(partial, Buffer.concat([...locals, directory, end]), { flag: 'wx' });
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }
  return files;
}

const invalid = (detail: string) => new TemplateImportError('This file is not a usable ImageFlow template: ' + detail);

/**
 * Unpacks an `.imageflow-template` file into `destination`, which must not exist yet. Only the files a template
 * folder would contribute, plus the reserved SDK snapshot, are written. Other dotfiles, `node_modules/` and
 * macOS's `__MACOSX/` are skipped, and an archive
 * that holds one folder with the template inside (as Finder's Compress makes) is unpacked from that folder. Entries
 * that would leave the destination, links, encrypted entries and damaged data are refused before anything is written.
 */
export async function extractTemplateArchive(file: string, destination: string) {
  const bytes = await readFile(file).catch(() => { throw new TemplateImportError('The template file could not be read.'); });
  if (bytes.length > maxBytes) throw invalid('it is too large.');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw invalid('it is not a zip archive.');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw invalid('it uses a zip format this app does not read (ZIP64).');
  if (count > maxEntries) throw invalid('it has too many files.');
  const entries = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) throw invalid('its file list is damaged.');
    const madeOn = bytes.readUInt8(at + 5);
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const size = bytes.readUInt32LE(at + 20);
    const length = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const mode = bytes.readUInt32LE(at + 38) >>> 16;
    const local = bytes.readUInt32LE(at + 42);
    const name = entryName(bytes.subarray(at + 46, at + 46 + nameLength), flags);
    at = next;
    if (name.endsWith('/')) continue;
    const problem = pathProblem(name);
    if (problem) throw invalid(problem);
    const parts = name.split('/');
    if (parts.some((part) => (part.startsWith('.') && part !== authoringSnapshotFolder) || part === 'node_modules' || part === '__MACOSX')) continue;
    if (madeOn === 3 && (mode & 0o170000) === 0o120000) throw invalid(name + ' is a symbolic link. Templates must contain their files.');
    if (flags & 1) throw invalid(name + ' is encrypted.');
    if (method !== 0 && method !== 8) throw invalid(name + ' is compressed in a way this app does not read.');
    if (entries.has(name)) throw invalid(name + ' appears twice.');
    total += length;
    if (total > maxBytes) throw invalid('it is too large.');
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid(name + ' is damaged.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + size > bytes.length) throw invalid(name + ' is damaged.');
    const body = bytes.subarray(start, start + size);
    let data: Buffer;
    try { data = method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(length, 1) }) : Buffer.from(body); }
    catch { throw invalid(name + ' is damaged.'); }
    if (data.length !== length || crc32(data) !== crc) throw invalid(name + ' is damaged.');
    entries.set(name, data);
  }
  // An archive of the folder itself rather than its contents: unpack from inside that folder.
  let prefix = '';
  if (!entries.has('index.tsx')) {
    const tops = new Set([...entries.keys()].map((name) => name.split('/')[0]));
    const [top] = tops;
    if (tops.size === 1 && entries.has(top + '/index.tsx')) prefix = top + '/';
  }
  if (!entries.has(prefix + 'index.tsx')) throw new TemplateImportError('This file is not an ImageFlow template: it has no index.tsx.');
  await mkdir(destination);
  for (const [name, data] of entries) {
    if (!name.startsWith(prefix)) continue;
    const target = join(destination, ...name.slice(prefix.length).split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
}
