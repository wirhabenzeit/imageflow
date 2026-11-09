import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import electronChecksums from 'electron/checksums.json' with { type: 'json' };
import { build } from 'esbuild';
import metadata from '../package.json' with { type: 'json' };

if (process.platform !== 'darwin') throw new Error('Run the macOS build on a Mac.');

const root = fileURLToPath(new URL('../', import.meta.url));
const work = join(root, '.build');
await mkdir(work, { recursive: true });
const staging = await mkdtemp(join(work, 'desktop-'));
try {
  const source = join(staging, 'app');
  const renderer = join(staging, 'senja-export');
  const swiftArch = process.arch === 'x64' ? 'x86_64' : 'arm64';
  execFileSync('xcrun', [
    'swiftc', '-O', '-target', swiftArch + '-apple-macosx13.0',
    '-module-cache-path', join(work, 'module-cache'),
    join(root, 'renderer', 'export.swift'), '-o', renderer,
  ], { stdio: 'inherit' });

  await cp(join(root, 'dist'), join(source, 'dist'), {
    recursive: true,
    filter: (path) => basename(path) !== 'senja-preview.html',
  });
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'imageflow', productName: 'ImageFlow', version: metadata.version, main: 'main.cjs',
  }));
  await build({
    entryPoints: [join(root, 'desktop', 'main.ts')],
    outfile: join(source, 'main.cjs'),
    bundle: true,
    platform: 'node',
    external: ['electron'],
  });

  const [output] = await packager({
    dir: source,
    out: join(root, 'out'),
    platform: 'darwin',
    arch: process.arch,
    electronVersion: metadata.devDependencies.electron,
    download: { cacheRoot: join(work, 'electron-cache'), checksums: electronChecksums },
    appBundleId: 'ch.wirhabenzeit.imageflow',
    appCategoryType: 'public.app-category.photography',
    asar: true,
    extraResource: renderer,
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
