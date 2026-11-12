import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import type { TemplateInfo } from '../src/desktop';
import { mm, printFormat } from '../src/format';
import { extractTemplateArchive, writeTemplateArchive } from '../desktop/template-archive';
import { TemplateLibrary, templateHash } from '../desktop/template-library';

const format = printFormat({ label: 'Square', trim: { width: mm(200), height: mm(200) }, bleed: mm(3), safe: mm(10),
  pageCount: { min: 2, max: 20, step: 2 } });
async function validate(folder: string): Promise<TemplateInfo> {
  const source = await readFile(join(folder, 'index.tsx'), 'utf8');
  const field = (name: string) => new RegExp(name + ": '([^']*)'").exec(source)?.[1];
  return { id: field('id'), version: field('version')!, label: field('label'), parameters: {}, format, formatId: 'default', formats: {},
    spreads: { story: { label: 'Story', span: 'spread', parameters: {}, boxes: {}, elements: {} } } };
}
async function template(folder: string, version = '1.0.0') {
  await mkdir(join(folder, 'fonts'), { recursive: true });
  await writeFile(join(folder, 'index.tsx'), `export default { id: 'travel', version: '${version}', label: 'Travel' }; // ` + 'x'.repeat(400));
  await writeFile(join(folder, 'fonts', 'a.woff2'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(folder, '.DS_Store'), 'x');
  return folder;
}
// A stored (uncompressed) zip with exactly these entries, as another tool might write it.
function zip(entries: { name: string | Buffer; data?: string; mode?: number }[]) {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data = '', mode = 0o100644 } of entries) {
    const bytes = Buffer.from(data);
    const nameBytes = Buffer.isBuffer(name) ? name : Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt32LE(crc32(bytes), 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((mode << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, bytes);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

test('an exported template file unpacks to the same files and hash, and exports byte for byte the same', async () => {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-archive-'));
  try {
    const source = await template(join(work, 'travel'));
    const file = join(work, 'Travel.imageflow-template');
    assert.deepEqual(await writeTemplateArchive(source, file), ['fonts/a.woff2', 'index.tsx']);
    const again = join(work, 'Again.imageflow-template');
    await writeTemplateArchive(source, again);
    assert.deepEqual(await readFile(file), await readFile(again));
    await extractTemplateArchive(file, join(work, 'out'));
    assert.equal(await templateHash(join(work, 'out')), await templateHash(source));
    assert.deepEqual((await readdir(work)).filter((name) => name.startsWith('.')), [], 'no partial files are left');
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('a zip of the template folder itself unpacks from inside it, without macOS extras', async () => {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-archive-'));
  try {
    const file = join(work, 'travel.imageflow-template');
    await writeFile(file, zip([{ name: 'travel/' }, { name: 'travel/index.tsx', data: 'source' }, { name: 'travel/fonts/a.woff2', data: 'font' },
      { name: '__MACOSX/travel/._index.tsx', data: 'meta' }, { name: 'travel/.DS_Store', data: 'x' }]));
    await extractTemplateArchive(file, join(work, 'out'));
    assert.deepEqual((await readdir(join(work, 'out'), { recursive: true })).sort(), ['fonts', 'fonts/a.woff2', 'index.tsx']);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('entries outside the template, links, damage and files without index.tsx are refused before anything is written', async () => {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-archive-'));
  try {
    const cases: [string, Buffer, RegExp][] = [
      ['escape', zip([{ name: 'index.tsx', data: 'x' }, { name: '../evil.txt', data: 'x' }]), /outside the template/],
      ['absolute', zip([{ name: 'index.tsx', data: 'x' }, { name: '/etc/evil', data: 'x' }]), /outside the template/],
      ['backslash', zip([{ name: 'index.tsx', data: 'x' }, { name: '..\\evil', data: 'x' }]), /outside the template/],
      ['link', zip([{ name: 'index.tsx', data: 'x' }, { name: 'fonts', data: '/etc', mode: 0o120777 }]), /symbolic link/],
      ['twice', zip([{ name: 'index.tsx', data: 'x' }, { name: 'index.tsx', data: 'y' }]), /appears twice/],
      ['empty', zip([{ name: 'readme.md', data: 'x' }]), /no index\.tsx/],
      ['text', Buffer.from('not a zip'), /not a zip archive/],
    ];
    const damaged = zip([{ name: 'index.tsx', data: 'source' }]);
    damaged[30 + 'index.tsx'.length] ^= 0xff;
    cases.push(['damaged', damaged, /damaged/]);
    for (const [name, bytes, message] of cases) {
      const file = join(work, name + '.imageflow-template');
      await writeFile(file, bytes);
      await assert.rejects(extractTemplateArchive(file, join(work, 'out-' + name)), message, name);
      await assert.rejects(readdir(join(work, 'out-' + name)), name + ' wrote nothing');
    }
    await assert.rejects(readFile(join(work, 'evil.txt')));
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('the library imports a template file and exports its entries, built-in ones too', async () => {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-archive-'));
  try {
    const builtIn = await template(join(work, 'builtin'));
    await writeFile(join(builtIn, 'index.tsx'), "export default { id: 'starter', version: '1.0.0', label: 'Photobook' };");
    const library = new TemplateLibrary(join(work, 'Templates'), [{ template: builtIn }], validate, async (path) => rm(path, { recursive: true }), 'caps');
    const file = join(work, 'Travel.imageflow-template');
    await writeTemplateArchive(await template(join(work, 'travel')), file);
    const result = await library.import(file, async () => true);
    assert.equal(result.status, 'imported');
    assert.equal(result.source, file);
    const entry = (await library.list()).find(({ id }) => id === 'travel')!;
    assert.equal(entry.importedFrom, file);
    assert.equal(entry.hash, await templateHash(join(work, 'travel')));
    assert.deepEqual(await readdir(join(work, 'Templates')), ['travel'], 'the unpacked copy is removed');
    assert.equal((await library.import(file, async () => true)).status, 'unchanged');

    await library.export('travel', join(work, 'Out.imageflow-template'));
    assert.deepEqual(await readFile(join(work, 'Out.imageflow-template')), await readFile(file));
    await library.export('starter', join(work, 'Starter.imageflow-template'));
    await extractTemplateArchive(join(work, 'Starter.imageflow-template'), join(work, 'starter-out'));
    assert.equal(await templateHash(join(work, 'starter-out')), await templateHash(builtIn));

    await writeFile(join(work, 'Broken.imageflow-template'), 'not a zip');
    const failed = await library.import(join(work, 'Broken.imageflow-template'), async () => true);
    assert.equal(failed.status, 'failed');
    assert.match(failed.message!, /not a zip archive/);
    assert.deepEqual(await readdir(join(work, 'Templates')), ['travel']);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('names macOS stores as UTF-8 without the UTF-8 flag keep their accents; other unflagged names are CP437', async () => {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-archive-'));
  try {
    const file = join(work, 'ditto.imageflow-template');
    // ditto writes UTF-8 names and leaves the flag unset; 0x81 alone is not UTF-8, and is ü in CP437.
    await writeFile(file, zip([{ name: 'index.tsx', data: 'source' }, { name: 'maps/Zürich.svg', data: '<svg/>' },
      { name: Buffer.from([0x4d, 0x81, 0x6e, 0x63, 0x68, 0x65, 0x6e, 0x2e, 0x73, 0x76, 0x67]), data: '<svg/>' }]));
    await extractTemplateArchive(file, join(work, 'out'));
    assert.deepEqual((await readdir(join(work, 'out'), { recursive: true })).sort(), ['München.svg', 'index.tsx', 'maps', 'maps/Zürich.svg']);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('export refuses a template its own import would refuse', async () => {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-archive-'));
  try {
    const many = await template(join(work, 'many'));
    await mkdir(join(many, 'icons'));
    await Promise.all(Array.from({ length: 10000 }, (_, i) => writeFile(join(many, 'icons', i + '.svg'), '')));
    await assert.rejects(writeTemplateArchive(many, join(work, 'Many.imageflow-template')), /10002 files; a template file holds at most 10000/);
    const odd = await template(join(work, 'odd'));
    await writeFile(join(odd, 'back\\slash.svg'), '');
    await assert.rejects(writeTemplateArchive(odd, join(work, 'Odd.imageflow-template')), /outside the template\. Rename it/);
    assert.deepEqual((await readdir(work)).sort(), ['many', 'odd'], 'nothing is written');
  } finally { await rm(work, { recursive: true, force: true }); }
});
