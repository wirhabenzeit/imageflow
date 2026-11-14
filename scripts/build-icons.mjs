// Renders the SVG sources in resources/brand/ into the macOS .icns files used for packaging.
// 16 and 32 pt use the pixel-fitted *-small.svg artwork; 64 pt and larger use the detailed artwork.
// Run `npm run build:icons` after editing a source SVG and commit the regenerated .icns files.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const brand = join(root, 'resources', 'brand');

// [icns type, pixel size, artwork]: PNG-backed entries supported since macOS 10.7.
const entries = [
  ['icp4', 16, 'small'], ['ic11', 32, 'small'],  // 16 pt @1x, @2x
  ['icp5', 32, 'small'], ['ic12', 64, 'small'],  // 32 pt @1x, @2x
  ['ic07', 128, 'large'], ['ic13', 256, 'large'], // 128 pt @1x, @2x
  ['ic08', 256, 'large'], ['ic14', 512, 'large'], // 256 pt @1x, @2x
  ['ic09', 512, 'large'], ['ic10', 1024, 'large'], // 512 pt @1x, @2x
];

const icons = [
  { name: 'app', output: 'ImageFlow.icns' },
  { name: 'book', output: 'ImageFlowBook.icns' },
  { name: 'template', output: 'ImageFlowTemplate.icns' },
];

async function render(svg, size) {
  const width = Number(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/.exec(svg.toString())?.[1]);
  if (!width) throw new Error('SVG source needs a square viewBox.');
  return sharp(svg, { density: 72 * size / width }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

for (const icon of icons) {
  const sources = {
    large: await readFile(join(brand, `${icon.name}.svg`)),
    small: await readFile(join(brand, `${icon.name}-small.svg`)),
  };
  const body = Buffer.concat(await Promise.all(entries.map(async ([type, size, art]) => chunk(type, await render(sources[art], size)))));
  await writeFile(join(root, 'resources', icon.output), chunk('icns', body));
  console.log(`resources/${icon.output}`);
}
