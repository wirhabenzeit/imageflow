import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import metadata from '../package.json' with { type: 'json' };
import { buildMcp } from './build-mcp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const desktop = join(root, '.build', 'desktop');
const platform = '@esbuild/' + process.platform + '-' + process.arch;
export const esbuildBinary = join(root, 'node_modules', platform, 'bin', 'esbuild');
export const sample = join(root, 'sample');
const platformTag = process.platform + '-' + process.arch;
const photoDependencies = [
  'sharp', 'semver', 'detect-libc', '@img/colour', '@img/sharp-' + platformTag, '@img/sharp-libvips-' + platformTag,
];

// esbuild options for the main process and preload; scripts/dev.mjs rebuilds them in watch mode.
export const mainBuild = (destination = desktop) => ({
  entryPoints: [join(root, 'desktop', 'main.ts'), join(root, 'desktop', 'preload.ts'), join(root, 'desktop', 'typecheck-worker.ts')],
  outdir: destination, outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', format: 'cjs', external: ['electron', 'esbuild', 'sharp', 'typescript'],
});

// `dev` stages without the Vite build; the editor then comes from the Vite dev server.
export async function stageDesktop({ packaged = false, dev = false, destination = desktop } = {}) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all([
    dev ? Promise.resolve() : cp(join(root, 'dist'), join(destination, 'dist'), { recursive: true }),
    cp(join(root, 'node_modules', 'esbuild'), join(destination, 'node_modules', 'esbuild'), { recursive: true }),
    cp(join(root, 'node_modules', 'typescript'), join(destination, 'node_modules', 'typescript'), { recursive: true }),
    cp(join(root, 'authoring'), join(destination, 'authoring-types'), { recursive: true })
      .then(() => Promise.all([
        cp(join(root, 'node_modules/@types/react'), join(destination, 'authoring-types/react-runtime'), { recursive: true }),
        cp(join(root, 'node_modules/csstype'), join(destination, 'authoring-types/csstype'), { recursive: true }),
      ])),
    ...photoDependencies.map((name) => cp(join(root, 'node_modules', name), join(destination, 'node_modules', name), { recursive: true })),
    packaged ? Promise.resolve() : cp(sample, join(destination, 'sample'), {
      recursive: true, filter: (path) => basename(path) !== '.imageflow' && basename(path) !== 'node_modules',
    }),
    packaged ? Promise.resolve() : cp(dirname(dirname(esbuildBinary)), join(destination, 'node_modules', platform), { recursive: true }),
    writeFile(join(destination, 'package.json'), JSON.stringify({
      name: 'imageflow', productName: 'ImageFlow', version: metadata.version, main: 'main.cjs',
    })),
    cp(join(root, 'docs'), join(destination, 'docs'), { recursive: true }),
    buildMcp(join(destination, 'mcp-bridge.cjs')),
    build(mainBuild(destination)),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await stageDesktop();
