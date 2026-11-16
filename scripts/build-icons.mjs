// Renders the SVG sources in resources/brand/ into the files used for packaging: the macOS .icns files, the Claude Desktop
// extension icon and the DMG window background. 16 and 32 pt icons use the pixel-fitted *-small.svg artwork; 64 pt and larger use the detailed
// artwork. On a Mac with Xcode 26 it also compiles the layered Icon Composer icon (resources/brand/ImageFlow.icon)
// into resources/Assets.car, which macOS 26 and later prefer over ImageFlow.icns.
// Run `npm run build:icons` after editing a source and commit the regenerated files.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
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

// Claude Desktop shows this 512 px icon on the extension's page (the .mcpb manifest's `icon`).
await writeFile(join(root, 'resources', 'extension-icon.png'), await render(await readFile(join(brand, 'app.svg')), 512));
console.log('resources/extension-icon.png');

// The DMG window is 660 × 420 pt; macOS picks the @2x file on Retina displays once the release joins both into a TIFF.
const background = await readFile(join(brand, 'dmg-background.svg'));
for (const scale of [1, 2]) {
  const output = join(root, 'resources', 'dmg', scale === 1 ? 'background.png' : 'background@2x.png');
  await sharp(background, { density: 72 * scale }).png({ compressionLevel: 9 }).toFile(output);
  console.log(output.slice(root.length));
}

if (process.platform === 'darwin') {
  const work = await mkdtemp(join(tmpdir(), 'imageflow-icon-'));
  try {
    await promisify(execFile)('xcrun', ['actool', join(brand, 'ImageFlow.icon'), '--compile', work,
      '--app-icon', 'ImageFlow', '--platform', 'macosx', '--target-device', 'mac', '--minimum-deployment-target', '12.0',
      '--output-partial-info-plist', join(work, 'partial.plist'), '--output-format', 'human-readable-text', '--notices', '--warnings', '--errors']);
    await rename(join(work, 'Assets.car'), join(root, 'resources', 'Assets.car'));
    console.log('resources/Assets.car');
  } catch (error) {
    console.warn('Skipped resources/Assets.car: compiling an Icon Composer icon needs Xcode 26 or later.\n' + (error.stderr || error.message));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
} else {
  console.log('Skipped resources/Assets.car: compiling the Icon Composer icon needs macOS with Xcode 26 or later.');
}
