import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Rebuilds a template's saved npm bundle (template/vendor/) from a source checkout, as the app's rebuild_dependencies
// tool and Templates → Rebuild Template Dependencies do: `node scripts/rebuild-template-dependencies.mjs sample/starter/template`.
// Packages are installed with this machine's npm into .build/template-dependencies/, never into the template.
const root = fileURLToPath(new URL('../', import.meta.url));
const template = resolve(process.argv[2] ?? 'sample/starter/template');
const out = join(root, '.build', 'rebuild-dependencies.mjs');
await mkdir(join(root, '.build'), { recursive: true });
await build({ entryPoints: [join(root, 'desktop/dependency-install.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm',
  packages: 'external', logLevel: 'error' });
const { rebuildTemplateDependencies } = await import(pathToFileURL(out).href);
const result = await rebuildTemplateDependencies(template, join(root, '.build', 'template-dependencies'));
const packages = Object.entries(result.packages).map(([name, version]) => name + '@' + version);
console.log(packages.length ? 'Saved ' + packages.join(', ') + ' into ' + join(template, 'vendor') + (result.reused ? ' (reused the install)' : '')
  : 'The template imports no packages; removed its vendor folder.');
if (result.lockfileUpdated) console.log('Updated ' + join(template, 'package-lock.json') + '.');
if (result.leftoverNodeModules) console.log(join(template, 'node_modules') + ' is no longer used; you can delete it.');
