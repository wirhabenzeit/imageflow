import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Rebuilds a template's saved npm bundle (template/vendor/) outside the app: `node scripts/rebuild-template-dependencies.mjs sample/starter/template`. Run npm install there first.
const root = fileURLToPath(new URL('../', import.meta.url));
const template = resolve(process.argv[2] ?? 'sample/starter/template');
const out = join(root, '.build', 'rebuild-dependencies.mjs');
await mkdir(join(root, '.build'), { recursive: true });
await build({ entryPoints: [join(root, 'desktop/dependencies.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm',
  packages: 'external', logLevel: 'error' });
const { rebuildDependencies } = await import(pathToFileURL(out).href);
const manifest = await rebuildDependencies(template);
console.log(manifest ? 'Saved ' + Object.entries(manifest.packages).map(([name, version]) => name + '@' + version).join(', ') +
  ' into ' + join(template, 'vendor') : 'The template imports no packages; removed its vendor folder.');
