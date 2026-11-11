import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import electronChecksums from 'electron/checksums.json' with { type: 'json' };
import metadata from '../package.json' with { type: 'json' };
import { esbuildBinary, sample, stageDesktop } from './stage-desktop.mjs';

if (process.platform !== 'darwin') throw new Error('Run the macOS build on a Mac.');

const root = fileURLToPath(new URL('../', import.meta.url));
const work = join(root, '.build');
await mkdir(work, { recursive: true });
const staging = await mkdtemp(join(work, 'package-'));
try {
  const source = join(staging, 'app');
  const books = join(staging, 'sample');
  await Promise.all([
    stageDesktop({ packaged: true, destination: source }),
    cp(sample, books, { recursive: true, filter: (path) => basename(path) !== '.imageflow' }),
  ]);
  const [output] = await packager({
    dir: source,
    out: join(root, 'out'),
    platform: 'darwin',
    arch: process.arch,
    electronVersion: metadata.devDependencies.electron,
    download: { cacheRoot: join(root, '.build', 'electron-cache'), checksums: electronChecksums },
    appBundleId: 'ch.wirhabenzeit.imageflow',
    appCategoryType: 'public.app-category.photography',
    // Agents run the MCP bridge with ImageFlow's executable in Node mode; keep it a plain file outside app.asar.
    asar: { unpackDir: 'node_modules/@img', unpack: '**/mcp-bridge.cjs' },
    extraResource: [esbuildBinary, books],
    icon: join(root, 'resources', 'ImageFlow.icns'),
    prune: false,
    overwrite: true,
    osxSign: {
      identity: '-',
      identityValidation: false,
      continueOnError: false,
      // A local ad-hoc signature has no Apple Team ID for hardened library validation.
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
  });
  console.log('Mac app: ' + join(output, 'ImageFlow.app'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
